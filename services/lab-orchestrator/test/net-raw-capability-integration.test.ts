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
 *   · one run-scoped image tag, built from the shared sandbox Dockerfile
 *
 * The image is built from the shared Dockerfile under a run-scoped tag rather
 * than from a derived one: tcpdump now ships in the sandbox image itself, so
 * the earlier workaround — restoring `/etc/sv/default-syslog` so apt could run
 * at all — is gone along with the defect that required it.
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
  networkRefForSandbox,
  parseLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { testRunId } from '@jumptotech/test-support/run-id';
import { REPO_ROOT, sessionContext } from './helpers.js';

const run = promisify(execFile);

const CAPTURE_IMAGE = `jumptotech/lab-linux:net-raw-${testRunId()}`;
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

const RUN_HEX = createHash('sha256').update(testRunId()).digest('hex').slice(0, 10);
/** The five sessions the isolation matrix uses. */
const SESSIONS = [0, 1, 2, 3, 4].map((i) => ({
  sandboxRef: `jtt-lab-${RUN_HEX}e${i}`,
  sessionId: `sess-${RUN_HEX}e${i}`,
  marker: `JTTMARKER${RUN_HEX}${i}`,
}));

/** Every shape of traffic each session tags with its marker. */
const MARKER_KINDS = [
  'unicast',
  'link-local-multicast',
  'limited-broadcast',
  'subnet-broadcast',
  'igmp',
] as const;

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

/** This sandbox's own address, its segment's broadcast, and the gateway that shares it. */
async function segmentOf(sandboxRef: string) {
  const routes = await exec(sandboxRef, ['ip', '-json', 'route', 'show']);
  const parsed = JSON.parse(routes.stdout) as Array<{ dst?: string; prefsrc?: string }>;
  const connected = parsed.find((r) => r.dst?.includes('/') && r.prefsrc)!;
  const [base, bits] = connected.dst!.split('/') as [string, string];
  const octets = base.split('.');
  // The whole prefix, not its first two octets: once Docker's /16 pool is
  // spent it hands out 192.168.x.0/20s, and two sessions would then share
  // "192.168." while sitting on different segments.
  const network = octets.reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const broadcast = network + 2 ** (32 - Number(bits)) - 1;
  return {
    own: connected.prefsrc!,
    broadcast: [24, 16, 8, 0].map((shift) => Math.floor(broadcast / 2 ** shift) % 256).join('.'),
    gateway: [octets[0], octets[1], octets[2], '1'].join('.'),
  };
}

type Segment = Awaited<ReturnType<typeof segmentOf>>;

/**
 * A BPF filter matching every IPv4 or ARP packet that is *not* one of the
 * exchanges a single-sandbox segment legitimately carries.
 *
 * The segment holds exactly two addresses — the sandbox and the host side of
 * its own bridge — so anything naming a third address is foreign, whoever
 * sent it. Each allowance below is a packet class this suite has observed
 * and attributed, not a range waved through:
 *
 *   · sandbox → gateway, subnet broadcast, 255.255.255.255, or link-local
 *     multicast (224.0.0.0/24): the sandbox's own emissions, which the matrix
 *     below generates on purpose.
 *   · gateway → sandbox: replies, e.g. ICMP port unreachable for the markers.
 *   · gateway → 224.0.0.0/24, IGMP only: the bridge's own membership reports.
 *     With multicast snooping on (the Linux default) a bridge joins the
 *     all-snoopers group 224.0.0.106 (RFC 4286) when it comes up and announces
 *     it — `172.x.0.1 > 224.0.0.22: igmp v3 report [gaddr 224.0.0.106]`, TTL 1.
 *     Timing decides whether a capture catches it, which is why it failed
 *     only intermittently. It is sourced from this session's own gateway and
 *     is link-local, so it can carry nothing about any other session.
 *
 * Another session's bridge reporting the same group has another session's
 * gateway as its source, and fails here.
 */
function foreignTrafficFilter({ own, gateway, broadcast }: Segment): string {
  const fromSandbox = `src host ${own} and (dst host ${gateway} or dst host ${broadcast} or dst host 255.255.255.255 or dst net 224.0.0.0/24)`;
  const fromGateway = `src host ${gateway} and (dst host ${own} or (ip proto 2 and dst net 224.0.0.0/24))`;
  const arp = `(src host ${own} or src host ${gateway}) and (dst host ${own} or dst host ${gateway})`;
  return `(ip and not ((${fromSandbox}) or (${fromGateway}))) or (arp and not (${arp}))`;
}

