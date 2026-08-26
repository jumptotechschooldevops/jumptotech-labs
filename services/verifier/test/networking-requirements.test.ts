/**
 * NET-002 — verification for the Networking track's first lab.
 *
 * NET-002 grades four things, and the sections below follow them:
 *
 *   1. arithmetic the student can only have done (broadcast addresses, host
 *      ranges, host counts);
 *   2. a classification that has a documented right answer and a popular wrong
 *      one (172.32.5.1 is *outside* 172.16.0.0/12);
 *   3. a non-overlapping allocation;
 *   4. a capture of the machine's own local routing table, which is where the
 *      student checks their broadcast rule against the kernel's.
 *
 * Every check in this lab is a `file_content` read. Nothing here runs a
 * command, so there is no argv for a lab operand to leak into — the injection
 * section asserts that property rather than assuming it.
 *
 * The reader is an in-memory sandbox. Real `docker exec` reads against a real
 * container are the integration suites' job.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const NET_002 = path.join(LABS_DIR, 'networking', 'net-002-cidr-subnetting', 'lab.yaml');

const NAMESPACE = 'jtt-lab-000000000001';

class FakeSandbox implements SandboxPort {
  readonly reads: string[] = [];
  constructor(private readonly entries: Record<string, Partial<SandboxPathRead>> = {}) {}

  put(pathName: string, entry: Partial<SandboxPathRead>): this {
    this.entries[pathName] = entry;
    return this;
  }

  remove(pathName: string): this {
    delete this.entries[pathName];
    return this;
  }

  async read(relativePath: string): Promise<SandboxPathRead | null> {
    this.reads.push(relativePath);
    const entry = this.entries[relativePath];
    if (!entry) return null;
    const content = entry.content ?? '';
    return {
      type: entry.type ?? 'file',
      mode: entry.mode ?? '644',
      owner: entry.owner ?? 'student',
      group: entry.group ?? 'student',
      sizeBytes: entry.sizeBytes ?? content.length,
      ...(entry.type === 'directory' ? {} : { content }),
      ...(entry.truncated ? { truncated: true } : {}),
    };
  }
}

function failures(checks: Array<{ status: string; label: string; detail?: string }>) {
  return checks.filter((c) => c.status !== 'pass');
}

// --- the world, before and after -------------------------------------------

/** The templates exactly as the lab seeds them: every answer line still blank. */
const SEEDED_PLAN = `JumpToTech Bank — addressing plan

BLOCK A  10.20.16.0/20
  network =
  broadcast =
  first_usable =
  last_usable =
  usable_count =

BLOCK B  10.20.5.128/26
  network =
  broadcast =
  first_usable =
  last_usable =
  usable_count =

BLOCK C  172.16.8.0/22
  network =
  broadcast =
  first_usable =
  last_usable =
  usable_count =

BLOCK D  192.168.100.64/28
  network =
  broadcast =
  first_usable =
  last_usable =
  usable_count =

  prod =
  staging =
  dev =
`;

const SEEDED_CLASSIFY = `10.20.31.254 =
172.32.5.1 =
192.168.100.79 =
127.0.0.1 =
169.254.10.5 =
8.8.8.8 =
`;

/**
 * A correct plan.
 *
 * Derived, not copied: a /20 leaves 12 host bits, so 10.20.16.0/20 spans
 * 10.20.16.0–10.20.31.255 and offers 4096 − 2 assignable addresses — RFC 1122
 * section 3.2.1.3 reserves the all-zeros and all-ones forms.
 */
const SOLVED_PLAN = `JumpToTech Bank — addressing plan

BLOCK A  10.20.16.0/20
  network = 10.20.16.0
  broadcast = 10.20.31.255
  first_usable = 10.20.16.1
  last_usable = 10.20.31.254
  usable_count = 4094

BLOCK B  10.20.5.128/26
  network = 10.20.5.128
  broadcast = 10.20.5.191
  first_usable = 10.20.5.129
  last_usable = 10.20.5.190
  usable_count = 62

BLOCK C  172.16.8.0/22
  network = 172.16.8.0
  broadcast = 172.16.11.255
  first_usable = 172.16.8.1
  last_usable = 172.16.11.254
  usable_count = 1022

BLOCK D  192.168.100.64/28
  network = 192.168.100.64
  broadcast = 192.168.100.79
  first_usable = 192.168.100.65
  last_usable = 192.168.100.78
  usable_count = 14

  prod = 10.20.0.0/20
  staging = 10.20.16.0/20
  dev = 10.20.32.0/20
`;

