/**
 * NET-004 — verification for the neighbour-discovery lab.
 *
 * Three of this lab's checks read the kernel's neighbour table, and they are
 * the reason the lab exists in this form: a neighbour entry cannot be written
 * by a student. Producing one means traffic was actually sent and the kernel
 * recorded what came back, and writing one by hand needs CAP_NET_ADMIN, which
 * no sandbox grants. Everything in the adversarial section below is an attempt
 * to pass without doing that, and every one of them fails.
 *
 * The neighbour rows here are the shape a real kernel produced in a
 * `--network none` container attached to a lab bridge, not an invention.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const NET_004 = path.join(LABS_DIR, 'networking', 'net-004-arp-neighbours', 'lab.yaml');

const NEIGH = 'ip -json neigh show';
const NS_A = 'jtt-lab-000000000001';
const NS_B = 'jtt-lab-000000000002';

function failures(checks: Array<{ status: string; label: string; detail?: string }>) {
  return checks.filter((c) => c.status !== 'pass');
}

/**
 * The table after a student has produced all three outcomes.
 *
 * `172.18.0.1` rather than a round number on purpose: the segment is allocated
 * by the daemon when the session starts, so a real student's gateway is
 * whatever they were given — which is exactly why the lab grades the *shape*
 * of the outcome and never a hardcoded address.
 */
const SOLVED_NEIGHBOURS = JSON.stringify([
  { dst: '172.18.0.1', dev: 'eth0', lladdr: '02:42:9a:1c:44:01', state: ['REACHABLE'] },
  { dst: '172.18.0.55', dev: 'eth0', state: ['FAILED'] },
]);

const SEEDED_ANSWERS = `JumpToTech Bank — link-layer review

  arp_request_destination =
  off_subnet_frame_goes_to =
`;

const SOLVED_ANSWERS = `JumpToTech Bank — link-layer review

  arp_request_destination = broadcast
  off_subnet_frame_goes_to = the gateway
`;

const SOLVED_FINDINGS = `172.18.0.1 dev eth0 lladdr 02:42:9a:1c:44:01 REACHABLE
172.18.0.55 dev eth0 FAILED
`;

function baseFiles(): NonNullable<FakeWorld['files']> {
  return {
    '/home/student/l2': { type: 'directory', mode: '755' },
    '/home/student/l2/brief.txt': { type: 'file', content: 'reach for 10.99.99.99\n' },
    '/home/student/l2/answers.txt': { type: 'file', content: SEEDED_ANSWERS },
    '/proc/net/dev': { type: 'file', content: 'eth0: 0 0\n  lo: 0 0\n' },
  };
}

function solvedFiles(): NonNullable<FakeWorld['files']> {
  return {
    ...baseFiles(),
    '/home/student/l2/answers.txt': { type: 'file', content: SOLVED_ANSWERS },
    '/home/student/l2/findings.txt': { type: 'file', content: SOLVED_FINDINGS },
  };
}

function box(neighbours: string, files = solvedFiles()): FakeSandbox {
  return new FakeSandbox({ files, commands: { [NEIGH]: { stdout: neighbours } } });
}

async function verify(sandbox: FakeSandbox, namespace = NS_A) {
  return verifyLab({ lab: await loadLabDefinition(NET_004), sandbox, namespace });
}

// --------------------------------------------------------- 1. before and after

describe('NET-004 before the work', () => {
  it('fails on an untouched sandbox', async () => {
    const result = await verify(box('[]', baseFiles()));

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    // Three checks legitimately pass on an untouched sandbox: the two hedge
    // guards (nothing wrong is written yet) and the absence check for the
    // off-segment address (nothing has been tried yet). The other five fail.
    expect(failures(result.checks)).toHaveLength(5);
  });

  it('never names an answer in a check label or detail', async () => {
    const lab = await loadLabDefinition(NET_004);
    const result = await verify(box('[]', baseFiles()));
    const reported = JSON.stringify(result.checks);

    for (const requirement of lab.requirements) {
      const answer = (requirement as { contains?: string }).contains;
      // `eth0` is the interface the student reads off their own machine, not a
      // graded answer, and it legitimately appears in observed-state detail.
      if (!answer || answer === 'eth0') continue;
      expect(reported, `a check leaked '${answer}'`).not.toContain(answer);
    }
    // The two remaining answer-sheet values must not appear anywhere a student
    // can see. The questions whose answers a check's own detail would have
    // echoed — the NUD state names — were removed from the sheet for exactly
    // this reason: the kernel checks already prove those outcomes.
    for (const value of ['broadcast', 'the gateway']) {
      expect(reported).not.toContain(value);
    }
  });
});