/** Every packet in `pcap` that `segment` does not account for, one tcpdump line each. */
async function foreignPackets(sandboxRef: string, segment: Segment) {
  const read = await shell(
    sandboxRef,
    `tcpdump -r /tmp/cap.pcap -nn -e -v '${foreignTrafficFilter(segment)}' 2>/tmp/foreign.err; echo "rc=$?"; cat /tmp/foreign.err >&2`,
  );
  // A filter tcpdump refused would match nothing and pass vacuously.
  expect(read.stdout, `tcpdump rejected the filter: ${read.stderr}`).toMatch(/rc=0\s*$/);
  return read.stdout.replace(/rc=0\s*$/, '').split('\n').filter((line) => line.trim() !== '');
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
    // Built from the shared sandbox Dockerfile, under this run's own tag so
    // concurrent worktrees cannot collide on `:latest`.
    await run(
      'docker',
      [
        'build',
        '-q',
        '-t',
        CAPTURE_IMAGE,
        '-f',
        path.join(REPO_ROOT, 'infrastructure', 'docker', 'sandbox-linux.Dockerfile'),
        REPO_ROOT,
      ],
      { timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 },
    );
  }, 900_000);

  afterAll(async () => {
    await teardown();
    await run('docker', ['rmi', '-f', CAPTURE_IMAGE]).catch(() => undefined);
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

    // Every session emits markers only it knows, at the same time, in every
    // shape a link can flood: unicast to its gateway, and the three
    // destinations a bridge delivers to all ports — link-local multicast,
    // limited broadcast, subnet broadcast — plus a raw IGMP report to
    // 224.0.0.22, the very packet class the bridges emit themselves. If any
    // of those could cross a segment, the capture on the far side would carry
    // the marker.
    await Promise.all(
      SESSIONS.map((session, index) =>
        shell(
          session.sandboxRef,
          `for i in 1 2 3 4 5; do printf '%s' '${session.marker}-unicast' | socat -T1 - UDP-DATAGRAM:${segments[index]!.gateway}:9999 2>/dev/null || true; sleep 0.3; done
python3 - '${segments[index]!.broadcast}' '${session.marker}' <<'PY'
import socket, sys, time
subnet_broadcast, marker = sys.argv[1:3]
SO_BINDTODEVICE = 25

def udp(kind, destination):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, b'eth0')
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
    sock.sendto(f'{marker}-{kind}'.encode(), (destination, 9999))
    sock.close()

def igmp():
    sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_IGMP)
    sock.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, b'eth0')
    sock.sendto(bytes([0x22, 0, 0, 0, 0, 0, 0, 0]) + f'{marker}-igmp'.encode(), ('224.0.0.22', 0))
    sock.close()

for _ in range(5):
    udp('link-local-multicast', '224.0.0.251')
    udp('limited-broadcast', '255.255.255.255')
    udp('subnet-broadcast', subnet_broadcast)
    igmp()
    time.sleep(0.3)
PY
echo sent`,
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

    for (const kind of MARKER_KINDS) {
      const matrix = captures.map((capture) =>
        SESSIONS.map((session) => capture.includes(`${session.marker}-${kind}`)),
      );

      // Diagonal: each session sees its own traffic — which is also what
      // proves the marker was really put on the wire, so its absence
      // elsewhere means something.
      for (const [index, row] of matrix.entries()) {
        expect(row[index], `session ${index} could not capture its own ${kind} marker`).toBe(true);
      }
      // Off-diagonal: no session sees any other's. Twenty cells per kind.
      for (const [i, row] of matrix.entries()) {
        for (const [j, seen] of row.entries()) {
          if (i === j) continue;
          expect(seen, `session ${i} captured session ${j}'s ${kind} marker`).toBe(false);
        }
      }
    }

    // And nothing else appears at all — no other session, no platform API,
    // terminal, kind or host traffic — because none of it traverses this link.
    // Classified by tcpdump from the packet headers, not by pattern-matching
    // the text dump, and reported whole so a failure names the packet.
    for (const [index, session] of SESSIONS.entries()) {
      const foreign = await foreignPackets(session.sandboxRef, segments[index]!);
      expect(foreign, `session ${index} captured traffic its own segment does not account for`).toEqual([]);
    }

    // The classifier is not vacuous: judged against a neighbour's segment,
    // this session's own capture — its markers, its gateway — is all foreign.
    for (const [index, session] of SESSIONS.entries()) {
      const neighbour = segments[(index + 1) % SESSIONS.length]!;
      const misjudged = await foreignPackets(session.sandboxRef, neighbour);
      expect(misjudged.length, `session ${index}'s capture read as session ${(index + 1) % SESSIONS.length}'s`).toBeGreaterThan(0);
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

  // ------------------------------- 3b. the image confers nothing by itself

  it('ships tcpdump with no setuid bit and no file capabilities', async () => {
    const sandbox = SESSIONS[0]!.sandboxRef;

    // Presence is not permission. If tcpdump ever gained a setuid bit or a
    // file capability, every Linux lab would silently become a capture lab —
    // including the ones on `--network none` and the ones sharing no segment
    // at all. This is the check that would catch that.
    const mode = await shell(sandbox, 'stat -c "%a %U" "$(command -v tcpdump)"');
    expect(mode.stdout.trim()).toBe('755 root');

    const setuid = await shell(sandbox, '[ -u "$(command -v tcpdump)" ] && echo yes || echo no');
    expect(setuid.stdout.trim()).toBe('no');

    const caps = await shell(sandbox, 'getcap "$(command -v tcpdump)" 2>/dev/null | wc -l');
    expect(caps.stdout.trim()).toBe('0');
  }, 300_000);

  // --------------------------------------- 3c. the host bridge residual

  it('cannot reach platform services through the host-side bridge address', async () => {
    // A documented residual, kept explicit rather than assumed away: a student
    // can emit packets to the host side of their own bridge, and the host
    // stack processes them. Nothing the platform runs is bound there today —
    // the API and terminal publish on loopback only and everything runs in
    // containers — and this asserts that rather than trusting it.
    //
    // If a future platform service ever binds to a bridge or otherwise
    // non-loopback address, this test is the one that must be revisited, and
    // the CAP_NET_RAW approval revisited with it.
    const sandbox = SESSIONS[0]!.sandboxRef;
    const segment = await segmentOf(sandbox);

    const ports = [3000, 4000, 4001, 5432, 16443];
    for (const port of ports) {
      const probe = await shell(
        sandbox,
        `nc -w 3 -v ${segment.gateway} ${port} </dev/null 2>&1 | tail -1`,
      );
      expect(
        probe.stdout,
        `the host bridge address answered on ${port} — a platform service may now be exposed to student segments`,
      ).toMatch(/refused|unreachable|timed out|Operation now in progress/i);
    }
  }, 600_000);

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
