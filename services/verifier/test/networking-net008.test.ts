/**
 * NET-008 — verification for the connection-lifecycle lab.
 *
 * This is the first lab whose evidence is a packet capture, and a capture is a
 * text file: a student could type one. So the capture checks are not the whole
 * of the grade. Each service records what actually reached it, and two
 * behavioural checks ask the sandbox whether those records are non-empty — a
 * connection log only grows when a connection really completed, and a datagram
 * log only when a datagram really arrived. Typing a plausible tcpdump
 * transcript satisfies neither.
 *
 * The capture strings below are not invented. They were read off a real
 * tcpdump inside the sandbox image, which is also why `Flags [R.]` is matched
 * with its trailing dot: a reset carrying an ACK is what a refused connection
 * on loopback actually produces.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const NET_008 = path.join(LABS_DIR, 'networking', 'net-008-tcp-lifecycle', 'lab.yaml');

const TCP_LOG = '/var/log/jumptotech/tcp-echo.log';
const UDP_LOG = '/var/log/jumptotech/udp-echo.log';
const CONTACTED = {
  [`test -s ${TCP_LOG}`]: { exitCode: 0 },
  [`test -s ${UDP_LOG}`]: { exitCode: 0 },
};

/** The three sockets the fixture provides. */
const SEEDED_SOCKETS: NonNullable<FakeWorld['listening']> = [
  { protocol: 'tcp', port: 9200, address: '0.0.0.0' },
  { protocol: 'udp', port: 9201, address: '0.0.0.0' },
];

/** Real tcpdump output, captured on loopback inside the sandbox image. */
const HANDSHAKE = [
  '22:14:02.831625 IP 127.0.0.1.55630 > 127.0.0.1.9200: Flags [S], seq 3319347931, win 65495, length 0',
  '22:14:02.831634 IP 127.0.0.1.9200 > 127.0.0.1.55630: Flags [S.], seq 1813875484, ack 3319347932, length 0',
  '22:14:02.831641 IP 127.0.0.1.55630 > 127.0.0.1.9200: Flags [.], ack 1, win 512, length 0',
  '',
].join('\n');

const REFUSED = [
  '22:14:49.386068 IP 127.0.0.1.44872 > 127.0.0.1.9202: Flags [S], seq 1033245793, length 0',
  '22:14:49.386088 IP 127.0.0.1.9202 > 127.0.0.1.44872: Flags [R.], seq 0, ack 1033245794, win 0, length 0',
  '',
].join('\n');

const UDP = [
  '22:14:03.845237 IP 127.0.0.1.37428 > 127.0.0.1.9201: UDP, length 7',
  '22:14:03.854658 IP 127.0.0.1.9201 > 127.0.0.1.37428: UDP, length 7',
  '',
].join('\n');

const STATES = [
  'LISTEN    0 5         0.0.0.0:9200       0.0.0.0:*',
  'TIME-WAIT 0 0       127.0.0.1:55630    127.0.0.1:9200',
  '',
].join('\n');

const SEEDED_ANSWERS = `JumpToTech Bank — connection lifecycle

  udp_holds_connection_state =
  retry_on_refused_helps =
  time_wait_belongs_to =
`;

const SOLVED_ANSWERS = `JumpToTech Bank — connection lifecycle

  udp_holds_connection_state = no
  retry_on_refused_helps = no
  time_wait_belongs_to = the side that closed first
`;

function baseFiles(): NonNullable<FakeWorld['files']> {
  return {
    '/home/student/tcp': { type: 'directory', mode: '755' },
    '/home/student/tcp/brief.txt': { type: 'file', content: 'ledger-echo\n' },
    '/home/student/tcp/answers.txt': { type: 'file', content: SEEDED_ANSWERS },
    '/proc/net/dev': { type: 'file', content: 'eth0: 0 0\n  lo: 0 0\n' },
  };
}

