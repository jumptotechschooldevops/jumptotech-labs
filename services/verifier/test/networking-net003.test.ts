/**
 * NET-003 — verification for the layer-triage lab.
 *
 * NET-003 is the first Networking lab whose evidence is not purely textual. It
 * grades three things, and the sections below follow them:
 *
 *   1. **Evidence** — the real error each failure produced. Three of the four
 *      are properties of a `--network none` sandbox (a closed port, an address
 *      with no route, an unreachable resolver); the fourth is a seeded service
 *      that accepts the connection and then refuses at the application layer.
 *   2. **Observed behaviour** — the ledger API records every connection it
 *      answers, and one requirement asks the sandbox whether that record is
 *      non-empty. A student who typed a plausible HTTP response into `app.txt`
 *      without ever speaking to the service fails that check.
 *   3. **A committed diagnosis** — four `file_content_absent` checks make a
 *      hedged answer fail, so listing every layer against a symptom cannot
 *      satisfy the positive checks by accident.
 *
 * The bypass section is the point of this file: each test is an attempt to pass
 * the lab without doing it, and asserts that the attempt fails.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const NET_003 = path.join(LABS_DIR, 'networking', 'net-003-osi-tcpip-layers', 'lab.yaml');

const NAMESPACE = 'jtt-lab-000000000001';
const ACCESS_LOG = '/var/log/jumptotech/ledger-access.log';
const CONTACTED = { [`test -s ${ACCESS_LOG}`]: { exitCode: 0 } };

function failures(checks: Array<{ status: string; label: string; detail?: string }>) {
  return checks.filter((c) => c.status !== 'pass');
}

// --- the world, before and after -------------------------------------------

const SEEDED_TRIAGE = `JumpToTech Bank — layer triage

  refused_layer =
  unreachable_layer =
  resolution_layer =
  app_503_layer =

  not_a_network_problem =
`;

const SEEDED_MODEL = `JumpToTech Bank — the two models

  L4_rfc1122_name =
  L3_rfc1122_name =

  1 =
  2 =
  3 =
  4 =
`;

/**
 * A correct triage.
 *
 * ECONNREFUSED is returned by a TCP connect that "found no one listening on the
 * remote address" (connect(2)), so the transport layer reported it. ENETUNREACH
 * comes from the routing decision, before a segment is ever sent. DNS is an
 * application-layer support protocol (RFC 1123 §6), and a 503 is an HTTP
 * status (RFC 9110 §15.6.4) — both L7, from completely different causes.
 */
const SOLVED_TRIAGE = `JumpToTech Bank — layer triage

  refused_layer = L4
  unreachable_layer = L3
  resolution_layer = L7
  app_503_layer = L7

  not_a_network_problem = app_503
`;

const SOLVED_MODEL = `JumpToTech Bank — the two models

  L4_rfc1122_name = transport
  L3_rfc1122_name = internet

  1 = request
  2 = segment
  3 = packet
  4 = frame
`;

/** Real output, as observed from a `--network none` container. */
const REAL_REFUSED = 'nc: connect to 127.0.0.1 port 9110 (tcp) failed: Connection refused\n';
const REAL_UNREACHABLE = 'nc: connect to 10.99.99.99 port 80 (tcp) failed: Network is unreachable\n';
const REAL_RESOLUTION = 'ping: ledger.bank.invalid: Temporary failure in name resolution\n';
const REAL_APP = [
  'HTTP/1.1 503 Service Unavailable',
  'Content-Type: text/plain',
  'Content-Length: 44',
  'Connection: close',
  '',
  'ledger-api unavailable: JTT-LEDGER-503-7F2A',
  '',
].join('\n');

function world(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    files: {
      '/home/student/triage': { type: 'directory', mode: '755' },
      '/home/student/triage/brief.txt': { type: 'file', content: 'ledger.bank.invalid\n' },
      '/home/student/triage/triage.txt': { type: 'file', content: SEEDED_TRIAGE },
      '/home/student/triage/model.txt': { type: 'file', content: SEEDED_MODEL },
      '/etc/resolv.conf': { type: 'file', content: 'nameserver 10.99.99.99\n' },
    },
    ...overrides,
  };
}

