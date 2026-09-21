/**
 * Networking checks tightened or loosened by the 2026-09-20 lab
 * certification pass, each graded through the lab's own requirement (found by
 * its label) against a sandbox stated explicitly.
 */
import { describe, expect, it } from 'vitest';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyRequirement } from '../src/index.js';
import { SandboxReader } from '../src/sandbox-reader.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

async function status(labId: string, label: string, world: FakeWorld) {
  const lab = (await realCatalog()).get(labId);
  const found = lab.requirements.filter((r) => r.label === label);
  expect(found, `${labId}: ${label}`).toHaveLength(1);
  return (await verifyRequirement(found[0]!, { sandbox: new SandboxReader(new FakeSandbox(world)) } as never)).status;
}
const file = (path: string, content: string): FakeWorld => ({ files: { [path]: { type: 'file', content } } });

describe('NET-005/006/007 — an old value kept as a comment is retired, not configured', () => {
  const cases = [
    ['NET-005', '/etc/ledger/settlement.conf', 'The unreachable destination is no longer configured',
      'settlement_endpoint = 10.80.4.10:9200', 'settlement_endpoint = 172.22.0.1:9200'],
    ['NET-006', '/etc/payments/api.conf', 'The loopback bind address is no longer configured',
      'bind_address = 127.0.0.1', 'bind_address = 0.0.0.0'],
    ['NET-007', '/etc/ledger/api.conf', 'The loopback address is gone from the configuration',
      'bind_address = 127.0.0.1', 'bind_address = 0.0.0.0'],
  ] as const;

  it.each(cases)('%s passes the old line commented out above the new one', async (lab, path, label, old, fixed) => {
    // Before: failed — the service reads only `key = value` lines.
    expect(await status(lab, label, file(path, `# ${old}\n${fixed}\n`))).toBe('pass');
    expect(await status(lab, label, file(path, `  #${old}\n${fixed}\n`))).toBe('pass');
  });

  it.each(cases)('%s still fails the old line left in effect', async (lab, path, label, old, fixed) => {
    expect(await status(lab, label, file(path, `${old}\n${fixed}\n`))).toBe('fail');
    expect(await status(lab, label, file(path, `${fixed} # was ${old}\n`))).toBe('fail');
  });
});

describe('NET-005 — the poller reaches its destination now, not once', () => {
  const LABEL = 'The poller reached a destination that required resolving a neighbour';
  const LOG = '/var/log/jumptotech/settlement.log';
  const good = '2026-09-20T10:00:05Z settlement_endpoint=172.22.0.1:9200 status=routable neighbour=resolved';
  const bad = '2026-09-20T10:00:10Z settlement_endpoint=10.80.5.10:9200 status=unreachable neighbour=none';

  it('passes when the latest cycle reached a resolved neighbour', async () => {
    expect(await status('NET-005', LABEL, file(LOG, `${bad}\n${good}\n`))).toBe('pass');
  });

  it('fails when a good cycle was followed by a move to an unreachable endpoint', async () => {
    // Before: the append-only log kept the good line, and this passed.
    expect(await status('NET-005', LABEL, file(LOG, `${good}\n${bad}\n`))).toBe('fail');
  });
});

describe('NET-007 — the diagnosis in whatever sentences, so in whatever case', () => {
  const PATH = '/home/student/incident/diagnosis.txt';
  const labels = ['The diagnosis names what the far side actually observed', 'The diagnosis names what was actually wrong'];

  it('passes capitalised words', async () => {
    const text = 'Bind address was 127.0.0.1, so every other host got Connection Refused.\n';
    for (const label of labels) expect(await status('NET-007', label, file(PATH, text))).toBe('pass');
  });

  it('fails a diagnosis that never says them, and a missing file', async () => {
    for (const label of labels) {
      expect(await status('NET-007', label, file(PATH, 'The service was down.\n'))).toBe('fail');
      expect(await status('NET-007', label, {})).toBe('fail');
    }
  });
});

describe('NET-004 — findings.txt holds the neighbour table', () => {
  const LABEL = 'The neighbour table was captured';
  const PATH = '/home/student/l2/findings.txt';

  it('passes `ip neigh show` output', async () => {
    const table = '172.18.0.1 dev eth0 lladdr 02:42:ac:12:00:01 REACHABLE\n172.18.0.55 dev eth0 FAILED\n';
    expect(await status('NET-004', LABEL, file(PATH, table))).toBe('pass');
  });

  it('fails `ip route` output, which also names eth0', async () => {
    const route = '172.18.0.0/16 dev eth0 proto kernel scope link src 172.18.0.2\n';
    expect(await status('NET-004', LABEL, file(PATH, route))).toBe('fail');
  });
});

describe('NET-002 — each Part 1 answer is read from its own field', () => {
  const PLAN = '/home/student/subnets/plan.txt';
  const ANSWERS: Record<string, string> = {
    a_network: '10.20.16.0', a_broadcast: '10.20.31.255', a_first_usable: '10.20.16.1', a_last_usable: '10.20.31.254', a_usable_count: '4094',
    b_network: '10.20.5.128', b_broadcast: '10.20.5.191', b_first_usable: '10.20.5.129', b_last_usable: '10.20.5.190', b_usable_count: '62',
    c_network: '172.16.8.0', c_broadcast: '172.16.11.255', c_first_usable: '172.16.8.1', c_last_usable: '172.16.11.254', c_usable_count: '1022',
    d_network: '192.168.100.64', d_broadcast: '192.168.100.79', d_first_usable: '192.168.100.65', d_last_usable: '192.168.100.78', d_usable_count: '14',
  };

  async function part1(overrides: Record<string, string> = {}) {
    const { readFile } = await import('node:fs/promises');
    const lab = (await realCatalog()).get('NET-002');
    const seeded = await readFile(`${lab.directory}/setup/plan.txt`, 'utf8');
    const answers = { ...ANSWERS, ...overrides };
    // Filled in the way the task asks: the value typed after "= ".
    const plan = seeded.replace(/^(\s+)([a-d]_[a-z_]+) = $/gm, (_m, indent: string, key: string) => `${indent}${key} = ${answers[key]}`);
    expect(plan).not.toBe(seeded);
    const labels = lab.requirements.filter((r) => r.label.startsWith('Block ')).map((r) => r.label);
    expect(labels).toHaveLength(8);
    const failing: string[] = [];
    for (const label of labels) if ((await status('NET-002', label, file(PLAN, plan))) !== 'pass') failing.push(label);
    return failing;
  }

  it('passes the correct plan written into the seeded worksheet', async () => {
    expect(await part1()).toEqual([]);
  });

  it('fails answers swapped between fields', async () => {
    // Before: every one of these passed, because each value appeared somewhere.
    expect(await part1({ b_broadcast: '10.20.5.190', b_last_usable: '10.20.5.191', a_usable_count: '1022', c_usable_count: '4094' })).toEqual([
      'Block A: the number of assignable addresses',
      'Block B: the broadcast address of 10.20.5.128/26',
      'Block B: the last assignable address',
      'Block C: the number of assignable addresses',
    ]);
  });
});