describe('NET-004 after the work', () => {
  it('passes once all three outcomes exist and the answers are right', async () => {
    const result = await verify(box(SOLVED_NEIGHBOURS));

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes whatever segment the session was allocated', async () => {
    // A different daemon allocation entirely: nothing in the lab is pinned to
    // an address, so a student on 10.42.x passes exactly as one on 172.18.x.
    const elsewhere = JSON.stringify([
      { dst: '10.42.7.1', dev: 'eth0', lladdr: '02:42:0a:2a:07:01', state: ['STALE'] },
      { dst: '10.42.7.99', dev: 'eth0', state: ['INCOMPLETE'] },
    ]);

    const result = await verify(box(elsewhere));

    expect(failures(result.checks)).toEqual([]);
  });
});

// -------------------------------------------------------- 2. adversarial set

describe('NET-004 cannot be passed without producing the state', () => {
  it('rejects the expected neighbour information written to a file', async () => {
    const files = solvedFiles();
    files['/home/student/l2/findings.txt'] = { type: 'file', content: SOLVED_FINDINGS };
    files['/home/student/l2/neigh.json'] = { type: 'file', content: SOLVED_NEIGHBOURS };

    const result = await verify(box('[]', files));
    const failed = failures(result.checks);

    // The findings file is there and correct; the table is empty. All three
    // kernel checks fail regardless of what the student wrote down.
    expect(result.passed).toBe(false);
    expect(failed.map((c) => c.label)).toEqual([
      'A neighbour on this segment was resolved to a hardware address',
      'An address on this segment was asked for and never answered',
    ]);
  });

  it('rejects a shell history full of the right commands', async () => {
    const files = solvedFiles();
    files['/home/student/.bash_history'] = {
      type: 'file',
      content: 'ip neigh show\nnc -w2 -v 172.18.0.1 9\nnc -w2 -v 172.18.0.55 9\n',
    };

    const result = await verify(box('[]', files));

    expect(result.passed).toBe(false);
  });

  it('rejects an entry on an unrelated interface', async () => {
    // Resolving something on another link is not resolving one on this segment.
    const elsewhere = JSON.stringify([
      { dst: '172.18.0.1', dev: 'eth9', lladdr: '02:42:9a:1c:44:01', state: ['REACHABLE'] },
      { dst: '172.18.0.55', dev: 'eth9', state: ['FAILED'] },
    ]);

    const result = await verify(box(elsewhere));

    expect(failures(result.checks)).toHaveLength(2);
  });

  it("rejects another session's topology", async () => {
    const solved = box(SOLVED_NEIGHBOURS);
    const untouched = box('[]', baseFiles());

    const b = await verify(solved, NS_B);
    const a = await verify(untouched, NS_A);

    // Session B did the work. Session A is unchanged by that, in both
    // directions: neighbour tables live in per-session network namespaces.
    expect(b.passed).toBe(true);
    expect(a.passed).toBe(false);
  });

  it('rejects a resolved neighbour with the unanswered one removed', async () => {
    const onlyResolved = JSON.stringify([
      { dst: '172.18.0.1', dev: 'eth0', lladdr: '02:42:9a:1c:44:01', state: ['REACHABLE'] },
    ]);

    const result = await verify(box(onlyResolved));
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('An address on this segment was asked for and never answered');
  });

  it('rejects the wrong destination: resolving the off-segment address instead', async () => {
    // If 10.99.99.99 somehow ends up in the table, the lesson did not land —
    // a destination with no route must never reach the neighbour stage.
    const wrong = JSON.stringify([
      { dst: '172.18.0.1', dev: 'eth0', lladdr: '02:42:9a:1c:44:01', state: ['REACHABLE'] },
      { dst: '172.18.0.55', dev: 'eth0', state: ['FAILED'] },
      { dst: '10.99.99.99', dev: 'eth0', state: ['FAILED'] },
    ]);

    const result = await verify(box(wrong));
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The off-segment destination never reached the neighbour stage');
  });

  it('rejects a hedged answer sheet', async () => {
    const hedged = [
      '  arp_request_destination = broadcast',
      '  arp_request_destination = unicast',
      '  off_subnet_frame_goes_to = the gateway',
      '  off_subnet_frame_goes_to = the destination itself',
    ].join('\n');

    const files = solvedFiles();
    files['/home/student/l2/answers.txt'] = { type: 'file', content: hedged };

    const result = await verify(box(SOLVED_NEIGHBOURS, files));
    const failed = failures(result.checks);

    // Every positive check is satisfied by the hedge; both absent checks fire,
    // which is the entire reason they exist.
    expect(failed).toHaveLength(2);
    for (const check of failed) expect(check.label).toContain('not hedged');
  });

  it('rejects documentation-only work', async () => {
    // Editing text and nothing else must not move the verdict at all.
    const files = solvedFiles();
    files['/home/student/l2/notes.md'] = {
      type: 'file',
      content: '# I understand ARP now\nbroadcast, FAILED, none, the gateway\n',
    };

    const result = await verify(box('[]', files));

    expect(result.passed).toBe(false);
  });

  it('is idempotent: checking repeatedly changes nothing', async () => {
    const sandbox = box(SOLVED_NEIGHBOURS);

    const first = await verify(sandbox);
    const second = await verify(sandbox);
    const third = await verify(sandbox);

    expect([first.passed, second.passed, third.passed]).toEqual([true, true, true]);
    expect(first.checks.map((c) => c.status)).toEqual(second.checks.map((c) => c.status));
    expect(second.checks.map((c) => c.status)).toEqual(third.checks.map((c) => c.status));
  });
});