/** The files a student leaves behind when they have done the lab honestly. */
function solvedFiles(): NonNullable<FakeWorld['files']> {
  return {
    ...world().files,
    '/home/student/triage/triage.txt': { type: 'file', content: SOLVED_TRIAGE },
    '/home/student/triage/model.txt': { type: 'file', content: SOLVED_MODEL },
    '/home/student/triage/refused.txt': { type: 'file', content: REAL_REFUSED },
    '/home/student/triage/unreachable.txt': { type: 'file', content: REAL_UNREACHABLE },
    '/home/student/triage/resolution.txt': { type: 'file', content: REAL_RESOLUTION },
    '/home/student/triage/app.txt': { type: 'file', content: REAL_APP },
  };
}

/** Everything the lab asks for, done honestly. */
function solved(): FakeSandbox {
  return new FakeSandbox({ files: solvedFiles(), commands: { ...CONTACTED } });
}

/** Replace one file in an otherwise-solved sandbox. */
function solvedExcept(pathName: string, content: string): FakeSandbox {
  const sandbox = solved();
  sandbox.put(pathName, { type: 'file', content });
  return sandbox;
}

// --------------------------------------------------------- 1. negative case

describe('NET-003 before the work', () => {
  it('fails every requirement on the seeded baseline, and never names an answer', async () => {
    const lab = await loadLabDefinition(NET_003);
    const result = await verifyLab({
      lab,
      sandbox: new FakeSandbox(world()),
      namespace: NAMESPACE,
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');

    // The five `file_content_absent` checks pass on a blank template — nothing
    // wrong is written there yet — so the untouched lab fails the other 14.
    const absentChecks = lab.requirements.filter((r) => r.type === 'file_content_absent');
    expect(absentChecks).toHaveLength(5);
    expect(failures(result.checks)).toHaveLength(lab.requirements.length - absentChecks.length);

    // No check may hand over the value that would satisfy it. Labels are shown
    // on every Check Solution, so a leaky one is a free answer.
    const reported = JSON.stringify(result.checks);
    for (const requirement of lab.requirements) {
      const answer = (requirement as { contains?: string }).contains;
      if (!answer) continue;
      expect(reported, `a check leaked '${answer}'`).not.toContain(answer);
    }
    for (const value of ['transport', 'internet', 'JTT-LEDGER-503-7F2A']) {
      expect(reported).not.toContain(value);
    }
  });

  it('fails on an empty sandbox rather than erroring', async () => {
    const lab = await loadLabDefinition(NET_003);
    const result = await verifyLab({ lab, sandbox: new FakeSandbox({}), namespace: NAMESPACE });

    expect(result.passed).toBe(false);
    expect(failures(result.checks).length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------- 2. positive case

describe('NET-003 after the work', () => {
  it('passes when the evidence is real and the diagnosis is committed', async () => {
    const lab = await loadLabDefinition(NET_003);
    const result = await verifyLab({ lab, sandbox: solved(), namespace: NAMESPACE });

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('accepts socat output as readily as nc output — the errno is the evidence', async () => {
    const lab = await loadLabDefinition(NET_003);
    const viaSocat = solvedExcept(
      '/home/student/triage/refused.txt',
      'socat[9] E connect(5, AF=2 127.0.0.1:9110, 16): Connection refused\n',
    );
    viaSocat.put('/home/student/triage/resolution.txt', {
      type: 'file',
      content:
        'socat[11] E getaddrinfo("ledger.bank.invalid", ...): Temporary failure in name resolution\n',
    });

    const result = await verifyLab({ lab, sandbox: viaSocat, namespace: NAMESPACE });

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

// ------------------------------------------------ 3. shortcut / bypass cases

describe('NET-003 cannot be passed without doing it', () => {
  it('rejects a fabricated HTTP response when the service was never contacted', async () => {
    const lab = await loadLabDefinition(NET_003);

    // app.txt is byte-for-byte what the service would have said — including the
    // token — but no connection was ever made, so the access log is empty.
    const sandbox = new FakeSandbox({
      files: solvedFiles(),
      commands: { [`test -s ${ACCESS_LOG}`]: { exitCode: 1 } },
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The ledger API was actually contacted');
    expect(result.passed).toBe(false);
  });

  it('rejects a hedged diagnosis that lists every layer on one line', async () => {
    const lab = await loadLabDefinition(NET_003);
    const hedged = SOLVED_TRIAGE.replace(
      'refused_layer = L4',
      'refused_layer = L1 L2 L3 L4 L5 L6 L7',
    );

    const result = await verifyLab({
      lab,
      sandbox: solvedExcept('/home/student/triage/triage.txt', hedged),
      namespace: NAMESPACE,
    });
    const failed = failures(result.checks);

    // The positive check wants L4 immediately after the '= ', so a line listing
    // every layer never matches it. Note that the absent check does *not* fire
    // here — 'refused_layer = L3' is not a substring of 'refused_layer = L1 L2
    // L3 …' — which is exactly why the multi-line shotgun below needs its own
    // defence, and why both tests exist.
    expect(result.passed).toBe(false);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The refused connection is attributed to the correct layer');
  });

  it('rejects the shotgun: every layer against every symptom, one per line', async () => {
    const lab = await loadLabDefinition(NET_003);

    // The attack the `file_content_absent` checks exist for. Every positive
    // substring is present somewhere in the file, so without those checks this
    // would pass the entire diagnosis section.
    const keys = ['refused_layer', 'unreachable_layer', 'resolution_layer', 'app_503_layer'];
    const shotgun = [
      ...keys.flatMap((key) => [1, 2, 3, 4, 5, 6, 7].map((n) => `  ${key} = L${n}`)),
      '  not_a_network_problem = app_503',
      '  not_a_network_problem = refused',
    ].join('\n');

    const result = await verifyLab({
      lab,
      sandbox: solvedExcept('/home/student/triage/triage.txt', shotgun),
      namespace: NAMESPACE,
    });
    const failed = failures(result.checks);

    expect(result.passed).toBe(false);
    // All four hedge checks fire, and nothing else — proving the positives
    // really would have been satisfied by the shotgun on their own.
    expect(failed).toHaveLength(4);
    for (const check of failed) expect(check.label).toContain('diagnosed once, not hedged');
  });

  it('rejects the same shotgun in model.txt', async () => {
    const lab = await loadLabDefinition(NET_003);
    const shotgun = [
      '  L4_rfc1122_name = transport',
      '  L3_rfc1122_name = internet',
      '  L3_rfc1122_name = link',
      '  1 = request',
      '  2 = segment',
      '  3 = packet',
      '  4 = frame',
    ].join('\n');

    const result = await verifyLab({
      lab,
      sandbox: solvedExcept('/home/student/triage/model.txt', shotgun),
      namespace: NAMESPACE,
    });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('OSI layer 3 was not mapped to the wrong RFC 1122 name');
  });

  it('rejects copying the brief into the answer files', async () => {
    const lab = await loadLabDefinition(NET_003);
    const brief =
      'refused  unreachable  resolution  app_503\nrefused_layer = L2\nledger.bank.invalid\n';

    const sandbox = solved();
    for (const name of ['triage.txt', 'model.txt', 'refused.txt', 'app.txt']) {
      sandbox.put(`/home/student/triage/${name}`, { type: 'file', content: brief });
    }

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(result.passed).toBe(false);
    expect(failures(result.checks).length).toBeGreaterThanOrEqual(9);
  });

  it('rejects right answers put in the wrong slots', async () => {
    const lab = await loadLabDefinition(NET_003);
    // L3 and L4 swapped: both values appear in the file, both in the wrong place.
    const swapped = SOLVED_TRIAGE.replace('refused_layer = L4', 'refused_layer = L3').replace(
      'unreachable_layer = L3',
      'unreachable_layer = L4',
    );

    const result = await verifyLab({
      lab,
      sandbox: solvedExcept('/home/student/triage/triage.txt', swapped),
      namespace: NAMESPACE,
    });

    expect(result.passed).toBe(false);
    // Two positives miss and both hedge checks fire on the wrong values.
    expect(failures(result.checks)).toHaveLength(4);
  });

  it('rejects an app.txt holding only the status line, with no body observed', async () => {
    const lab = await loadLabDefinition(NET_003);
    // What a student sees if they connect but never send a request: nothing.
    // Guessing the status line is easy; the body token is not.
    const result = await verifyLab({
      lab,
      sandbox: solvedExcept('/home/student/triage/app.txt', 'HTTP/1.1 503 Service Unavailable\n'),
      namespace: NAMESPACE,
    });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe("The ledger API's response body was captured");
  });
});

// ------------------------------------------------------ 4. wrong-value cases

describe('NET-003 fails one wrong value at a time', () => {
  it('rejects a refused connection blamed on the network layer', async () => {
    const lab = await loadLabDefinition(NET_003);
    const result = await verifyLab({
      lab,
      sandbox: solvedExcept(
        '/home/student/triage/triage.txt',
        SOLVED_TRIAGE.replace('refused_layer = L4', 'refused_layer = L3'),
      ),
      namespace: NAMESPACE,
    });

    expect(failures(result.checks)).toHaveLength(2);
  });

  it('rejects naming the 503 a network problem', async () => {
    const lab = await loadLabDefinition(NET_003);
    const result = await verifyLab({
      lab,
      sandbox: solvedExcept(
        '/home/student/triage/triage.txt',
        SOLVED_TRIAGE.replace('not_a_network_problem = app_503', 'not_a_network_problem = refused'),
      ),
      namespace: NAMESPACE,
    });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The one failure that is not a network problem was identified');
  });

  it('rejects mapping OSI layer 3 onto the link layer', async () => {
    const lab = await loadLabDefinition(NET_003);
    const result = await verifyLab({
      lab,
      sandbox: solvedExcept(
        '/home/student/triage/model.txt',
        SOLVED_MODEL.replace('L3_rfc1122_name = internet', 'L3_rfc1122_name = link'),
      ),
      namespace: NAMESPACE,
    });

    // The positive check misses and the hedge check fires.
    expect(failures(result.checks)).toHaveLength(2);
  });

  it('rejects encapsulation ordered from the wire upwards', async () => {
    const lab = await loadLabDefinition(NET_003);
    const reversed = SOLVED_MODEL.replace('1 = request', '1 = frame')
      .replace('2 = segment', '2 = packet')
      .replace('3 = packet', '3 = segment')
      .replace('4 = frame', '4 = request');

    const result = await verifyLab({
      lab,
      sandbox: solvedExcept('/home/student/triage/model.txt', reversed),
      namespace: NAMESPACE,
    });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('Encapsulation was ordered correctly');
  });

  it('rejects evidence that records the wrong failure', async () => {
    const lab = await loadLabDefinition(NET_003);
    // "No route to host" (EHOSTUNREACH) is a different error from ENETUNREACH.
    const result = await verifyLab({
      lab,
      sandbox: solvedExcept(
        '/home/student/triage/unreachable.txt',
        'nc: connect to 10.99.99.99 port 80 (tcp) failed: No route to host\n',
      ),
      namespace: NAMESPACE,
    });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The unreachable network was reproduced and its error recorded');
  });
});

// ------------------------------------------------------- 5. malformed input

describe('NET-003 handles malformed and missing work honestly', () => {
  it('fails the evidence checks when the files were never created', async () => {
    const lab = await loadLabDefinition(NET_003);
    const sandbox = solved();
    for (const name of ['refused.txt', 'unreachable.txt', 'resolution.txt', 'app.txt']) {
      sandbox.remove(`/home/student/triage/${name}`);
    }

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(failures(result.checks)).toHaveLength(5);
    expect(result.passed).toBe(false);
  });

  it('does not accept a directory standing in for an evidence file', async () => {
    const lab = await loadLabDefinition(NET_003);
    const sandbox = solved();
    sandbox.put('/home/student/triage/app.txt', { type: 'directory', mode: '755' });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(failures(result.checks)).toHaveLength(2);
  });

  it('does not pass on a truncated read of an otherwise correct file', async () => {
    const lab = await loadLabDefinition(NET_003);
    const sandbox = solved();
    sandbox.put('/home/student/triage/triage.txt', {
      type: 'file',
      content: SOLVED_TRIAGE.slice(0, 60),
      truncated: true,
    });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(result.passed).toBe(false);
  });

  it('reports a sandbox that cannot answer the behavioural check, without passing it', async () => {
    const lab = await loadLabDefinition(NET_003);
    // The inspection command is simply unknown to this sandbox.
    const sandbox = new FakeSandbox({ files: solvedFiles() });

    const result = await verifyLab({ lab, sandbox, namespace: NAMESPACE });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The ledger API was actually contacted');
  });
});

// ----------------------------------------------------------- 6. reset

describe('NET-003 reset returns the lab to its starting condition', () => {
  it('goes back to NOT COMPLETE once the container is replaced and re-seeded', async () => {
    const lab = await loadLabDefinition(NET_003);

    const before = await verifyLab({ lab, sandbox: solved(), namespace: NAMESPACE });
    expect(before.passed).toBe(true);

    // A Linux reset replaces the container: the student's evidence files are
    // gone, the templates are seeded blank again, and the service's access log
    // starts empty — so the behavioural check fails again too.
    const afterReset = new FakeSandbox({
      files: { ...world().files },
      commands: { [`test -s ${ACCESS_LOG}`]: { exitCode: 1 } },
    });
    const after = await verifyLab({ lab, sandbox: afterReset, namespace: NAMESPACE });

    expect(after.passed).toBe(false);
    expect(after.summary).toBe('LAB NOT COMPLETE');
    // Same verdict as a lab that was never started: the reset left nothing of
    // the student's work behind, including the service's access log.
    const absentChecks = lab.requirements.filter((r) => r.type === 'file_content_absent');
    expect(failures(after.checks)).toHaveLength(lab.requirements.length - absentChecks.length);
  });
});

// -------------------------------------------------- 7. operands stay inert

describe('NET-003 verification cannot become command execution', () => {
  it('runs exactly one inspection, as an argv array of allow-listed parts', async () => {
    const lab = await loadLabDefinition(NET_003);
    const sandbox = solved();
    await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    expect(sandbox.inspections).toEqual([`test -s ${ACCESS_LOG}`]);

    const [requirement] = lab.requirements.filter((r) => r.type === 'command_exit_code');
    expect(requirement).toBeDefined();
    const inspection = requirement as { command: string; args: string[] };
    expect(inspection.command).toBe('test');
    for (const arg of inspection.args) {
      expect(arg).toMatch(/^[A-Za-z0-9._\-/=:,%@+]+$/);
      expect(arg).not.toMatch(/[;&|`$()<>*?\\'"\s]/);
    }
  });

  it('reads only the paths the lab names', async () => {
    const lab = await loadLabDefinition(NET_003);
    const sandbox = solved();
    await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    const allowed = new Set([
      '/home/student/triage',
      '/home/student/triage/brief.txt',
      '/home/student/triage/triage.txt',
      '/home/student/triage/model.txt',
      '/home/student/triage/refused.txt',
      '/home/student/triage/unreachable.txt',
      '/home/student/triage/resolution.txt',
      '/home/student/triage/app.txt',
      '/etc/resolv.conf',
    ]);

    expect(sandbox.reads.length).toBeGreaterThan(0);
    for (const read of sandbox.reads) {
      expect(allowed.has(read), `unexpected read of ${read}`).toBe(true);
      expect(read.split('/')).not.toContain('..');
      expect(read).not.toMatch(/[;&|`$()<>*?\\'"]/);
    }
  });

  it('treats student content as data, not as a pattern', async () => {
    const lab = await loadLabDefinition(NET_003);
    const hostile = `${SOLVED_TRIAGE}\n$(id) \`id\` ; rm -rf / | .* ^.*$ [L0-9]+ \\n`;

    const result = await verifyLab({
      lab,
      sandbox: solvedExcept('/home/student/triage/triage.txt', hostile),
      namespace: NAMESPACE,
    });

    // The committed answers are still there, so the injected text changes
    // nothing about the verdict.
    expect(result.passed).toBe(true);

    // And a regex in place of an answer is not a wildcard: it is just wrong.
    const globbed = await verifyLab({
      lab,
      sandbox: solvedExcept(
        '/home/student/triage/triage.txt',
        SOLVED_TRIAGE.replace('refused_layer = L4', 'refused_layer = L.'),
      ),
      namespace: NAMESPACE,
    });
    expect(globbed.passed).toBe(false);
  });
});
