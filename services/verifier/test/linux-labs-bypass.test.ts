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
    ).toEqual(['The ledger API service is enabled', "The enabled service is the ledger API's own definition"]);
  });

  it('fails a link to something other than the ledger API definition', async () => {
    expect(
      await failing('LINUX-005', {
        processes: RUNNING,
        commands: {
          'test -L /etc/service/ledger-api': { exitCode: 0 },
          'readlink -f /etc/service/ledger-api': { exitCode: 0, stdout: '/etc/sv/debug-tracer\n' },
        },
      }),
    ).toEqual(["The enabled service is the ledger API's own definition"]);
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
});
