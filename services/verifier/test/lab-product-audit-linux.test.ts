/**
 * Linux labs: grading defects found by the 2026-09-21 lab product audit,
 * pinned so they stay closed. The real catalog lab, graded by the real
 * `verifyLab`, against an explicitly stated sandbox world.
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

// ---------------------------------------------------------------- LINUX-017

const UNIT = '/etc/systemd/system/ledger-api.service';

function unit(description: string, workingDirectory = '/srv/jumptotech'): string {
  return [
    '[Unit]',
    `Description=${description}`,
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/usr/local/bin/ledger-api',
    'User=ledger',
    'Group=ledger',
    `WorkingDirectory=${workingDirectory}`,
    'EnvironmentFile=/etc/jumptotech/ledger-api.env',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function unitWorld(content: string): FakeWorld {
  return { files: { [UNIT]: { content, mode: '644', owner: 'root', group: 'root' } } };
}

describe('LINUX-017 — a description that names the service passes, however it is punctuated', () => {
  it('passes a correct unit', async () => {
    expect(await failing('LINUX-017', unitWorld(unit('ledger-api — JumpToTech Bank ledger API')))).toEqual([]);
  });

  it.each([
    'ledger-api: JumpToTech Bank ledger API',
    'JumpToTech Bank ledger API (ledger-api.service)',
    'Ledger API service: ledger-api.',
    'ledger-api.service',
  ])('passes Description=%s', async (description) => {
    // Before: the name followed by `:`, `.` or `.service` was refused.
    expect(await failing('LINUX-017', unitWorld(unit(description)))).toEqual([]);
  });

  it.each(['JumpToTech application', 'ledger-apiserver gateway', 'the ledger api'])(
    'still refuses Description=%s',
    async (description) => {
      expect(await failing('LINUX-017', unitWorld(unit(description)))).toEqual(['The description names the service']);
    },
  );

  it('passes WorkingDirectory with a trailing slash, which systemd reads as the same directory', async () => {
    expect(
      await failing('LINUX-017', unitWorld(unit('ledger-api — JumpToTech Bank ledger API', '/srv/jumptotech/'))),
    ).toEqual([]);
  });
});
