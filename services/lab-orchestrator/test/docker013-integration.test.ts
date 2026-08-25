/**
 * DOCKER-013 production validation against a REAL `docker:27-dind` sandbox.
 *
 * This is the suite the primitive was built for, and it is the only place the
 * central claim can be tested: that comparing two images' ordered
 * `RootFS.Layers` actually distinguishes a cache-friendly Dockerfile from a
 * cache-hostile one. Docker's build cache decides which digests are reused, so
 * either the daemon demonstrates it here or the check is guesswork.
 *
 * Three scenarios are measured, all with real builds:
 *
 *   friendly + source-only change   -> the dependency layers survive
 *   hostile   + source-only change  -> they do not
 *   friendly + dependency change    -> they correctly do NOT survive
 *
 * The third matters as much as the first two: the lab must not reward a
 * student for keeping a dependency layer that *should* have been invalidated.
 *
 * Skipped unless RUN_DOCKER_INTEGRATION_TESTS=1:
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker013-integration.test.ts --root services/lab-orchestrator
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
  asTerminalContext,
  loadLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
  type SessionPolicy,
  type TerminalContext,
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
  console.log('[docker013-integration] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1');
}

const RUN = randomBytes(4).toString('hex');
const SANDBOX_A = `jtt-lab-${RUN}13`;
const SANDBOX_B = `jtt-lab-${RUN}17`;
const TEST_NETWORK = `jtt-it13-${RUN}-net`;
const SESSION_A = `sess-${randomBytes(8).toString('hex')}`;
const SESSION_B = `sess-${randomBytes(8).toString('hex')}`;

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
  async write(sessionId: string, filePath: string, content: string): Promise<void> {
    const dir = this.#dir(sessionId);
    await mkdir(path.dirname(path.join(dir, filePath)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, filePath), content, { mode: 0o600 });
  }
  async destroy(sessionId: string): Promise<void> {
    await rm(this.#dir(sessionId), { recursive: true, force: true });
  }
}

/** The repair: manifest, then the dependency step, then the volatile source. */
const FRIENDLY_DOCKERFILE = [
  'FROM alpine:3.20',
  'WORKDIR /app',
  'COPY requirements.txt /app/requirements.txt',
  'RUN sort /app/requirements.txt > /app/.installed',
  'COPY src /app/src',
  'CMD ["/bin/sh", "/app/src/greeter.sh"]',
  '',
].join('\n');

/** The seeded original: everything copied before the expensive step. */
const HOSTILE_DOCKERFILE = [
  'FROM alpine:3.20',
  'WORKDIR /app',
  'COPY . /app',
  'RUN sort /app/requirements.txt > /app/.installed',
  'CMD ["/bin/sh", "/app/src/greeter.sh"]',
  '',
].join('\n');

const REQUIREMENTS_V1 = 'greeter-core==1.4.0\ngreeter-format==0.9.2\n';
const REQUIREMENTS_V2 = 'greeter-core==1.5.0\ngreeter-format==0.9.2\n';
const SOURCE_V1 = '#!/bin/sh\necho "greeter: hello from JumpToTech Bank"\n';
const SOURCE_V2 = '#!/bin/sh\necho "greeter: hello again from JumpToTech Bank"\n';

