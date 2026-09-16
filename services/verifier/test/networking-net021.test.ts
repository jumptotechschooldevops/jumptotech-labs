/**
 * NET-021 — verification for the network-namespace lab.
 *
 * This is the first lab whose central claim is graded by *running something*
 * rather than by reading state, so the tests are about what the probes are
 * allowed to conclude.
 *
 * Three properties:
 *
 *   1. the seeded baseline fails — only the peer exists, none of the three
 *      containers has been started and the network has not been created;
 *   2. the finished work passes, with every probe answering as the real daemon
 *      answered when this lab was measured;
 *   3. a partial or forged solution fails, one way per test. The ones that
 *      matter are the shortcuts: starting all three containers on the *same*
 *      network, and satisfying the "no eth0" check by deleting the container
 *      rather than by starting it with no networking.
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
const NET_021 = path.join(LABS_DIR, 'networking', 'net-021-network-namespaces', 'lab.yaml');

const SANDBOX = 'lab-00000000000a';
const SESSION = 'sess-000000000000000a';

let lab: LoadedLabDefinition;
beforeAll(async () => {
  lab = await loadLabDefinition(NET_021);
});

const failures = (checks: Array<{ status: string; label: string; detail?: string }>) =>
  checks.filter((c) => c.status !== 'pass');

/**
 * `ip -o link show` as the real thing prints it.
 *
 * Copied from Docker Engine 28.4.0 and kept whole rather than trimmed to `lo`,
 * because the tunnel devices are the reason this lab grades `eth0` instead of
 * an interface count: a fresh namespace inherits whatever the host kernel's
 * loaded modules create, which differs between hosts.
 */
const NAMESPACE_WITHOUT_ETH0 = [
  '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000',
  '2: tunl0@NONE: <NOARP> mtu 1480 qdisc noop state DOWN qlen 1000',
  '3: gre0@NONE: <NOARP> mtu 1476 qdisc noop state DOWN qlen 1000',
  '8: sit0@NONE: <NOARP> mtu 1480 qdisc noop state DOWN qlen 1000',
].join('\n');

const NAMESPACE_WITH_ETH0 = [
  NAMESPACE_WITHOUT_ETH0,
  '11: eth0@if2080: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 65535 qdisc noqueue state UP',
].join('\n');

const SOLVED_VETH = [
  'container_end: 11: eth0@if2080: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP',
  'host_end: 2080: veth7ed9442@if11: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 master br-6c30700f4cd1 state UP',
  '',
].join('\n');

const SOLVED_EXPLAIN = [
  'two_containers_same_port_because = each container has its own network namespace, with its own socket table',
  'network_none_means = it has its own network stack, not no network stack',
  '',
].join('\n');

interface World {
  /** Networks each student container sits on. `null` means "not created at all". */
  none?: string | null;
  bridge?: string | null;
  user?: string | null;
  /** Networks the seeded peer is attached to. */
  peer?: string;
  /** Create the user-defined network. */
  network?: boolean;
  /** Per-container link listings, keyed by container name. */
  links?: Record<string, { stdout?: string; exitCode?: number }>;
  /** Outcomes for the two connectivity probes. */
  noneConnect?: { exitCode?: number; timedOut?: boolean };
  userFetch?: { exitCode?: number; timedOut?: boolean };
  images?: Record<string, string>;
  veth?: string;
  explain?: string;
  states?: Record<string, string>;
}

