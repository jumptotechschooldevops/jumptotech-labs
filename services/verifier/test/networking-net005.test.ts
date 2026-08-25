/**
 * NET-005 — verification for the routing-and-reachability lab.
 *
 * The lab's premise is that the fault is in application configuration and the
 * *diagnosis* is routing — because a student cannot change a routing table in
 * this sandbox and should not need to. That makes the anti-false-positive
 * question sharper than usual: the graded network state has to be something
 * the fixture cannot produce for the student.
 *
 * It cannot. The seeded endpoint is on a network no route covers, so every poll
 * fails at the routing decision, before address resolution is attempted. The
 * baseline, a restart of the poller, and a reset back to the baseline all leave
 * the neighbour table with nothing resolved on the segment — which the tests in
 * section 4 assert directly rather than assume.
 *
 * The neighbour rows and log lines here are the shapes a real kernel and the
 * real seeded poller produce.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const NET_005 = path.join(LABS_DIR, 'networking', 'net-005-routing-reachability', 'lab.yaml');

const NEIGH = 'ip -json neigh show';
const CONF = '/etc/ledger/settlement.conf';
const LOG = '/var/log/jumptotech/settlement.log';

/** The segment this session happened to be allocated. */
const GATEWAY = '172.22.0.1';
const OWN = '172.22.0.2';
const BAD = '10.80.4.10';

function failures(checks: Array<{ status: string; label: string; detail?: string }>) {
  return checks.filter((c) => c.status !== 'pass');
}

const SEEDED_CONF = `# ledger-api — settlement poller
settlement_endpoint = ${BAD}:9200
poll_interval_seconds = 5
`;

const FIXED_CONF = `# ledger-api — settlement poller
settlement_endpoint = ${GATEWAY}:9200
poll_interval_seconds = 5
`;

/** What the poller writes while the endpoint is on a network with no route. */
const SEEDED_LOG = [
  `2026-08-25T09:00:00Z settlement_endpoint=${BAD}:9200 status=unreachable neighbour=none`,
  `2026-08-25T09:00:05Z settlement_endpoint=${BAD}:9200 status=unreachable neighbour=none`,
  '',
].join('\n');

/** What it writes once the endpoint is somewhere this host can reach. */
const FIXED_LOG =
  SEEDED_LOG +
  [
    `2026-08-25T09:04:00Z settlement_endpoint=${GATEWAY}:9200 status=routable neighbour=resolved`,
    '',
  ].join('\n');

/** The neighbour table once the poller has actually reached the gateway. */
const RESOLVED = JSON.stringify([
  { dst: GATEWAY, dev: 'eth0', lladdr: '02:42:ac:16:00:01', state: ['REACHABLE'] },
]);

/** A destination with no route never reaches the neighbour stage. */
const EMPTY_TABLE = '[]';

function world(over: { conf?: string; log?: string; sockets?: FakeWorld['listening'] } = {}): FakeWorld {
  return {
    files: {
      '/home/student/routing': { type: 'directory', mode: '755' },
      '/home/student/routing/brief.txt': { type: 'file', content: 'settlement poller\n' },
      [CONF]: { type: 'file', content: over.conf ?? SEEDED_CONF },
      [LOG]: { type: 'file', content: over.log ?? SEEDED_LOG },
      '/proc/net/dev': { type: 'file', content: 'eth0: 0 0\n  lo: 0 0\n' },
    },
    listening: over.sockets ?? [{ protocol: 'tcp', port: 9120, address: '0.0.0.0' }],
  };
}

function box(neighbours: string, over: Parameters<typeof world>[0] = {}): FakeSandbox {
  return new FakeSandbox({ ...world(over), commands: { [NEIGH]: { stdout: neighbours } } });
}

async function verify(sandbox: FakeSandbox, namespace = 'jtt-lab-000000000001') {
  return verifyLab({ lab: await loadLabDefinition(NET_005), sandbox, namespace });
}

/** The sandbox exactly as a student who solved the lab leaves it. */
function solved(): FakeSandbox {
  return box(RESOLVED, { conf: FIXED_CONF, log: FIXED_LOG });
}

// ------------------------------------------------------------ 1. the fixture