suite('DOCKER-013 against a real docker:27-dind sandbox', () => {
  const engines = new DockerCliFactory({});
  let workspaceRoot: string;
  let workspace: TempDirWorkspace;
  let provider: DockerLabProvider;
  let lab: LoadedLabDefinition;

  const asDockerContext = (context: TerminalContext) => asTerminalContext(context, 'docker-daemon');

  const context = (sandbox = SANDBOX_A, sessionId = SESSION_A): LabSessionContext => ({
    sessionId,
    labId: lab.id,
    namespace: sandbox,
    serviceAccountName: POLICY.serviceAccountName,
    lab,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: POLICY,
  });

  const verify = (sandbox = SANDBOX_A, sessionId = SESSION_A) =>
    verifyLab({
      lab,
      namespace: sandbox,
      docker: engines.session(sandbox),
      workspace: { port: workspace, sessionId },
    });

  const failing = (r: Awaited<ReturnType<typeof verify>>) =>
    r.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  /** Run a command as the student does: Docker CLI over mTLS, files in place. */
  async function asStudent(
    sandbox: string,
    sessionId: string,
    files: Record<string, string>,
    command: string,
  ): Promise<Cmd> {
    const credentials = asDockerContext(await provider.getTerminalContext(context(sandbox, sessionId)));
    const writeFiles = Object.keys(files)
      .map((name, index) => `mkdir -p "$(dirname /workspace/${name})" && printf %s "$FILE_${index}" > /workspace/${name}`)
      .join(' && ');

    return docker(
      'run', '--rm',
      '--network', TEST_NETWORK,
      '--env', `CA_PEM=${credentials.ca}`,
      '--env', `CERT_PEM=${credentials.clientCert}`,
      '--env', `KEY_PEM=${credentials.clientKey}`,
      ...Object.values(files).flatMap((content, index) => ['--env', `FILE_${index}=${content}`]),
      '--env', `DOCKER_HOST=tcp://${sandbox}:${POLICY.docker.daemonPort}`,
      '--env', 'DOCKER_TLS_VERIFY=1',
      '--env', 'DOCKER_CERT_PATH=/certs',
      '--env', 'DOCKER_BUILDKIT=0',
      '--entrypoint', 'sh',
      POLICY.docker.image.replace(/-dind$/, '-cli'),
      '-c',
      'mkdir -p /certs /workspace/src' +
        ' && printf %s "$CA_PEM" > /certs/ca.pem' +
        ' && printf %s "$CERT_PEM" > /certs/cert.pem' +
        ' && printf %s "$KEY_PEM" > /certs/key.pem' +
        ` && ${writeFiles}` +
        ` && cd /workspace && ${command}`,
    );
  }

  /**
   * Two builds with one change between them, exactly as the lab describes.
   *
   * Returns the two images' layer arrays, read back through the platform's own
   * path rather than from anything the build printed.
   */
  async function twoBuilds(options: {
    dockerfile: string;
    change: 'source' | 'dependency' | 'nothing';
    sandbox?: string;
    sessionId?: string;
    tagBefore?: string;
    tagAfter?: string;
  }) {
    const sandbox = options.sandbox ?? SANDBOX_A;
    const sessionId = options.sessionId ?? SESSION_A;
    const before = options.tagBefore ?? 'jumptotech/greeter:1.0';
    const after = options.tagAfter ?? 'jumptotech/greeter:1.1';

    const first = await asStudent(
      sandbox,
      sessionId,
      { Dockerfile: options.dockerfile, 'requirements.txt': REQUIREMENTS_V1, 'src/greeter.sh': SOURCE_V1 },
      `docker build --tag ${before} .`,
    );
    expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);

    const changed = {
      Dockerfile: options.dockerfile,
      'requirements.txt': options.change === 'dependency' ? REQUIREMENTS_V2 : REQUIREMENTS_V1,
      'src/greeter.sh': options.change === 'source' ? SOURCE_V2 : SOURCE_V1,
    };
    const second = await asStudent(sandbox, sessionId, changed, `docker build --tag ${after} .`);
    expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);

    await workspace.write(sessionId, 'Dockerfile', options.dockerfile);

    const session = engines.session(sandbox);
    const beforeImage = await session.inspectImage(before);
    const afterImage = await session.inspectImage(after);
    return { beforeLayers: beforeImage?.layers ?? [], afterLayers: afterImage?.layers ?? [] };
  }

  const sharedPrefix = (a: string[], b: string[]) => {
    let n = 0;
    while (n < Math.min(a.length, b.length) && a[n] === b[n]) n += 1;
    return n;
  };

  /** Run the rebuilt image once so the lab's runtime checks are satisfied. */
  const runGreeter = (sandbox = SANDBOX_A) =>
    docker('exec', sandbox, 'docker', 'run', '--name', 'greeter', 'jumptotech/greeter:1.1');

  async function createWithRetry(ctx: LabSessionContext, attempts = 3) {
    let result = await provider.create(ctx);
    for (let attempt = 1; attempt < attempts && !result.ok; attempt += 1) {
      if (!/could not obtain image|timeout|TLS handshake|i\/o timeout/i.test(result.error?.message ?? '')) break;
      await provider.destroy(ctx);
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      result = await provider.create(ctx);
    }
    return result;
  }

  const clean = (sandbox = SANDBOX_A) =>
    docker('exec', sandbox, 'sh', '-c',
      'docker rm -f greeter >/dev/null 2>&1; docker rmi -f jumptotech/greeter:1.0 jumptotech/greeter:1.1 >/dev/null 2>&1; true');

  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'docker', 'docker-013-layers-build-cache', 'lab.yaml'),
    );
    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-it13-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    provider = new DockerLabProvider({
      engines,
      workspace,
      hostName: 'integration-013',
      waitForRequirements: (input) =>
        waitForRequirements({
          docker: engines.session(input.namespace),
          workspace: { port: workspace, sessionId: SESSION_A },
          ...input,
        }),
    });
    for (const image of [POLICY.docker.image, POLICY.docker.image.replace(/-dind$/, '-cli')]) {
      const pull = await docker('image', 'pull', image);
      expect(pull.code, pull.stderr).toBe(0);
    }
  }, 900_000);

  afterAll(async () => {
    for (const sandbox of [SANDBOX_A, SANDBOX_B]) {
      await docker('rm', '--force', '--volumes', owned(sandbox));
      await docker('volume', 'rm', '--force', owned(DockerLabProvider.dataVolume(sandbox)));
    }
    await docker('network', 'rm', owned(TEST_NETWORK));
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }, 300_000);

  // ------------------------------------------------------------ START

  it('START: provisions with the cache-hostile Dockerfile, and the lab fails', async () => {
    const result = await createWithRetry(context());
    expect(result.error?.message ?? '').toBe('');
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);

    // The seeded Dockerfile is the broken one.
    expect(await workspace.read(SESSION_A, 'Dockerfile')).toContain('COPY . /app');
    expect(await workspace.read(SESSION_A, 'requirements.txt')).toContain('greeter-core');

    const before = await verify();
    expect(before.passed).toBe(false);
    expect(before.checks).toHaveLength(7);
  }, 900_000);

  // ----------------------------------------- the three measured scenarios

  it('MEASURES the cache-friendly rebuild: only the source layer changes', async () => {
    await clean();
    const { beforeLayers, afterLayers } = await twoBuilds({
      dockerfile: FRIENDLY_DOCKERFILE,
      change: 'source',
    });
    const shared = sharedPrefix(beforeLayers, afterLayers);
    const changed = afterLayers.length - shared;

    expect(beforeLayers.length).toBeGreaterThan(0);
    expect(changed, 'a source-only change must rebuild exactly one layer').toBe(1);
    expect(shared).toBeGreaterThanOrEqual(3);
  }, 900_000);

  it('MEASURES the cache-hostile rebuild: the dependency step is rebuilt too', async () => {
    await clean();
    const { beforeLayers, afterLayers } = await twoBuilds({
      dockerfile: HOSTILE_DOCKERFILE,
      change: 'source',
    });
    const shared = sharedPrefix(beforeLayers, afterLayers);
    const changed = afterLayers.length - shared;

    // The reason layer COUNT was rejected: the hostile image is SMALLER.
    expect(changed, 'a source change must invalidate the dependency step too').toBeGreaterThan(1);
    expect(afterLayers.length).toBeLessThanOrEqual(5);
  }, 900_000);

  it('MEASURES a dependency change: the dependency layer is legitimately invalidated', async () => {
    await clean();
    const { beforeLayers, afterLayers } = await twoBuilds({
      dockerfile: FRIENDLY_DOCKERFILE,
      change: 'dependency',
    });
    const changed = afterLayers.length - sharedPrefix(beforeLayers, afterLayers);
    // Editing requirements.txt SHOULD rebuild the install and everything after.
    expect(changed).toBeGreaterThan(1);
  }, 900_000);

  // ------------------------------------------------------------- SOLVE

  it('SOLVE: the repaired Dockerfile plus a source-only rebuild passes', async () => {
    await clean();
    await twoBuilds({ dockerfile: FRIENDLY_DOCKERFILE, change: 'source' });
    expect((await runGreeter()).code).toBe(0);

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  }, 900_000);

  // ------------------------------------------------------------- BREAK

  it('BREAK: rebuilding with the hostile ordering fails again', async () => {
    await clean();
    await twoBuilds({ dockerfile: HOSTILE_DOCKERFILE, change: 'source' });
    expect((await runGreeter()).code).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['The source-only rebuild reused the dependency layers']);
  }, 900_000);

  // ---------------------------------------------------------- adversarial

  it('two identical builds with no change at all do not pass', async () => {
    await clean();
    await twoBuilds({ dockerfile: FRIENDLY_DOCKERFILE, change: 'nothing' });
    expect((await runGreeter()).code).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(
      result.checks.find((c) => c.label.includes('reused the dependency layers'))?.detail,
    ).toContain('same image');
  }, 900_000);

  it('changing the dependency manifest instead of the source does not pass', async () => {
    await clean();
    await twoBuilds({ dockerfile: FRIENDLY_DOCKERFILE, change: 'dependency' });
    expect((await runGreeter()).code).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('The source-only rebuild reused the dependency layers');
  }, 900_000);

  it('fake evidence in the workspace changes nothing', async () => {
    await clean();
    await twoBuilds({ dockerfile: HOSTILE_DOCKERFILE, change: 'source' });
    await runGreeter();
    await workspace.write(SESSION_A, 'layers.json', '{"shared":4,"cached":true}');
    await workspace.write(SESSION_A, 'history.txt', 'CACHED COPY requirements.txt\nCACHED RUN sort');

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('The source-only rebuild reused the dependency layers');
  }, 900_000);

  // ------------------------------------------------------------- RESET

  it('RESET: restores the hostile Dockerfile and removes both built images', async () => {
    // Get to a passing state first.
    await clean();
    await twoBuilds({ dockerfile: FRIENDLY_DOCKERFILE, change: 'source' });
    expect((await runGreeter()).code).toBe(0);
    expect((await verify()).passed).toBe(true);

    const reset = await provider.reset(context());
    expect(reset.error?.message ?? '').toBe('');
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    const session = engines.session(SANDBOX_A);
    expect(await session.inspectImage('jumptotech/greeter:1.0')).toBeNull();
    expect(await session.inspectImage('jumptotech/greeter:1.1')).toBeNull();
    expect(await session.inspectImage('alpine:3.20')).not.toBeNull();
    expect(await workspace.read(SESSION_A, 'Dockerfile')).toContain('COPY . /app');

    const after = await verify();
    expect(after.passed).toBe(false);
  }, 900_000);

  it('SOLVE AGAIN: the same repair passes from the restored state', async () => {
    await twoBuilds({ dockerfile: FRIENDLY_DOCKERFILE, change: 'source' });
    expect((await runGreeter()).code).toBe(0);

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
  }, 900_000);

  // ------------------------------------------------------------ isolation

  it('session A cannot pass because session B built the correct images', async () => {
    const other = await createWithRetry(context(SANDBOX_B, SESSION_B));
    expect(other.error?.message ?? '').toBe('');
    expect(other.ok, JSON.stringify(other.steps)).toBe(true);

    // A is left broken; B does it properly.
    await clean(SANDBOX_A);
    await twoBuilds({ dockerfile: HOSTILE_DOCKERFILE, change: 'source' });
    await runGreeter(SANDBOX_A);

    await twoBuilds({
      dockerfile: FRIENDLY_DOCKERFILE,
      change: 'source',
      sandbox: SANDBOX_B,
      sessionId: SESSION_B,
    });
    expect((await runGreeter(SANDBOX_B)).code).toBe(0);

    expect((await verify(SANDBOX_B, SESSION_B)).passed).toBe(true);
    expect((await verify(SANDBOX_A, SESSION_A)).passed).toBe(false);

    // B's images are not in A's store at all.
    expect(await engines.session(SANDBOX_A).inspectImage('jumptotech/greeter:1.1')).not.toBeNull();
    const aLayers = (await engines.session(SANDBOX_A).inspectImage('jumptotech/greeter:1.1'))?.layers ?? [];
    const bLayers = (await engines.session(SANDBOX_B).inspectImage('jumptotech/greeter:1.1'))?.layers ?? [];
    expect(aLayers).not.toEqual(bLayers);
  }, 900_000);
});