function world(options: World = {}) {
  const docker = new FakeDockerDaemon({ images: ['alpine:3.20', 'nginx:1.27-alpine'] });
  if (options.network !== false) docker.createNetwork({ name: 'netns-net', driver: 'bridge' });

  docker.addContainer(
    containerSpec({
      name: 'netns-peer',
      image: 'nginx:1.27-alpine',
      ...(options.peer && options.peer !== 'bridge' ? { network: options.peer } : {}),
    }),
  );
  if (options.peer && options.peer !== 'bridge') {
    // Already created on that network above; nothing more to do.
  } else if (options.peer === 'bridge') {
    // Left on the default bridge: the student never attached it.
  }

  const add = (name: string, network: string | null | undefined, fallback: string) => {
    if (network === null) return;
    const chosen = network ?? fallback;
    docker.addContainer(
      containerSpec({
        name,
        image: options.images?.[name] ?? 'alpine:3.20',
        ...(chosen === 'bridge' ? {} : { network: chosen }),
      }),
      options.states?.[name] ?? 'running',
    );
  };
  add('netns-none', options.none, 'none');
  add('netns-bridge', options.bridge, 'bridge');
  add('netns-user', options.user, 'netns-net');

  // Link listings, per container.
  const links = options.links ?? {
    'netns-none': { stdout: NAMESPACE_WITHOUT_ETH0 },
    'netns-bridge': { stdout: NAMESPACE_WITH_ETH0 },
    'netns-user': { stdout: NAMESPACE_WITH_ETH0 },
  };
  for (const [container, outcome] of Object.entries(links)) {
    docker.probes[`${container}: ip -o link show`] = {
      exitCode: outcome.exitCode ?? 0,
      stdout: outcome.stdout ?? '',
    };
  }

  docker.probes['netns-none: nc -z -w 10 netns-peer 80'] = options.noneConnect ?? { exitCode: 1 };
  docker.probes['netns-user: wget -q -O /dev/null -T 5 http://netns-peer:80/'] =
    options.userFetch ?? { exitCode: 0 };

  const port = new InMemoryWorkspace();
  port.write(SESSION, 'three-modes.txt', '## netns-none\nlo only, immediate failure\n');
  port.write(SESSION, 'veth.txt', options.veth ?? 'container_end:\nhost_end:\n');
  port.write(SESSION, 'explain.txt', options.explain ?? 'two_containers_same_port_because =\n');

  return { docker, workspace: { port, sessionId: SESSION } };
}

/** Everything the lab asks for, done honestly. */
function solved(overrides: World = {}) {
  return world({
    peer: 'netns-net',
    veth: SOLVED_VETH,
    explain: SOLVED_EXPLAIN,
    ...overrides,
  });
}

const verify = (state: ReturnType<typeof world>) =>
  verifyLab({ lab, namespace: SANDBOX, docker: state.docker, workspace: state.workspace });

// ------------------------------------------------------------ 1. baseline