const SOLVED_CLASSIFY = `10.20.31.254 = private
172.32.5.1 = public
192.168.100.79 = private
127.0.0.1 = loopback
169.254.10.5 = link-local
8.8.8.8 = public
`;

/**
 * A real capture, as the kernel prints it in a `--network none` container.
 * Taken from a live read of /proc/net/fib_trie so the test grades the shape a
 * student will actually produce, not an idealised one.
 */
const SOLVED_KERNEL = `Main:
  +-- 127.0.0.0/8 2 0 2
     +-- 127.0.0.0/31 1 0 0
        |-- 127.0.0.0
           /8 host LOCAL
        |-- 127.0.0.1
           /32 host LOCAL
     |-- 127.255.255.255
        /32 link BROADCAST
Local:
  +-- 127.0.0.0/8 2 0 2
     |-- 127.255.255.255
        /32 link BROADCAST
loopback_addresses = 16777216
`;

function seededSandbox(): FakeSandbox {
  return new FakeSandbox({
    '/home/student/subnets': { type: 'directory', mode: '755' },
    '/home/student/subnets/brief.txt': { type: 'file', content: 'blocks inside 10.20.0.0/16\n' },
    '/home/student/subnets/plan.txt': { type: 'file', content: SEEDED_PLAN },
    '/home/student/subnets/classify.txt': { type: 'file', content: SEEDED_CLASSIFY },
    '/proc/net/fib_trie': { type: 'file', content: SOLVED_KERNEL },
  });
}

function solvedSandbox(): FakeSandbox {
  return seededSandbox()
    .put('/home/student/subnets/plan.txt', { type: 'file', content: SOLVED_PLAN })
    .put('/home/student/subnets/classify.txt', { type: 'file', content: SOLVED_CLASSIFY })
    .put('/home/student/subnets/kernel.txt', { type: 'file', content: SOLVED_KERNEL });
}

// --------------------------------------------------------- 1. negative case

describe('NET-002 before the work', () => {
  it('fails every requirement on the seeded templates, and never names the answer', async () => {
    const lab = await loadLabDefinition(NET_002);
    const result = await verifyLab({ lab, sandbox: seededSandbox(), namespace: NAMESPACE });

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    expect(failures(result.checks)).toHaveLength(lab.requirements.length);

    // A blank template must not accidentally satisfy a substring check, and the
    // failure text must not hand over a value the student is meant to derive.
    const reported = JSON.stringify(result.checks);
    for (const answer of ['10.20.31.255', '172.16.11.255', '4094', '16777216', '10.20.32.0/20']) {
      expect(reported).not.toContain(answer);
    }
  });

  it('fails on a completely empty sandbox too, rather than erroring', async () => {
    const lab = await loadLabDefinition(NET_002);
    const result = await verifyLab({ lab, sandbox: new FakeSandbox(), namespace: NAMESPACE });

    expect(result.passed).toBe(false);
    expect(failures(result.checks)).toHaveLength(lab.requirements.length);
  });
});

// --------------------------------------------------------- 2. positive case

