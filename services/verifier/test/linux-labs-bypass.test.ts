/**
 * Shortcuts through shipped Linux labs that an audit reproduced in a real
 * sandbox container, pinned here so they stay closed.
 *
 * Each world is stated explicitly (see `sandbox-fake.ts`): what the container
 * would report after the shortcut, and after an honest solution.
 */
import { describe, expect, it } from 'vitest';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

async function failing(labId: string, world: FakeWorld): Promise<string[]> {
  const lab = (await realCatalog()).get(labId);
  const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001', sandbox: new FakeSandbox(world) });
  expect(result.error).toBeUndefined();
  return result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

// ---------------------------------------------------------------- LINUX-005

describe('LINUX-005 — a service is enabled by linking it, not by making a directory', () => {
  const RUNNING = ['101 root runsvdir -P /etc/service', '140 student /usr/local/bin/ledger-api'];

  it('passes the service linked from its definition in /etc/sv', async () => {
    expect(
      await failing('LINUX-005', {
        processes: [...RUNNING, '139 root runsv ledger-api'],
        commands: {
          'test -L /etc/service/ledger-api': { exitCode: 0 },
          'readlink -f /etc/service/ledger-api': { exitCode: 0, stdout: '/etc/sv/ledger-api\n' },
          'cat /etc/service/ledger-api/supervise/stat': { exitCode: 0, stdout: 'run\n' },
        },
      }),
    ).toEqual([]);
  });

  it('fails an empty directory in /etc/service and the process started by hand', async () => {
    // The audit's shortcut: `mkdir /etc/service/ledger-api` satisfied `test -d`,
    // and `nohup /usr/local/bin/ledger-api &` satisfied the process check.
    expect(
      await failing('LINUX-005', {
        processes: RUNNING,
        commands: {
          'test -L /etc/service/ledger-api': { exitCode: 1 },
          'readlink -f /etc/service/ledger-api': { exitCode: 0, stdout: '/etc/service/ledger-api\n' },
        },
      }),
    ).toEqual([
      'The ledger API service is enabled',
      "The enabled service is the ledger API's own definition",
      'The ledger API is running under supervision',
    ]);
  });

  it('fails a link to something other than the ledger API definition', async () => {
    expect(
      await failing('LINUX-005', {
        processes: RUNNING,
        commands: {
          'test -L /etc/service/ledger-api': { exitCode: 0 },
          'readlink -f /etc/service/ledger-api': { exitCode: 0, stdout: '/etc/sv/debug-tracer\n' },
          'cat /etc/service/ledger-api/supervise/stat': { exitCode: 0, stdout: 'run\n' },
        },
      }),
    ).toEqual(["The enabled service is the ledger API's own definition"]);
  });

  it('fails a link to the run file plus a process started by hand — nothing supervises it', async () => {
    // Measured in a lab-linux container: `ln -s /etc/sv/ledger-api/run
    // /etc/service/ledger-api` resolves under /etc/sv/ledger-api, but runsvdir
    // ignores a link to a file, so there is no supervise/stat to read.
    expect(
      await failing('LINUX-005', {
        processes: [...RUNNING],
        commands: {
          'test -L /etc/service/ledger-api': { exitCode: 0 },
          'readlink -f /etc/service/ledger-api': { exitCode: 0, stdout: '/etc/sv/ledger-api/run\n' },
          'cat /etc/service/ledger-api/supervise/stat': { exitCode: 1, stderr: 'cat: Not a directory\n' },
        },
      }),
    ).toEqual(['The ledger API is running under supervision']);
  });
});

// ---------------------------------------------------------------- LINUX-007

describe('LINUX-007 — answers are found, not enumerated', () => {
  const DIR = '/home/student/analysis';
  const answers = (count: string, txn: string, source: string): FakeWorld => ({
    files: {
      [`${DIR}/error-count.txt`]: { content: count },
      [`${DIR}/failed-transaction.txt`]: { content: txn },
      [`${DIR}/source.txt`]: { content: source },
    },
  });
  const ARCHIVE = '/var/log/jumptotech/archive';
  const REJECTED =
    '2026-08-19T02:57:03+00:00 payments REJECTED TXN-4471 account ACC-100419 reason=insufficient_reserve\n';

  it('passes the output of the commands that find each answer', async () => {
    expect(await failing('LINUX-007', answers('17\n', REJECTED, `${ARCHIVE}/payments-2026-08-19.log\n`))).toEqual([]);
  });

  it('fails every count from 1 to 99 written into the count file', async () => {
    const seq = Array.from({ length: 99 }, (_, i) => String(i + 1)).join('\n');
    expect(await failing('LINUX-007', answers(`${seq}\n`, REJECTED, `${ARCHIVE}/payments-2026-08-19.log\n`))).toEqual([
      'The error count for the current log is correct',
    ]);
  });

  it('fails every archive listed as the source, and every archive dumped as the transaction', async () => {
    const everyArchive = ['17', '18', '19'].map((d) => `${ARCHIVE}/payments-2026-08-${d}.log`).join('\n');
    const everyLine = [
      '2026-08-17T03:41:07+00:00 payments INFO settled 4181 transactions',
      REJECTED,
    ].join('\n');
    expect(await failing('LINUX-007', answers('17\n', everyLine, `${everyArchive}\n`))).toEqual([
      'The rejected transaction was identified',
      'The source log file was recorded',
    ]);
  });

  it('never prints an answer, or a decoy, in a failure detail', async () => {
    // A Check with placeholder answers used to print "does not mention
    // 'TXN-4471'" and the archive path — two of the lab's three answers.
    const lab = (await realCatalog()).get('LINUX-007');
    for (const world of [answers('0\n', 'TODO\n', 'TODO\n'), answers('0\n', '2026-08-17 settled 4181\n', `${ARCHIVE}/payments-2026-08-17.log\n`)]) {
      const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001', sandbox: new FakeSandbox(world) });
      const text = result.checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');
      expect(text).not.toContain('TXN-4471');
      expect(text).not.toContain('payments-2026-08-19');
      expect(text).not.toContain('payments-2026-08-17');
      expect(text).not.toContain('settled 4181');
    }
  });
});

// ---------------------------------------------------------------- LINUX-010

describe('LINUX-010 — graded on what the service sees, not on how the fix is spelled', () => {
  const RUN = '/etc/sv/ledger-api/run';
  const CONF = '/etc/jumptotech/ledger-api.conf';
  async function status(world: FakeWorld, label: string) {
    const lab = (await realCatalog()).get('LINUX-010');
    const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001', sandbox: new FakeSandbox(world) });
    return result.checks.find((c) => c.label === label)?.status;
  }
  const START = 'The supervisor is able to start the service';
  const PORT = 'The service is configured for its assigned port';

  it('accepts `chmod u+x` as well as 0755: runsv starts ./run as root', async () => {
    for (const mode of ['744', '755', '700']) {
      expect(await status({ files: { [RUN]: { content: '#!/bin/sh\n', mode, owner: 'root' } } }, START), mode).toBe('pass');
    }
    expect(await status({ files: { [RUN]: { content: '#!/bin/sh\n', mode: '644', owner: 'root' } } }, START)).toBe('fail');
  });

  it('accepts the old port left behind as a comment, and refuses two PORT settings', async () => {
    const conf = (content: string) => ({ files: { [CONF]: { content } } });
    expect(await status(conf('# PORT=9999 (set by the migration)\nPORT=9105\nLOG_LEVEL=info\n'), PORT)).toBe('pass');
    expect(await status(conf('PORT=9999\nLOG_LEVEL=info\n'), PORT)).toBe('fail');
    // The shell would take the last one, but a file that says both is not fixed.
    expect(await status(conf('PORT=9999\nPORT=9105\n'), PORT)).toBe('fail');
  });
});

// ---------------------------------------------------------------- LINUX-003

describe('LINUX-003 — the shared directory is graded on who may use it', () => {
  const LABEL = 'Only the owner and the deployers group can use the staging directory';
  async function status(mode: string) {
    const lab = (await realCatalog()).get('LINUX-003');
    const world: FakeWorld = { files: { '/srv/jumptotech/deploy': { type: 'directory', mode, group: 'deployers' } } };
    const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001', sandbox: new FakeSandbox(world) });
    return result.checks.find((c) => c.label === LABEL)?.status;
  }

  it('accepts 770 and the setgid 2770 a shared directory usually gets', async () => {
    expect(await status('770')).toBe('pass');
    expect(await status('2770')).toBe('pass');
  });

  it('still fails any access for other accounts, or less than full group access', async () => {
    for (const mode of ['775', '2775', '750', '777']) expect(await status(mode), mode).toBe('fail');
  });

  it('keeps comparing all four digits for a lab that does not opt out (LINUX-011 grades setgid itself)', async () => {
    const { verifyRequirement } = await import('../src/registry.js');
    const { SandboxReader } = await import('../src/sandbox-reader.js');
    const reader = new SandboxReader(new FakeSandbox({ files: { '/srv/x': { type: 'directory', mode: '2770' } } }));
    const result = await verifyRequirement({ type: 'file_mode', path: '/srv/x', mode: '770', special_bits: 'exact' } as never, reader);
    expect(result.status).toBe('fail');
  });
});