// ------------------------------------------------------------- 3. reset

describe('NET-004 reset', () => {
  it('cannot keep a previous pass once the topology is rebuilt', async () => {
    const before = await verify(box(SOLVED_NEIGHBOURS));
    expect(before.passed).toBe(true);

    // A reset replaces the container. The new one joins the same private
    // network, but its network namespace — and so its neighbour table — is
    // empty, and the seeded answer sheet is blank again.
    const after = await verify(box('[]', baseFiles()));

    expect(after.passed).toBe(false);
    expect(after.summary).toBe('LAB NOT COMPLETE');
    expect(failures(after.checks)).toHaveLength(5);
  });

  it('a stale findings file cannot carry a pass across a reset', async () => {
    // The student's file survives nothing, but even if it did, it is not what
    // the three kernel checks read.
    const files = baseFiles();
    files['/home/student/l2/findings.txt'] = { type: 'file', content: SOLVED_FINDINGS };
    files['/home/student/l2/answers.txt'] = { type: 'file', content: SOLVED_ANSWERS };

    const result = await verify(box('[]', files));
    const failed = failures(result.checks);

    expect(result.passed).toBe(false);
    expect(failed).toHaveLength(2);
    for (const check of failed) {
      expect(check.label).toMatch(/resolved to a hardware address|never answered/);
    }
  });
});

// ----------------------------------------------------- 4. reads stay in bounds

describe('NET-004 verification stays inside one session', () => {
  it('reads only the paths and the one command the lab named', async () => {
    const sandbox = box(SOLVED_NEIGHBOURS);
    await verify(sandbox);

    expect(sandbox.inspections).toEqual([NEIGH]);
    const allowed = new Set([
      '/home/student/l2',
      '/home/student/l2/brief.txt',
      '/home/student/l2/answers.txt',
      '/home/student/l2/findings.txt',
      '/proc/net/dev',
    ]);
    for (const read of sandbox.reads) {
      expect(allowed.has(read), `unexpected read of ${read}`).toBe(true);
    }
  });
});
