/**
 * DOCKER-010 production validation against a REAL `docker:27-dind` sandbox.
 *
 * The thing a fake cannot prove for this lab is that the *seeded faults are
 * real faults*: that a command naming a missing binary really does leave exit
 * code 127 and a "not found" line in the log, that a program that inspects its
 * own environment and refuses really does leave the code it chose, and that a
 * container built from the wrong image really does sit there looking healthy.
 * Those are properties of Docker and of the images, so they are measured here.
 *
 * Skipped unless RUN_DOCKER_INTEGRATION_TESTS=1:
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker010-integration.test.ts --root services/lab-orchestrator
 *
 * ---------------------------------------------------------------------------
 * SAFETY — runs against a developer's own Docker daemon.
 *
 * Every host object carries this run's random token, and every destructive host
 * call passes through `owned()`, which throws on a name without it. No prune,
 * no wildcards, no label sweeps.
 * ---------------------------------------------------------------------------
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SESSION_POLICY,
  DockerCliFactory,
  DockerLabProvider,
  loadLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
  type SessionPolicy,
  type WorkspaceFile,
  type WorkspacePort,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';
import { LABS_DIR } from './helpers.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.RUN_DOCKER_INTEGRATION_TESTS === '1';
const suite = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log('[docker010-integration] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1');
}

const RUN = randomBytes(4).toString('hex');
const SANDBOX = `jtt-lab-${RUN}10`;
const TEST_NETWORK = `jtt-it10-${RUN}-net`;
const SESSION = `sess-${randomBytes(8).toString('hex')}`;

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

interface Cmd {
  code: number;
  stdout: string;
  stderr: string;
}

async function docker(...args: string[]): Promise<Cmd> {
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

/** Run a command inside the sandbox — i.e. against the session's OWN daemon. */
const inSandbox = (...args: string[]) => docker('exec', SANDBOX, ...args);

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
      const { readFile } = await import('node:fs/promises');
      return await readFile(path.join(this.#dir(sessionId), filePath), 'utf8');
    } catch {
      return null;
    }
  }
  async destroy(sessionId: string): Promise<void> {
    await rm(this.#dir(sessionId), { recursive: true, force: true });
  }
}

/** The worker's command, byte-identical to the one the lab seeds. */
const WORKER_CMD =
  'if [ "$LEDGER_MODE" != "live" ]; then echo "FATAL: ledger-worker refuses to start with LEDGER_MODE=$LEDGER_MODE" >&2; exit 78; fi; exec sleep 3600';

