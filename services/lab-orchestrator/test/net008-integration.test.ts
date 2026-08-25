/**
 * NET-008 against a real Docker daemon.
 *
 * The platform suite next door proves the capability is safe in general. This
 * one proves the *lab* works and stays inside its boundary: that a student can
 * capture the exchanges it asks for, that typing a transcript is not enough,
 * that five students running it at once are graded from their own sandboxes,
 * and that none of them can widen the grant they were given.
 *
 * Tier: E2E (PLATFORM-006). Gated on RUN_INTEGRATION_TESTS=1.
 *
 * What it mutates on the shared daemon, and nothing else:
 *   · up to five sandbox containers, named from this run's id
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
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { verifyLab } from '@jumptotech/verifier';
import { testRunId } from '@jumptotech/test-support/run-id';
import { LABS_DIR, REPO_ROOT, sessionContext } from './helpers.js';

const run = promisify(execFile);

const IMAGE = `jumptotech/lab-linux:net008-${testRunId()}`;
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

const RUN_HEX = createHash('sha256').update(testRunId()).digest('hex').slice(0, 10);
const SESSIONS = [0, 1, 2, 3, 4].map((i) => ({
  sandboxRef: `jtt-lab-${RUN_HEX}a${i}`,
  sessionId: `sess-${RUN_HEX}a${i}`,
}));

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
  };
}

async function check(context: LabSessionContext) {
  return verifyLab({
    lab,
    namespace: context.sandboxRef ?? context.namespace,
    sandbox: sandboxPort(context),
  });
}

async function shell(sandboxRef: string, script: string, user = 'root') {
  return runtime.exec(sandboxRef, { argv: ['bash', '-lc', script], user, timeoutMs: 120_000 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The student workflow from the brief: capture on loopback while producing a
 * handshake, a refusal and a datagram, then record the socket table.
 *
 * `pkill -x` rather than `-f`: the pattern would otherwise match this very
 * shell's own command line and kill the script mid-run.
 */
const SOLVE = `
set -e
cd /home/student/tcp
rm -f cap.pcap handshake.txt refused.txt udp.txt states.txt
(setsid tcpdump -i lo -nn -s0 -w /tmp/cap.pcap >/dev/null 2>&1 &)
sleep 2
printf 'ledger\\n' | timeout 5 nc -q1 127.0.0.1 9200 >/dev/null 2>&1 || true
printf 'metric\\n' | timeout 5 nc -u -w1 127.0.0.1 9201 >/dev/null 2>&1 || true
timeout 5 nc -w2 127.0.0.1 9202 </dev/null >/dev/null 2>&1 || true
sleep 2
pkill -x tcpdump || true
sleep 1
tcpdump -r /tmp/cap.pcap -nn 2>/dev/null | grep 9200 > handshake.txt || true
tcpdump -r /tmp/cap.pcap -nn 2>/dev/null | grep 9202 > refused.txt || true
tcpdump -r /tmp/cap.pcap -nn 2>/dev/null | grep 9201 > udp.txt || true
ss -tan > states.txt
printf '  udp_holds_connection_state = no\\n  retry_on_refused_helps = no\\n  time_wait_belongs_to = the side that closed first\\n' > answers.txt
echo solved
`;

async function teardown() {
  for (const session of SESSIONS) {
    const info = await runtime.inspect(session.sandboxRef).catch(() => null);
    if (info && info.labels[CONTAINER_SESSION_LABEL] !== session.sessionId) continue;
    await provider.destroySandbox(session.sandboxRef, session.sessionId).catch(() => undefined);
  }
}

