/**
 * DOCKER-011 production validation against a REAL `docker:27-dind` sandbox.
 *
 * Two things can only be measured here. First, that the incident is real: the
 * seeded application genuinely writes a degraded verdict for the wrong region
 * and a ready one for the right region, so the lab is diagnosable rather than
 * merely assertable. Second — and this is the reason the primitive was built —
 * that `docker_container_file_content` reads a file out of a real container
 * through the daemon's archive endpoint, with nothing executing inside it.
 *
 * Skipped unless RUN_DOCKER_INTEGRATION_TESTS=1:
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker011-integration.test.ts --root services/lab-orchestrator
 *
 * ---------------------------------------------------------------------------
 * SAFETY — runs against a developer's own Docker daemon.
 *
 * Every host object carries this run's random token, and every destructive host
 * call passes through `owned()`, which throws on a name without it.
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
  console.log('[docker011-integration] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1');
}

const RUN = randomBytes(4).toString('hex');
const SANDBOX = `jtt-lab-${RUN}11`;
const TEST_NETWORK = `jtt-it11-${RUN}-net`;
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

/** The seeded commands, byte-identical to the lab's. */
const API_CMD =
  'mkdir -p /etc/statements /var/run/statements; printf "supported_regions=eu-west-1\\nshard=ledger-eu\\n" > /etc/statements/regions.conf; if [ "$STATEMENTS_REGION" = eu-west-1 ]; then printf "ready: region=%s\\n" "$STATEMENTS_REGION" > /var/run/statements/status; echo "statements-api ready"; else printf "degraded: region=%s\\n" "$STATEMENTS_REGION" > /var/run/statements/status; echo "WARN: no ledger shard for region $STATEMENTS_REGION" >&2; fi; exec sleep 3600';
const WORKER_CMD =
  'if [ -z "$STATEMENTS_API_URL" ]; then echo "FATAL: STATEMENTS_API_URL is not set" >&2; exit 78; fi; exec sleep 3600';

