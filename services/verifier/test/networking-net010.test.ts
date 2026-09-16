/**
 * NET-010 — verification for the DHCP and IPAM lab.
 *
 * The lab's claim is a contrast: one container on a network obtained its
 * address over DHCP, and another on the same network obtained one without
 * sending a single DHCP packet. Both halves are graded from the address each
 * container's interface actually holds, which is what makes this more than a
 * worksheet.
 *
 * The fixtures below use `ip -o addr show` exactly as BusyBox printed it on a
 * real daemon on 2026-09-16, with the IPAM address and the DHCP-pool address
 * as they were observed.
 *
 * The sections that matter most are the attacks, because both were run against
 * the real daemon while building the lab and both failed there for the reason
 * asserted here:
 *
 *   - a client that obtained a lease but never applied it;
 *   - an "ordinary" container that secretly ran a DHCP client too.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InMemoryWorkspace,
  loadLabDefinition,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerDaemon, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { verifyLab } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const NET_010 = path.join(LABS_DIR, 'networking', 'net-010-dhcp-and-ipam', 'lab.yaml');

const SANDBOX = 'lab-00000000000a';
const SESSION = 'sess-000000000000000a';

let lab: LoadedLabDefinition;
beforeAll(async () => {
  lab = await loadLabDefinition(NET_010);
});

const failures = (checks: Array<{ status: string; label: string; detail?: string }>) =>
  checks.filter((c) => c.status !== 'pass');

/** An interface listing as BusyBox `ip -o addr show` prints it. */
const addresses = (...cidrs: string[]) =>
  [
    '1: lo    inet 127.0.0.1/8 scope host lo',
    ...cidrs.map(
      (cidr, index) =>
        `29: eth0    inet ${cidr} ${index === 0 ? 'brd 10.77.0.255 ' : ''}scope global${index === 0 ? '' : ' secondary'} eth0`,
    ),
  ].join('\n');

/** Measured: Docker's IPAM gave the client .3 and the DHCP server gave it .129. */
const CLIENT_WITH_LEASE_APPLIED = addresses('10.77.0.3/24', '10.77.0.129/24');
/** Measured: `udhcpc` with no `-s` script obtains a lease and changes nothing. */
const CLIENT_LEASE_NOT_APPLIED = addresses('10.77.0.3/24');
/** Measured: an ordinary container gets the next IPAM address, .4. */
const ORDINARY_CONTAINER = addresses('10.77.0.4/24');
/** Measured: the same container running `udhcpc` as well takes .130. */
const ORDINARY_CONTAINER_THAT_RAN_DHCP = addresses('10.77.0.4/24', '10.77.0.130/24');

/** `tcpdump -v` output, trimmed to the lines the check reads. */
const CAPTURE = [
  '0.0.0.0.68 > 255.255.255.255.67: BOOTP/DHCP, Request from 02:42:0a:4d:00:03, length 300',
  '    DHCP-Message (53), length 1: Discover',
  '10.77.0.2.67 > 255.255.255.255.68: BOOTP/DHCP, Reply, length 300',
  '    DHCP-Message (53), length 1: Offer',
  '0.0.0.0.68 > 255.255.255.255.67: BOOTP/DHCP, Request from 02:42:0a:4d:00:03, length 300',
  '    DHCP-Message (53), length 1: Request',
  '10.77.0.2.67 > 255.255.255.255.68: BOOTP/DHCP, Reply, length 300',
  '    DHCP-Message (53), length 1: ACK',
  '',
].join('\n');

const CONCLUSIONS = [
  "ipam_client_address_came_from = the daemon's IPAM driver, when the container was created",
  'what_happened_to_the_lease = there is no lease — the address is held for the life of the container',
  '',
].join('\n');

interface World {
  network?: boolean;
  server?: boolean;
  client?: string | null;
  ipam?: string | null;
  images?: Record<string, string>;
  networks?: Record<string, string>;
  capture?: string;
  conclusions?: string;
}

function world(options: World = {}) {
  const docker = new FakeDockerDaemon({ images: ['busybox:1.36'] });
  if (options.network !== false) {
    docker.createNetwork({ name: 'dhcp-lab', driver: 'bridge' });
  }

  const add = (name: string, listing: string | null | undefined) => {
    if (listing === null) return;
    docker.addContainer(
      containerSpec({
        name,
        image: options.images?.[name] ?? 'busybox:1.36',
        network: options.networks?.[name] ?? 'dhcp-lab',
      }),
    );
    if (listing !== undefined) {
      docker.probes[`${name}: ip -o addr show`] = { exitCode: 0, stdout: listing };
    }
  };

  if (options.server !== false) add('dhcp-server', undefined);
  add('dhcp-client', options.client === undefined ? CLIENT_WITH_LEASE_APPLIED : options.client);
  add('ipam-client', options.ipam === undefined ? ORDINARY_CONTAINER : options.ipam);

  const port = new InMemoryWorkspace();
  port.write(SESSION, 'dhcp.txt', options.capture ?? CAPTURE);
  port.write(SESSION, 'ipam.txt', options.conclusions ?? CONCLUSIONS);

  return { docker, workspace: { port, sessionId: SESSION } };
}

const verify = (state: ReturnType<typeof world>) =>
  verifyLab({ lab, namespace: SANDBOX, docker: state.docker, workspace: state.workspace });

