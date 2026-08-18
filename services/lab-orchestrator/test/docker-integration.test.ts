/**
 * Integration tests against a REAL Docker daemon.
 *
 * These exist for the same reason the kind suite does: the properties this
 * track claims are properties of *Docker*, not of our code. Whether two
 * sandboxes genuinely have separate image stores, whether one session's client
 * certificate is actually rejected by another session's daemon, whether
 * `--memory` is actually enforced, whether a missing object actually reads back
 * as "missing" rather than as an error — a fake that returned the right answer
 * would prove none of it. Nothing in this file is faked.
 *
 * Skipped unless RUN_DOCKER_INTEGRATION_TESTS=1, so `npm test` stays hermetic:
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker-integration.test.ts --root services/lab-orchestrator
 *
 * It needs a Docker daemon that permits privileged containers (Docker-in-Docker
 * requires it) and enough disk for one `docker:dind` image plus two sandbox data
 * volumes. Expect the first run to spend a few minutes pulling images;
 * subsequent runs are much faster.
 *
 * ---------------------------------------------------------------------------
 * SAFETY — this suite runs against a developer's own Docker daemon.
 *
 * Every object it creates carries a per-run random token (`RUN`), and every
 * destructive call passes through `owned()`, which throws on any name that does
 * not carry that token. There is no prune, no wildcard removal, and no "delete
 * everything labelled managed": a developer's existing containers, images,
 * volumes, and networks are never touched, and a crashed run leaves behind
 * objects an operator can identify by that token.
 * ---------------------------------------------------------------------------
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
  LAB_LABEL,
  MANAGED_LABEL,
  MANAGED_SELECTOR,
  SANDBOX_LABELS,
  SESSION_LABEL,
  asTerminalContext,
  type TerminalContext,
  loadLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
  type SessionPolicy,
  type WorkspaceFile,
  type WorkspacePort,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';
import { DOCKER_001_PATH, LABS_DIR } from './helpers.js';

/** The Docker variant of the terminal binding, or a loud failure. */
function asDockerContext(context: TerminalContext) {
  return asTerminalContext(context, 'docker-daemon');
}


const execFileAsync = promisify(execFile);

const enabled = process.env.RUN_DOCKER_INTEGRATION_TESTS === '1';
const suite = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    '[docker-integration] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1 to run against a real Docker daemon',
  );
}

/**
 * Per-run token. Nothing without it is ever removed.
 *
 * Sandbox names are real `lab-<label>` names, because `isLabNamespace` gates
 * every destructive call and a test that bypassed that gate would not be
 * exercising the production path.
 */
const RUN = randomBytes(4).toString('hex');
const SANDBOX_A = `jtt-lab-${RUN}aa`;
const SANDBOX_B = `jtt-lab-${RUN}bb`;
/** A `jtt-lab-`-shaped container the platform did NOT create, for the refusal test. */
const DECOY = `jtt-lab-${RUN}cc`;
/** A managed, lab-named container belonging to a *different* platform component. */
const IMPOSTOR = `jtt-lab-${RUN}dd`;
const TEST_NETWORK = `jtt-it-${RUN}-net`;
const SESSION_A = `sess-${randomBytes(8).toString('hex')}`;
const SESSION_B = `sess-${randomBytes(8).toString('hex')}`;

/**
 * The one gate every destructive call in this file passes through.
 *
 * A name without this run's token is a bug in the test, not something to clean
 * up — so it throws loudly rather than quietly skipping.
 */
function owned(name: string): string {
  if (!name.includes(RUN)) {
    throw new Error(
      `refusing to remove Docker object '${name}': it was not created by this test run (${RUN})`,
    );
  }
  return name;
}

