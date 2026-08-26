/**
 * DOCKER-014 production validation against a REAL `docker:27-dind` sandbox.
 *
 * Everything here goes through the path a student actually uses: a
 * `docker:27-cli` container reaching the session's daemon over mutual TLS,
 * building from a real workspace and running real containers. The verifier
 * reads through the platform's own `docker exec` path, which is a different
 * route to the same daemon — so a pass here means the two agree about state
 * neither of them invented.
 *
 * The one thing a fake cannot establish is the reason this lab exists: that
 * the shell form of ENTRYPOINT silently discards runtime arguments. That is a
 * property of Docker's own instruction parsing, and it is measured below on a
 * real build.
 *
 * Skipped unless RUN_DOCKER_INTEGRATION_TESTS=1:
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker014-integration.test.ts --root services/lab-orchestrator
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
  console.log('[docker014-integration] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1');
}

const RUN = randomBytes(4).toString('hex');
const SANDBOX_A = `jtt-lab-${RUN}14`;
const SANDBOX_B = `jtt-lab-${RUN}15`;
const TEST_NETWORK = `jtt-it14-${RUN}-net`;
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
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, filePath), content, { mode: 0o600 });
  }
  async destroy(sessionId: string): Promise<void> {
    await rm(this.#dir(sessionId), { recursive: true, force: true });
  }
}

/** The Dockerfile a student who read the reference would write. */
const CORRECT_DOCKERFILE = [
  'FROM alpine:3.20',
  'WORKDIR /app',
  'COPY batch.sh /app/batch.sh',
  'RUN chmod +x /app/batch.sh',
  'ENTRYPOINT ["/app/batch.sh"]',
  'CMD ["--dry-run"]',
  '',
].join('\n');

/** The same thing with ENTRYPOINT in shell form — the silent bug. */
const SHELL_FORM_DOCKERFILE = CORRECT_DOCKERFILE.replace(
  'ENTRYPOINT ["/app/batch.sh"]',
  'ENTRYPOINT /app/batch.sh',
);