// ------------------------------------------------------------ 1. baseline

describe('NET-010 before the work', () => {
  it('fails on the seeded baseline, where nothing has been built', async () => {
    const result = await verify(
      world({
        network: false,
        server: false,
        client: null,
        ipam: null,
        capture: '# NET-010 — the exchange\n',
        conclusions: 'ipam_client_address_came_from =\n',
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    // Measured on the real daemon: every one of the fourteen fails at baseline.
    expect(failures(result.checks)).toHaveLength(lab.requirements.length);
  });

  it('fails on an empty daemon rather than erroring', async () => {
    const result = await verifyLab({
      lab,
      namespace: SANDBOX,
      docker: new FakeDockerDaemon(),
      workspace: { port: new InMemoryWorkspace(), sessionId: SESSION },
    });
    expect(result.passed).toBe(false);
  });
});

// -------------------------------------------------------------- 2. solved

describe('NET-010 after the work', () => {
  it('passes when DHCP was applied on one container and not used on the other', async () => {
    const result = await verify(world());

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('reads each container\'s addresses, and runs nothing a lab author chose', async () => {
    const state = world();
    await verify(state);

    // `address_in_range` passes neither the interface nor the range to `ip`.
    for (const run of state.docker.probeRuns) {
      expect(run.endsWith(': ip -o addr show'), run).toBe(true);
    }
    expect(state.docker.execs).toEqual([]);
  });
});

// ------------------------------------------ 3. the attacks, as measured

describe('NET-010 rejects a DHCP exchange that did not complete', () => {
  it('fails when the client obtained a lease but never applied it', async () => {
    // Run against the real daemon while building the lab: `udhcpc` with no
    // `-s` script logged "lease of 10.77.0.129 obtained" and the interface
    // kept only its IPAM address. Obtaining is not applying.
    const result = await verify(world({ client: CLIENT_LEASE_NOT_APPLIED }));

    expect(result.passed).toBe(false);
    expect(failures(result.checks).map((c) => c.label)).toEqual([
      'The client applied an address from the range the server hands out',
    ]);
  });

  it('fails when the "ordinary" container secretly ran a DHCP client too', async () => {
    // Also run against the real daemon: with `udhcpc` added, ipam-client took
    // .130 from the pool as well as its IPAM .4. It then has an address from
    // the server, which the lab exists to show an ordinary container does not.
    const result = await verify(world({ ipam: ORDINARY_CONTAINER_THAT_RAN_DHCP }));

    expect(result.passed).toBe(false);
    expect(failures(result.checks).map((c) => c.label)).toEqual([
      "The ordinary container's address did not come from the server",
    ]);
  });

  it('fails when the address came from the wrong subnet altogether', async () => {
    // A student who created the network without the stated subnet gets
    // addresses from a range the lab never named.
    const result = await verify(
      world({
        client: addresses('172.20.0.3/16'),
        ipam: addresses('172.20.0.4/16'),
      }),
    );

    expect(result.passed).toBe(false);
    expect(failures(result.checks).length).toBeGreaterThanOrEqual(2);
  });
});

describe('NET-010 rejects the rest of the shortcuts', () => {
  it('fails when the DHCP server was never started', async () => {
    const result = await verify(world({ server: false }));
    expect(result.passed).toBe(false);
  });

  it('fails when the network was never created', async () => {
    const result = await verify(world({ network: false }));
    expect(result.passed).toBe(false);
  });

  it('fails when a container is on some other network', async () => {
    const result = await verify(world({ networks: { 'ipam-client': 'bridge' } }));
    expect(result.passed).toBe(false);
  });

  it('fails when the server or client runs another image', async () => {
    expect((await verify(world({ images: { 'dhcp-server': 'alpine:3.20' } }))).passed).toBe(false);
    expect((await verify(world({ images: { 'dhcp-client': 'alpine:3.20' } }))).passed).toBe(false);
  });

  it.each([
    ['the capture has no ACK', CAPTURE.replace('length 1: ACK', 'length 1: NAK')],
    ['the capture was taken without -v, so no message is named', 'BOOTP/DHCP, Request\nBOOTP/DHCP, Reply\n'],
    ['the capture is empty', '# NET-010 — the exchange\n'],
  ])('fails when %s', async (_name, capture) => {
    expect((await verify(world({ capture }))).passed).toBe(false);
  });

  it.each([
    [
      'the source was attributed to a DHCP server',
      "ipam_client_address_came_from = a DHCP server running inside the daemon\nwhat_happened_to_the_lease = there is no lease — the address is held for the life of the container\n",
    ],
    ['the conclusions were left blank', 'ipam_client_address_came_from =\n'],
  ])('fails when %s', async (_name, conclusions) => {
    expect((await verify(world({ conclusions }))).passed).toBe(false);
  });
});

// ------------------------------------------------------ 4. non-disclosure

describe('NET-010 hands over no answer', () => {
  it('names no graded conclusion in any check', async () => {
    const result = await verify(world({ conclusions: 'ipam_client_address_came_from =\n' }));
    const reported = JSON.stringify(result.checks);

    expect(reported).not.toContain("the daemon's IPAM driver");
    expect(reported).not.toContain('held for the life of the container');
  });
});
