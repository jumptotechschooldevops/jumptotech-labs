/**
 * DOCKER-012 production validation against a REAL `docker:27-dind` sandbox.
 *
 * The fake daemon can model a port binding. What it cannot model is the thing
 * this lab teaches: that the daemon *refuses* the second bind. A host-port
 * collision is enforced by the kernel and the daemon's port allocator, so the
 * incident is either real here or it is not real at all.
 *
 * The sequence proved below is the lab's whole story:
 *
 *     ledger-web binds host 8080
 *          -> statements-web attempts host 8080 -> DAEMON REFUSES
 *          -> statements-web recreated on host 8081
 *          -> both running, both listening on container port 80
 *
 * NOT proved here, and not claimed anywhere: that an HTTP request to 8080 or
 * 8081 returns a page. This lab verifies port *bindings*. Reachability needs an
 * executor design that is DESIGNED / NOT APPROVED.
 *
 * Skipped unless RUN_DOCKER_INTEGRATION_TESTS=1:
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker012-integration.test.ts --root services/lab-orchestrator
 *
 * ---------------------------------------------------------------------------
 * SAFETY — runs against a developer's own Docker daemon.
 *
 * Every host object carries this run's random token, and every destructive host
 * call passes through `owned()`. The published ports live on the *sandbox's*
 * daemon, not the developer's, so 8080 here is not the host's 8080.
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
  console.log('[docker012-integration] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1');
}

const RUN = randomBytes(4).toString('hex');
const SANDBOX = `jtt-lab-${RUN}12`;
const SANDBOX_OTHER = `jtt-lab-${RUN}13`;
const TEST_NETWORK = `jtt-it12-${RUN}-net`;
const SESSION = `sess-${randomBytes(8).toString('hex')}`;
const SESSION_OTHER = `sess-${randomBytes(8).toString('hex')}`;

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

suite('DOCKER-012 against a real docker:27-dind sandbox', () => {
  const engines = new DockerCliFactory({});
  let workspaceRoot: string;
  let workspace: TempDirWorkspace;
  let provider: DockerLabProvider;
  let lab: LoadedLabDefinition;

  const inSandbox = (...args: string[]) => docker('exec', SANDBOX, ...args);
  const inOther = (...args: string[]) => docker('exec', SANDBOX_OTHER, ...args);

  const verify = (sandbox = SANDBOX) =>
    verifyLab({
      lab,
      namespace: sandbox,
      docker: engines.session(sandbox),
      workspace: { port: workspace, sessionId: SESSION },
    });

  const failing = (r: Awaited<ReturnType<typeof verify>>) =>
    r.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  const state = async (name: string, format: string) =>
    (await inSandbox('docker', 'inspect', name, '--format', format)).stdout.trim();

  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'docker', 'docker-012-publish-ports', 'lab.yaml'),
    );
    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-it12-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    provider = new DockerLabProvider({
      engines,
      workspace,
      hostName: 'integration-012',
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
    for (const sandbox of [SANDBOX, SANDBOX_OTHER]) {
      await docker('rm', '--force', '--volumes', owned(sandbox));
      await docker('volume', 'rm', '--force', owned(DockerLabProvider.dataVolume(sandbox)));
    }
    await docker('network', 'rm', owned(TEST_NETWORK));
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }, 300_000);

  const context = (sandbox = SANDBOX, sessionId = SESSION): LabSessionContext => ({
    sessionId,
    labId: lab.id,
    namespace: sandbox,
    serviceAccountName: POLICY.serviceAccountName,
    lab,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: POLICY,
  });

  /**
   * Provision, retrying a registry failure.
   *
   * Each sandbox has its own image store, so every one of them pulls
   * `nginx:1.27-alpine` from Docker Hub — and Hub occasionally times out its
   * TLS handshake. That is a registry hiccup, not a provisioning defect, so it
   * is retried rather than reported as one. Anything else fails immediately.
   */
  async function createWithRetry(ctx: LabSessionContext, attempts = 3) {
    let result = await provider.create(ctx);
    for (let attempt = 1; attempt < attempts && !result.ok; attempt += 1) {
      const message = result.error?.message ?? '';
      if (!/could not obtain image|timeout|TLS handshake|i\/o timeout/i.test(message)) break;
      await provider.destroy(ctx);
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      result = await provider.create(ctx);
    }
    return result;
  }

  // ------------------------------------------------------------- seeding

  it('provisions, and the seeding order really does hand 8080 to ledger-web', async () => {
    const result = await createWithRetry(context());
    expect(result.error?.message ?? '').toBe('');
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);

    // Only the production service is up, and it holds the contested port.
    const running = (await inSandbox('docker', 'ps', '--format', '{{.Names}}')).stdout.trim();
    expect(running).toBe('ledger-web');
    expect(await state('ledger-web', '{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}')).toBe('8080');

    // The failed deployment is present but stopped, and still *asks* for 8080 —
    // which is what the student finds by inspecting it.
    const all = (await inSandbox('docker', 'ps', '-a', '--format', '{{.Names}}')).stdout
      .split('\n').map((s) => s.trim()).filter(Boolean).sort();
    expect(all).toEqual(['ledger-web', 'statements-web']);
    expect(await state('statements-web', '{{.State.Running}}')).toBe('false');
    expect(
      await state('statements-web', '{{(index .HostConfig.PortBindings "80/tcp" 0).HostPort}}'),
    ).toBe('8080');
    // A stopped container holds no live binding, so it is not occupying 8080.
    expect(await state('statements-web', '{{len .NetworkSettings.Ports}}')).toBe('0');
  }, 900_000);

  // ----------------------------------------------------- the collision

  it('THE INCIDENT: starting the second service is refused, and 8080 stays with the first', async () => {
    const start = await inSandbox('docker', 'start', 'statements-web');
    expect(start.code, 'the daemon must refuse the second bind').not.toBe(0);
    expect(`${start.stdout}${start.stderr}`.toLowerCase()).toMatch(
      /already (in use|allocated)|address already in use|external connectivity/,
    );

    // Production is untouched by the failed attempt.
    expect(await state('ledger-web', '{{.State.Running}}')).toBe('true');
    expect(await state('ledger-web', '{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}')).toBe('8080');
    expect(await state('statements-web', '{{.State.Running}}')).toBe('false');
  }, 300_000);

  it('the unsolved lab fails exactly the two checks it should', async () => {
    const before = await verify();
    expect(before.passed).toBe(false);
    expect(before.checks).toHaveLength(6);
    // ledger-web is correct already; only the second service is outstanding.
    expect(failing(before).sort()).toEqual([
      'Container statements-web is running',
      'statements-web publishes container port 80 on host port 8081',
    ].sort());
  }, 300_000);

  // ----------------------------------------------------------- the fix

  it('the fix: a different host port lets both run, sharing container port 80', async () => {
    await inSandbox('docker', 'rm', '--force', 'statements-web');
    const run = await inSandbox('docker', 'run', '-d', '--name', 'statements-web',
      '-p', '8081:80', 'nginx:1.27-alpine');
    expect(run.code, run.stderr).toBe(0);

    // The architecture the lab asks for: same container port, different hosts.
    expect(await state('ledger-web', '{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}')).toBe('8080');
    expect(await state('statements-web', '{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}')).toBe('8081');

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  }, 600_000);

  // --------------------------------------------------------- adversarial

  it('EXPOSE without publishing does not satisfy the check, on a real daemon', async () => {
    // nginx's own Dockerfile EXPOSEs 80. Running it with no -p leaves the port
    // declared and unpublished — exactly the case the lab warns about.
    await inSandbox('docker', 'rm', '--force', 'statements-web');
    expect(
      (await inSandbox('docker', 'run', '-d', '--name', 'statements-web', 'nginx:1.27-alpine')).code,
    ).toBe(0);
    expect(await state('statements-web', '{{json .NetworkSettings.Ports}}')).toBe('{"80/tcp":null}');

    const result = await verify();
    expect(result.passed).toBe(false);
    const portCheck = result.checks.find((c) => c.label.includes('8081'));
    expect(portCheck?.status).toBe('fail');
    expect(portCheck?.detail).toContain('does not publish it to a host port');
  }, 300_000);

  it('stopping production to free 8080 does not pass', async () => {
    await inSandbox('docker', 'rm', '--force', 'statements-web');
    await inSandbox('docker', 'stop', '-t', '2', 'ledger-web');
    expect(
      (await inSandbox('docker', 'run', '-d', '--name', 'statements-web', '-p', '8080:80',
        'nginx:1.27-alpine')).code,
    ).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('Container ledger-web is still running');

    // Put production back for the tests that follow.
    await inSandbox('docker', 'rm', '--force', 'statements-web');
    expect((await inSandbox('docker', 'start', 'ledger-web')).code).toBe(0);
  }, 600_000);

  it('an alternate creation workflow reaches the same graded state', async () => {
    // `docker create` + `docker start` rather than `docker run`. Same bindings,
    // so the same verdict — the checks read state, not commands.
    await inSandbox('docker', 'rm', '--force', 'statements-web');
    expect(
      (await inSandbox('docker', 'create', '--name', 'statements-web', '-p', '8081:80',
        'nginx:1.27-alpine')).code,
    ).toBe(0);
    expect((await inSandbox('docker', 'start', 'statements-web')).code).toBe(0);

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
  }, 600_000);

  // ------------------------------------------------------------ isolation

  it('one session\'s published ports do not exist in another session', async () => {
    // A second sandbox, provisioned from the same lab. Its daemon publishes its
    // own 8080 — inside its own network namespace, with no relation to the
    // first sandbox's 8080 and no conflict between them.
    const other = await createWithRetry(context(SANDBOX_OTHER, SESSION_OTHER));
    expect(other.error?.message ?? '').toBe('');
    expect(other.ok, JSON.stringify(other.steps)).toBe(true);

    // Both sandboxes hold a container bound to 8080 at the same time.
    const mine = await inSandbox('docker', 'inspect', 'ledger-web', '--format',
      '{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}');
    const theirs = await inOther('docker', 'inspect', 'ledger-web', '--format',
      '{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}');
    expect(mine.stdout.trim()).toBe('8080');
    expect(theirs.stdout.trim()).toBe('8080');

    // The first session solved it; the second has done nothing and must fail.
    expect((await verify(SANDBOX)).passed).toBe(true);
    const otherResult = await verify(SANDBOX_OTHER);
    expect(otherResult.passed).toBe(false);
    expect(failing(otherResult)).toContain('Container statements-web is running');
  }, 900_000);

  // ---------------------------------------------------------------- reset

  it('reset restores the incident, including the still-conflicting configuration', async () => {
    expect((await verify()).passed).toBe(true);

    const reset = await provider.reset(context());
    expect(reset.error?.message ?? '').toBe('');
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    expect(await state('ledger-web', '{{.State.Running}}')).toBe('true');
    expect(await state('ledger-web', '{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}')).toBe('8080');
    expect(await state('statements-web', '{{.State.Running}}')).toBe('false');
    expect(
      await state('statements-web', '{{(index .HostConfig.PortBindings "80/tcp" 0).HostPort}}'),
    ).toBe('8080');

    const after = await verify();
    expect(after.passed).toBe(false);
    expect(failing(after)).toHaveLength(2);
  }, 900_000);

  /*
   * Sandbox teardown is deliberately NOT re-tested here. `docker-integration.
   * test.ts` already proves it twice — "destroys a sandbox, its data volume,
   * and everything inside it" and "leaves nothing of a destroyed session behind
   * on the host" — and duplicating it here only added a second chance to hit
   * the containerd condition where a privileged dind container refuses to die
   * ("could not kill container: did not receive an exit event") on a loaded
   * host. That flake is tracked centrally as DOCKER-CT-3. This suite's
   * `afterAll` still removes everything it created.
   */
});
