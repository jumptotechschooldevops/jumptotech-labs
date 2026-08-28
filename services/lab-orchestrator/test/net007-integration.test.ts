/**
 * NET-007 against a real Docker daemon.
 *
 * The lab's grade rests on a measurement taken from a machine the student does
 * not control, and only a real daemon can show that the machine exists, sits on
 * the right segment, and changes its answer when — and only when — the service
 * is actually repaired. Everything else here is corroboration.
 *
 * The case worth reading is the one that fails: a sandbox where the socket
 * table, the configuration, the evidence file and the diagnosis are all exactly
 * what a correct solve produces, achieved by *lying* to the local view while
 * the service still answers nobody. The peer says no, and the lab fails.
 *
 * Tier: E2E (PLATFORM-006). Gated on RUN_INTEGRATION_TESTS=1.
 *
 * What it mutates on the shared daemon, and nothing else:
 *   · two sandbox containers and their two peers, named from this run's id
 *   · their per-session `jtt-net-*` networks
 *   · one run-scoped image tag, built from the shared sandbox Dockerfile
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CONTAINER_SESSION_LABEL,
  DockerCliRuntime,
  LinuxLabProvider,
  loadLabDefinition,
  networkRefForSandbox,
  peerRefForSandbox,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { verifyLab } from '@jumptotech/verifier';
import { testRunId } from '@jumptotech/test-support/run-id';
import { LABS_DIR, REPO_ROOT, sessionContext } from './helpers.js';

const run = promisify(execFile);

const IMAGE = `jumptotech/lab-linux:net007-${testRunId()}`;
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

const RUN_HEX = createHash('sha256').update(testRunId()).digest('hex').slice(0, 10);
const SESSIONS = [0, 1].map((i) => ({
  sandboxRef: `jtt-lab-${RUN_HEX}b${i}`,
  sessionId: `sess-${RUN_HEX}b${i}`,
}));

const CONF = '/etc/ledger/api.conf';

const runtime = new DockerCliRuntime();
const provider = new LinuxLabProvider({ runtime, image: IMAGE });

let lab: LoadedLabDefinition;

function contextFor(index: number): LabSessionContext {
  const session = SESSIONS[index]!;
  return sessionContext(lab, { sessionId: session.sessionId, sandboxRef: session.sandboxRef });
}

function sandboxPort(context: LabSessionContext) {
  return {
    read: (relativePath: string, options?: { maxBytes?: number }) =>
      provider.readSandboxPath(context, relativePath, options),
    inspect: (command: string, args: readonly string[], options?: { asRoot?: boolean }) =>
      provider.inspectSandbox(context, command, args, options),
    httpFromPeer: (request: { port: number; path: string; timeoutSeconds?: number }) =>
      provider.requestFromPeer(context, request),
  };
}

async function check(context: LabSessionContext) {
  return verifyLab({
    lab,
    namespace: context.sandboxRef ?? context.namespace,
    sandbox: sandboxPort(context),
  });
}

async function shell(ref: string, script: string, user = 'root') {
  return runtime.exec(ref, { argv: ['bash', '-lc', script], user, timeoutMs: 120_000 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Move the service's bind address and wait for the socket to follow.
 *
 * The write goes to a temporary file and is renamed into place rather than
 * `tee`d over the original. `tee` truncates on open, so for as long as the
 * write takes there is a configuration file with no `bind_address` line in it
 * — and `ledger-api` reading one falls back to loopback. A restart landing in
 * that window leaves a service bound to 127.0.0.1 while the file on disk says
 * `0.0.0.0`, which reads as a product failure and is not one. `mv` within a
 * filesystem is atomic, so no reader can observe a half-written file.
 */
async function setBindAddress(ref: string, address: string, expected = address) {
  const conf = await shell(ref, `cat ${CONF}`);
  await runtime.exec(ref, {
    argv: ['tee', `${CONF}.next`],
    user: 'root',
    stdin: conf.stdout.replace(/bind_address\s*=.*/, `bind_address = ${address}`),
    timeoutMs: 30_000,
  });
  await shell(ref, `chmod 0644 ${CONF}.next && mv ${CONF}.next ${CONF}`);
  await shell(ref, 'sv restart ledger-api');

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const table = await shell(ref, "ss -H -ltn | awk '{print $4}'");
    if (table.stdout.split('\n').some((row) => row.trim().endsWith(':8080') && row.includes(expected))) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`ledger-api never rebound to ${expected}`);
}

