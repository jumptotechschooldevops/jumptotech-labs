/**
 * CAP_NET_RAW against a real Docker daemon.
 *
 * The security review concluded that packet capture is safe *because of where
 * it is allowed*, not because the capability is mild: a student who can capture
 * sees every frame on their link, so the link must carry nothing but their own
 * traffic. That conclusion rests on the per-session bridge holding exactly one
 * container, and this suite is what turns it from an argument into evidence.
 *
 * The centrepiece is the five-session matrix. Five sessions capture
 * concurrently while each emits a marker only it knows; every capture must
 * contain its own marker and none of the other four. That is 5 diagonal cells
 * present and 20 off-diagonal cells absent, and it catches a bridge collision
 * that pairwise checks would miss because it only appears under concurrency.
 *
 * Tier: E2E (PLATFORM-006). Gated on RUN_INTEGRATION_TESTS=1.
 *
 * What it mutates on the shared daemon, and nothing else:
 *   · up to five sandbox containers, named from this run's id
 *   · their per-session `jtt-net-*` networks
 *   · one derived image, built from the shared sandbox image plus tcpdump
 *
 * The image is built here rather than by editing the shared Dockerfile, which
 * belongs to the Linux track. Adding tcpdump there is a coordination item, not
 * something to take unilaterally, and nothing in the platform change requires
 * it — only a lab that actually captures does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CONTAINER_SESSION_LABEL,
  DockerCliRuntime,
  LinuxLabProvider,
  networkRefForSandbox,
  parseLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { scopedTmpPrefix, testRunId } from '@jumptotech/test-support/run-id';
import { sessionContext } from './helpers.js';

const run = promisify(execFile);

const BASE_IMAGE = process.env.NET_RAW_BASE_IMAGE ?? 'jumptotech/lab-linux:net004-e2e';
const CAPTURE_IMAGE = `jumptotech/lab-linux:net-raw-${testRunId()}`;
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

const RUN_HEX = createHash('sha256').update(testRunId()).digest('hex').slice(0, 10);
/** The five sessions the isolation matrix uses. */
const SESSIONS = [0, 1, 2, 3, 4].map((i) => ({
  sandboxRef: `jtt-lab-${RUN_HEX}e${i}`,
  sessionId: `sess-${RUN_HEX}e${i}`,
  marker: `JTTMARKER${RUN_HEX}${i}`,
}));

/**
 * A sixth sandbox, for the lab that asks for *no* capability.
 *
 * Deliberately outside the five: giving it one of their refs would leave a
 * session without `NET_RAW` in the matrix, and the matrix would then fail for
 * the wrong reason entirely.
 */
const PLAIN = {
  sandboxRef: `jtt-lab-${RUN_HEX}f0`,
  sessionId: `sess-${RUN_HEX}f0`,
};

const runtime = new DockerCliRuntime();
const provider = new LinuxLabProvider({ runtime, image: CAPTURE_IMAGE });

let buildDir: string | undefined;

/**
 * A synthetic lab that asks for a segment and the capture capability.
 *
 * Deliberately not a curriculum lab: this suite tests the *platform*
 * capability, and no shipped lab declares `sandbox_capabilities` yet.
 */
function captureLab(): LoadedLabDefinition {
  const yaml = `
id: NET-905
slug: net-905-capture-probe
title: Capture probe
track: networking
topic: layering
difficulty: beginner
duration_minutes: 10
environment:
  provider: linux
  network: link
  sandbox_capabilities: [NET_RAW]
task:
  summary: s
  description: d
requirements:
  - type: file_exists
    path: /home/student/x
    label: l
references:
  - title: RFC 826
    url: https://www.rfc-editor.org/info/rfc826
skills:
  - net.l2.arp
`;
  return {
    ...parseLabDefinition(yaml),
    directory: '/labs/net-905',
    sourcePath: '/labs/net-905/lab.yaml',
  };
}