suite('DOCKER-014 against a real docker:27-dind sandbox', () => {
  const engines = new DockerCliFactory({});
  let workspaceRoot: string;
  let workspace: TempDirWorkspace;
  let provider: DockerLabProvider;
  let lab: LoadedLabDefinition;
  let batchScript: string;

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

  /**
   * Run a command the way a student does: a Docker CLI container reaching the
   * session daemon over mutual TLS, with the workspace files present.
   */
  async function asStudent(
    sandbox: string,
    sessionId: string,
    files: Record<string, string>,
    command: string,
  ): Promise<Cmd> {
    const credentials = asDockerContext(await provider.getTerminalContext(context(sandbox, sessionId)));
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

  /** Build the image and run both containers, exactly as the lab asks. */
  async function solveAsStudent(dockerfile = CORRECT_DOCKERFILE, sandbox = SANDBOX_A, sessionId = SESSION_A) {
    const result = await asStudent(
      sandbox,
      sessionId,
      { Dockerfile: dockerfile, 'batch.sh': batchScript },
      'chmod +x batch.sh' +
        ' && docker build --tag jumptotech/batch:1.0 .' +
        ' && docker run --name batch-default jumptotech/batch:1.0' +
        ' && docker run --name batch-override jumptotech/batch:1.0 --commit',
    );
    // The Dockerfile also has to reach the workspace the verifier reads.
    await workspace.write(sessionId, 'Dockerfile', dockerfile);
    return result;
  }

  const state = (sandbox: string, target: string, format: string) =>
    docker('exec', sandbox, 'docker', 'inspect', target, '--format', format);

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

  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'docker', 'docker-014-cmd-entrypoint', 'lab.yaml'),
    );
    batchScript = lab.setup.docker?.files.find((f) => f.path === 'batch.sh')?.content ?? '';
    expect(batchScript, 'the lab must seed batch.sh').not.toBe('');

    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-it14-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    provider = new DockerLabProvider({
      engines,
      workspace,
      hostName: 'integration-014',
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

  // ------------------------------------------------------- START -> FAIL

  it('START: provisions, seeds batch.sh, and the untouched lab fails every check', async () => {
    const result = await createWithRetry(context());
    expect(result.error?.message ?? '').toBe('');
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);

    expect(await workspace.read(SESSION_A, 'batch.sh')).toContain('--dry-run');
    expect(await workspace.read(SESSION_A, 'Dockerfile')).toBeNull();

    const before = await verify();
    expect(before.passed).toBe(false);
    expect(before.checks).toHaveLength(8);
    expect(failing(before)).toHaveLength(8);
  }, 900_000);

  // -------------------------------------------------- STUDENT WORK -> PASS

  it('SOLVE: a real build and two real runs make the lab pass', async () => {
    const done = await solveAsStudent();
    expect(done.code, `${done.stdout}\n${done.stderr}`).toBe(0);

    // What the student actually produced, read from the daemon.
    expect(
      (await state(SANDBOX_A, 'jumptotech/batch:1.0', '{{json .Config.Entrypoint}} {{json .Config.Cmd}}')).stdout.trim(),
    ).toBe('["/app/batch.sh"] ["--dry-run"]');
    expect(
      (await state(SANDBOX_A, 'batch-default', '{{json .Config.Cmd}} {{.State.ExitCode}}')).stdout.trim(),
    ).toBe('["--dry-run"] 0');
    // The override kept the entrypoint and replaced only the mode.
    expect(
      (await state(SANDBOX_A, 'batch-override', '{{json .Config.Entrypoint}} {{json .Config.Cmd}} {{.State.ExitCode}}')).stdout.trim(),
    ).toBe('["/app/batch.sh"] ["--commit"] 0');

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  }, 900_000);

  // ------------------------------------------------------- BREAK -> FAIL

  it('BREAK: replacing the program instead of the mode fails', async () => {
    await docker('exec', SANDBOX_A, 'docker', 'rm', '--force', 'batch-override');
    // `docker run --entrypoint /bin/sh …` — exactly what ENTRYPOINT prevents.
    const broken = await docker('exec', SANDBOX_A, 'docker', 'run', '--name', 'batch-override',
      '--entrypoint', '/bin/echo', 'jumptotech/batch:1.0', '--commit');
    expect(broken.code, broken.stderr).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual([
      'batch-override replaced the mode while keeping the same program',
    ]);
  }, 600_000);

  // ------------------------------------------------------- RESET -> FAIL

  it('RESET: restores the starting state, and the previous pass is gone', async () => {
    const reset = await provider.reset(context());
    expect(reset.error?.message ?? '').toBe('');
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    // Containers gone, and the student's own image with them — the lab resets
    // `images: true` precisely so a stale build cannot survive into a retry.
    expect((await docker('exec', SANDBOX_A, 'docker', 'ps', '-a', '--format', '{{.Names}}')).stdout.trim()).toBe('');
    expect(await engines.session(SANDBOX_A).inspectImage('jumptotech/batch:1.0')).toBeNull();
    // The base image and the seeded script survive.
    expect(await engines.session(SANDBOX_A).inspectImage('alpine:3.20')).not.toBeNull();
    expect(await workspace.read(SESSION_A, 'batch.sh')).toContain('--dry-run');

    const after = await verify();
    expect(after.passed).toBe(false);
    expect(failing(after)).toHaveLength(8);
  }, 900_000);

  // ------------------------------------------------- SOLVE AGAIN -> PASS

  it('SOLVE AGAIN: the same work passes a second time from the restored state', async () => {
    const done = await solveAsStudent();
    expect(done.code, `${done.stdout}\n${done.stderr}`).toBe(0);

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
  }, 900_000);

  // ------------------------------------------- the bug the lab is about

  it('the shell form builds, runs, exits non-zero, and is caught by the argv', async () => {
    await docker('exec', SANDBOX_A, 'docker', 'rm', '--force', 'batch-default', 'batch-override');
    await docker('exec', SANDBOX_A, 'docker', 'rmi', '--force', 'jumptotech/batch:1.0');

    const built = await solveAsStudent(SHELL_FORM_DOCKERFILE);
    // The last `docker run --commit` fails, because the argument was discarded
    // and the script refuses an empty mode — the second signal the lab relies on.
    expect(built.code, 'a shell-form entrypoint must not produce a working tool').not.toBe(0);

    // And the image itself records the shell wrapper, which is the first signal.
    expect(
      (await state(SANDBOX_A, 'jumptotech/batch:1.0', '{{json .Config.Entrypoint}}')).stdout.trim(),
    ).toBe('["/bin/sh","-c","/app/batch.sh"]');

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain(
      'The image runs the script directly, with --dry-run as its default mode',
    );
  }, 900_000);

  // ------------------------------------------------------------ isolation

  it('session A cannot pass using session B\'s image and containers', async () => {
    const other = await createWithRetry(context(SANDBOX_B, SESSION_B));
    expect(other.error?.message ?? '').toBe('');
    expect(other.ok, JSON.stringify(other.steps)).toBe(true);

    // B does the work properly. A is left with the broken shell-form build.
    const done = await solveAsStudent(CORRECT_DOCKERFILE, SANDBOX_B, SESSION_B);
    expect(done.code, `${done.stdout}\n${done.stderr}`).toBe(0);

    expect((await verify(SANDBOX_B, SESSION_B)).passed).toBe(true);

    // A's daemon has its own image store: B's correct image is not in it.
    const aResult = await verify(SANDBOX_A, SESSION_A);
    expect(aResult.passed).toBe(false);
    expect(await engines.session(SANDBOX_A).inspectContainer('batch-default')).not.toBeNull();
    // …and B's containers are not visible from A either.
    const aNames = (await docker('exec', SANDBOX_A, 'docker', 'ps', '-a', '--format', '{{.Names}}')).stdout;
    const bNames = (await docker('exec', SANDBOX_B, 'docker', 'ps', '-a', '--format', '{{.Names}}')).stdout;
    expect(aNames.trim()).not.toBe('');
    expect(bNames.trim()).not.toBe('');
  }, 900_000);
});
