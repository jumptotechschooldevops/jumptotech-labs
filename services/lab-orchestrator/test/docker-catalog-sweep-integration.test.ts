/**
 * Every Docker-track lab, started on a real docker:27-dind sandbox.
 *
 * The docker0NN suites walk DOCKER-009 … 014 to a PASS and the core suite a few
 * more; this asks every lab whose provider is `docker` the questions a student's
 * first minutes ask:
 *
 *   1. **Start** succeeds: the sandbox daemon comes up, the lab's images,
 *      containers and workspace files are seeded, and its setup verification
 *      holds.
 *   2. **Check** before any work does not pass: the lab does not begin solved.
 *   3. **Reset** succeeds, and the Check that follows grades exactly as the
 *      first one did.
 *   4. **End Lab** removes the sandbox and its data volume.
 *
 * Both Checks are read once the grades stop changing — a seeded container can
 * still be starting when setup verification accepts it.
 *
 * Sequential, one sandbox at a time: each is a privileged dind daemon, and
 * several at once on a two-core runner measures the runner.
 *
 * SAFETY: every object carries this run's random token and every removal goes
 * through `owned()`, exactly as in the other Docker suites.
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker-catalog-sweep-integration.test.ts --root services/lab-orchestrator
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SESSION_POLICY,
  DockerCliFactory,
  DockerLabProvider,
  type LabRegistry,
  type LabSessionContext,
  type SessionPolicy,
  type WorkspaceFile,
  type WorkspacePort,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';
import { realCatalog } from './real-catalog.js';

const execFileAsync = promisify(execFile);
const ENABLED = process.env.RUN_DOCKER_INTEGRATION_TESTS === '1';

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log('[docker-catalog-sweep] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1');
}

const RUN = randomBytes(4).toString('hex');
const TEST_NETWORK = `jtt-itcat-${RUN}-net`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function owned(name: string): string {
  if (!name.includes(RUN)) {
    throw new Error(`refusing to remove '${name}': not created by this run (${RUN})`);
  }
  return name;
}

const POLICY: SessionPolicy = {
  ...DEFAULT_SESSION_POLICY,
  docker: {
    ...DEFAULT_SESSION_POLICY.docker,
    network: TEST_NETWORK,
    memory: '1g',
    cpus: '1',
    pidsLimit: 256,
    readyTimeoutSeconds: 240,
  },
};

async function docker(...args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** The student's workspace, as the terminal service keeps it, on local disk. */
class TempDirWorkspace implements WorkspacePort {
  constructor(private readonly root: string) {}
  #dir(sessionId: string): string {
    return path.join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, ''));
  }
  async seed(sessionId: string, files: readonly WorkspaceFile[]): Promise<void> {
    const dir = this.#dir(sessionId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const target = path.join(dir, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { mode: 0o600 });
    }
  }
  async read(sessionId: string, filePath: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.#dir(sessionId), filePath), 'utf8');
    } catch {
      return null;
    }
  }
  async destroy(sessionId: string): Promise<void> {
    await rm(this.#dir(sessionId), { recursive: true, force: true });
  }
}

/** Docker-provider lab ids, read from disk so a new lab joins the sweep by existing. */
const CATALOG: LabRegistry = await realCatalog();
const LAB_IDS = CATALOG.all()
  .filter((lab) => lab.environment.provider === 'docker')
  .map((lab) => lab.id)
  .sort();

describe.runIf(ENABLED)('every Docker-track lab on a real dind sandbox', () => {
  const engines = new DockerCliFactory({});
  const sandboxes: string[] = [];
  let workspaceRoot: string;
  let workspace: TempDirWorkspace;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-itcat-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    const pull = await docker('image', 'pull', POLICY.docker.image);
    expect(pull.code, pull.stderr).toBe(0);
  }, 900_000);

  afterAll(async () => {
    for (const sandbox of sandboxes) {
      await docker('rm', '--force', '--volumes', owned(sandbox));
      await docker('volume', 'rm', '--force', owned(DockerLabProvider.dataVolume(sandbox)));
    }
    await docker('network', 'rm', owned(TEST_NETWORK));
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }, 600_000);

  it.each(LAB_IDS)(
    '%s starts, does not begin solved, resets to its start, and ends',
    async (labId) => {
      const lab = CATALOG.get(labId);
      const tag = randomBytes(2).toString('hex');
      const sandbox = `jtt-lab-${RUN}${tag}`;
      const sessionId = `sess-${randomBytes(8).toString('hex')}`;
      sandboxes.push(sandbox);

      const provider = new DockerLabProvider({
        engines,
        workspace,
        hostName: 'integration-catalog',
        waitForRequirements: (input) =>
          waitForRequirements({
            docker: engines.session(input.namespace),
            workspace: { port: workspace, sessionId },
            ...input,
          }),
      });
      const context: LabSessionContext = {
        sessionId,
        labId,
        namespace: sandbox,
        serviceAccountName: POLICY.serviceAccountName,
        lab,
        expiresAtMs: Date.now() + 60 * 60_000,
        policy: POLICY,
      };
      const grades = async () => {
        const result = await verifyLab({
          lab,
          namespace: sandbox,
          docker: engines.session(sandbox),
          workspace: { port: workspace, sessionId },
        });
        return {
          passed: result.passed,
          byLabel: Object.fromEntries(result.checks.map((c) => [c.label, c.status])),
        };
      };
      /** Grades once two reads five seconds apart agree, or after a minute. */
      const settled = async () => {
        const deadline = Date.now() + 60_000;
        let previous = await grades();
        for (;;) {
          await sleep(5_000);
          const current = await grades();
          if (JSON.stringify(current) === JSON.stringify(previous) || Date.now() > deadline) return current;
          previous = current;
        }
      };

      // 1. Start — retrying only a registry hiccup, as the per-lab suites do:
      //    every sandbox has its own image store and pulls from Docker Hub.
      let created = await provider.create(context);
      for (let attempt = 1; attempt < 3 && !created.ok; attempt += 1) {
        if (!/could not obtain image|timeout|TLS handshake|i\/o timeout/i.test(created.error?.message ?? '')) break;
        await provider.destroy(context);
        await sleep(5_000 * attempt);
        created = await provider.create(context);
      }
      expect(created.error?.message ?? '', JSON.stringify(created.steps)).toBe('');
      expect(created.ok).toBe(true);

      try {
        // 2. Check before any work.
        const initial = await settled();
        expect(Object.keys(initial.byLabel).length).toBeGreaterThan(0);
        expect(initial.passed, `${labId} passes its Check before any work`).toBe(false);

        // 3. Reset, then the same grades as at Start.
        const reset = await provider.reset(context);
        expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
        const after = await settled();
        expect(after.byLabel).toEqual(initial.byLabel);
      } finally {
        // 4. End Lab.
        await provider.destroy(context);
      }
      const left = await docker('ps', '-a', '--filter', `name=^${sandbox}$`, '--format', '{{.Names}}');
      expect(left.stdout.trim(), `${labId} sandbox left behind`).toBe('');
      const volume = await docker('volume', 'ls', '--filter', `name=^${DockerLabProvider.dataVolume(sandbox)}$`, '--format', '{{.Name}}');
      expect(volume.stdout.trim(), `${labId} data volume left behind`).toBe('');
    },
    1_200_000,
  );
});