/** The same lab without the capability, for the negative comparison. */
function plainLab(): LoadedLabDefinition {
  return {
    ...parseLabDefinition(
      `
id: NET-906
slug: net-906-plain-probe
title: Plain probe
track: networking
topic: layering
difficulty: beginner
duration_minutes: 10
environment:
  provider: linux
  network: link
task:
  summary: s
  description: d
requirements:
  - type: file_exists
    path: /home/student/x
    label: l
references:
  - title: RFC 826
    url: https://www.rfc-editor.org/info/rfc826
skills:
  - net.l2.arp
`,
    ),
    directory: '/labs/net-906',
    sourcePath: '/labs/net-906/lab.yaml',
  };
}

function contextFor(index: number, lab: LoadedLabDefinition): LabSessionContext {
  const session = SESSIONS[index]!;
  return sessionContext(lab, {
    sessionId: session.sessionId,
    sandboxRef: session.sandboxRef,
  });
}

function plainContext(): LabSessionContext {
  return sessionContext(plainLab(), {
    sessionId: PLAIN.sessionId,
    sandboxRef: PLAIN.sandboxRef,
  });
}

async function exec(sandboxRef: string, argv: string[], user = 'root') {
  return runtime.exec(sandboxRef, { argv, user, timeoutMs: 60_000 });
}