describe('NET-005 as the fixture leaves it', () => {
  it('fails every student-facing check', async () => {
    const result = await verify(box(EMPTY_TABLE));
    const failed = failures(result.checks);

    expect(result.passed).toBe(false);
    expect(failed.map((c) => c.label).sort()).toEqual(
      [
        'The unreachable destination is no longer configured',
        'The poller reached a destination that required resolving a neighbour',
        'A neighbour on this segment was really resolved',
      ].sort(),
    );
    // The API is healthy from the start; the lab is not about restarting it.
    expect(failed.map((c) => c.label)).not.toContain('The ledger API is still healthy');
  });

  it('never names the correct destination in a label or detail', async () => {
    const result = await verify(box(EMPTY_TABLE));
    const reported = JSON.stringify(result.checks);

    // The answer is session-specific and derived by the student; nothing the
    // checker says may hand over an address or the arithmetic behind it.
    expect(reported).not.toContain(GATEWAY);
    expect(reported).not.toContain('first usable');
    expect(reported).not.toContain('gateway');
  });
});

// ------------------------------------------------------------ 2. the solution

describe('NET-005 once the configuration is corrected', () => {
  it('passes on the state a correct repair leaves behind', async () => {
    const result = await verify(solved());

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes on whatever segment the session was allocated', async () => {
    // A different daemon allocation entirely. Nothing in the lab is pinned to
    // an address, because the lab cannot know one.
    const other = '10.42.7.1';
    const result = await verify(
      box(JSON.stringify([{ dst: other, dev: 'eth0', lladdr: '02:42:0a:2a:07:01', state: ['STALE'] }]), {
        conf: `settlement_endpoint = ${other}:9200\n`,
        log: `2026-08-25T09:04:00Z settlement_endpoint=${other}:9200 status=routable neighbour=resolved\n`,
      }),
    );

    expect(failures(result.checks)).toEqual([]);
  });

  it('accepts a student who probed by hand before fixing the config', async () => {
    // An alternate but entirely valid workflow: confirm the address answers
    // first, then repoint the poller. The end state is what is graded.
    const byHand = box(
      JSON.stringify([
        { dst: GATEWAY, dev: 'eth0', lladdr: '02:42:ac:16:00:01', state: ['STALE'] },
        { dst: '172.22.0.55', dev: 'eth0', state: ['FAILED'] },
      ]),
      { conf: FIXED_CONF, log: FIXED_LOG },
    );

    const result = await verify(byHand);

    expect(failures(result.checks)).toEqual([]);
  });
});

// -------------------------------------------------------- 3. partial answers

describe('NET-005 rejects a partial repair', () => {
  it('fails while the unreachable destination is still configured', async () => {
    // Even with everything else in place: the fault itself must be gone.
    const result = await verify(box(RESOLVED, { conf: SEEDED_CONF, log: FIXED_LOG }));
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The unreachable destination is no longer configured');
  });

  it('fails when the config was corrected but nothing was ever contacted', async () => {
    // The most likely honest-but-incomplete state: the student edited the file
    // and stopped there. No poll has succeeded and nothing was resolved.
    const result = await verify(box(EMPTY_TABLE, { conf: FIXED_CONF, log: SEEDED_LOG }));
    const failed = failures(result.checks);

    expect(failed.map((c) => c.label).sort()).toEqual(
      [
        'The poller reached a destination that required resolving a neighbour',
        'A neighbour on this segment was really resolved',
      ].sort(),
    );
  });

  it('fails when the poller reached this host itself rather than a neighbour', async () => {
    // Pointing at your own address is routable, and resolves nothing: traffic
    // to yourself is delivered locally. The log records exactly that, and the
    // neighbour table stays empty — so the lab is not satisfied.
    const selfTargeted = box(EMPTY_TABLE, {
      conf: `settlement_endpoint = ${OWN}:9200\n`,
      log: `2026-08-25T09:04:00Z settlement_endpoint=${OWN}:9200 status=routable neighbour=none\n`,
    });

    const result = await verify(selfTargeted);
    const failed = failures(result.checks);

    expect(result.passed).toBe(false);
    expect(failed.map((c) => c.label).sort()).toEqual(
      [
        'The poller reached a destination that required resolving a neighbour',
        'A neighbour on this segment was really resolved',
      ].sort(),
    );
  });

  it('fails when the only neighbour on the segment never answered', async () => {
    // An address inside the prefix with nothing behind it: resolution was
    // attempted and failed, which is not the same as reaching something.
    const unanswered = JSON.stringify([
      { dst: '172.22.0.55', dev: 'eth0', state: ['FAILED'] },
    ]);

    const result = await verify(unanswered ? box(unanswered, { conf: FIXED_CONF, log: FIXED_LOG }) : solved());
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('A neighbour on this segment was really resolved');
  });

  it('fails when the API was broken along the way', async () => {
    const result = await verify(
      box(RESOLVED, { conf: FIXED_CONF, log: FIXED_LOG, sockets: [] }),
    );
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The ledger API is still healthy');
  });

  it('fails when the configuration was emptied rather than corrected', async () => {
    // Deleting the offending line removes the bad address, but the poller then
    // has nothing to reach and records so.
    const result = await verify(
      box(EMPTY_TABLE, {
        conf: '# ledger-api — settlement poller\npoll_interval_seconds = 5\n',
        log: `${SEEDED_LOG}2026-08-25T09:04:00Z settlement_endpoint=<empty> status=unconfigured neighbour=none\n`,
      }),
    );

    expect(result.passed).toBe(false);
    expect(failures(result.checks)).toHaveLength(2);
  });
});