describe.skipIf(!ENABLED)('NET-008 end to end, against a real daemon', () => {
  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'networking', 'net-008-tcp-lifecycle', 'lab.yaml'),
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

  it('start, fail, capture, pass, break, fail, reset, fail, capture, pass', async () => {
    const context = contextFor(0);
    expect((await provider.create(context)).ok).toBe(true);

    // The lab declared the capability, so the sandbox has it — and only it.
    const caps = await shell(context.sandboxRef!, 'capsh --print 2>/dev/null | head -2 || grep CapBnd /proc/self/status');
    expect(caps.stdout).toBeTruthy();
    const admin = await shell(
      context.sandboxRef!,
      'ip link add dummy0 type dummy 2>&1 | head -1 || true',
    );
    expect(admin.stdout).toMatch(/not permitted|Operation not permitted/i);

    const before = await check(context);
    expect(before.passed).toBe(false);

    const solved = await shell(context.sandboxRef!, SOLVE);
    expect(solved.stdout).toContain('solved');

    const after = await check(context);
    expect(after.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(after.passed).toBe(true);

    // Break one observation: a capture without the SYN-ACK is a connection
    // that never completed.
    await shell(
      context.sandboxRef!,
      "cd /home/student/tcp && grep -v '\\[S\\.\\]' handshake.txt > h2 && mv h2 handshake.txt",
    );
    expect((await check(context)).passed).toBe(false);

    // Reset restores the fixture and discards the student's work.
    const reset = await provider.reset(context);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
    const gone = await shell(context.sandboxRef!, 'ls /home/student/tcp/handshake.txt 2>&1 | tail -1');
    expect(gone.stdout).toMatch(/No such file/i);
    const logs = await shell(
      context.sandboxRef!,
      'wc -c < /var/log/jumptotech/tcp-echo.log',
    );
    expect(logs.stdout.trim()).toBe('0');
    expect((await check(context)).passed).toBe(false);

    // And it can be done again from the restored baseline.
    await shell(context.sandboxRef!, SOLVE);
    expect((await check(context)).passed).toBe(true);
  }, 1_800_000);

  it('cannot be passed by typing the capture without ever connecting', async () => {
    const context = contextFor(1);
    expect((await provider.create(context)).ok).toBe(true);

    // Byte-for-byte what a correct run produces — written by hand, with no
    // traffic sent at all. The services recorded nothing, so it fails.
    await shell(
      context.sandboxRef!,
      `cd /home/student/tcp
printf 'IP 127.0.0.1.5 > 127.0.0.1.9200: Flags [S], length 0\\nIP 127.0.0.1.9200 > 127.0.0.1.5: Flags [S.], length 0\\n' > handshake.txt
printf 'IP 127.0.0.1.9202 > 127.0.0.1.5: Flags [R.], length 0\\n' > refused.txt
printf 'IP 127.0.0.1.5 > 127.0.0.1.9201: UDP, length 7\\n' > udp.txt
printf 'TIME-WAIT 0 0 127.0.0.1:5 127.0.0.1:9200\\n' > states.txt
printf '  udp_holds_connection_state = no\\n  retry_on_refused_helps = no\\n  time_wait_belongs_to = the side that closed first\\n' > answers.txt`,
    );

    const result = await check(context);
    const failed = result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

    expect(result.passed).toBe(false);
    expect(failed).toEqual([
      'A TCP connection was really completed against the echo service',
      'A datagram really reached the metrics socket',
    ]);
  }, 900_000);

  it('five concurrent students are graded from their own sandboxes and cannot see each other', async () => {
    await Promise.all(
      SESSIONS.map(async (session, index) => {
        if (await runtime.inspect(session.sandboxRef)) return;
        expect((await provider.create(contextFor(index))).ok, `session ${index}`).toBe(true);
      }),
    );

    // Every session captures while every session generates traffic.
    await Promise.all(SESSIONS.map((s) => shell(s.sandboxRef, SOLVE)));

    const verdicts = await Promise.all(SESSIONS.map((_, i) => check(contextFor(i))));
    for (const [index, verdict] of verdicts.entries()) {
      expect(verdict.passed, `session ${index} should pass on its own work`).toBe(true);
    }

    // Each capture contains only this session's own loopback traffic: the
    // segments are separate, and loopback is per network namespace besides.
    const captures = await Promise.all(
      SESSIONS.map((s) =>
        shell(s.sandboxRef, 'tcpdump -r /tmp/cap.pcap -nn 2>/dev/null | wc -l'),
      ),
    );
    for (const capture of captures) {
      expect(Number(capture.stdout.trim())).toBeGreaterThan(0);
    }

    // Undo one session's work: only that session's verdict changes.
    await shell(SESSIONS[2]!.sandboxRef, 'rm -f /home/student/tcp/handshake.txt');
    expect((await check(contextFor(2))).passed).toBe(false);
    expect((await check(contextFor(0))).passed).toBe(true);
    expect((await check(contextFor(4))).passed).toBe(true);
  }, 2_400_000);

  it('a student cannot widen the grant they were given', async () => {
    const a = SESSIONS[0]!;
    const b = SESSIONS[1]!;

    // No NET_ADMIN: interface, route and firewall mutation all refused, even
    // through sudo, because the capability is not in the bounding set.
    for (const attempt of [
      'ip link add dummy0 type dummy',
      'ip route add 10.80.0.0/24 dev eth0',
      'ip neigh add 10.80.0.5 lladdr de:ad:be:ef:00:01 dev eth0',
    ]) {
      const denied = await shell(a.sandboxRef, `sudo ${attempt} 2>&1 | head -1`);
      expect(denied.stdout, attempt).toMatch(/not permitted/i);
    }

    // No route to another session's sandbox, addressed by the IP the daemon
    // actually gave it rather than by a name that would never resolve anyway.
    const { stdout: addressB } = await run('docker', [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      b.sandboxRef,
    ]);
    const peer = addressB.trim();
    expect(peer, "session B should have an address on its own segment").toMatch(
      /^\d+\.\d+\.\d+\.\d+$/,
    );
    const cross = await shell(a.sandboxRef, `nc -w 3 -v ${peer} 9200 </dev/null 2>&1 | tail -1`);
    expect(cross.stdout).toMatch(/unreachable|refused|timed out|Operation now in progress/i);
    const socket = await shell(a.sandboxRef, 'ls /var/run/docker.sock 2>&1 | tail -1');
    expect(socket.stdout).toMatch(/No such file/i);

    // Only the veth into this session's own bridge carries traffic.
    const up = await shell(a.sandboxRef, "ip -brief link show | awk '$2==\"UP\"{print $1}'");
    expect(up.stdout.split('\n').map((l) => l.split('@')[0]!.trim()).filter(Boolean)).toEqual([
      'eth0',
    ]);
  }, 900_000);

  it('leaves no container or network behind', async () => {
    await teardown();

    for (const session of SESSIONS) {
      expect(await runtime.inspect(session.sandboxRef)).toBeNull();
      expect(await runtime.networkInspect(networkRefForSandbox(session.sandboxRef))).toBeNull();
    }
  }, 600_000);
});
