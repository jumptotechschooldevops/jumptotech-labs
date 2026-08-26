/**
 * LINUX-017 — the unit is graded on what it says, not on how it is written.
 *
 * The regression this guards against is a later edit swapping these checks back
 * to `file_content`. Several of the worlds below are files that a substring
 * check would pass and systemd would refuse, and one is a file that a substring
 * check would fail and systemd would happily accept.
 *
 * Nothing here claims the unit would *start*. The sandbox has no systemd, and
 * the lab says so; these tests assert the static grading is right, which is the
 * only thing the lab promises.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAB_YAML = path.resolve(here, '../../../labs/linux/linux-017-systemd-unit/lab.yaml');
const SANDBOX = 'jtt-lab-000000000017';
const UNIT = '/etc/systemd/system/ledger-api.service';

/** A unit that satisfies every line of the migration runbook. */
const CORRECT = `
# ledger-api, migrated from runit.

[Unit]
Description=ledger-api — JumpToTech ledger API
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ledger-api
User=ledger
Group=ledger
WorkingDirectory=/srv/jumptotech
EnvironmentFile=/etc/jumptotech/ledger-api.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

/** The draft the seed leaves behind: unparseable, and wrong twice over. */
const ABANDONED_DRAFT = `# Started during the planning meeting, never finished.
[Unit
Description=JumpToTech application

[Service]
ExecStart=ledger-api
Restart=always
`;

function world(content: string, mode = '644'): FakeWorld {
  return { files: { [UNIT]: { type: 'file', mode, owner: 'root', group: 'root', content } } };
}

function lab() {
  return loadLabDefinition(LAB_YAML);
}

async function verify(w: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(w), namespace: SANDBOX });
}

function failed(checks: Array<{ status: string; label: string }>): string[] {
  return checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

describe('LINUX-017 grades the unit semantically', () => {
  it('passes a unit that satisfies the runbook', async () => {
    const result = await verify(world(CORRECT));

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails the abandoned draft, and says the file is unparseable rather than empty', async () => {
    const result = await verify(world(ABANDONED_DRAFT));

    expect(result.passed).toBe(false);
    // The unterminated header is the first thing to fix: until it is, systemd
    // reads none of the file, and the student should be told that rather than
    // handed a list of directives that "look" present.
    const detail = result.checks.find((c) => c.status !== 'pass')?.detail ?? '';
    expect(detail).toMatch(/not a valid unit file/);
    expect(detail).toMatch(/line 2/);
  });

  it('is indifferent to formatting, comments and directive order', async () => {
    const scrambled = [
      '[Install]',
      'WantedBy=multi-user.target',
      '',
      '; a comment mentioning Restart=always, which is not a directive',
      '[Service]',
      'RestartSec   =   5',
      'Restart=on-failure',
      'EnvironmentFile=/etc/jumptotech/ledger-api.env',
      'WorkingDirectory=/srv/jumptotech',
      'Group=ledger',
      'User=ledger',
      'ExecStart=/usr/local/bin/ledger-api',
      'Type=simple',
      '',
      '[Unit]',
      'After=network-online.target',
      'Wants=network-online.target',
      'Description=ledger-api on the systemd fleet',
    ].join('\n');

    const result = await verify(world(scrambled));
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails a restart policy that would fight the on-call engineer', async () => {
    // `always` brings the service back after a deliberate stop, which the
    // runbook explicitly rules out. This is the draft's substantive error.
    const result = await verify(world(CORRECT.replace('Restart=on-failure', 'Restart=always')));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A crash restarts the service and a deliberate stop does not',
    ]);
  });

  it('fails a relative ExecStart, which systemd would reject', async () => {
    const result = await verify(world(CORRECT.replace('/usr/local/bin/ledger-api', 'ledger-api')));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The service starts the application by its absolute path',
    );
  });

  it('fails a unit with no [Install] section, naming that rather than the directive', async () => {
    const noInstall = CORRECT.replace(/\[Install\][\s\S]*$/, '');
    const result = await verify(world(noInstall));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The unit has an [Install] section',
      'Enabling the service would start it on a normal boot',
    ]);
  });

  it('fails a directive written into the wrong section', async () => {
    // `User=` in [Unit] is a common slip and systemd ignores it there.
    const misplaced = CORRECT.replace('User=ledger\n', '').replace(
      'Description=ledger-api — JumpToTech ledger API',
      'Description=ledger-api — JumpToTech ledger API\nUser=ledger',
    );

    const result = await verify(world(misplaced));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The service runs as its own account rather than as root',
    ]);
  });

  it('fails a commented-out directive rather than matching its text', async () => {
    // The case a substring check gets exactly backwards.
    const commented = CORRECT.replace('User=ledger', '#User=ledger');
    const result = await verify(world(commented));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The service runs as its own account rather than as root',
    );
  });

  it('accepts a dependency written as one line or as two', async () => {
    const combined = CORRECT.replace(
      'Wants=network-online.target\nAfter=network-online.target',
      'Wants=network-online.target postgresql.service\nAfter=network-online.target postgresql.service',
    );

    const result = await verify(world(combined));
    expect(failed(result.checks)).toEqual([]);
  });

  it('fails a unit the service manager could not read', async () => {
    const result = await verify(world(CORRECT, '600'));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The unit file is readable by the service manager']);
  });

  it('fails an untouched sandbox with every check reported', async () => {
    const result = await verify({});

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength((await lab()).requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

describe('LINUX-017 discloses nothing and claims nothing it cannot check', () => {
  it('never reveals an expected directive value in a failure detail', async () => {
    const wrong = CORRECT
      .replace('Restart=on-failure', 'Restart=always')
      .replace('ExecStart=/usr/local/bin/ledger-api', 'ExecStart=/bin/wrong')
      .replace('User=ledger', 'User=root');

    const result = await verify(world(wrong));
    const details = result.checks.map((c) => c.detail ?? '').join('\n');

    for (const secret of ['on-failure', '/usr/local/bin/ledger-api', 'ledger', 'simple', '5']) {
      expect(details, `leaked '${secret}'`).not.toContain(`=${secret}`);
    }
    // Nor does it echo what the student wrote, which would let them bisect.
    expect(details).not.toContain('/bin/wrong');
    expect(details).not.toContain('always');
  });

  it('runs nothing and executes no command', async () => {
    const definition = await lab();
    for (const requirement of [...definition.requirements, ...definition.setup.verify]) {
      expect(requirement.type).not.toBe('script_runs');
      expect(requirement.type).not.toBe('command_exit_code');
      expect(requirement.type).not.toBe('command_output');
    }
  });

  it('states in its own text that the unit is never started', async () => {
    // The lab must not let a student believe runtime behaviour was validated.
    const definition = await lab();
    const text = definition.task.description.toLowerCase();
    expect(text).toContain('never started');
    expect(text).toMatch(/no systemd|has no systemd/);
  });

  it('claims the certification domain it actually covers, and no more', async () => {
    // "Create, configure, and troubleshoot services" is a published LFCS
    // competency under Essential Commands, verified 2026-08-25. The lab covers
    // configure and part of troubleshoot; it cannot cover runtime, and its task
    // text says so.
    const certification = (await lab()).certification;
    expect(certification[0]?.certification).toBe('LFCS');
    expect(certification[0]?.relevant).toBe(true);
    expect(certification[0]?.domains).toEqual(['essential-commands']);
  });
});