const POLICY: SessionPolicy = {
  ...DEFAULT_SESSION_POLICY,
  docker: {
    ...DEFAULT_SESSION_POLICY.docker,
    network: TEST_NETWORK,
    // Small enough to be cheap, large enough for dind to actually start.
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

/** Run docker on the host. Never throws — the exit code is data. */
async function docker(...args: string[]): Promise<Cmd> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

/** Run a command inside a sandbox, as the platform's orchestrator does. */
const inSandbox = (sandbox: string, ...args: string[]) => docker('exec', sandbox, ...args);

/**
 * `WorkspacePort` over a real directory on disk.
 *
 * Production puts this in the terminal container (`services/terminal/src/
 * workspace.ts`) and reaches it over an authenticated internal call. What
 * matters here is that `file_exists` and `dockerfile_valid` grade a file that
 * genuinely exists on a filesystem, rather than an entry in a map.
 */
class TempDirWorkspace implements WorkspacePort {
  constructor(private readonly root: string) {}

  #dir(sessionId: string): string {
    return path.join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, ''));
  }

  async seed(sessionId: string, files: readonly WorkspaceFile[]): Promise<void> {
    const dir = this.#dir(sessionId);
    // A reset discards the student's edits rather than merging over them.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const target = path.join(dir, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { mode: 0o600 });
    }
  }

  async read(sessionId: string, relative: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.#dir(sessionId), relative), 'utf8');
    } catch {
      return null;
    }
  }

  async destroy(sessionId: string): Promise<void> {
    await rm(this.#dir(sessionId), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Test hook: pretend the student wrote a file with their editor. */
  async write(sessionId: string, relative: string, content: string): Promise<void> {
    const target = path.join(this.#dir(sessionId), relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
}

suite('integration: real Docker daemon', () => {
  const engines = new DockerCliFactory({});

  let workspaceRoot: string;
  let workspace: TempDirWorkspace;
  let provider: DockerLabProvider;
  let lab: LoadedLabDefinition;
  let dockerfileLab: LoadedLabDefinition;

  const contextFor = (
    sandbox: string,
    sessionId: string,
    definition: LoadedLabDefinition = lab,
  ): LabSessionContext => ({
    sessionId,
    labId: definition.id,
    namespace: sandbox,
    serviceAccountName: POLICY.serviceAccountName,
    lab: definition,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: POLICY,
  });

  beforeAll(async () => {
    lab = await loadLabDefinition(DOCKER_001_PATH);
    dockerfileLab = await loadLabDefinition(
      path.join(LABS_DIR, 'docker', 'docker-004-dockerfile', 'lab.yaml'),
    );

    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-it-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    provider = new DockerLabProvider({
      engines,
      workspace,
      hostName: 'integration',
      // Exactly the wiring apps/api/src/index.ts uses for the Docker track, so
      // setup verification runs through the real verifier registry.
      waitForRequirements: (input) =>
        waitForRequirements({
          docker: engines.session(input.namespace),
          workspace: { port: workspace, sessionId: SESSION_A },
          ...input,
        }),
    });

    // Pre-pull the sandbox image so the ready timeout measures dind's startup,
    // not a registry download.
    const pull = await docker('image', 'pull', POLICY.docker.image);
    expect(pull.code, pull.stderr).toBe(0);
  }, 900_000);

  afterAll(async () => {
    // Only this run's objects, and only by exact name.
    for (const sandbox of [SANDBOX_A, SANDBOX_B, DECOY, IMPOSTOR]) {
      await docker('rm', '--force', '--volumes', owned(sandbox));
      await docker('volume', 'rm', '--force', owned(DockerLabProvider.dataVolume(sandbox)));
    }
    await docker('network', 'rm', owned(TEST_NETWORK));
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }, 300_000);

  // ------------------------------------------------------------ reachability

  it('reaches a real Docker daemon', async () => {
    await expect(engines.host.ping()).resolves.toBeUndefined();

    const version = await engines.host.version();
    expect(version.serverVersion).not.toBe('');
    expect(version.serverVersion).not.toBe('unknown');
    expect(version.clientVersion).not.toBe('unknown');

    // And this run starts from nothing of its own.
    expect((await docker('inspect', SANDBOX_A)).code).not.toBe(0);
    expect((await docker('inspect', SANDBOX_B)).code).not.toBe(0);
  }, 120_000);

  // ------------------------------------------------------------ provisioning

  it('provisions two sandboxes, each with its own running daemon', async () => {
    for (const [sandbox, sessionId] of [
      [SANDBOX_A, SESSION_A],
      [SANDBOX_B, SESSION_B],
    ] as const) {
      const result = await provider.create(contextFor(sandbox, sessionId));

      expect(result.error?.message ?? '').toBe('');
      expect(result.ok, `${sandbox}: ${JSON.stringify(result.steps)}`).toBe(true);
      expect(result.environment.phase).toBe('ready');
      // Every provisioning step actually ran, rather than being skipped.
      expect(result.steps.filter((s) => s.status !== 'ok')).toEqual([]);
    }

    // Two separate daemons, each answering for itself.
    for (const sandbox of [SANDBOX_A, SANDBOX_B]) {
      const version = await inSandbox(sandbox, 'docker', 'version', '--format', '{{.Server.Version}}');
      expect(version.code, version.stderr).toBe(0);
      expect(version.stdout.trim()).not.toBe('');
    }
  }, 900_000);

  it('labels the sandbox with its owner, so cleanup can never guess', async () => {
    const sandbox = await engines.host.inspectContainer(SANDBOX_A);

    expect(sandbox).not.toBeNull();
    expect(sandbox?.running).toBe(true);
    expect(sandbox?.labels[MANAGED_LABEL]).toBe('true');
    expect(sandbox?.labels[SESSION_LABEL]).toBe(SESSION_A);
    expect(sandbox?.labels[LAB_LABEL]).toBe('DOCKER-001');
  }, 120_000);

  it("applies the session's resource controls to the real container", async () => {
    const inspect = await docker(
      'inspect',
      '--format',
      '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{.HostConfig.Privileged}}',
      SANDBOX_A,
    );
    expect(inspect.code, inspect.stderr).toBe(0);

    const [memory, nanoCpus, pids, privileged] = inspect.stdout.trim().split(/\s+/);

    // These are the limits that actually bind a Docker session: every container
    // the student starts is a child of this one process tree.
    expect(Number(memory)).toBe(1024 ** 3);
    expect(Number(nanoCpus)).toBe(1e9);
    expect(Number(pids)).toBe(256);
    // Docker-in-Docker cannot run unprivileged; this is the single privileged
    // component in the design. See README → Docker sandbox security.
    expect(privileged).toBe('true');
  }, 120_000);

  it('gives the sandbox a dedicated volume for its image store', async () => {
    const volume = await docker('volume', 'inspect', DockerLabProvider.dataVolume(SANDBOX_A));
    expect(volume.code, volume.stderr).toBe(0);

    const mounts = await docker('inspect', '--format', '{{json .Mounts}}', SANDBOX_A);
    expect(mounts.stdout).toContain('/var/lib/docker');
  }, 120_000);

  it("materialised the lab's declared initial state inside the session daemon", async () => {
    // DOCKER-001 declares nginx:1.27-alpine, pre-pulled so the student never
    // waits on a registry.
    const image = await engines.session(SANDBOX_A).inspectImage('nginx:1.27-alpine');

    expect(image).not.toBeNull();
    expect(image?.tags).toContain('nginx:1.27-alpine');
  }, 300_000);

  // --------------------------------------------------------------- isolation

  it('gives each session a container list the other cannot see', async () => {
    const created = await inSandbox(
      SANDBOX_A,
      'docker', 'run', '--detach', '--name', 'web', 'nginx:1.27-alpine',
    );
    expect(created.code, created.stderr).toBe(0);

    const listA = await inSandbox(SANDBOX_A, 'docker', 'ps', '--format', '{{.Names}}');
    const listB = await inSandbox(SANDBOX_B, 'docker', 'ps', '--format', '{{.Names}}');

    expect(listA.stdout).toContain('web');
    // Not a filtered view of one list — a different daemon process with a
    // different container store. There is nothing for B to filter out.
    expect(listB.stdout).not.toContain('web');
  }, 300_000);

  it('gives each session its own image store', async () => {
    // Both sandboxes run the same lab, so both were seeded with nginx. Tagging
    // is a purely local operation on one daemon's image store, which makes it
    // the cleanest way to ask whether these are in fact two stores.
    const tag = `only-in-a-${RUN}:1.0`;
    expect((await inSandbox(SANDBOX_A, 'docker', 'tag', 'nginx:1.27-alpine', tag)).code).toBe(0);

    expect(await engines.session(SANDBOX_A).inspectImage(tag)).not.toBeNull();
    // Nothing filters this: B's daemon has never held that name.
    expect(await engines.session(SANDBOX_B).inspectImage(tag)).toBeNull();

    const imagesB = await inSandbox(SANDBOX_B, 'docker', 'images', '--format', '{{.Repository}}');
    expect(imagesB.stdout).not.toContain(`only-in-a-${RUN}`);
  }, 300_000);

  it("rejects one session's client certificate at another session's daemon", async () => {
    const credentialsA = asDockerContext(
      await provider.getTerminalContext(contextFor(SANDBOX_A, SESSION_A)),
    );

    /*
     * Reach both daemons over TLS from a throwaway client on the sandbox
     * network, holding A's certificates. This is the real test of the design's
     * central claim: network reachability is NOT the boundary, mutual TLS is.
     *
     * The material is passed through the environment and written inside the
     * client container rather than bind-mounted, so the test does not depend on
     * which host paths a developer's Docker happens to share.
     */
    const asClient = (target: string) =>
      docker(
        'run', '--rm',
        '--network', TEST_NETWORK,
        '--env', `CA_PEM=${credentialsA.ca}`,
        '--env', `CERT_PEM=${credentialsA.clientCert}`,
        '--env', `KEY_PEM=${credentialsA.clientKey}`,
        '--env', `DOCKER_HOST=tcp://${target}:${POLICY.docker.daemonPort}`,
        '--env', 'DOCKER_TLS_VERIFY=1',
        '--env', 'DOCKER_CERT_PATH=/certs',
        '--entrypoint', 'sh',
        POLICY.docker.image.replace(/-dind$/, '-cli'),
        '-c',
        'mkdir -p /certs' +
          ' && printf %s "$CA_PEM" > /certs/ca.pem' +
          ' && printf %s "$CERT_PEM" > /certs/cert.pem' +
          ' && printf %s "$KEY_PEM" > /certs/key.pem' +
          ' && docker version --format "{{.Server.Version}}"',
      );

    const ownDaemon = await asClient(SANDBOX_A);
    const otherDaemon = await asClient(SANDBOX_B);

    expect(ownDaemon.code, `A should reach its own daemon: ${ownDaemon.stderr}`).toBe(0);
    expect(ownDaemon.stdout.trim()).not.toBe('');
    // B is reachable on the network and still refuses: every sandbox mints its
    // own CA at startup, so A's certificate is not merely unauthorised there —
    // it is cryptographically unusable, in both directions.
    expect(otherDaemon.code).not.toBe(0);
    expect(`${otherDaemon.stderr}${otherDaemon.stdout}`.toLowerCase()).toMatch(
      /certificate|tls|unknown authority|bad certificate|handshake/,
    );
  }, 600_000);

  it('issues distinct material per sandbox', async () => {
    const a = asDockerContext(await provider.getTerminalContext(contextFor(SANDBOX_A, SESSION_A)));
    const b = asDockerContext(await provider.getTerminalContext(contextFor(SANDBOX_B, SESSION_B)));

    expect(a.ca).toContain('BEGIN CERTIFICATE');
    expect(a.clientCert).toContain('BEGIN CERTIFICATE');
    expect(a.clientKey).toMatch(/BEGIN (RSA |EC )?PRIVATE KEY/);
    expect(a.ca).not.toBe(b.ca);
    expect(a.clientCert).not.toBe(b.clientCert);
    expect(a.clientKey).not.toBe(b.clientKey);
    expect(a.dockerHost).toBe(`tcp://${SANDBOX_A}:${POLICY.docker.daemonPort}`);
  }, 120_000);

  // ------------------------------------------------------- the student path

  /*
   * DOCKER-004 and DOCKER-008 ask the student to author a file and then use it,
   * and both of those run *client-side*: `docker build` tars the workspace and
   * sends it to the daemon, and `docker compose` reads compose.yaml locally.
   * That is the terminal container's job, not the sandbox's — so these two tests
   * drive a throwaway client with the session's certificates, the way a student
   * shell actually would, rather than exec-ing inside the sandbox.
   */

  /**
   * Run a client command against a sandbox's daemon, exactly as a shell would.
   *
   * Certificates and workspace files are passed through the environment and
   * written inside the client container rather than bind-mounted, for the same
   * reason as the mTLS test above: the result must not depend on which host
   * paths a developer's Docker happens to share.
   */
  async function asStudent(
    sandbox: string,
    files: Record<string, string>,
    command: string,
  ): Promise<Cmd> {
    const credentials = asDockerContext(
      await provider.getTerminalContext(contextFor(sandbox, SESSION_A)),
    );

    const writeFiles = Object.keys(files)
      .map((name, index) => `printf %s "$FILE_${index}" > /workspace/${name}`)
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
      // The shipped terminal image carries the Docker CLI without buildx, so
      // `docker build` uses the classic builder. Pinning that here means this
      // test exercises the path students actually get.
      '--env', 'DOCKER_BUILDKIT=0',
      '--entrypoint', 'sh',
      POLICY.docker.image.replace(/-dind$/, '-cli'),
      '-c',
      'mkdir -p /certs /workspace' +
        ' && printf %s "$CA_PEM" > /certs/ca.pem' +
        ' && printf %s "$CERT_PEM" > /certs/cert.pem' +
        ' && printf %s "$KEY_PEM" > /certs/key.pem' +
        ` && ${writeFiles}` +
        ` && cd /workspace && ${command}`,
    );
  }

  it('lets a student build an image from a workspace Dockerfile, over mTLS', async () => {
    const dockerfile = [
      'FROM alpine:3.20',
      'WORKDIR /app',
      'ENV APP_ENV=production',
      'CMD ["echo", "ledger"]',
      '',
    ].join('\n');

    const built = await asStudent(
      SANDBOX_A,
      { Dockerfile: dockerfile },
      'docker build --tag ledger:1.0 .',
    );
    expect(built.code, `${built.stdout}\n${built.stderr}`).toBe(0);

    // The image landed in this session's own daemon, and the verifier — which
    // reads through the platform's `docker exec` path, not the student's TLS
    // path — sees it and can grade the configuration the Dockerfile produced.
    const image = await engines.session(SANDBOX_A).inspectImage('ledger:1.0');
    expect(image).not.toBeNull();
    expect(image?.workingDir).toBe('/app');
    expect(image?.env.APP_ENV).toBe('production');

    // And it is not in the other session's store.
    expect(await engines.session(SANDBOX_B).inspectImage('ledger:1.0')).toBeNull();
  }, 600_000);

  it('lets a student bring up a Compose stack, over mTLS', async () => {
    const composeFile = [
      'services:',
      '  ledger-api:',
      '    image: nginx:1.27-alpine',
      '  ledger-worker:',
      '    image: alpine:3.20',
      '    command: ["sleep", "600"]',
      '',
    ].join('\n');

    const up = await asStudent(
      SANDBOX_A,
      { 'compose.yaml': composeFile },
      'docker compose --project-name ledgerstack up --detach',
    );
    expect(up.code, `${up.stdout}\n${up.stderr}`).toBe(0);

    // Compose containers are ordinary containers in the session's own daemon,
    // which is why the verifier needs no Compose-specific knowledge at all.
    const names = (await engines.session(SANDBOX_A).listContainers({ all: true })).map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['ledgerstack-ledger-api-1', 'ledgerstack-ledger-worker-1']),
    );

    const down = await asStudent(
      SANDBOX_A,
      { 'compose.yaml': composeFile },
      'docker compose --project-name ledgerstack down',
    );
    expect(down.code, `${down.stdout}\n${down.stderr}`).toBe(0);
  }, 600_000);

  // ------------------------------------------------------------ verification

  it("grades the lab against the session's own daemon", async () => {
    const readerFor = (sandbox: string) => engines.session(sandbox);

    // Session A ran the container the lab asks for; session B did not.
    const solved = await verifyLab({ lab, namespace: SANDBOX_A, docker: readerFor(SANDBOX_A) });
    const untouched = await verifyLab({ lab, namespace: SANDBOX_B, docker: readerFor(SANDBOX_B) });

    expect(
      solved.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`),
    ).toEqual([]);
    expect(solved.passed).toBe(true);
    expect(solved.summary).toBe('LAB PASSED');
    // A correct container in somebody else's sandbox is invisible here.
    expect(untouched.passed).toBe(false);
    expect(untouched.checks.every((c) => c.status === 'fail')).toBe(true);
  }, 300_000);

  it('fails an intentionally incorrect container, from real daemon state', async () => {
    // Right name, right image, but it ran and stopped: the lab asks for a
    // running container. Nothing is stubbed — the daemon is asked what is there.
    expect((await inSandbox(SANDBOX_A, 'docker', 'rm', '--force', 'web')).code).toBe(0);
    const wrong = await inSandbox(
      SANDBOX_A,
      'docker', 'run', '--name', 'web', 'nginx:1.27-alpine', 'true',
    );
    expect(wrong.code, wrong.stderr).toBe(0);

    const result = await verifyLab({
      lab,
      namespace: SANDBOX_A,
      docker: engines.session(SANDBOX_A),
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');

    const byLabel = Object.fromEntries(result.checks.map((c) => [c.label, c]));
    expect(byLabel['Container web exists']?.status).toBe('pass');
    expect(byLabel['Container is running']?.status).toBe('fail');
    // The detail describes what was observed, never what to type.
    expect(byLabel['Container is running']?.detail).toMatch(/exited/);
    expect(byLabel['Container is running']?.detail).not.toMatch(/docker run/i);
  }, 300_000);

  it('fails a container built from the wrong image', async () => {
    expect((await inSandbox(SANDBOX_A, 'docker', 'rm', '--force', 'web')).code).toBe(0);
    // The image reference the daemon records is what is graded, so a retagged
    // copy of the right image is still the wrong answer.
    expect(
      (await inSandbox(SANDBOX_A, 'docker', 'tag', 'nginx:1.27-alpine', `decoy-${RUN}:1.0`)).code,
    ).toBe(0);
    expect(
      (await inSandbox(SANDBOX_A, 'docker', 'run', '--detach', '--name', 'web', `decoy-${RUN}:1.0`))
        .code,
    ).toBe(0);

    const result = await verifyLab({ lab, namespace: SANDBOX_A, docker: engines.session(SANDBOX_A) });
    const byLabel = Object.fromEntries(result.checks.map((c) => [c.label, c]));

    expect(result.passed).toBe(false);
    expect(byLabel['Container is running']?.status).toBe('pass');
    expect(byLabel['Container runs the nginx:1.27-alpine image']?.status).toBe('fail');
    expect(byLabel['Container runs the nginx:1.27-alpine image']?.detail).toContain(`decoy-${RUN}`);
  }, 300_000);

  it('passes again once the student fixes it, so grading is not sticky', async () => {
    expect((await inSandbox(SANDBOX_A, 'docker', 'rm', '--force', 'web')).code).toBe(0);
    expect(
      (await inSandbox(SANDBOX_A, 'docker', 'run', '--detach', '--name', 'web', 'nginx:1.27-alpine'))
        .code,
    ).toBe(0);

    const result = await verifyLab({ lab, namespace: SANDBOX_A, docker: engines.session(SANDBOX_A) });
    expect(result.passed).toBe(true);
  }, 300_000);

  it('reports a missing object as a failing check, not as a broken environment', async () => {
    /*
     * Regression guard. `docker network inspect` answers `network <name> not
     * found`, which is the one absence Docker does *not* phrase as "no such
     * …". While that went unrecognised, `verifyLab` threw instead of reporting a
     * failing check — so a student on DOCKER-006 whose network simply did not
     * exist yet would have seen a broken lab rather than "Network ledger-net
     * does not exist". A fake engine cannot surface this; only a real daemon can.
     */
    const session = engines.session(SANDBOX_A);

    await expect(session.inspectNetwork(`absent-${RUN}`)).resolves.toBeNull();
    await expect(session.inspectVolume(`absent-${RUN}`)).resolves.toBeNull();
    await expect(session.inspectContainer(`absent-${RUN}`)).resolves.toBeNull();
    await expect(session.inspectImage(`absent-${RUN}:1.0`)).resolves.toBeNull();
    // Removing something already gone is the desired end state, which is what
    // makes reset and teardown safe to re-enter.
    await expect(session.removeNetwork(`absent-${RUN}`)).resolves.toBeUndefined();
  }, 180_000);

  // ------------------------------------------------------------------ reset

  it("resets one session's environment and leaves the other untouched", async () => {
    await inSandbox(SANDBOX_B, 'docker', 'run', '--detach', '--name', 'web', 'nginx:1.27-alpine');
    await inSandbox(SANDBOX_A, 'docker', 'volume', 'create', 'student-data');
    await inSandbox(SANDBOX_A, 'docker', 'network', 'create', 'student-net');

    const result = await provider.reset(contextFor(SANDBOX_A, SESSION_A));

    expect(result.error?.message ?? '').toBe('');
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual(
      expect.arrayContaining(['container/web', 'volume/student-data', 'network/student-net']),
    );

    const containersA = await inSandbox(SANDBOX_A, 'docker', 'ps', '-a', '--format', '{{.Names}}');
    const volumesA = await inSandbox(SANDBOX_A, 'docker', 'volume', 'ls', '--format', '{{.Name}}');
    const networksA = await inSandbox(SANDBOX_A, 'docker', 'network', 'ls', '--format', '{{.Name}}');

    expect(containersA.stdout).not.toContain('web');
    expect(volumesA.stdout).not.toContain('student-data');
    expect(networksA.stdout).not.toContain('student-net');
    // The three networks Docker provides itself are never the student's to lose.
    for (const predefined of ['bridge', 'host', 'none']) {
      expect(networksA.stdout).toContain(predefined);
    }

    // DOCKER-001 keeps images, so the reset stays fast.
    const imagesA = await inSandbox(SANDBOX_A, 'docker', 'images', '--format', '{{.Repository}}');
    expect(imagesA.stdout).toContain('nginx');

    // B's work survives A's reset entirely — separate daemons, separate stores.
    const containersB = await inSandbox(SANDBOX_B, 'docker', 'ps', '--format', '{{.Names}}');
    expect(containersB.stdout).toContain('web');
  }, 600_000);

  it('leaves the lab failing again, because the student work is genuinely gone', async () => {
    const result = await verifyLab({ lab, namespace: SANDBOX_A, docker: engines.session(SANDBOX_A) });
    expect(result.passed).toBe(false);
  }, 180_000);

  it('keeps the sandbox, and its credentials, alive across a reset', async () => {
    const status = await provider.status(contextFor(SANDBOX_A, SESSION_A));

    expect(status.phase).toBe('ready');
    const credentials = asDockerContext(
      await provider.getTerminalContext(contextFor(SANDBOX_A, SESSION_A)),
    );
    expect(credentials.ca).toContain('BEGIN CERTIFICATE');
  }, 120_000);

  // -------------------------------------------------------------- workspace

  it('seeds, grades, and restores real files in the session workspace', async () => {
    /*
     * DOCKER-004 is the lab that asks the student to *write* something. Its
     * baseline file has to appear on disk, the two workspace checks have to
     * grade the real file, and a reset has to put the baseline back.
     */
    const context = contextFor(SANDBOX_A, SESSION_A, dockerfileLab);
    const reset = await provider.reset(context);
    expect(reset.error?.message ?? '').toBe('');
    expect(reset.ok).toBe(true);

    // The lab's declared baseline file is genuinely on disk.
    expect(await workspace.read(SESSION_A, 'message.txt')).toContain('JumpToTech Bank');

    const verify = () =>
      verifyLab({
        lab: dockerfileLab,
        namespace: SANDBOX_A,
        docker: engines.session(SANDBOX_A),
        workspace: { port: workspace, sessionId: SESSION_A },
      });
    const labelled = (result: Awaited<ReturnType<typeof verify>>) =>
      Object.fromEntries(result.checks.map((c) => [c.label, c]));

    expect(labelled(await verify())['A Dockerfile exists in your workspace']?.status).toBe('fail');

    // The student writes one, with their editor, into their own workspace.
    await workspace.write(
      SESSION_A,
      'Dockerfile',
      [
        'FROM alpine:3.20',
        'WORKDIR /app',
        'COPY message.txt /app/message.txt',
        'RUN chmod 0444 /app/message.txt',
        'CMD ["cat", "/app/message.txt"]',
        '',
      ].join('\n'),
    );

    const after = labelled(await verify());
    expect(after['A Dockerfile exists in your workspace']?.status).toBe('pass');
    expect(after['The Dockerfile uses FROM, WORKDIR, COPY, RUN, and CMD']?.status).toBe('pass');
    // Writing the file is not building it: the image checks are still failing,
    // because the verifier grades what was produced, not what was typed.
    expect(after['Image jumptotech/greeter:1.0 was built']?.status).toBe('fail');

    // A reset discards the student's edits and puts the baseline back.
    const second = await provider.reset(context);
    expect(second.ok).toBe(true);
    expect(await workspace.read(SESSION_A, 'Dockerfile')).toBeNull();
    expect(await workspace.read(SESSION_A, 'message.txt')).toContain('JumpToTech Bank');
    // And nothing was ever written into the other session's workspace.
    expect(await workspace.read(SESSION_B, 'message.txt')).toBeNull();
  }, 900_000);

  // ----------------------------------------------------------------- cleanup

  it('finds only the sandboxes it created and labelled', async () => {
    const managed = await provider.listManagedSandboxes();
    const names = managed.map((m) => m.sandboxRef);

    expect(names).toEqual(expect.arrayContaining([SANDBOX_A, SANDBOX_B]));
    for (const entry of managed) {
      expect(entry.sandboxRef).toMatch(/^lab-[a-z0-9-]+$/);
      expect(entry.expiresAtMs).toBeGreaterThan(0);
    }
    expect(managed.find((m) => m.sandboxRef === SANDBOX_A)?.sessionId).toBe(SESSION_A);

    // The selector is real: the host daemon does the filtering.
    const raw = await docker(
      'ps', '--all', '--filter', `label=${MANAGED_SELECTOR}`, '--format', '{{.Names}}',
    );
    expect(raw.stdout).toContain(SANDBOX_A);
  }, 120_000);

  it('refuses to delete a container it does not own', async () => {
    // A `lab-`-shaped container carrying none of the ownership labels.
    await docker('run', '--detach', '--name', owned(DECOY), 'nginx:1.27-alpine');

    const result = await provider.destroySandbox(DECOY);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Refusing to delete sandbox/);
    expect(result.error?.message).toContain(MANAGED_LABEL);
    // Still there: name shape alone never authorises a delete.
    expect((await docker('inspect', '--format', '{{.Name}}', DECOY)).code).toBe(0);
    // And the reaper never adopts it either.
    expect((await provider.listManagedSandboxes()).map((m) => m.sandboxRef)).not.toContain(DECOY);
  }, 300_000);

  it("refuses another platform component's container, even when it is managed", async () => {
    /*
     * A Docker daemon is a flat namespace shared with everything else the
     * platform runs on that host, unlike a Kubernetes namespace which only ever
     * holds one session's objects. `lab-<hash>-control` is a well-formed
     * `lab-…` DNS label, so a per-session cluster node carrying the managed
     * label satisfies every gate except the component one — and removing it
     * would take out a running cluster.
     */
    const created = await docker(
      'run', '--detach', '--name', owned(IMPOSTOR),
      '--label', `${MANAGED_LABEL}=true`,
      '--label', `${SESSION_LABEL}=${SESSION_A}`,
      '--label', `${SANDBOX_LABELS.component}=kind-node`,
      'nginx:1.27-alpine',
    );
    expect(created.code, created.stderr).toBe(0);

    const result = await provider.destroySandbox(IMPOSTOR, SESSION_A);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain(SANDBOX_LABELS.component);
    expect((await docker('inspect', '--format', '{{.Name}}', IMPOSTOR)).code).toBe(0);
    // And the reaper's orphan sweep never picks it up either.
    expect((await provider.listManagedSandboxes()).map((m) => m.sandboxRef)).not.toContain(IMPOSTOR);
  }, 300_000);

  it('refuses a name that is not a lab sandbox name at all', async () => {
    const result = await provider.destroySandbox('postgres');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/not a JumpToTech lab sandbox name/);
  }, 60_000);

  it('refuses to delete a sandbox belonging to another session', async () => {
    const result = await provider.destroySandbox(SANDBOX_A, SESSION_B);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain(SESSION_A);
    expect((await docker('inspect', '--format', '{{.Name}}', SANDBOX_A)).code).toBe(0);
  }, 120_000);

  it('destroys a sandbox, its data volume, and everything inside it', async () => {
    const result = await provider.destroy(contextFor(SANDBOX_A, SESSION_A));

    expect(result.ok).toBe(true);
    expect(result.namespaceGone).toBe(true);
    expect((await docker('inspect', SANDBOX_A)).code).not.toBe(0);
    expect(
      (await docker('volume', 'inspect', DockerLabProvider.dataVolume(SANDBOX_A))).code,
    ).not.toBe(0);
    // The student's workspace dies with their session.
    expect(await workspace.read(SESSION_A, 'message.txt')).toBeNull();

    // Nothing had to enumerate the student's containers, images, or volumes:
    // they lived in a daemon that no longer exists.
    const remaining = await provider.listManagedSandboxes();
    expect(remaining.map((m) => m.sandboxRef)).not.toContain(SANDBOX_A);
    expect(remaining.map((m) => m.sandboxRef)).toContain(SANDBOX_B);
  }, 300_000);

  it('is safe to re-enter teardown, which is what makes the reaper work', async () => {
    const again = await provider.destroySandbox(SANDBOX_A, SESSION_A);
    expect(again.ok).toBe(true);
    expect(again.namespaceGone).toBe(true);

    const third = await provider.destroy(contextFor(SANDBOX_A, SESSION_A));
    expect(third.ok).toBe(true);
    expect(third.namespaceGone).toBe(true);

    // A destroyed session reads as absent, not as an error.
    expect((await provider.status(contextFor(SANDBOX_A, SESSION_A))).phase).toBe('not_created');
  }, 300_000);

  it('leaves nothing of a destroyed session behind on the host', async () => {
    const containers = await docker('ps', '--all', '--format', '{{.Names}}');
    const volumes = await docker('volume', 'ls', '--format', '{{.Name}}');

    expect(containers.stdout).not.toContain(SANDBOX_A);
    expect(volumes.stdout).not.toContain(DockerLabProvider.dataVolume(SANDBOX_A));
  }, 120_000);

  it('leaves every other session, and every foreign container, completely intact', async () => {
    // B survived a neighbour's reset, refusal, destroy, and re-entered teardown.
    expect((await provider.status(contextFor(SANDBOX_B, SESSION_B))).phase).toBe('ready');
    const containersB = await inSandbox(SANDBOX_B, 'docker', 'ps', '--format', '{{.Names}}');
    expect(containersB.stdout).toContain('web');

    // And so did the container the platform refused to touch.
    expect((await docker('inspect', '--format', '{{.Name}}', DECOY)).code).toBe(0);
  }, 180_000);

  // Referenced so an accidental deletion of the labs directory fails loudly here
  // rather than silently reducing this suite's coverage.
  it('ran against the shipped lab definitions', () => {
    expect(lab.id).toBe('DOCKER-001');
    expect(dockerfileLab.id).toBe('DOCKER-004');
    expect(DOCKER_001_PATH.startsWith(LABS_DIR)).toBe(true);
  });
});