suite('DOCKER-011 against a real docker:27-dind sandbox', () => {
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

  const runApi = (region: string) =>
    inSandbox('docker', 'run', '-d', '--name', 'statements-api',
      '-e', `STATEMENTS_REGION=${region}`, 'alpine:3.20', 'sh', '-c', API_CMD);
  const runWorker = (url?: string) =>
    inSandbox('docker', 'run', '-d', '--name', 'statements-worker',
      ...(url ? ['-e', `STATEMENTS_API_URL=${url}`] : []),
      'alpine:3.20', 'sh', '-c', WORKER_CMD);

  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'docker', 'docker-011-inspect-exec-logs', 'lab.yaml'),
    );
    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-it11-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    provider = new DockerLabProvider({
      engines,
      workspace,
      hostName: 'integration-011',
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

  it('provisions the sandbox and seeds the incident', async () => {
    let result = await provider.create(context());
    if (!result.ok && /timeout|TLS handshake|i\/o timeout/i.test(result.error?.message ?? '')) {
      await provider.destroy(context());
      result = await provider.create(context());
    }
    expect(result.error?.message ?? '').toBe('');
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);

    // The api is up. The worker is not — and `docker ps` alone would hide it,
    // which is the lesson the second fault exists to teach.
    const running = (await inSandbox('docker', 'ps', '--format', '{{.Names}}')).stdout.trim();
    expect(running).toBe('statements-api');
    const all = (await inSandbox('docker', 'ps', '-a', '--format', '{{.Names}}')).stdout
      .split('\n').map((s) => s.trim()).filter(Boolean).sort();
    expect(all).toEqual(['statements-api', 'statements-worker']);
  }, 900_000);

  it('the incident is real: the application wrote a degraded verdict and warned', async () => {
    expect(await state('statements-api', '{{.State.Status}}')).toBe('running');
    const logs = await inSandbox('docker', 'logs', 'statements-api');
    expect(`${logs.stdout}${logs.stderr}`).toContain('no ledger shard for region us-east-1');

    // What the student finds with `docker exec`.
    const status = await inSandbox('docker', 'exec', 'statements-api', 'cat', '/var/run/statements/status');
    expect(status.stdout.trim()).toBe('degraded: region=us-east-1');
    const regions = await inSandbox('docker', 'exec', 'statements-api', 'cat', '/etc/statements/regions.conf');
    expect(regions.stdout).toContain('supported_regions=eu-west-1');

    expect(await state('statements-worker', '{{.State.Status}} {{.State.ExitCode}}')).toBe('exited 78');
    const workerLogs = await inSandbox('docker', 'logs', 'statements-worker');
    expect(`${workerLogs.stdout}${workerLogs.stderr}`).toContain('STATEMENTS_API_URL is not set');
  }, 300_000);

  it('the unsolved lab fails exactly the four checks it should', async () => {
    const before = await verify();
    expect(before.passed).toBe(false);
    expect(before.checks).toHaveLength(5);
    // "statements-api is running" legitimately passes — it is running, and
    // wrong, which is the whole incident.
    expect(failing(before).sort()).toEqual([
      'Container statements-worker is running',
      'statements-api is configured for a region that has a ledger shard',
      'statements-api reports itself ready rather than degraded',
      'statements-worker knows how to reach the API',
    ].sort());
  }, 300_000);

  // ---------------------------------------------- the primitive, for real

  it('reads the status file out of a RUNNING container through the archive endpoint', async () => {
    // The check passed nothing and executed nothing inside the container; it
    // read /var/run/statements/status and compared it.
    const degraded = await verify();
    const fileCheck = degraded.checks.find((c) => c.label.includes('reports itself ready'));
    expect(fileCheck?.status).toBe('fail');
    expect(fileCheck?.detail).toContain('does not match what the lab expects');
  }, 300_000);

  it('reads a file out of a STOPPED container, which exec could not do', async () => {
    // statements-worker is exited. Its filesystem is still readable.
    const read = await engines
      .session(SANDBOX)
      .copyFileFromContainer('statements-worker', '/etc/alpine-release');
    expect(read).not.toBeNull();
    expect(read?.content.toString('utf8').trim()).toMatch(/^3\.20/);
    expect(await state('statements-worker', '{{.State.Status}}')).toBe('exited');
  }, 300_000);

  it('returns null for a missing file and a missing container, and refuses a directory', async () => {
    const session = engines.session(SANDBOX);
    expect(await session.copyFileFromContainer('statements-api', '/no/such/file')).toBeNull();
    expect(await session.copyFileFromContainer('no-such-container', '/etc/hostname')).toBeNull();
    await expect(session.copyFileFromContainer('statements-api', '/etc/statements')).rejects.toThrow(
      /directory/i,
    );
  }, 300_000);

  it('never discloses the expected value or the file content in a failing result', async () => {
    const result = await verify();
    const body = JSON.stringify(result);
    expect(body).not.toContain('ready: region=eu-west-1');
    expect(body).not.toContain('degraded: region=us-east-1');
  }, 300_000);

  // -------------------------------------------------------------- repairs

  it('fixing only the environment is not enough until the application agrees', async () => {
    // A student who edits the status file by hand but leaves the region wrong
    // fails the environment check; one who fixes the region passes both,
    // because the application rewrites the file on start.
    await rmInSandbox('statements-api');
    expect((await runApi('us-east-1')).code).toBe(0);
    await inSandbox('docker', 'exec', 'statements-api', 'sh', '-c',
      'printf "ready: region=eu-west-1\\n" > /var/run/statements/status');

    const forged = await verify();
    expect(forged.passed).toBe(false);
    expect(failing(forged)).toContain(
      'statements-api is configured for a region that has a ledger shard',
    );
    // The forged file does satisfy its own check — which is why the lab grades
    // the environment as well. Neither check alone would be enough.
    expect(failing(forged)).not.toContain('statements-api reports itself ready rather than degraded');
  }, 300_000);

  it('both correct repairs pass the lab', async () => {
    await rmInSandbox('statements-api', 'statements-worker');
    expect((await runApi('eu-west-1')).code).toBe(0);
    expect((await runWorker('http://statements-api')).code).toBe(0);

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  }, 600_000);

  it('an equivalent repair with a different command still passes', async () => {
    // The lab grades state, not how it was reached: a student who writes the
    // status file from their own command passes if the state is right.
    await rmInSandbox('statements-api');
    expect(
      (await inSandbox('docker', 'run', '-d', '--name', 'statements-api',
        '-e', 'STATEMENTS_REGION=eu-west-1', 'alpine:3.20', 'sh', '-c',
        'mkdir -p /var/run/statements; printf "ready: region=%s\\n" "$STATEMENTS_REGION" > /var/run/statements/status; exec sleep 3600')).code,
    ).toBe(0);

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
  }, 300_000);

  it('the worker still fails when its URL is wrong rather than missing', async () => {
    await rmInSandbox('statements-worker');
    expect((await runWorker('http://wrong-host')).code).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['statements-worker knows how to reach the API']);
  }, 300_000);

  // ---------------------------------------------------------------- reset

  it('reset restores the incident exactly as it started', async () => {
    await rmInSandbox('statements-worker');
    expect((await runWorker('http://statements-api')).code).toBe(0);
    expect((await verify()).passed).toBe(true);

    const reset = await provider.reset(context());
    expect(reset.error?.message ?? '').toBe('');
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    expect(await state('statements-api', '{{.State.Status}}')).toBe('running');
    expect(await state('statements-worker', '{{.State.Status}} {{.State.ExitCode}}')).toBe('exited 78');
    const status = await inSandbox('docker', 'exec', 'statements-api', 'cat', '/var/run/statements/status');
    expect(status.stdout.trim()).toBe('degraded: region=us-east-1');

    const after = await verify();
    expect(after.passed).toBe(false);
  }, 900_000);
});
