/**
 * Linux and CS checks tightened or loosened by the 2026-09-20 lab
 * certification pass. Each case grades the lab's own requirement, found by its
 * label, against a sandbox stated explicitly — the plausible mistake that used
 * to pass, and the valid answer that used to fail.
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

// --------------------------------------------------------------- LINUX-003

describe('LINUX-003 — ci-runner can use its home directory', () => {
  const LABEL = 'ci-runner owns its home directory';
  const home = (owner: string): FakeWorld => ({
    files: { '/home/ci-runner': { type: 'directory', mode: '755', owner, group: owner } },
  });

  it('passes the home `useradd -m` creates', async () => {
    expect(await status('LINUX-003', LABEL, home('ci-runner'))).toBe('pass');
  });

  it('fails a home made afterwards with `sudo mkdir`, which root owns', async () => {
    expect(await status('LINUX-003', LABEL, home('root'))).toBe('fail');
  });
});

// --------------------------------------------------------------- LINUX-008

describe('LINUX-008 — the archive index survives with its entries', () => {
  const LABEL = 'The archive index still holds its entries';
  const index = (content: string): FakeWorld => ({
    files: { '/var/log/jumptotech/archive/index.txt': { type: 'file', owner: 'root', group: 'root', content } },
  });

  it('passes the index left as it was', async () => {
    const seeded = 'bulk-2026-06.dump   raw export, superseded, safe to delete\n' +
      'index.txt           this file — required by the archival tooling, keep\n';
    expect(await status('LINUX-008', LABEL, index(seeded))).toBe('pass');
  });

  it('fails the directory wiped and the index recreated empty with touch', async () => {
    expect(await status('LINUX-008', LABEL, index(''))).toBe('fail');
  });
});

// --------------------------------------------------------------- LINUX-017

describe('LINUX-017 — Group= left to its default', () => {
  const LABEL = 'The service runs under its own group';
  const UNIT = '/etc/systemd/system/ledger-api.service';
  const unit = (groupLine: string): FakeWorld => ({
    files: {
      [UNIT]: {
        type: 'file',
        owner: 'root',
        group: 'root',
        content: `[Unit]\nDescription=ledger-api\n\n[Service]\nExecStart=/usr/local/bin/ledger-api\nUser=ledger\n${groupLine}\n`,
      },
    },
  });

  it('passes Group=ledger written out, and Group= omitted (ledger is the account’s primary group)', async () => {
    expect(await status('LINUX-017', LABEL, unit('Group=ledger'))).toBe('pass');
    expect(await status('LINUX-017', LABEL, unit(''))).toBe('pass');
  });

  it('still fails another group', async () => {
    expect(await status('LINUX-017', LABEL, unit('Group=root'))).toBe('fail');
  });
});

// ------------------------------------------------------------------ CS-010

describe('CS-010 — the country code is quoted, whatever case the bare word had', () => {
  const LABEL = 'The leeds country is quoted, so it stays the country code it was meant to be';
  const depots = (country: string): FakeWorld => ({
    files: { '/home/student/ops/depots.yaml': { type: 'file', content: `leeds:\n  country: ${country}\n` } },
  });

  it('passes the quoted code', async () => {
    expect(await status('CS-010', LABEL, depots('"no"'))).toBe('pass');
    expect(await status('CS-010', LABEL, depots("'NO'"))).toBe('pass');
  });

  it('fails the bare word in any case — YAML 1.1 reads NO as false too', async () => {
    expect(await status('CS-010', LABEL, depots('no'))).toBe('fail');
    expect(await status('CS-010', LABEL, depots('NO'))).toBe('fail');
  });
});

// ----------------------------------------------------- instruction fixes

describe('the task says what the checks need', () => {
  it('LINUX-004 asks for ledger-sync to be started by its full path', async () => {
    // `./ledger-sync` from /usr/local/bin shows as `/bin/bash ./ledger-sync`,
    // which the process check does not match.
    expect((await realCatalog()).get('LINUX-004').task.description).toContain('by its full path');
  });

  it('CS-003 asks for a line number, which is what the check compares', async () => {
    expect((await realCatalog()).get('CS-003').task.description).toContain('OVER_LIMIT_LINE=<the line number');
  });
});