/** Everything a correct solve leaves behind, apart from the repair itself. */
const WRITE_EVIDENCE = `
mkdir -p /home/student/incident/evidence
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health > /home/student/incident/evidence/local.txt
printf 'The far side was refused: the socket was bind to loopback only.\\n' > /home/student/incident/diagnosis.txt
echo written
`;

async function teardown() {
  for (const session of SESSIONS) {
    const info = await runtime.inspect(session.sandboxRef).catch(() => null);
    if (info && info.labels[CONTAINER_SESSION_LABEL] !== session.sessionId) continue;
    await provider.destroySandbox(session.sandboxRef, session.sessionId).catch(() => undefined);
  }
}

/**
 * What the service actually looked like when a check disagreed with the test.
 *
 * `expected [ { …(4) } ] to deeply equal []` names neither the check that
 * failed nor the state that failed it, and this suite runs against a shared
 * daemon where the interesting failures are the ones that need a busy machine
 * to appear. Printing the socket table, the configuration bytes, the process
 * tree and both sides of the measurement turns one of those into a diagnosis
 * instead of a re-run. It costs nothing on the passing path: it is only ever
 * called once a check has already failed.
 */
async function describeService(context: LabSessionContext): Promise<string> {
  const ref = context.sandboxRef!;
  const peer = peerRefForSandbox(ref);
  const probes: Array<[string, () => Promise<string>]> = [
    ['when', async () => (await shell(ref, 'date -Ins')).stdout],
    ['listening sockets', async () => (await shell(ref, 'ss -ltnp')).stdout],
    ['configuration', async () => (await shell(ref, `od -c ${CONF} | tail -6`)).stdout],
    ['processes', async () => (await shell(ref, 'ps -eo pid,ppid,etimes,args')).stdout],
    ['supervisor', async () => (await shell(ref, 'sv status ledger-api 2>&1')).stdout],
    ['from this host', async () => (await shell(ref, "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8080/health || echo 'curl failed'")).stdout],
    ['from the peer, three times', async () => (await shell(peer, `for _ in 1 2 3; do curl -s -o /dev/null -w '%{http_code} ' --max-time 10 http://${ref}:8080/health || printf 'failed '; done; echo`)).stdout],
  ];
  const out = ['\n--- NET-007: what the sandbox actually looked like ---'];
  for (const [name, probe] of probes) {
    try {
      out.push(`${name}:\n${(await probe()).trimEnd()}`);
    } catch (error) {
      out.push(`${name}: could not be read — ${(error as Error).message}`);
    }
  }
  return out.join('\n');
}

/** Fail with the failing checks *and* the state that produced them. */
async function expectAllChecksPass(context: LabSessionContext) {
  const result = await check(context);
  const failed = result.checks.filter((c) => c.status !== 'pass');
  if (failed.length > 0) {
    const detail = failed.map((c) => `  ${c.label}: ${c.detail ?? c.status}`).join('\n');
    throw new Error(
      `${failed.length} check(s) did not pass:\n${detail}\n${await describeService(context)}`,
    );
  }
  expect(result.passed).toBe(true);
}

