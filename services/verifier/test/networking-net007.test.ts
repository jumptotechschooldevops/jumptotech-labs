/**
 * NET-007 — verification for the bind-address incident.
 *
 * This lab exists because of a measurement that cannot be taken from inside the
 * machine being measured, and its grade rests on that: `http_request` is issued
 * by the session's peer against the session's sandbox, and a student has no
 * shell on the peer. Every other check here is corroboration — the socket table
 * and the configuration explain *why* the peer's answer changed — but the
 * peer's answer is the one that cannot be written into existence.
 *
 * The fake models a peer that can be asked and one that cannot. The second case
 * matters more than it looks: a lab that asked for a peer request in an
 * environment with no peer must fail, never pass, because "the platform could
 * not measure" is not "the platform measured and found it good".
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const NET_007 = path.join(LABS_DIR, 'networking', 'net-007-bind-address-incident', 'lab.yaml');

const CONF = '/etc/ledger/api.conf';
const LOCAL = '/home/student/incident/evidence/local.txt';
const DIAGNOSIS = '/home/student/incident/diagnosis.txt';

const SEEDED_CONF = `# ledger-api
bind_address = 127.0.0.1
port = 8080
`;
const FIXED_CONF = `# ledger-api
bind_address = 0.0.0.0
port = 8080
`;

/** A sandbox whose peer answers as the platform's peer would. */
class PeerSandbox extends FakeSandbox {
  readonly requests: Array<{ port: number; path: string }> = [];

  constructor(
    world: FakeWorld,
    private readonly answer: { reached: boolean; status?: number } | null,
  ) {
    super(world);
  }

  // `null` models an environment with no peer at all: the capability is simply
  // not offered, exactly as a provider that created none would leave it.
  get hasPeer(): boolean {
    return this.answer !== null;
  }

  httpFromPeer = async (request: { port: number; path: string }) => {
    this.requests.push({ port: request.port, path: request.path });
    if (!this.answer) throw new Error('no peer');
    return this.answer;
  };
}

function world(over: { conf?: string; files?: NonNullable<FakeWorld['files']>; sockets?: FakeWorld['listening'] } = {}): FakeWorld {
  return {
    files: over.files ?? {
      '/home/student/incident/evidence': { type: 'directory', mode: '755' },
      '/home/student/incident/brief.txt': { type: 'file', content: 'ledger-api\n' },
      [CONF]: { type: 'file', content: over.conf ?? SEEDED_CONF },
    },
    listening: over.sockets ?? [{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }],
  };
}

/** The state a student leaves behind after a correct repair. */
function solvedWorld(): FakeWorld {
  return {
    files: {
      '/home/student/incident/evidence': { type: 'directory', mode: '755' },
      '/home/student/incident/brief.txt': { type: 'file', content: 'ledger-api\n' },
      [CONF]: { type: 'file', content: FIXED_CONF },
      [LOCAL]: { type: 'file', content: '200\n' },
      [DIAGNOSIS]: {
        type: 'file',
        content: 'The far side was refused because the socket was bind-ed to loopback only.\n',
      },
    },
    listening: [{ protocol: 'tcp', port: 8080, address: '0.0.0.0' }],
  };
}

function solved(): PeerSandbox {
  return new PeerSandbox(solvedWorld(), { reached: true, status: 200 });
}

async function verify(sandbox: PeerSandbox, namespace = 'jtt-lab-000000000001') {
  return verifyLab({ lab: await loadLabDefinition(NET_007), sandbox, namespace });
}

const failures = (checks: Array<{ status: string; label: string; detail?: string }>) =>
  checks.filter((c) => c.status !== 'pass');

// ------------------------------------------------------------- 1. the states