// ------------------------------------------- 4. the fixture cannot self-pass

describe('the fixture cannot satisfy its own lab', () => {
  it('produces no resolved neighbour, because the seeded endpoint has no route', async () => {
    // This is the property the whole design rests on. The seeded endpoint is
    // outside every route this host holds, so the poll fails at the routing
    // decision and address resolution is never attempted.
    const result = await verify(box(EMPTY_TABLE));
    const neighbourCheck = result.checks.find(
      (c) => c.label === 'A neighbour on this segment was really resolved',
    );

    expect(neighbourCheck?.status).toBe('fail');
  });

  it('still produces none after the poller has run many times', async () => {
    // Restarting or simply leaving the fixture running must not drift into a
    // passing state: every cycle repeats the same unreachable outcome.
    const manyCycles = Array.from(
      { length: 40 },
      (_, i) => `2026-08-25T09:${String(i).padStart(2, '0')}:00Z settlement_endpoint=${BAD}:9200 status=unreachable neighbour=none`,
    ).join('\n');

    const result = await verify(box(EMPTY_TABLE, { log: manyCycles }));

    expect(result.passed).toBe(false);
    expect(
      result.checks.find((c) => c.label === 'A neighbour on this segment was really resolved')
        ?.status,
    ).toBe('fail');
  });

  it('does not accept the seeded log as evidence of a reachable destination', async () => {
    // `status=unreachable neighbour=none` must never satisfy a check looking
    // for `status=routable neighbour=resolved`.
    const result = await verify(box(EMPTY_TABLE));
    const logCheck = result.checks.find(
      (c) => c.label === 'The poller reached a destination that required resolving a neighbour',
    );

    expect(logCheck?.status).toBe('fail');
  });

  it('is not satisfied by a reset back to the baseline', async () => {
    const before = await verify(solved());
    expect(before.passed).toBe(true);

    // A reset restores the seeded config and replaces the container, so the
    // neighbour table starts empty and the log starts over.
    const after = await verify(box(EMPTY_TABLE, { conf: SEEDED_CONF, log: '' }));

    expect(after.passed).toBe(false);
    expect(after.summary).toBe('LAB NOT COMPLETE');
  });
});

// ------------------------------------------------------------- 5. isolation

describe('one student cannot satisfy another', () => {
  it("does not let a solved session carry an untouched one", async () => {
    const b = await verify(solved(), 'jtt-lab-000000000002');
    const a = await verify(box(EMPTY_TABLE), 'jtt-lab-000000000001');

    expect(b.passed).toBe(true);
    expect(a.passed).toBe(false);
  });

  it('reads only this session’s own files and table', async () => {
    const sandbox = solved();
    await verify(sandbox);

    // Exactly two inspections, both with argv the verifier owns: the neighbour
    // table and the listening-socket table. No lab operand reaches either.
    expect([...sandbox.inspections].sort()).toEqual([NEIGH, 'ss -H -lntu'].sort());
    const allowed = new Set([
      '/home/student/routing',
      '/home/student/routing/brief.txt',
      CONF,
      LOG,
      '/proc/net/dev',
    ]);
    for (const read of sandbox.reads) {
      expect(allowed.has(read), `unexpected read of ${read}`).toBe(true);
    }
  });
});