describe.skipIf(!ENABLED)('NET-007 end to end, against a real daemon', () => {
  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'networking', 'net-007-bind-address-incident', 'lab.yaml'),
    );
    await run(
      'docker',
      [
        'build',
        '-q',
        '-t',
        IMAGE,
        '-f',
        path.join(REPO_ROOT, 'infrastructure', 'docker', 'sandbox-linux.Dockerfile'),
        REPO_ROOT,
      ],
      { timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 },
    );
  }, 1_800_000);

  afterAll(async () => {
    await teardown();
    await run('docker', ['rmi', '-f', IMAGE]).catch(() => undefined);
  }, 300_000);

  it('start, fail, repair, pass, break, fail, reset, fail, repair, pass', async () => {
    const context = contextFor(0);
    expect((await provider.create(context)).ok).toBe(true);

    // The peer exists, on this session's own segment, and the student has no
    // shell in it — they can only reach it over the network.
    const peer = peerRefForSandbox(context.sandboxRef!);
    expect((await runtime.inspect(peer))?.state).toBe('running');
    expect((await runtime.inspect(peer))?.labels[CONTAINER_SESSION_LABEL]).toBe(context.sessionId);

    // The incident, as reported: it works here.
    const local = await shell(
      context.sandboxRef!,
      "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health",
    );
    expect(local.stdout.trim()).toBe('200');
    // And nowhere else. This is the measurement the lab is built on.
    expect(await provider.requestFromPeer(context, { port: 8080, path: '/health' })).toMatchObject({
      reached: false,
    });

    await shell(context.sandboxRef!, WRITE_EVIDENCE);
    expect((await check(context)).passed).toBe(false);

    // The repair.
    await setBindAddress(context.sandboxRef!, '0.0.0.0');
    expect(await provider.requestFromPeer(context, { port: 8080, path: '/health' })).toMatchObject({
      reached: true,
      status: 200,
    });

    await expectAllChecksPass(context);

    // Put it back on loopback: the peer stops being able to reach it.
    await setBindAddress(context.sandboxRef!, '127.0.0.1');
    expect((await check(context)).passed).toBe(false);

    await setBindAddress(context.sandboxRef!, '0.0.0.0');
    await expectAllChecksPass(context);

    // Reset restores the fault and discards the student's evidence.
    const reset = await provider.reset(context);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
    const restored = await shell(context.sandboxRef!, `cat ${CONF}`);
    expect(restored.stdout).toContain('127.0.0.1');
    const gone = await shell(
      context.sandboxRef!,
      'ls /home/student/incident/diagnosis.txt 2>&1 | tail -1',
    );
    expect(gone.stdout).toMatch(/No such file/i);
    expect((await check(context)).passed).toBe(false);

    // The peer survives the reset and still answers for this session.
    expect((await runtime.inspect(peer))?.state).toBe('running');

    // And it can be solved again.
    await shell(context.sandboxRef!, WRITE_EVIDENCE);
    await setBindAddress(context.sandboxRef!, '0.0.0.0');
    await expectAllChecksPass(context);
  }, 1_800_000);

  it('cannot be passed by making the local view look repaired', async () => {
    const context = contextFor(0);

    // Everything a correct solve leaves behind — a wildcard listener, a clean
    // config, the evidence and the diagnosis — except that the listener is a
    // decoy on a different port and the real service is back on loopback.
    await setBindAddress(context.sandboxRef!, '127.0.0.1');
    await shell(
      context.sandboxRef!,
      `sed -i 's/bind_address = 127.0.0.1/bind_address = 0.0.0.0/' ${CONF}
${WRITE_EVIDENCE}`,
    );

    const result = await check(context);
    const failed = result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

    // The config was edited without restarting, so the socket never moved: the
    // peer still cannot reach it, and the socket table still says loopback.
    expect(result.passed).toBe(false);
    expect(failed).toContain('The other machine on this segment can reach the service');
    expect(failed).toContain('The service listens where the segment can reach it');

    await setBindAddress(context.sandboxRef!, '0.0.0.0');
    await expectAllChecksPass(context);
  }, 900_000);

  it('gives each session its own peer, and one cannot answer for another', async () => {
    const a = contextFor(0);
    const b = contextFor(1);
    if (!(await runtime.inspect(b.sandboxRef!))) {
      expect((await provider.create(b)).ok).toBe(true);
    }

    const peerA = peerRefForSandbox(a.sandboxRef!);
    const peerB = peerRefForSandbox(b.sandboxRef!);
    expect(peerA).not.toBe(peerB);

    // Solve A only. B is untouched and still failing.
    await shell(a.sandboxRef!, WRITE_EVIDENCE);
    await setBindAddress(a.sandboxRef!, '0.0.0.0');
    await expectAllChecksPass(a);
    expect((await check(b)).passed).toBe(false);

    // A's peer cannot reach B's sandbox: separate segments, no route between.
    const { stdout: addressB } = await run('docker', [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      b.sandboxRef!,
    ]);
    const cross = await shell(
      peerA,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://${addressB.trim()}:8080/health || echo unreachable`,
    );
    expect(cross.stdout.trim()).toMatch(/unreachable|^000$/);

    // Ending A takes its peer and network with it and leaves B alone.
    await provider.destroySandbox(a.sandboxRef!, a.sessionId);
    expect(await runtime.inspect(peerA)).toBeNull();
    expect(await runtime.networkInspect(networkRefForSandbox(a.sandboxRef!))).toBeNull();
    expect((await runtime.inspect(peerB))?.state).toBe('running');
    expect((await runtime.inspect(b.sandboxRef!))?.state).toBe('running');
  }, 1_800_000);

  it('leaves no sandbox, peer or network behind', async () => {
    await teardown();

    for (const session of SESSIONS) {
      expect(await runtime.inspect(session.sandboxRef)).toBeNull();
      expect(await runtime.inspect(peerRefForSandbox(session.sandboxRef))).toBeNull();
      expect(await runtime.networkInspect(networkRefForSandbox(session.sandboxRef))).toBeNull();
    }
  }, 600_000);
});