function solvedFiles(): NonNullable<FakeWorld['files']> {
  return {
    ...baseFiles(),
    '/home/student/tcp/answers.txt': { type: 'file', content: SOLVED_ANSWERS },
    '/home/student/tcp/handshake.txt': { type: 'file', content: HANDSHAKE },
    '/home/student/tcp/refused.txt': { type: 'file', content: REFUSED },
    '/home/student/tcp/udp.txt': { type: 'file', content: UDP },
    '/home/student/tcp/states.txt': { type: 'file', content: STATES },
  };
}

function box(
  over: {
    files?: NonNullable<FakeWorld['files']>;
    sockets?: FakeWorld['listening'];
    commands?: Record<string, { exitCode?: number }>;
  } = {},
): FakeSandbox {
  return new FakeSandbox({
    files: over.files ?? solvedFiles(),
    listening: over.sockets ?? SEEDED_SOCKETS,
    commands: over.commands ?? { ...CONTACTED },
  });
}

async function verify(sandbox: FakeSandbox, namespace = 'jtt-lab-000000000001') {
  return verifyLab({ lab: await loadLabDefinition(NET_008), sandbox, namespace });
}

const failures = (checks: Array<{ status: string; label: string; detail?: string }>) =>
  checks.filter((c) => c.status !== 'pass');

// ------------------------------------------------------------ 1. the fixture

describe('NET-008 as the fixture leaves it', () => {
  it('fails the student-facing checks while passing the fixture-integrity ones', async () => {
    const untouched = box({
      files: baseFiles(),
      commands: { [`test -s ${TCP_LOG}`]: { exitCode: 1 }, [`test -s ${UDP_LOG}`]: { exitCode: 1 } },
    });

    const result = await verify(untouched);
    const failed = failures(result.checks).map((c) => c.label);

    expect(result.passed).toBe(false);
    // The three services are up and the empty port is empty: those pass from
    // the start, because the lab is about observing them, not repairing them.
    expect(failed).not.toContain('The TCP echo service was left running');
    expect(failed).not.toContain('The UDP metrics socket was left open');
    expect(failed).not.toContain('Nothing was started on the empty port');
    // Everything the student is asked to produce fails.
    expect(failed).toContain('A TCP connection was really completed against the echo service');
    expect(failed).toContain('The opening packet of the connection was captured');
  });

  it('never names an answer in a label or detail', async () => {
    const lab = await loadLabDefinition(NET_008);
    const result = await verify(
      box({
        files: baseFiles(),
        commands: { [`test -s ${TCP_LOG}`]: { exitCode: 1 }, [`test -s ${UDP_LOG}`]: { exitCode: 1 } },
      }),
    );
    const reported = JSON.stringify(result.checks);

    for (const requirement of lab.requirements) {
      const answer = (requirement as { contains?: string }).contains;
      // `9200` is a port the brief names openly; the rest are answers.
      if (!answer || answer === '9200') continue;
      expect(reported, `a check leaked '${answer}'`).not.toContain(answer);
    }
  });
});

// ----------------------------------------------------------- 2. the solution

