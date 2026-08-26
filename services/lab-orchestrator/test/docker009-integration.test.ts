/**
 * DOCKER-009 production validation against a REAL `docker:27-dind` sandbox.
 *
 * The fake daemon proves our handlers read the snapshot correctly. It cannot
 * prove the thing DOCKER-009 actually depends on: that the Linux kernel, this
 * Docker version, and this cgroup driver really do set `State.OOMKilled` on a
 * memory-limit kill and really do leave it false for every other way a
 * container reaches exit code 137. That is a property of Docker, not of us, so
 * it is measured here or not at all.
 *
 * Skipped unless RUN_DOCKER_INTEGRATION_TESTS=1:
 *
 *   RUN_DOCKER_INTEGRATION_TESTS=1 \
 *     npx vitest run test/docker009-integration.test.ts --root services/lab-orchestrator
 *
 * ---------------------------------------------------------------------------
 * SAFETY — runs against a developer's own Docker daemon.
 *
 * Every host object carries this run's random token, and every destructive host
 * call passes through `owned()`, which throws on a name without it. No prune,
 * no wildcards, no label sweeps. Containers created *inside* the sandbox are
 * unreachable from the host daemon and die with it.
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
  console.log('[docker009-integration] skipped — set RUN_DOCKER_INTEGRATION_TESTS=1');
}

const RUN = randomBytes(4).toString('hex');
const SANDBOX = `jtt-lab-${RUN}09`;
const TEST_NETWORK = `jtt-it9-${RUN}-net`;
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

suite('DOCKER-009 against a real docker:27-dind sandbox', () => {
  const engines = new DockerCliFactory({});
  let workspaceRoot: string;
  let workspace: TempDirWorkspace;
  let provider: DockerLabProvider;
  let lab: LoadedLabDefinition;
  let docker001: LoadedLabDefinition;

  const verify = () =>
    verifyLab({
      lab,
      namespace: SANDBOX,
      docker: engines.session(SANDBOX),
      workspace: { port: workspace, sessionId: SESSION },
    });

  /** Every failing check label, for readable assertions. */
  const failing = (r: Awaited<ReturnType<typeof verify>>) =>
    r.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  const writeAnswers = (text: string) => workspace.seed(SESSION, []).then(async () => {
    const dir = path.join(workspaceRoot, SESSION.replace(/[^a-zA-Z0-9_-]/g, ''));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'answers.txt'), text, { mode: 0o600 });
  });

  /** The budget half of the lab, correct. */
  const runReporting = (memory = '256m', cpus = '0.5', pids = '64') =>
    inSandbox('docker', 'run', '-d', '--name', 'reporting', '--memory', memory, '--cpus', cpus,
      '--pids-limit', pids, 'alpine:3.20', 'sleep', '3600');

  /** Drive a container past its memory limit for real. */
  const runProbeOom = (memory = '16m') =>
    inSandbox('docker', 'run', '--name', 'memory-probe', '--memory', memory, 'alpine:3.20',
      'sh', '-c', 'dd if=/dev/zero of=/dev/shm/fill bs=1M count=64');

  const probeState = async () => {
    const r = await inSandbox('docker', 'inspect', 'memory-probe', '--format',
      '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.HostConfig.Memory}}');
    return r.stdout.trim();
  };

  const rmInSandbox = (...names: string[]) =>
    inSandbox('docker', 'rm', '--force', ...names);

  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'docker', 'docker-009-resource-limits', 'lab.yaml'),
    );
    docker001 = await loadLabDefinition(
      path.join(LABS_DIR, 'docker', 'docker-001-first-container', 'lab.yaml'),
    );
    workspaceRoot = await mkdtemp(path.join(tmpdir(), `jtt-it9-${RUN}-`));
    workspace = new TempDirWorkspace(workspaceRoot);
    provider = new DockerLabProvider({
      engines,
      workspace,
      hostName: 'integration-009',
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

  const context = (definition?: LoadedLabDefinition): LabSessionContext => ({
    sessionId: SESSION,
    labId: (definition ?? lab).id,
    namespace: SANDBOX,
    serviceAccountName: POLICY.serviceAccountName,
    lab: definition ?? lab,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: POLICY,
  });

  // ---------------------------------------------------------------- A

  it('A. provisions the sandbox and the intentionally-unsolved lab fails every check', async () => {
    let result = await provider.create(context());
    // Docker Hub sometimes times out its TLS handshake. That is a registry
    // hiccup, not a provisioning defect, so retry once before believing it.
    if (!result.ok && /timeout|TLS handshake|i\/o timeout/i.test(result.error?.message ?? '')) {
      await provider.destroy(context());
      result = await provider.create(context());
    }
    expect(result.error?.message ?? '').toBe('');
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);

    // The seeded starting state: the image, and nothing else.
    const ps = await inSandbox('docker', 'ps', '-a', '--format', '{{.Names}}');
    expect(ps.stdout.trim()).toBe('');

    const before = await verify();
    expect(before.passed).toBe(false);
    expect(before.summary).toBe('LAB NOT COMPLETE');
    expect(failing(before)).toHaveLength(before.checks.length);
    expect(before.checks.length).toBe(8);
  }, 900_000);

  // ---------------------------------------------------------------- E + B

  it('E. a real memory-limit kill sets OOMKilled=true on this kernel', async () => {
    const run = await runProbeOom();
    // The container is SUPPOSED to fail — that is the exercise.
    expect(run.code).not.toBe(0);

    const state = await probeState();
    // status exitCode OOMKilled memoryBytes
    expect(state).toBe('exited 137 true 16777216');
  }, 300_000);

  it('B. the correct student solution passes every check', async () => {
    const r = await runReporting();
    expect(r.code, r.stderr).toBe(0);
    await writeAnswers('exit_code: 137\ninspect_field: OOMKilled\n');

    const result = await verify();
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  }, 300_000);

  // ---------------------------------------------------------------- H

  it('H. the verdict follows current state, not a past pass', async () => {
    // Same container name, one control removed.
    await rmInSandbox('reporting');
    const r = await inSandbox('docker', 'run', '-d', '--name', 'reporting', '--memory', '256m',
      '--cpus', '0.5', 'alpine:3.20', 'sleep', '3600');
    expect(r.code, r.stderr).toBe(0);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual([
      'Container reporting is limited to 256m of memory, 0.5 CPU, and 64 processes',
    ]);
    expect(
      result.checks.find((c) => c.label.includes('64 processes'))?.detail,
    ).toContain('process count is unlimited');
  }, 300_000);

  // ---------------------------------------------------------------- C

  it('C. wrong memory, CPU or PID values each fail on their own', async () => {
    for (const [memory, cpus, pids, expected] of [
      ['128m', '0.5', '64', 'memory is'],
      ['256m', '0.25', '64', 'CPU limit is'],
      ['256m', '0.5', '32', 'process limit is 32'],
    ] as const) {
      await rmInSandbox('reporting');
      const r = await runReporting(memory, cpus, pids);
      expect(r.code, r.stderr).toBe(0);

      const result = await verify();
      expect(result.passed, `${memory}/${cpus}/${pids}`).toBe(false);
      const budget = result.checks.find((c) => c.label.includes('64 processes'));
      expect(budget?.status).toBe('fail');
      expect(budget?.detail, `${memory}/${cpus}/${pids}`).toContain(expected);
    }

    // Restore the correct budget for the checks that follow.
    await rmInSandbox('reporting');
    expect((await runReporting()).code).toBe(0);
    const restored = await verify();
    expect(restored.passed).toBe(true);
  }, 1_800_000);

  // ---------------------------------------------------------------- D

  it('D. docker kill cannot fake an OOM, on a real daemon', async () => {
    await rmInSandbox('memory-probe');
    const started = await inSandbox('docker', 'run', '-d', '--name', 'memory-probe',
      '--memory', '16m', 'alpine:3.20', 'sleep', '300');
    expect(started.code, started.stderr).toBe(0);
    const killed = await inSandbox('docker', 'kill', 'memory-probe');
    expect(killed.code, killed.stderr).toBe(0);

    // Identical exit code to a genuine OOM. Different flag.
    expect(await probeState()).toBe('exited 137 false 16777216');

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual([
      'The kernel stopped memory-probe for exceeding its memory limit',
    ]);
    const oom = result.checks.find((c) => c.label.includes('kernel stopped'));
    expect(oom?.detail).toContain('exit code 137');
    expect(oom?.detail).toContain('does not report it as killed');
  }, 300_000);

  it('D2. docker stop, and an application exiting 137 itself, also fail', async () => {
    // docker stop where SIGTERM is ignored -> daemon escalates to SIGKILL -> 137.
    await rmInSandbox('memory-probe');
    expect(
      (await inSandbox('docker', 'run', '-d', '--name', 'memory-probe', '--memory', '16m',
        'alpine:3.20', 'sh', '-c', 'trap "" TERM; sleep 300')).code,
    ).toBe(0);
    await inSandbox('docker', 'stop', '-t', '2', 'memory-probe');
    expect(await probeState()).toBe('exited 137 false 16777216');
    expect((await verify()).passed).toBe(false);

    // An application that simply returns 137.
    await rmInSandbox('memory-probe');
    await inSandbox('docker', 'run', '--name', 'memory-probe', '--memory', '16m',
      'alpine:3.20', 'sh', '-c', 'exit 137');
    expect(await probeState()).toBe('exited 137 false 16777216');
    expect((await verify()).passed).toBe(false);
  }, 300_000);

  // ---------------------------------------------------------------- F

  it('F. a past OOM does not survive a restart, so stale evidence cannot pass', async () => {
    await rmInSandbox('memory-probe');
    // First run OOMs; the marker on the writable layer makes the second run exit 0.
    await inSandbox('docker', 'run', '--name', 'memory-probe', '--memory', '16m', 'alpine:3.20',
      'sh', '-c', '[ -f /marker ] && exit 0; touch /marker; dd if=/dev/zero of=/dev/shm/fill bs=1M count=64');
    expect(await probeState()).toBe('exited 137 true 16777216');
    expect((await verify()).passed).toBe(true);

    // Same container, started again, exits cleanly.
    await inSandbox('docker', 'start', '-a', 'memory-probe');
    expect(await probeState()).toBe('exited 0 false 16777216');

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('The kernel stopped memory-probe for exceeding its memory limit');
  }, 300_000);

  it('F2. a genuine OOM at the wrong limit still fails', async () => {
    await rmInSandbox('memory-probe');
    await runProbeOom('8m');
    const state = await probeState();
    expect(state.startsWith('exited 137 true')).toBe(true);

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['Container memory-probe was given a 16m memory limit']);
  }, 300_000);

  it('F3. a compliant decoy container cannot be substituted for the target', async () => {
    await rmInSandbox('memory-probe', 'real-oom');
    // The decoy is a genuine OOM under the right name-adjacent settings…
    await inSandbox('docker', 'run', '--name', 'real-oom', '--memory', '16m', 'alpine:3.20',
      'sh', '-c', 'dd if=/dev/zero of=/dev/shm/fill bs=1M count=64');
    // …while the target was merely killed.
    await inSandbox('docker', 'run', '-d', '--name', 'memory-probe', '--memory', '16m',
      'alpine:3.20', 'sleep', '300');
    await inSandbox('docker', 'kill', 'memory-probe');

    const result = await verify();
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual([
      'The kernel stopped memory-probe for exceeding its memory limit',
    ]);
    await rmInSandbox('real-oom');
  }, 300_000);

  // ---------------------------------------------------------------- I

  it('I. hostile student-controlled values never reach the verifier as code', async () => {
    // Docker itself refuses a container name with shell metacharacters, so a
    // student cannot even create one to point the verifier at.
    for (const name of ['probe;whoami', 'probe|id', 'probe$(id)', 'probe probe']) {
      const r = await inSandbox('docker', 'run', '-d', '--name', name, 'alpine:3.20', 'sleep', '30');
      expect(r.code, `docker should refuse '${name}'`).not.toBe(0);
    }

    // And values a student CAN control — command, env, labels — are inspected
    // as data. A verification run over them must complete normally, not error.
    await rmInSandbox('memory-probe');
    await inSandbox('docker', 'run', '--name', 'memory-probe', '--memory', '16m',
      '--env', 'EVIL=$(touch /tmp/pwned); rm -rf /',
      '--label', 'evil=`id`',
      'alpine:3.20', 'sh', '-c', 'dd if=/dev/zero of=/dev/shm/fill bs=1M count=64');

    const result = await verify();
    // The hostile env/label changed nothing: this is a genuine OOM and passes.
    expect(await probeState()).toBe('exited 137 true 16777216');
    expect(result.checks.find((c) => c.label.includes('kernel stopped'))?.status).toBe('pass');
    // Nothing was executed on the host or in the sandbox as a side effect.
    const pwned = await inSandbox('test', '-e', '/tmp/pwned');
    expect(pwned.code).not.toBe(0);
  }, 300_000);

  // ---------------------------------------------------------------- G

  it('G. reset returns the lab to its clean starting state', async () => {
    // Get back to a passing state first, so the reset has something to undo.
    await rmInSandbox('memory-probe');
    await runProbeOom();
    await writeAnswers('exit_code: 137\ninspect_field: OOMKilled\n');
    expect((await verify()).passed).toBe(true);

    const reset = await provider.reset(context());
    expect(reset.error?.message ?? '').toBe('');
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    // Containers gone, image kept (reset.docker.images is false).
    const ps = await inSandbox('docker', 'ps', '-a', '--format', '{{.Names}}');
    expect(ps.stdout.trim()).toBe('');
    const images = await inSandbox('docker', 'images', '--format', '{{.Repository}}:{{.Tag}}');
    expect(images.stdout).toContain('alpine:3.20');
    const volumes = await inSandbox('docker', 'volume', 'ls', '--quiet');
    expect(volumes.stdout.trim()).toBe('');

    // The worksheet is re-seeded, so a student's old answers cannot survive.
    const answers = await workspace.read(SESSION, 'answers.txt');
    expect(answers).not.toBeNull();
    expect(answers).not.toContain('137');
    expect(answers).not.toContain('OOMKilled');

    const after = await verify();
    expect(after.passed).toBe(false);
    expect(failing(after)).toHaveLength(after.checks.length);
  }, 600_000);

  // ---------------------------------------------------------------- J

  it('J. an existing Docker lab still verifies correctly in the same sandbox', async () => {
    // DOCKER-001 shares this sandbox; its image is pulled by its own setup.
    const pull = await inSandbox('docker', 'pull', 'nginx:1.27-alpine');
    expect(pull.code, pull.stderr).toBe(0);

    const unsolved = await verifyLab({
      lab: docker001,
      namespace: SANDBOX,
      docker: engines.session(SANDBOX),
      workspace: { port: workspace, sessionId: SESSION },
    });
    expect(unsolved.passed).toBe(false);

    const run = await inSandbox('docker', 'run', '-d', '--name', 'web', 'nginx:1.27-alpine');
    expect(run.code, run.stderr).toBe(0);

    const solved = await verifyLab({
      lab: docker001,
      namespace: SANDBOX,
      docker: engines.session(SANDBOX),
      workspace: { port: workspace, sessionId: SESSION },
    });
    expect(solved.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(solved.passed).toBe(true);
    await rmInSandbox('web');
  }, 600_000);
});