suite('DOCKER-010 against a real docker:27-dind sandbox', () => {
  const engines = new DockerCliFactory({});
  let workspaceRoot: string;
  let workspace: TempDirWorkspace;
  let provider: DockerLabProvider;
  let lab: LoadedLabDefinition;

  const verify = () =>
    verifyLab({
      lab,
      namespace: SANDBOX,
      docker: engines.session(SANDBOX),
      workspace: { port: workspace, sessionId: SESSION },
    });

  const failing = (r: Awaited<ReturnType<typeof verify>>) =>
    r.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  const state = async (name: string, format: string) =>
    (await inSandbox('docker', 'inspect', name, '--format', format)).stdout.trim();

  const rmInSandbox = (...names: string[]) => inSandbox('docker', 'rm', '--force', ...names);

  /** Each of the three correct repairs, as a student would make them. */
  const fixApi = () =>
    inSandbox('docker', 'run', '-d', '--name', 'ledger-api', '-p', '8080:80', 'nginx:1.27-alpine');
  const fixWorker = (mode = 'live') =>
    inSandbox('docker', 'run', '-d', '--name', 'ledger-worker',
      '-e', `LEDGER_MODE=${mode}`, '-e', 'LEDGER_API_URL=http://ledger-api',
      'alpine:3.20', 'sh', '-c', WORKER_CMD);
  const fixWeb = (hostPort = '8081') =>
    inSandbox('docker', 'run', '-d', '--name', 'ledger-web', '-p', `${hostPort}:80`, 'nginx:1.27-alpine');

  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'docker', 'docker-010-troubleshooting', 'lab.yaml'),
    );
    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-it10-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    provider = new DockerLabProvider({
      engines,
      workspace,
      hostName: 'integration-010',
      waitForRequirements: (input) =>
        waitForRequirements({
          docker: engines.session(input.namespace),
          workspace: { port: workspace, sessionId: SESSION },
          ...input,
        }),
    });
    const pull = await docker('image', 'pull', POLICY.docker.image);
    expect(pull.code, pull.stderr).toBe(0);
  }, 900_000);

  afterAll(async () => {
    await docker('rm', '--force', '--volumes', owned(SANDBOX));
    await docker('volume', 'rm', '--force', owned(DockerLabProvider.dataVolume(SANDBOX)));
    await docker('network', 'rm', owned(TEST_NETWORK));
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }, 300_000);

  const context = (): LabSessionContext => ({
    sessionId: SESSION,
    labId: lab.id,
    namespace: SANDBOX,
    serviceAccountName: POLICY.serviceAccountName,
    lab,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: POLICY,
  });

  // ------------------------------------------------------- seeding is real

  it('provisions the sandbox and seeds all three faults', async () => {
    let result = await provider.create(context());
    // A Docker Hub TLS hiccup is a registry problem, not a provisioning defect.
    if (!result.ok && /timeout|TLS handshake|i\/o timeout/i.test(result.error?.message ?? '')) {
      await provider.destroy(context());
      result = await provider.create(context());
    }
    expect(result.error?.message ?? '').toBe('');
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);

    const names = (await inSandbox('docker', 'ps', '-a', '--format', '{{.Names}}')).stdout
      .split('\n').map((s) => s.trim()).filter(Boolean).sort();
    expect(names).toEqual(['ledger-api', 'ledger-web', 'ledger-worker']);
  }, 900_000);

  it('fault 1: ledger-api exits 127 with the missing binary named in its log', async () => {
    expect(await state('ledger-api', '{{.State.Status}} {{.State.ExitCode}}')).toBe('exited 127');
    // Exit 127 is what makes this diagnosable; the log says which path failed.
    const logs = await inSandbox('docker', 'logs', 'ledger-api');
    expect(`${logs.stdout}${logs.stderr}`).toContain('/usr/local/bin/ledger-api');
    expect(`${logs.stdout}${logs.stderr}`).toMatch(/not found/i);
    // Its port binding is already correct — the student must notice and keep it.
    expect(await state('ledger-api', '{{(index .HostConfig.PortBindings "80/tcp" 0).HostPort}}')).toBe('8080');
  }, 300_000);

  it('fault 2: ledger-worker exits 78 and says which setting it refused', async () => {
    expect(await state('ledger-worker', '{{.State.Status}} {{.State.ExitCode}}')).toBe('exited 78');
    const logs = await inSandbox('docker', 'logs', 'ledger-worker');
    expect(`${logs.stdout}${logs.stderr}`).toContain('LEDGER_MODE=maintenance');
  }, 300_000);

  it('fault 3: ledger-web is running, from the wrong image, publishing nothing', async () => {
    expect(await state('ledger-web', '{{.State.Status}}')).toBe('running');
    expect(await state('ledger-web', '{{.Config.Image}}')).toBe('alpine:3.20');
    expect(await state('ledger-web', '{{len .HostConfig.PortBindings}}')).toBe('0');
  }, 300_000);

  // ------------------------------------------------------------ unsolved

  it('the unsolved lab fails every check', async () => {
    const before = await verify();
    expect(before.passed).toBe(false);
    expect(before.summary).toBe('LAB NOT COMPLETE');
    expect(before.checks).toHaveLength(9);

    /*
     * Exactly which six fail is worth pinning, because three checks legitimately
     * pass on the broken environment and that is not a bug:
     *
     *   ledger-api's image      — seeded correct; only its command is wrong
     *   ledger-worker's API URL — seeded correct; only LEDGER_MODE is wrong
     *   ledger-web "is running" — it genuinely is running, which is the whole
     *                             point of that fault
     *
     * ledger-api's *port* check fails even though its binding is configured
     * correctly: published ports are read from NetworkSettings.Ports, which the
     * daemon empties while a container is stopped. The binding is still in
     * HostConfig for the student to read — asserted in the fault-1 test above.
     */
    expect(failing(before).sort()).toEqual([
      'Container ledger-api is running',
      'Container ledger-web runs the nginx:1.27-alpine image',
      'Container ledger-worker is running',
      'ledger-api publishes container port 80 on host port 8080',
      'ledger-web publishes container port 80 on host port 8081',
      'ledger-worker runs with LEDGER_MODE set to live',
    ].sort());
  }, 300_000);

  // --------------------------------------------------- one fix at a time

  it('fixing one fault does not pass the lab, and the report names what is left', async () => {
    await rmInSandbox('ledger-api');
    expect((await fixApi()).code).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    // The api checks now pass; worker and web are still broken.
    expect(failing(result)).not.toContain('Container ledger-api is running');
    expect(failing(result)).toContain('Container ledger-worker is running');
    expect(failing(result)).toContain('Container ledger-web runs the nginx:1.27-alpine image');
  }, 300_000);

  it('the same environment fault, left in place, still fails after a recreate', async () => {
    // A student who recreates the worker without reading the log repeats the
    // fault: same command, same wrong mode, same exit 78.
    await rmInSandbox('ledger-worker');
    expect((await fixWorker('maintenance')).code).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('Container ledger-worker is running');
    expect(await state('ledger-worker', '{{.State.ExitCode}}')).toBe('78');
  }, 300_000);

  // ------------------------------------------------------------- solved

  it('all three repairs together pass the lab', async () => {
    await rmInSandbox('ledger-worker', 'ledger-web');
    expect((await fixWorker()).code).toBe(0);
    expect((await fixWeb()).code).toBe(0);

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  }, 600_000);

  // -------------------------------------------------------- adversarial

  it('the wrong host port fails, even with the right image', async () => {
    await rmInSandbox('ledger-web');
    expect((await fixWeb('9090')).code).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['ledger-web publishes container port 80 on host port 8081']);
    expect(
      result.checks.find((c) => c.label.includes('8081'))?.detail,
    ).toContain('9090');
  }, 300_000);

  it('the right port on the wrong image fails', async () => {
    await rmInSandbox('ledger-web');
    expect(
      (await inSandbox('docker', 'run', '-d', '--name', 'ledger-web', '-p', '8081:80',
        'alpine:3.20', 'sleep', '3600')).code,
    ).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['Container ledger-web runs the nginx:1.27-alpine image']);
  }, 300_000);

  it('a decoy container with the right settings cannot stand in for the target', async () => {
    await rmInSandbox('ledger-web', 'ledger-web-fixed');
    // Correct in every way — but under the wrong name.
    expect(
      (await inSandbox('docker', 'run', '-d', '--name', 'ledger-web-fixed', '-p', '8081:80',
        'nginx:1.27-alpine')).code,
    ).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('Container ledger-web is running');
    await rmInSandbox('ledger-web-fixed');
  }, 300_000);

  // ------------------------------------------------------------- reset

  it('reset restores the three broken containers exactly as they started', async () => {
    // Solve it first so the reset has something to undo.
    await rmInSandbox('ledger-web');
    expect((await fixWeb()).code).toBe(0);
    expect((await verify()).passed).toBe(true);

    const reset = await provider.reset(context());
    expect(reset.error?.message ?? '').toBe('');
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    expect(await state('ledger-api', '{{.State.Status}} {{.State.ExitCode}}')).toBe('exited 127');
    expect(await state('ledger-worker', '{{.State.Status}} {{.State.ExitCode}}')).toBe('exited 78');
    expect(await state('ledger-web', '{{.Config.Image}}')).toBe('alpine:3.20');

    const after = await verify();
    expect(after.passed).toBe(false);
    expect(failing(after)).toContain('Container ledger-api is running');
  }, 900_000);
});
