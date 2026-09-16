/**
 * NET-011 — verification for the firewall lab.
 *
 * The lab grades a fix behaviourally, from a client container: 8080 and 8081
 * reachable, the admin port 8083 not. The two tests that carry it are the two
 * wrong answers, and both were run against a real daemon while building the lab:
 *
 *   - the fix not made — 8081 still dropped;
 *   - the fix made too broadly — the whole ruleset flushed, which opens 8083.
 *
 * Reachability comes from `tcp_connect` probes, keyed by the argv the probe
 * vocabulary builds, so a test states the command it expects.
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
const NET_011 = path.join(LABS_DIR, 'networking', 'net-011-firewalls-refused-dropped', 'lab.yaml');

const SANDBOX = 'lab-00000000000a';
const SESSION = 'sess-000000000000000a';
const IMAGE = 'jumptotech/lab-nettools:1.0';

let lab: LoadedLabDefinition;
beforeAll(async () => {
  lab = await loadLabDefinition(NET_011);
});

const failures = (checks: Array<{ status: string; label: string; detail?: string }>) =>
  checks.filter((c) => c.status !== 'pass');

const SYMPTOMS = '8080: ok 0s\n8081: hung 4s\n8082: refused 0s\ninstant=8082 hung=8081\n';
const RULE = 'default_policy: drop\nwhy_8081_is_unreachable: no accept rule for it\n';
const MECHANISM =
  'The closed port answers with a RST; the dropped one answers with nothing. A stateful rule tracks the connection so the reply comes home.\n';

interface World {
  services?: boolean;
  client?: boolean;
  network?: boolean;
  /** Reachability of each port from the client, as the probe would find it. */
  reach?: { 8080?: boolean; 8081?: boolean; 8083?: boolean };
  servicesImage?: string;
  symptoms?: string;
  rule?: string;
  mechanism?: string;
}

function world(options: World = {}) {
  const docker = new FakeDockerDaemon({ images: [IMAGE] });
  if (options.network !== false) docker.createNetwork({ name: 'svc-net', driver: 'bridge' });

  if (options.services !== false) {
    docker.addContainer(
      containerSpec({ name: 'services', image: options.servicesImage ?? IMAGE, network: 'svc-net' }),
    );
  }
  if (options.client !== false) {
    docker.addContainer(containerSpec({ name: 'client', image: IMAGE, network: 'svc-net' }));
  }

  // Default reachability = a correctly solved firewall.
  const reach = { 8080: true, 8081: true, 8083: false, ...options.reach };
  for (const [port, ok] of Object.entries(reach)) {
    docker.probes[`client: nc -z -w 4 services ${port}`] = { exitCode: ok ? 0 : 1 };
  }

  const port = new InMemoryWorkspace();
  port.write(SESSION, 'symptoms.txt', options.symptoms ?? SYMPTOMS);
  port.write(SESSION, 'rule.txt', options.rule ?? RULE);
  port.write(SESSION, 'mechanism.txt', options.mechanism ?? MECHANISM);

  return { docker, workspace: { port, sessionId: SESSION } };
}

const verify = (state: ReturnType<typeof world>) =>
  verifyLab({ lab, namespace: SANDBOX, docker: state.docker, workspace: state.workspace });

describe('NET-011 before the work', () => {
  it('fails on the seeded baseline, where nothing has been built', async () => {
    const result = await verify(
      world({
        services: false,
        client: false,
        network: false,
        symptoms: '#\n',
        rule: '#\n',
        mechanism: '#\n',
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
  });
});

describe('NET-011 after the work', () => {
  it('passes when 8081 is reachable and the admin port is not', async () => {
    const result = await verify(world());

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('probes from the client, never from services-to-itself', async () => {
    // A probe of services from services travels loopback, which the ruleset
    // accepts; the lab must observe the firewall from a separate client.
    const state = world();
    await verify(state);

    expect(state.docker.probeRuns.length).toBe(3);
    for (const run of state.docker.probeRuns) {
      expect(run.startsWith('client: '), run).toBe(true);
    }
    expect(state.docker.execs).toEqual([]);
  });
});

describe('NET-011 rejects the two wrong fixes, both measured on a real daemon', () => {
  it('fails when 8081 was never opened', async () => {
    const result = await verify(world({ reach: { 8081: false } }));

    expect(result.passed).toBe(false);
    expect(failures(result.checks).map((c) => c.label)).toEqual([
      'The port that was hanging is now reachable',
    ]);
  });

  it('fails when the whole ruleset was flushed, which opens the admin port', async () => {
    // The shortcut the lab exists to catch: flushing to policy accept makes
    // 8081 reachable and 8083 reachable too.
    const result = await verify(world({ reach: { 8081: true, 8083: true } }));

    expect(result.passed).toBe(false);
    expect(failures(result.checks).map((c) => c.label)).toEqual([
      'The admin port was left closed',
    ]);
  });
});

describe('NET-011 rejects the rest of the shortcuts', () => {
  it('fails when the services container is gone', async () => {
    expect((await verify(world({ services: false }))).passed).toBe(false);
  });

  it('fails when the client the platform probes from is gone', async () => {
    const result = await verify(world({ client: false }));
    expect(result.passed).toBe(false);
  });

  it('fails when services runs a different image', async () => {
    expect((await verify(world({ servicesImage: 'busybox:1.36' }))).passed).toBe(false);
  });

  it.each([
    ['the rule worksheet does not name the policy', { rule: 'default_policy:\nwhy:\n' }],
    ['the mechanism worksheet omits the reset', { mechanism: 'A stateful rule tracks connections.\n' }],
    ['the mechanism worksheet omits stateful', { mechanism: 'The closed port sends a RST.\n' }],
  ])('fails when %s', async (_name, overrides) => {
    expect((await verify(world(overrides))).passed).toBe(false);
  });
});