describe('NET-021 before the work', () => {
  it('fails on the seeded baseline', async () => {
    const result = await verify(
      world({ none: null, bridge: null, user: null, peer: 'bridge', network: false }),
    );

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    // The network, the three containers, their images, the probes and the two
    // graded worksheets are all outstanding.
    expect(failures(result.checks).length).toBeGreaterThanOrEqual(10);
  });

  it('fails on an empty daemon rather than erroring', async () => {
    const result = await verifyLab({
      lab,
      namespace: SANDBOX,
      docker: new FakeDockerDaemon(),
      workspace: { port: new InMemoryWorkspace(), sessionId: SESSION },
    });

    expect(result.passed).toBe(false);
    expect(failures(result.checks).length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------- 2. solved

describe('NET-021 after the work', () => {
  it('passes when all three modes are up and every probe answers as measured', async () => {
    const result = await verify(solved());

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('asks each probe exactly once, and never reaches arbitrary exec', async () => {
    const state = solved();
    await verify(state);

    expect(state.docker.probeRuns.sort()).toEqual([
      'netns-bridge: ip -o link show',
      'netns-none: ip -o link show',
      'netns-none: ip -o link show',
      'netns-none: nc -z -w 10 netns-peer 80',
      'netns-user: ip -o link show',
      'netns-user: wget -q -O /dev/null -T 5 http://netns-peer:80/',
    ]);
    // Nothing in this lab runs a command a lab author chose.
    expect(state.docker.execs).toEqual([]);
  });
});

// ------------------------------------------- 3. shortcuts and wrong work

describe('NET-021 rejects work that was not done', () => {
  it('fails when the isolated container was never started', async () => {
    // The shortcut `expect: failure` invites: a container that does not exist
    // also has no eth0. The handler resolves the container first, so this is a
    // missing-container failure and not a pass.
    const result = await verify(solved({ none: null }));

    expect(result.passed).toBe(false);
    const detail = failures(result.checks)
      .map((c) => c.detail ?? '')
      .join(' ');
    expect(detail).toContain('No container named');
  });

  it('fails when the isolated container was started on a network anyway', async () => {
    // All three on the default bridge — the "just make the checks pass" attempt.
    const result = await verify(
      solved({
        none: 'bridge',
        links: {
          'netns-none': { stdout: NAMESPACE_WITH_ETH0 },
          'netns-bridge': { stdout: NAMESPACE_WITH_ETH0 },
          'netns-user': { stdout: NAMESPACE_WITH_ETH0 },
        },
      }),
    );

    expect(result.passed).toBe(false);
    // Both the declared network and the observed interface disagree with the task.
    expect(failures(result.checks).length).toBeGreaterThanOrEqual(2);
  });

  it('fails when the user-defined network was never created', async () => {
    const result = await verify(solved({ network: false, user: null, peer: 'bridge' }));
    expect(result.passed).toBe(false);
  });

  it('fails when the peer was left on the default bridge', async () => {
    const result = await verify(solved({ peer: 'bridge' }));
    expect(result.passed).toBe(false);
  });

  it('fails when the third container cannot actually reach the peer', async () => {
    // Everything is attached correctly on paper and the fetch still does not
    // work. The probe is what catches it.
    const result = await verify(solved({ userFetch: { exitCode: 1 } }));

    expect(result.passed).toBe(false);
    expect(failures(result.checks)).toHaveLength(1);
  });

  it('fails when the isolated container can open a connection after all', async () => {
    const result = await verify(solved({ noneConnect: { exitCode: 0 } }));
    expect(result.passed).toBe(false);
  });

  it('fails when a probed container was swapped for another image', async () => {
    // A probe observes behaviour inside a container the student controls, so
    // the image is pinned beside it. This is that pin doing its job.
    const result = await verify(solved({ images: { 'netns-none': 'busybox:1.36' } }));
    expect(result.passed).toBe(false);
  });

  it('fails when a container was created but left stopped', async () => {
    const result = await verify(solved({ states: { 'netns-user': 'exited' } }));
    expect(result.passed).toBe(false);
  });

  it('fails when the link listing could not be read at all', async () => {
    // An image with no `ip` must not "prove" that eth0 is absent.
    const result = await verify(
      solved({
        links: {
          'netns-none': { exitCode: 127, stdout: '' },
          'netns-bridge': { stdout: NAMESPACE_WITH_ETH0 },
          'netns-user': { stdout: NAMESPACE_WITH_ETH0 },
        },
      }),
    );

    expect(result.passed).toBe(false);
  });

  it.each([
    ['the link worksheet was left blank', { veth: 'container_end:\nhost_end:\n' }],
    ['only the container end was captured', { veth: 'container_end: 11: eth0@if2080: <UP>\nhost_end:\n' }],
    [
      'the explanation picked the wrong value',
      { explain: 'two_containers_same_port_because = only one of them is really listening\n' },
    ],
    ['the explanation was left blank', { explain: 'two_containers_same_port_because =\n' }],
  ])('fails when %s', async (_name, overrides) => {
    const result = await verify(solved(overrides));
    expect(result.passed).toBe(false);
  });
});

// ------------------------------------------------------- 4. non-disclosure

describe('NET-021 hands over no answer', () => {
  it('names no graded worksheet value in any check', async () => {
    const result = await verify(
      world({ none: null, bridge: null, user: null, peer: 'bridge', network: false }),
    );
    const reported = JSON.stringify(result.checks);

    for (const answer of [
      'each container has its own network namespace, with its own socket table',
      'it has its own network stack, not no network stack',
    ]) {
      expect(reported, `a check leaked '${answer}'`).not.toContain(answer);
    }
  });
});