describe('NET-007 through the incident', () => {
  it('fails on the seeded fault, with the peer unable to reach the service', async () => {
    const result = await verify(new PeerSandbox(world(), { reached: false }));

    expect(result.passed).toBe(false);
    const failed = failures(result.checks).map((c) => c.label);
    expect(failed).toContain('The other machine on this segment can reach the service');
    expect(failed).toContain('The service listens where the segment can reach it');
  });

  it('passes once the service answers the other machine', async () => {
    const result = await verify(solved());

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('asks the peer for exactly the endpoint the lab named', async () => {
    const sandbox = solved();
    await verify(sandbox);

    expect(sandbox.requests).toEqual([{ port: 8080, path: '/health' }]);
  });
});

// --------------------------------------------- 2. the measurement is the grade

describe('NET-007 cannot be passed by describing the repair', () => {
  it('fails when everything local looks right but the peer still cannot reach it', async () => {
    // The socket table says 0.0.0.0, the config is clean, the evidence and the
    // diagnosis are written — and the other machine still gets nothing. The
    // lab fails, because the claim it grades is the one that is false.
    const result = await verify(new PeerSandbox(solvedWorld(), { reached: false }));
    const failed = failures(result.checks);

    expect(result.passed).toBe(false);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The other machine on this segment can reach the service');
  });

  it('fails when the peer reaches something that answers with the wrong status', async () => {
    const result = await verify(new PeerSandbox(solvedWorld(), { reached: true, status: 502 }));
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('502');
  });

  it('fails rather than passes when there is no peer to ask', async () => {
    // "Could not measure" must never read as "measured and fine".
    const result = await verifyLab({
      lab: await loadLabDefinition(NET_007),
      sandbox: {
        async read() {
          return null;
        },
      },
      namespace: 'jtt-lab-000000000001',
    });

    expect(result.passed).toBe(false);
    expect(failures(result.checks).map((c) => c.label)).toContain(
      'The other machine on this segment can reach the service',
    );
  });

  it('ignores a student file claiming the other machine succeeded', async () => {
    const files = { ...solvedWorld().files };
    files['/home/student/incident/evidence/remote.txt'] = {
      type: 'file',
      content: 'peer: HTTP/1.1 200 OK\n',
    };

    const sandbox = new PeerSandbox(
      { files, listening: [{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }] },
      { reached: false },
    );
    const result = await verify(sandbox);

    expect(result.passed).toBe(false);
  });
});

// ------------------------------------------------------ 3. partial repairs

describe('NET-007 rejects a partial repair', () => {
  it('fails while the configuration still names loopback', async () => {
    const sandbox = new PeerSandbox(
      { ...solvedWorld(), files: { ...solvedWorld().files, [CONF]: { type: 'file', content: SEEDED_CONF } } },
      { reached: true, status: 200 },
    );
    const failed = failures((await verify(sandbox)).checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe('The loopback address is gone from the configuration');
  });

  it('fails when the socket is still bound to loopback alone', async () => {
    const sandbox = new PeerSandbox(
      { ...solvedWorld(), listening: [{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }] },
      { reached: true, status: 200 },
    );
    const failed = failures((await verify(sandbox)).checks).map((c) => c.label);

    expect(failed).toContain('The service listens where the segment can reach it');
    expect(failed).toContain('The service no longer listens on loopback alone');
  });

  it('fails when the local evidence or the diagnosis is missing', async () => {
    const files = { ...solvedWorld().files };
    delete files[LOCAL];
    delete files[DIAGNOSIS];

    const failed = failures(
      (await verify(new PeerSandbox({ ...solvedWorld(), files }, { reached: true, status: 200 })))
        .checks,
    );
    expect(failed).toHaveLength(3);
  });

  it('fails a diagnosis that names neither the symptom nor the cause', async () => {
    const files = { ...solvedWorld().files };
    files[DIAGNOSIS] = { type: 'file', content: 'The network was down.\n' };

    const failed = failures(
      (await verify(new PeerSandbox({ ...solvedWorld(), files }, { reached: true, status: 200 })))
        .checks,
    );
    expect(failed).toHaveLength(2);
  });
});

// -------------------------------------------------------------- 4. isolation

describe('NET-007 stays inside one session', () => {
  it('grades each session from its own peer', async () => {
    const solvedSession = solved();
    const brokenSession = new PeerSandbox(world(), { reached: false });

    expect((await verify(solvedSession, 'jtt-lab-000000000002')).passed).toBe(true);
    expect((await verify(brokenSession, 'jtt-lab-000000000001')).passed).toBe(false);
  });

  it('never names an answer in a label or detail', async () => {
    const lab = await loadLabDefinition(NET_007);
    const result = await verify(new PeerSandbox(world(), { reached: false }));
    const reported = JSON.stringify(result.checks);

    for (const requirement of lab.requirements) {
      const answer = (requirement as { contains?: string }).contains;
      // `file_content_absent` values are the *wrong* ones — the fault the
      // student is told to find and remove. Naming `127.0.0.1` in a failure is
      // how the check explains itself, and the config and brief show it openly
      // anyway. Only the positive answers must stay unsaid.
      if (!answer || requirement.type === 'file_content_absent') continue;
      expect(reported, `a check leaked '${answer}'`).not.toContain(answer);
    }
  });
});
