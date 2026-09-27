/**
 * Networking labs: grading defects found by the 2026-09-21 lab product audit,
 * pinned so they stay closed. Each world is stated explicitly; the lab is the
 * real catalog lab, graded by the real `verifyLab`.
 */
import { describe, expect, it } from 'vitest';
import { requirementSchema } from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const NS = 'jtt-lab-000000000001';

async function failing(labId: string, sandbox: FakeSandbox): Promise<string[]> {
  const lab = (await realCatalog()).get(labId);
  const result = await verifyLab({ lab, namespace: NS, sandbox });
  expect(result.error).toBeUndefined();
  return result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

/** A sandbox with a peer on the session segment that answers HTTP as told. */
class PeerSandbox extends FakeSandbox {
  constructor(world: FakeWorld, private readonly answer: { reached: boolean; status?: number }) {
    super(world);
  }
  get hasPeer(): boolean {
    return true;
  }
  httpFromPeer = async () => this.answer;
}

// ---------------------------------------------------------------- NET-006

describe('NET-006 — "reachable from the segment" is any binding beyond loopback', () => {
  const world = (address: string): FakeWorld => ({
    files: { '/etc/payments/api.conf': { type: 'file', content: `bind_address = ${address}\nport = 9106\n` } },
    listening: [
      { protocol: 'tcp', port: 9105, address: '0.0.0.0' },
      { protocol: 'tcp', port: 9106, address },
      { protocol: 'udp', port: 9107, address: '0.0.0.0' },
    ],
  });

  it('passes the wildcard binding', async () => {
    expect(await failing('NET-006', new FakeSandbox(world('0.0.0.0')))).toEqual([]);
  });

  it("passes a binding to the host's own segment address", async () => {
    // Before: `address: [0.0.0.0, "::"]` refused this, although the segment
    // reaches it and it is the narrower exposure.
    expect(await failing('NET-006', new FakeSandbox(world('10.90.0.2')))).toEqual([]);
  });

  it('still fails a move to another loopback address', async () => {
    // 127.0.0.2 is not 127.0.0.1, so the "no longer on 127.0.0.1" check
    // passes — the reachability check is what must refuse it.
    expect(await failing('NET-006', new FakeSandbox(world('127.0.0.2')))).toEqual([
      'The payments API is reachable from outside this host',
    ]);
  });
});

// ---------------------------------------------------------------- NET-007

describe('NET-007 — the peer is the grade, and the socket check agrees with it', () => {
  const world = (address: string): FakeWorld => ({
    files: {
      '/etc/ledger/api.conf': { type: 'file', content: `bind_address = ${address}\nport = 8080\n` },
      '/home/student/incident/evidence/local.txt': { type: 'file', content: '200\n' },
      '/home/student/incident/diagnosis.txt': { type: 'file', content: 'refused because of the bind address\n' },
    },
    listening: [{ protocol: 'tcp', port: 8080, address }],
  });

  it("passes a service bound to the host's segment address that the peer reaches", async () => {
    // Before: the peer got 200 and "The service listens where the segment can
    // reach it" still failed.
    expect(await failing('NET-007', new PeerSandbox(world('10.90.0.2'), { reached: true, status: 200 }))).toEqual([]);
  });

  it('fails a service left on loopback, which the peer cannot reach', async () => {
    const labels = await failing('NET-007', new PeerSandbox(world('127.0.0.1'), { reached: false }));
    expect(labels).toContain('The service listens where the segment can reach it');
    expect(labels).toContain('The other machine on this segment can reach the service');
  });
});

// ---------------------------------------------------------------- NET-025

describe('NET-025 — the broken Service is repaired, not the application moved to match it', () => {
  const pod = (containerPort: number) => ({
    name: 'ledger-api-1',
    namespace: NS,
    labels: { app: 'ledger-api' },
    phase: 'Running',
    ready: true,
    restarts: 0,
    containers: [{ name: 'ledger-api', image: 'ledger', ports: [{ name: 'http', containerPort }] }],
  });
  const service = (targetPort: number | string) => ({
    name: 'ledger-port-broken',
    namespace: NS,
    type: 'ClusterIP',
    selector: { app: 'ledger-api' },
    ports: [{ port: 80, targetPort, protocol: 'TCP' }],
  });
  const LABEL = 'The second Service forwards to the port the application listens on';

  async function status(targetPort: number | string, containerPort: number): Promise<string | undefined> {
    const lab = (await realCatalog()).get('NET-025');
    const k8s = new FakeKubernetes({ services: { [NS]: [service(targetPort)] }, pods: { [NS]: [pod(containerPort)] } } as never);
    const result = await verifyLab({ lab, namespace: NS, k8s } as never);
    return result.checks.find((c) => c.label === LABEL)?.status;
  }

  it('passes targetPort 3000, and the named port that resolves to it', async () => {
    expect(await status(3000, 3000)).toBe('pass');
    expect(await status('http', 3000)).toBe('pass');
  });

  it('fails the seeded targetPort 8080 even when the application was moved to 8080', async () => {
    // Before: no check read the targetPort, so moving the application to the
    // broken Service's port satisfied the HTTP check.
    expect(await status(8080, 8080)).toBe('fail');
  });
});

// ------------------------------------------------- port_listening beyond_loopback

describe('port_listening beyond_loopback', () => {
  const requirement = { type: 'port_listening', port: 9106, beyond_loopback: true, label: 'Reachable' };

  it('refuses a requirement that also names an address', () => {
    expect(requirementSchema.safeParse({ ...requirement, address: '0.0.0.0' }).success).toBe(false);
    expect(requirementSchema.safeParse(requirement).success).toBe(true);
  });

  it.each([
    ['::1', 'fail'],
    ['::ffff:127.0.0.1', 'fail'],
    ['127.10.0.1', 'fail'],
    ['::', 'pass'],
    ['*', 'pass'],
    ['fd00::2', 'pass'],
  ])('reads a socket bound to %s as a %s', async (address, expected) => {
    const lab = { requirements: [requirementSchema.parse(requirement)] } as never;
    const sandbox = new FakeSandbox({ listening: [{ protocol: 'tcp', port: 9106, address }] });
    const result = await verifyLab({ lab, namespace: NS, sandbox });
    expect(result.checks[0]?.status).toBe(expected);
  });
});