async function shell(sandboxRef: string, script: string, user = 'root') {
  return exec(sandboxRef, ['bash', '-lc', script], user);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** This sandbox's own prefix and the gateway that shares its segment. */
async function segmentOf(sandboxRef: string) {
  const routes = await exec(sandboxRef, ['ip', '-json', 'route', 'show']);
  const parsed = JSON.parse(routes.stdout) as Array<{ dst?: string; prefsrc?: string }>;
  const connected = parsed.find((r) => r.dst?.includes('/') && r.prefsrc)!;
  const octets = String(connected.dst!.split('/')[0]).split('.');
  return {
    own: connected.prefsrc!,
    prefix: `${octets[0]}.${octets[1]}.`,
    gateway: [octets[0], octets[1], octets[2], '1'].join('.'),
  };
}

async function teardown() {
  for (const session of [...SESSIONS, PLAIN]) {
    const info = await runtime.inspect(session.sandboxRef).catch(() => null);
    if (info && info.labels[CONTAINER_SESSION_LABEL] !== session.sessionId) continue;
    await provider.destroySandbox(session.sandboxRef, session.sessionId).catch(() => undefined);
  }
}

describe.skipIf(!ENABLED)('CAP_NET_RAW, against a real daemon', () => {
  beforeAll(async () => {
    // A derived image: the shared sandbox plus tcpdump. Built here so the
    // shared Dockerfile — another track's file — stays untouched.
    buildDir = await mkdtemp(path.join(tmpdir(), scopedTmpPrefix('netraw')));
    // The shared sandbox image cannot currently be extended with apt at all:
    // it removes /etc/sv/default-syslog, so the `runit` package's postinst
    // trigger fails (`cpsv: fatal: no service found for default-syslog`) and
    // takes dpkg down with it. The directory is restored for the install and
    // removed again afterwards, so the derived image keeps the base's intent —
    // no stray service — while apt is able to run. Reported as a coordination
    // item: whoever adds tcpdump to the shared image will hit the same wall.
    await writeFile(
      path.join(buildDir, 'Dockerfile'),
      [
        `FROM ${BASE_IMAGE}`,
        'RUN set -eux; \\',
        '    mkdir -p /etc/sv/default-syslog; \\',
        "    printf '#!/bin/sh\\nexec /bin/true\\n' > /etc/sv/default-syslog/run; \\",
        '    chmod 0755 /etc/sv/default-syslog/run; \\',
        '    apt-get update; \\',
        '    apt-get install -y --no-install-recommends tcpdump; \\',
        '    rm -rf /etc/sv/default-syslog /etc/runit/runsvdir/default/default-syslog; \\',
        '    rm -rf /var/lib/apt/lists/*',
        '',
      ].join('\n'),
    );
    await run('docker', ['build', '-q', '-t', CAPTURE_IMAGE, buildDir], {
      timeout: 900_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  }, 900_000);

  afterAll(async () => {
    await teardown();
    await run('docker', ['rmi', '-f', CAPTURE_IMAGE]).catch(() => undefined);
    if (buildDir) await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
  }, 300_000);

  // ------------------------------------------------- 1. the capability itself

  it('grants raw sockets only to the lab that asked for them', async () => {
    const withCap = contextFor(0, captureLab());
    expect((await provider.create(withCap)).ok).toBe(true);

    // Capture works, and a raw-socket tool that failed without the capability
    // now succeeds.
    const capabilities = await shell(withCap.sandboxRef!, 'grep CapBnd /proc/self/status');
    expect(capabilities.stdout).toMatch(/CapBnd/);
    const tcpdump = await shell(withCap.sandboxRef!, 'tcpdump --version 2>&1 | head -1');
    expect(tcpdump.stdout).toMatch(/tcpdump/i);
    const canCapture = await shell(
      withCap.sandboxRef!,
      'timeout 5 tcpdump -i eth0 -c 1 -nn >/dev/null 2>&1; echo rc=$?',
    );
    // 0 (a packet) or 124 (timed out waiting) both mean the socket opened.
    expect(canCapture.stdout).toMatch(/rc=(0|124)/);

    // The same sandbox without the capability cannot open one at all.
    const withoutCap = plainContext();
    expect((await provider.create(withoutCap)).ok).toBe(true);
    const denied = await shell(
      withoutCap.sandboxRef!,
      'tcpdump -i eth0 -c 1 -nn 2>&1 | head -2',
    );
    expect(denied.stdout).toMatch(/not permitted|permission denied|no permission/i);
  }, 900_000);

  // --------------------------------------------- 2. the five-session matrix

  it('five concurrent sessions each capture only their own traffic', async () => {
    // Start all five before any traffic, so every capture is running while
    // every marker is emitted. Concurrency is the point.
    await Promise.all(
      SESSIONS.map(async (session, index) => {
        if (await runtime.inspect(session.sandboxRef)) return;
        const created = await provider.create(contextFor(index, captureLab()));
        expect(created.ok, `session ${index}`).toBe(true);
      }),
    );

    const segments = await Promise.all(SESSIONS.map((s) => segmentOf(s.sandboxRef)));

    // Capture on each session's own interface, in the background.
    await Promise.all(
      SESSIONS.map((session) =>
        shell(
          session.sandboxRef,
          'rm -f /tmp/cap.pcap; (setsid tcpdump -i eth0 -nn -s0 -w /tmp/cap.pcap >/dev/null 2>&1 &) ; sleep 2; echo started',
        ),
      ),
    );

    // Every session emits a marker only it knows, at the same time.
    await Promise.all(
      SESSIONS.map((session, index) =>
        shell(
          session.sandboxRef,
          `for i in 1 2 3 4 5; do printf '%s' '${session.marker}' | socat -T1 - UDP-DATAGRAM:${segments[index]!.gateway}:9999 2>/dev/null || true; sleep 0.3; done; echo sent`,
        ),
      ),
    );

    await sleep(3_000);
    await Promise.all(
      SESSIONS.map((session) => shell(session.sandboxRef, 'pkill -f tcpdump || true; sleep 1')),
    );

    // Read every capture as text once, then build the matrix from it.
    const captures = await Promise.all(
      SESSIONS.map(async (session) => {
        const read = await shell(
          session.sandboxRef,
          'tcpdump -r /tmp/cap.pcap -nn -A 2>/dev/null | tr -d "\\0" || true',
        );
        return read.stdout;
      }),
    );

    const matrix = captures.map((capture) =>
      SESSIONS.map((session) => capture.includes(session.marker)),
    );

    // Diagonal: each session sees its own traffic.
    for (const [index, row] of matrix.entries()) {
      expect(row[index], `session ${index} could not capture its own marker`).toBe(true);
    }
    // Off-diagonal: no session sees any other's. Twenty cells.
    for (const [i, row] of matrix.entries()) {
      for (const [j, seen] of row.entries()) {
        if (i === j) continue;
        expect(seen, `session ${i} captured session ${j}'s marker`).toBe(false);
      }
    }

    // And nothing from outside the session's own segment appears at all — no
    // platform API, terminal, kind or host traffic, because none of it
    // traverses this link.
    for (const [index, capture] of captures.entries()) {
      const foreign = [...capture.matchAll(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g)]
        .map((match) => `${match[1]}.`)
        .filter((prefix) => prefix !== segments[index]!.prefix);
      expect(foreign, `session ${index} saw addresses outside its own segment`).toEqual([]);
    }
  }, 1_800_000);

  // ------------------------------------------------------- 3. the boundaries

  it('cannot reach or join another session, the host, or the daemon', async () => {
    const a = SESSIONS[0]!;
    const b = SESSIONS[1]!;
    const segmentB = await segmentOf(b.sandboxRef);

    // Another session's sandbox is unreachable at the routing layer.
    const cross = await shell(
      a.sandboxRef,
      `nc -w 3 -v ${segmentB.own} 22 2>&1 | tail -1`,
    );
    expect(cross.stdout).toMatch(/unreachable|refused|timed out/i);

    // Exactly one interface carries traffic: the veth into this session's own
    // bridge. No host interfaces, no docker0, no other session's bridge.
    // (`lo` is reported UNKNOWN rather than UP by `ip -brief link`, so it is
    // excluded here and asserted separately below.)
    const links = await shell(a.sandboxRef, "ip -brief link show | awk '$2==\"UP\"{print $1}'");
    const up = links.stdout.split('\n').map((l) => l.split('@')[0]!.trim()).filter(Boolean);
    expect(up).toEqual(['eth0']);
    const loopback = await shell(a.sandboxRef, "ip -brief link show lo | awk '{print $1}'");
    expect(loopback.stdout.trim()).toBe('lo');

    // No Docker socket, and no route off the segment.
    const socket = await shell(a.sandboxRef, 'ls /var/run/docker.sock 2>&1 | tail -1');
    expect(socket.stdout).toMatch(/No such file/i);
    const routes = await shell(a.sandboxRef, 'ip route show');
    expect(routes.stdout).not.toMatch(/default/);

    // A forged identifier is refused before any daemon call is made.
    expect(() => networkRefForSandbox('bridge')).toThrow();
    expect(() => networkRefForSandbox('../../etc')).toThrow();
    await expect(runtime.networkRemove('bridge')).rejects.toThrow();
    await expect(runtime.networkRemove('jumptotech-sandboxes')).rejects.toThrow();

    // B's network still exists: naming it from A's teardown is impossible.
    expect(await runtime.networkInspect(networkRefForSandbox(b.sandboxRef))).not.toBeNull();
  }, 900_000);

  // ------------------------------------------------- 4. lifecycle and cleanup

  it('reset replaces the sandbox, killing any capture with it', async () => {
    const context = contextFor(0, captureLab());
    await shell(
      context.sandboxRef!,
      '(setsid tcpdump -i eth0 -nn -w /tmp/cap2.pcap >/dev/null 2>&1 &) ; sleep 2; pgrep -c tcpdump',
    );

    const reset = await provider.reset(context);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    // `pgrep -c` prints its count *and* exits non-zero when there are none, so
    // a `||` fallback would append a second line rather than replace it.
    const after = await shell(context.sandboxRef!, 'pgrep -c tcpdump | head -1');
    expect(after.stdout.trim()).toBe('0');
    // The capture file went with the container, and the segment came back.
    const stale = await shell(context.sandboxRef!, 'ls /tmp/cap2.pcap 2>&1 | tail -1');
    expect(stale.stdout).toMatch(/No such file/i);
    expect(await runtime.networkInspect(networkRefForSandbox(context.sandboxRef!))).not.toBeNull();
  }, 900_000);

  it('ending one session leaves the others untouched, and removes its capability with it', async () => {
    const a = SESSIONS[0]!;
    const b = SESSIONS[1]!;

    await provider.destroySandbox(a.sandboxRef, a.sessionId);

    expect(await runtime.inspect(a.sandboxRef)).toBeNull();
    expect(await runtime.networkInspect(networkRefForSandbox(a.sandboxRef))).toBeNull();

    // B is entirely unaffected.
    expect((await runtime.inspect(b.sandboxRef))?.state).toBe('running');
    expect(await runtime.networkInspect(networkRefForSandbox(b.sandboxRef))).not.toBeNull();
  }, 900_000);

  it('leaves no container or network behind', async () => {
    await teardown();

    for (const session of SESSIONS) {
      expect(await runtime.inspect(session.sandboxRef)).toBeNull();
      expect(await runtime.networkInspect(networkRefForSandbox(session.sandboxRef))).toBeNull();
    }
  }, 600_000);
});