describe('NET-002 after the work', () => {
  it('passes once all three files hold the derived answers', async () => {
    const lab = await loadLabDefinition(NET_002);
    const result = await verifyLab({ lab, sandbox: solvedSandbox(), namespace: NAMESPACE });

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('accepts an `ip route show table local` capture as readily as a fib_trie one', async () => {
    const lab = await loadLabDefinition(NET_002);
    const viaIpRoute = [
      'local 127.0.0.0/8 dev lo proto kernel scope host src 127.0.0.1',
      'local 127.0.0.1 dev lo proto kernel scope host src 127.0.0.1',
      'broadcast 127.255.255.255 dev lo proto kernel scope link src 127.0.0.1',
      'loopback_addresses = 16777216',
    ].join('\n');

    const sandbox = solvedSandbox().put('/home/student/subnets/kernel.txt', {
      type: 'file',
      content: viaIpRoute,
    });
    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

// ------------------------------------------------------ 3. wrong-value cases

describe('NET-002 fails one wrong value at a time', () => {
  it('rejects a broadcast address taken from the wrong end of the block', async () => {
    const lab = await loadLabDefinition(NET_002);
    // 10.20.16.255 is the end of a /24, not of the /20 the lab asked about.
    const sandbox = solvedSandbox().put('/home/student/subnets/plan.txt', {
      type: 'file',
      content: SOLVED_PLAN.replace('broadcast = 10.20.31.255', 'broadcast = 10.20.16.255'),
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('Block A: the broadcast address of 10.20.16.0/20');
  });

  it('rejects a host count that forgot the network and broadcast addresses', async () => {
    const lab = await loadLabDefinition(NET_002);
    // 4096 is the size of the block; 4094 is what can be assigned to a host.
    const sandbox = solvedSandbox().put('/home/student/subnets/plan.txt', {
      type: 'file',
      content: SOLVED_PLAN.replace('usable_count = 4094', 'usable_count = 4096'),
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('Block A: the number of assignable addresses');
  });

  it('rejects the "everything starting 172 is private" misconception', async () => {
    const lab = await loadLabDefinition(NET_002);
    // RFC 1918 reserves 172.16.0.0/12, which ends at 172.31.255.255.
    const sandbox = solvedSandbox().put('/home/student/subnets/classify.txt', {
      type: 'file',
      content: SOLVED_CLASSIFY.replace('172.32.5.1 = public', '172.32.5.1 = private'),
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('172.32.5.1 is outside the reserved 172.16.0.0/12 block');
  });

  it('rejects a link-local address filed as private', async () => {
    const lab = await loadLabDefinition(NET_002);
    const sandbox = solvedSandbox().put('/home/student/subnets/classify.txt', {
      type: 'file',
      content: SOLVED_CLASSIFY.replace('169.254.10.5 = link-local', '169.254.10.5 = private'),
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(failures(result.checks)).toHaveLength(1);
  });

  it('rejects an allocation whose second block overlaps the first', async () => {
    const lab = await loadLabDefinition(NET_002);
    // 10.20.8.0/20 is not a /20 boundary at all, and it overlaps prod.
    const sandbox = solvedSandbox().put('/home/student/subnets/plan.txt', {
      type: 'file',
      content: SOLVED_PLAN.replace('staging = 10.20.16.0/20', 'staging = 10.20.8.0/20'),
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The second /20 follows the first without overlapping it');
  });

  it('rejects a total that counted only the assignable addresses', async () => {
    const lab = await loadLabDefinition(NET_002);
    const sandbox = solvedSandbox().put('/home/student/subnets/kernel.txt', {
      type: 'file',
      content: SOLVED_KERNEL.replace('16777216', '16777214'),
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The total address count of that prefix was computed');
  });
});

// ------------------------------------------------------ 4. malformed input

describe('NET-002 handles malformed and missing work honestly', () => {
  it('fails the three kernel checks when the capture was never made', async () => {
    const lab = await loadLabDefinition(NET_002);
    const sandbox = solvedSandbox();
    sandbox.remove('/home/student/subnets/kernel.txt');

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(3);
    for (const check of failed) {
      expect(check.detail).toMatch(/kernel\.txt/);
    }
  });

  it('does not accept a directory standing in for a graded file', async () => {
    const lab = await loadLabDefinition(NET_002);
    const sandbox = solvedSandbox().put('/home/student/subnets/kernel.txt', {
      type: 'directory',
      mode: '755',
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(failures(result.checks)).toHaveLength(3);
    expect(result.passed).toBe(false);
  });

  it('does not pass on a truncated read of an otherwise correct file', async () => {
    const lab = await loadLabDefinition(NET_002);
    const sandbox = solvedSandbox().put('/home/student/subnets/plan.txt', {
      type: 'file',
      content: SOLVED_PLAN.slice(0, 120),
      truncated: true,
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(result.passed).toBe(false);
    expect(failures(result.checks).length).toBeGreaterThan(0);
  });

  it('survives a file full of replacement characters without throwing', async () => {
    const lab = await loadLabDefinition(NET_002);
    const sandbox = solvedSandbox().put('/home/student/subnets/classify.txt', {
      type: 'file',
      content: ` �  binary garbage �   `,
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(result.passed).toBe(false);
    expect(failures(result.checks)).toHaveLength(4);
  });
});

// --------------------------------------------------------- 5. no injection

describe('NET-002 verification cannot become command execution', () => {
  it('reads exactly the paths the lab named, and nothing else', async () => {
    const lab = await loadLabDefinition(NET_002);
    const sandbox = solvedSandbox();
    await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    const expected = new Set([
      '/home/student/subnets',
      '/home/student/subnets/brief.txt',
      '/home/student/subnets/plan.txt',
      '/home/student/subnets/classify.txt',
      '/home/student/subnets/kernel.txt',
      '/proc/net/fib_trie',
    ]);

    expect(sandbox.reads.length).toBeGreaterThan(0);
    for (const read of sandbox.reads) {
      expect(expected.has(read), `unexpected read of ${read}`).toBe(true);
      expect(read.split('/')).not.toContain('..');
      expect(read).not.toMatch(/[;&|`$()<>*?\\'"]/);
    }
  });

  it('never asks the sandbox to run anything', async () => {
    const lab = await loadLabDefinition(NET_002);

    // This sandbox port implements `read` only. If any check tried to inspect
    // the process table or run a script, the verifier would have to call a
    // method that does not exist here — so a passing run is itself the proof.
    const sandbox = solvedSandbox();
    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(result.passed).toBe(true);
    expect('inspect' in sandbox).toBe(false);
    expect('runScript' in sandbox).toBe(false);
  });

  it('treats student content as data, not as a pattern', async () => {
    const lab = await loadLabDefinition(NET_002);
    // A student who pastes shell and regex syntax into their answers must
    // simply be graded on the text, not have matching behave differently.
    const hostile = `${SOLVED_PLAN}\n$(id) \`id\` ; rm -rf / | .* ^.*$ [a-z]+ \\n`;
    const sandbox = solvedSandbox().put('/home/student/subnets/plan.txt', {
      type: 'file',
      content: hostile,
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    // The real answers are still there, so it still passes — the point is that
    // the injected text changed nothing about the verdict.
    expect(result.passed).toBe(true);

    const globbed = solvedSandbox().put('/home/student/subnets/plan.txt', {
      type: 'file',
      content: SOLVED_PLAN.replace('broadcast = 10.20.31.255', 'broadcast = 10.20.31.*'),
    });
    const globResult = await verifyLab({ lab, sandbox: globbed, namespace: NAMESPACE });

    // `10.20.31.*` must not match `10.20.31.255`: contains is a literal.
    expect(globResult.passed).toBe(false);
  });
});

// -------------------------------------------------- 6. session isolation

describe('NET-002 verification stays inside one session', () => {
  it('reaches only through the sandbox it was handed', async () => {
    const lab = await loadLabDefinition(NET_002);

    const mine = solvedSandbox();
    const theirs = seededSandbox();

    const mineResult = await verifyLab({ lab, sandbox: mine, namespace: NAMESPACE });
    const theirsResult = await verifyLab({
      lab,
      sandbox: theirs,
      namespace: 'jtt-lab-000000000002',
    });

    // Two sessions, same lab, different state, independent verdicts. The second
    // session's reader looked for its own kernel.txt and found nothing, rather
    // than seeing the first session's finished work.
    expect(mineResult.passed).toBe(true);
    expect(theirsResult.passed).toBe(false);
    expect(theirs.reads).toContain('/home/student/subnets/kernel.txt');
    expect(mine.reads.length).toBeGreaterThan(0);
  });

  it('reads each path once per run, however many checks name it', async () => {
    const lab = await loadLabDefinition(NET_002);
    const sandbox = solvedSandbox();
    await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    const planReads = sandbox.reads.filter((r) => r.endsWith('/plan.txt'));
    // Ten requirements name plan.txt; the reader memoises, so the sandbox is
    // asked once. A per-check read would multiply container exec calls.
    expect(planReads).toHaveLength(1);
  });
});