describe('NET-008 once the exchanges have been captured', () => {
  it('passes on the state a correct run leaves behind', async () => {
    const result = await verify(box());

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

// ------------------------------------------- 3. captures alone are not proof

describe('a typed capture cannot pass the lab', () => {
  it('fails when the transcripts are perfect but nothing ever connected', async () => {
    // Every capture file is byte-for-byte what tcpdump would have printed, and
    // the answers are right. No connection was made, so the services recorded
    // nothing, and the two behavioural checks fail.
    const result = await verify(
      box({
        commands: {
          [`test -s ${TCP_LOG}`]: { exitCode: 1 },
          [`test -s ${UDP_LOG}`]: { exitCode: 1 },
        },
      }),
    );
    const failed = failures(result.checks).map((c) => c.label);

    expect(result.passed).toBe(false);
    expect(failed).toEqual([
      'A TCP connection was really completed against the echo service',
      'A datagram really reached the metrics socket',
    ]);
  });

  it('fails when only the TCP exchange really happened', async () => {
    const result = await verify(
      box({ commands: { ...CONTACTED, [`test -s ${UDP_LOG}`]: { exitCode: 1 } } }),
    );
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('A datagram really reached the metrics socket');
  });
});

// ------------------------------------------------------- 4. wrong observations

describe('NET-008 rejects the wrong observation', () => {
  it('fails when the handshake capture has no SYN-ACK', async () => {
    // A capture that only shows the outgoing SYN is a connection that never
    // completed — which is a different lesson, and not this one.
    const files = solvedFiles();
    files['/home/student/tcp/handshake.txt'] = {
      type: 'file',
      content: HANDSHAKE.split('\n').filter((l) => !l.includes('[S.]')).join('\n'),
    };

    const failed = failures((await verify(box({ files }))).checks);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The reply that completes the handshake was captured');
  });

  it('fails when the refusal capture shows a timeout rather than a reset', async () => {
    const files = solvedFiles();
    files['/home/student/tcp/refused.txt'] = {
      type: 'file',
      content: REFUSED.split('\n').filter((l) => !l.includes('[R.]')).join('\n'),
    };

    const failed = failures((await verify(box({ files }))).checks);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe(
      'The refusal was captured, and it is a reset rather than a silence',
    );
  });

  it('fails when the socket table was taken before the connection closed', async () => {
    const files = solvedFiles();
    files['/home/student/tcp/states.txt'] = {
      type: 'file',
      content: 'ESTAB 0 0 127.0.0.1:55630 127.0.0.1:9200\n',
    };

    const failed = failures((await verify(box({ files }))).checks);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The state the closed connection sits in was captured');
  });

  it('fails when a service was stopped or a listener started on the empty port', async () => {
    const stopped = await verify(
      box({ sockets: [{ protocol: 'udp', port: 9201, address: '0.0.0.0' }] }),
    );
    expect(failures(stopped.checks).map((c) => c.label)).toContain(
      'The TCP echo service was left running',
    );

    const occupied = await verify(
      box({ sockets: [...SEEDED_SOCKETS, { protocol: 'tcp', port: 9202, address: '0.0.0.0' }] }),
    );
    expect(failures(occupied.checks).map((c) => c.label)).toContain(
      'Nothing was started on the empty port',
    );
  });

  it('rejects a hedged answer sheet', async () => {
    const files = solvedFiles();
    files['/home/student/tcp/answers.txt'] = {
      type: 'file',
      content: [
        '  udp_holds_connection_state = no',
        '  udp_holds_connection_state = yes',
        '  retry_on_refused_helps = no',
        '  retry_on_refused_helps = yes',
        '  time_wait_belongs_to = the side that closed first',
        '',
      ].join('\n'),
    };

    const failed = failures((await verify(box({ files }))).checks);
    expect(failed).toHaveLength(2);
    for (const check of failed) expect(check.label).toContain('not hedged');
  });
});

// -------------------------------------------------------------- 5. isolation

describe('NET-008 stays inside one session', () => {
  it('does not let a solved session carry an untouched one', async () => {
    const solved = box();
    const untouched = box({
      files: baseFiles(),
      commands: { [`test -s ${TCP_LOG}`]: { exitCode: 1 }, [`test -s ${UDP_LOG}`]: { exitCode: 1 } },
    });

    expect((await verify(solved, 'jtt-lab-000000000002')).passed).toBe(true);
    expect((await verify(untouched, 'jtt-lab-000000000001')).passed).toBe(false);
  });

  it('runs only allow-listed inspections, with argv the verifier owns', async () => {
    const sandbox = box();
    await verify(sandbox);

    expect([...sandbox.inspections].sort()).toEqual(
      [`test -s ${TCP_LOG}`, `test -s ${UDP_LOG}`, 'ss -H -lntu'].sort(),
    );
  });
});
