/**
 * The Linux verifier.
 *
 * Covers the checks a system-administration lab needs and a plain file read
 * cannot answer: processes, listening sockets, accounts and group membership,
 * the student's own scripts, and the allow-listed inspection commands.
 *
 * Three properties run through all of it:
 *
 *   - **Nothing consults command history.** Every assertion below is about
 *     state, and the fake has no notion of what commands produced it. A student
 *     who reached the right state any way at all passes.
 *   - **Nothing a lab declares is executed as shell.** `command_*` names a
 *     binary from a closed list and passes an argv array; `script_runs` runs
 *     the student's own file by path, through a separate capability.
 *   - **A failure describes the observed state, never the fix.** A
 *     troubleshooting lab that named the fault in its failure detail would be
 *     giving away the answer.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type Requirement } from '@jumptotech/lab-orchestrator';
import { SandboxReader, verifyLab, verifyRequirement } from '../src/index.js';
import { FakeSandbox, ReadOnlyFakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const SANDBOX = 'jtt-lab-000000000001';

function check(requirement: Requirement, world: FakeWorld = {}) {
  return verifyRequirement(requirement, { sandbox: new SandboxReader(new FakeSandbox(world)) });
}

function linuxLab(dir: string) {
  return loadLabDefinition(path.join(LABS_DIR, 'linux', dir, 'lab.yaml'));
}

function failures(checks: Array<{ status: string; label: string; detail?: string }>) {
  return checks.filter((c) => c.status !== 'pass');
}

// --------------------------------------------------------------- processes

describe('process checks read the real process table', () => {
  const RUNNING: FakeWorld = {
    processes: [
      '    1 root     /usr/bin/runsvdir -P /etc/service',
      '  118 student  /usr/local/bin/ledger-sync --interval 30',
      '  119 student  /usr/local/bin/ledger-sync --interval 30',
    ],
  };

  it('passes when a matching process is running', async () => {
    const result = await check(
      { type: 'process_running', pattern: '/usr/local/bin/ledger-sync', min_count: 1 },
      RUNNING,
    );
    expect(result.status).toBe('pass');
  });

  it('counts matches when a lab asks for more than one', async () => {
    expect(
      (await check({ type: 'process_running', pattern: '/usr/local/bin/ledger-sync', min_count: 2 }, RUNNING))
        .status,
    ).toBe('pass');
    expect(
      (await check({ type: 'process_running', pattern: '/usr/local/bin/ledger-sync', min_count: 3 }, RUNNING))
        .status,
    ).toBe('fail');
  });

  it('fails, without naming a pid, when a process that should be gone is still running', async () => {
    const result = await check(
      { type: 'process_not_running', pattern: '/usr/local/bin/ledger-sync' },
      RUNNING,
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/still running/);
    // A troubleshooting lab must not hand back the identifier that makes the
    // fix a copy-paste.
    expect(result.detail).not.toMatch(/\b118\b/);
  });

  it('passes process_not_running on an empty process table', async () => {
    const result = await check(
      { type: 'process_not_running', pattern: '/usr/local/bin/stale-batch-job' },
      RUNNING,
    );
    expect(result.status).toBe('pass');
  });

  it('matches as fixed text, never as a pattern', async () => {
    // A regex metacharacter is compared literally, so a lab pattern can neither
    // over-match nor be turned into a catastrophic backtrack.
    const world: FakeWorld = { processes: ['   42 student /usr/local/bin/a.b.c'] };
    expect((await check({ type: 'process_running', pattern: '/usr/local/bin/a.b.c', min_count: 1 }, world)).status).toBe(
      'pass',
    );
    expect((await check({ type: 'process_running', pattern: '/usr/local/bin/axbxc', min_count: 1 }, world)).status).toBe(
      'fail',
    );
  });
});

// ------------------------------------------------------------------- ports

describe('port checks read real listening sockets', () => {
  const LISTENING: FakeWorld = {
    listening: [
      { protocol: 'tcp', port: 9105 },
      { protocol: 'udp', port: 5353, address: '[::]' },
    ],
  };

  it('passes when something is listening on the port', async () => {
    expect((await check({ type: 'port_listening', port: 9105, protocol: 'tcp' }, LISTENING)).status).toBe('pass');
  });

  it('distinguishes protocols', async () => {
    expect((await check({ type: 'port_listening', port: 9105, protocol: 'udp' }, LISTENING)).status).toBe('fail');
    expect((await check({ type: 'port_listening', port: 5353, protocol: 'udp' }, LISTENING)).status).toBe('pass');
  });

  it('reads an IPv6 socket as a socket on that port', async () => {
    expect((await check({ type: 'port_not_listening', port: 5353, protocol: 'udp' }, LISTENING)).status).toBe('fail');
  });

  it('passes port_not_listening once nothing is bound', async () => {
    expect((await check({ type: 'port_not_listening', port: 8080, protocol: 'tcp' }, LISTENING)).status).toBe('pass');
  });
});

// ---------------------------------------------------------------- accounts

describe('account checks read the account databases, not /etc/passwd by hand', () => {
  const WORLD: FakeWorld = {
    users: {
      student: { uid: '1001', gid: '1001' },
      'ci-runner': { uid: '1500', gid: '2001' },
      backup: { uid: '1600', gid: '1600' },
    },
    groups: {
      deployers: { gid: '2001', members: ['student'] },
      backup: { gid: '1600', members: [] },
    },
  };

  it('passes for an account and a group that exist', async () => {
    expect((await check({ type: 'user_exists', name: 'ci-runner' }, WORLD)).status).toBe('pass');
    expect((await check({ type: 'group_exists', name: 'deployers' }, WORLD)).status).toBe('pass');
  });

  it('fails for one that does not, and says only that', async () => {
    const result = await check({ type: 'user_exists', name: 'nobody-here' }, WORLD);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe("There is no account named 'nobody-here'");
  });

  it('counts secondary membership', async () => {
    expect(
      (await check({ type: 'user_in_group', user: 'student', group: 'deployers' }, WORLD)).status,
    ).toBe('pass');
  });

  /*
   * The case that a naive implementation gets wrong. `useradd -g deployers`
   * makes deployers the account's *primary* group, and the group line does not
   * list them at all — so checking only the members field would fail a
   * perfectly correct solution.
   */
  it('counts primary membership, which the group line does not list', async () => {
    const result = await check({ type: 'user_in_group', user: 'ci-runner', group: 'deployers' }, WORLD);
    expect(result.status).toBe('pass');
  });

  it('fails when the user is in neither sense a member', async () => {
    const result = await check({ type: 'user_in_group', user: 'backup', group: 'deployers' }, WORLD);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/is not a member of 'deployers'/);
  });

  it('reports a missing group as a missing group, not as a failed membership', async () => {
    const result = await check({ type: 'user_in_group', user: 'student', group: 'ghosts' }, WORLD);
    expect(result.detail).toMatch(/no group named 'ghosts'/);
  });
});

// ----------------------------------------------------------------- scripts

describe('script checks grade behaviour, not source', () => {
  const EXECUTABLE = { type: 'file' as const, mode: '750', owner: 'student', content: '#!/bin/bash\n' };

  it('requires the owner execute bit, not just any execute bit', async () => {
    expect(
      (await check(
        { type: 'script_executable', path: '/home/student/report.sh' },
        { files: { '/home/student/report.sh': EXECUTABLE } },
      )).status,
    ).toBe('pass');

    const notExecutable = await check(
      { type: 'script_executable', path: '/home/student/report.sh' },
      { files: { '/home/student/report.sh': { ...EXECUTABLE, mode: '644' } } },
    );
    expect(notExecutable.status).toBe('fail');
    expect(notExecutable.detail).toMatch(/owner cannot execute it/);
  });

  it('passes any script that behaves correctly, whatever it contains', async () => {
    const requirement: Requirement = {
      type: 'script_runs',
      path: '/home/student/report.sh',
      args: [],
      expected_exit_code: 0,
      output_contains: ['total=3'],
      timeout_seconds: 15,
    };

    // Two completely different implementations, identical observable behaviour.
    for (const source of ['#!/bin/bash\nwc -l < a\n', '#!/usr/bin/env python3\nprint(1)\n']) {
      const result = await check(requirement, {
        files: { '/home/student/report.sh': { ...EXECUTABLE, content: source } },
        scripts: { '/home/student/report.sh': { exitCode: 0, stdout: 'total=3\n' } },
      });
      expect(result.status, source).toBe('pass');
    }
  });

  it('fails on the wrong exit status, and on missing output', async () => {
    const base = {
      files: { '/home/student/report.sh': EXECUTABLE },
    };

    const wrongStatus = await check(
      { type: 'script_runs', path: '/home/student/report.sh', args: [], expected_exit_code: 0, output_contains: [], timeout_seconds: 15 },
      { ...base, scripts: { '/home/student/report.sh': { exitCode: 1 } } },
    );
    expect(wrongStatus.status).toBe('fail');
    expect(wrongStatus.detail).toMatch(/exited with 1/);

    const wrongOutput = await check(
      { type: 'script_runs', path: '/home/student/report.sh', args: [], expected_exit_code: 0, output_contains: ['total=3'], timeout_seconds: 15 },
      { ...base, scripts: { '/home/student/report.sh': { exitCode: 0, stdout: 'total=9\n' } } },
    );
    expect(wrongOutput.status).toBe('fail');
    // It says the output was wrong; it does not print what was expected.
    expect(wrongOutput.detail).not.toContain('total=3');
  });

  it('reports a script that hangs as a timeout rather than waiting forever', async () => {
    const result = await check(
      { type: 'script_runs', path: '/home/student/report.sh', args: [], expected_exit_code: 0, output_contains: [], timeout_seconds: 5 },
      {
        files: { '/home/student/report.sh': EXECUTABLE },
        scripts: { '/home/student/report.sh': { timedOut: true } },
      },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/did not finish within 5s/);
  });

  it('refuses to run something that is not a regular executable file', async () => {
    const missing = await check(
      { type: 'script_runs', path: '/home/student/report.sh', args: [], expected_exit_code: 0, output_contains: [], timeout_seconds: 15 },
      {},
    );
    expect(missing.status).toBe('fail');
    expect(missing.detail).toMatch(/No script found/);

    const notExecutable = await check(
      { type: 'script_runs', path: '/home/student/report.sh', args: [], expected_exit_code: 0, output_contains: [], timeout_seconds: 15 },
      { files: { '/home/student/report.sh': { ...EXECUTABLE, mode: '644' } } },
    );
    expect(notExecutable.status).toBe('fail');
    expect(notExecutable.detail).toMatch(/not executable/);
  });
});

// ------------------------------------------- allow-listed inspection commands

describe('allow-listed inspection commands', () => {
  it('passes the argv through unchanged, and compares the status', async () => {
    const sandbox = new FakeSandbox({
      commands: { 'id -u student': { exitCode: 0, stdout: '1001\n' } },
    });

    const result = await verifyRequirement(
      { type: 'command_exit_code', command: 'id', args: ['-u', 'student'], expected_exit_code: 0, as_user: 'student' },
      { sandbox: new SandboxReader(sandbox) },
    );

    expect(result.status).toBe('pass');
    // One argv, exactly as the lab declared it — nothing concatenated.
    expect(sandbox.inspections).toContain('id -u student');
  });

  it('compares output as fixed text', async () => {
    const world: FakeWorld = {
      commands: { 'df -h /var/log': { exitCode: 0, stdout: 'Filesystem Size Used\n/dev/sda1 20G 3G\n' } },
    };
    expect(
      (await check({ type: 'command_output', command: 'df', args: ['-h', '/var/log'], contains: 'Filesystem', as_user: 'student' }, world))
        .status,
    ).toBe('pass');
    expect(
      (await check({ type: 'command_output', command: 'df', args: ['-h', '/var/log'], contains: 'nothing-here', as_user: 'student' }, world))
        .status,
    ).toBe('fail');
  });

  it('treats a non-zero status as a failed output check, not a passing one', async () => {
    const result = await check(
      { type: 'command_output', command: 'cat', args: ['/nope'], contains: 'x', as_user: 'student' },
      { commands: { 'cat /nope': { exitCode: 1, stdout: '', stderr: 'No such file' } } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/exited with 1/);
  });
});

// -------------------------------------------------- filesystem, linux-specific

describe('filesystem checks the linux family adds', () => {
  it('passes path_absent only when nothing is there', async () => {
    expect((await check({ type: 'path_absent', path: '/home/student/project/app.log' }, {})).status).toBe('pass');

    const stillThere = await check(
      { type: 'path_absent', path: '/home/student/project/app.log' },
      { files: { '/home/student/project/app.log': { type: 'file' } } },
    );
    expect(stillThere.status).toBe('fail');
    expect(stillThere.detail).toMatch(/still present/);
  });

  it('passes file_content_absent once the text is gone', async () => {
    const world = (content: string): FakeWorld => ({
      files: { '/etc/ledger/api.conf': { type: 'file', content } },
    });

    expect(
      (await check({ type: 'file_content_absent', path: '/etc/ledger/api.conf', contains: 'debug = true', ignore_case: false }, world('debug = false\n')))
        .status,
    ).toBe('pass');
    expect(
      (await check({ type: 'file_content_absent', path: '/etc/ledger/api.conf', contains: 'debug = true', ignore_case: false }, world('debug = true\n')))
        .status,
    ).toBe('fail');
  });

  /*
   * Absence cannot be proved from a partial read. A file the platform only read
   * the first 64KB of could still contain the text further down, so reporting
   * "it is gone" would be a false pass on the one check where that matters.
   */
  it('will not claim absence from a truncated read', async () => {
    const result = await check(
      { type: 'file_content_absent', path: '/var/log/jumptotech/payments.log', contains: 'ERROR', ignore_case: false },
      { files: { '/var/log/jumptotech/payments.log': { type: 'file', content: 'ok\n', truncated: true } } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/too large to check exhaustively/);
  });

  it('honours ignore_case where a lab asks for it', async () => {
    const world: FakeWorld = { files: { '/etc/ledger/api.conf': { type: 'file', content: 'DEBUG = TRUE\n' } } };
    expect(
      (await check({ type: 'file_content_absent', path: '/etc/ledger/api.conf', contains: 'debug = true', ignore_case: true }, world)).status,
    ).toBe('fail');
    expect(
      (await check({ type: 'file_content_absent', path: '/etc/ledger/api.conf', contains: 'debug = true', ignore_case: false }, world)).status,
    ).toBe('pass');
  });
});

// -------------------------------------------- a sandbox that cannot be inspected

describe('a sandbox with no inspection capability', () => {
  it('skips a linux check rather than failing the student for it', async () => {
    const result = await verifyRequirement(
      { type: 'process_running', pattern: '/usr/local/bin/ledger-sync', min_count: 1 },
      { sandbox: new SandboxReader(new ReadOnlyFakeSandbox()) },
    );

    expect(result.status).toBe('skipped');
    expect(result.detail).toMatch(/cannot be inspected/);
  });

  it('skips script_runs rather than failing it', async () => {
    const result = await verifyRequirement(
      { type: 'script_runs', path: '/home/student/report.sh', args: [], expected_exit_code: 0, output_contains: [], timeout_seconds: 15 },
      { sandbox: new SandboxReader(new ReadOnlyFakeSandbox()) },
    );

    expect(result.status).toBe('skipped');
    expect(result.detail).toMatch(/cannot run scripts/);
  });
});

// ------------------------------------------------------- whole shipped labs

describe('every shipped Linux lab', () => {
  const DIRS = [
    'linux-001-files',
    'linux-002-permissions',
    'linux-003-users-groups',
    'linux-004-processes',
    'linux-005-services',
    'linux-006-networking',
    'linux-007-logs',
    'linux-008-storage',
    'linux-009-shell-scripting',
    'linux-010-troubleshooting',
    'linux-014-environment',
    'linux-015-sudo-policy',
    'linux-016-text-sweeps',
    'linux-017-systemd-unit',
    'linux-018-cron',
  ];

  it.each(DIRS)('fails %s on an untouched sandbox, and never names the fix', async (dir) => {
    const lab = await linuxLab(dir);

    const result = await verifyLab({ lab, sandbox: new FakeSandbox(), namespace: SANDBOX });

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    // Every check ran and reported; none was skipped for want of a reader.
    expect(result.checks).toHaveLength(lab.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped'), dir).toBe(true);

    for (const failure of failures(result.checks)) {
      // The detail describes what was observed, never a command to run.
      expect(failure.detail ?? '', `${dir}: ${failure.label}`).not.toMatch(
        /\b(chmod|chown|useradd|groupadd|mkdir|systemctl|sv start|run:)\b/,
      );
    }
  });

  it.each(DIRS)('passes %s once the world satisfies every requirement', async (dir) => {
    const lab = await linuxLab(dir);

    const result = await verifyLab({
      lab,
      sandbox: new FakeSandbox(worldSatisfying(lab.requirements as readonly Requirement[])),
      namespace: SANDBOX,
    });

    expect(failures(result.checks).map((c) => `${c.label}: ${c.detail ?? ''}`), dir).toEqual([]);
    expect(result.passed, dir).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });
});

/**
 * A world built from a lab's own requirements.
 *
 * Derived rather than hand-written so it stays correct as the labs change, and
 * so "passes once the world satisfies every requirement" cannot quietly drift
 * into asserting something narrower than the lab actually asks for.
 */
function worldSatisfying(requirements: readonly Requirement[]): FakeWorld {
  const world: Required<Pick<FakeWorld, 'files' | 'processes' | 'listening' | 'users' | 'groups' | 'scripts' | 'commands'>> = {
    files: {},
    processes: [],
    listening: [],
    users: { student: { uid: '1001', gid: '1001' } },
    groups: { student: { gid: '1001', members: [] } },
    scripts: {},
    commands: {},
  };
  let nextId = 3000;

  /** Unit files under construction, keyed by path. */
  const units = new Map<
    string,
    { sections: Set<string>; directives: Array<{ section: string; directive: string; value: string }> }
  >();
  const unitFor = (path: string) => {
    let unit = units.get(path);
    if (!unit) {
      unit = { sections: new Set<string>(), directives: [] };
      units.set(path, unit);
    }
    return unit;
  };

  for (const requirement of requirements) {
    switch (requirement.type) {
      case 'directory_exists':
        world.files[requirement.path] = { type: 'directory', mode: '755' };
        break;

      case 'file_exists':
        world.files[requirement.path] ??= { type: 'file', content: '' };
        break;

      case 'file_content': {
        const existing = world.files[requirement.path] ?? { type: 'file' as const };
        world.files[requirement.path] = {
          ...existing,
          type: 'file',
          content: requirement.equals ?? `${existing.content ?? ''}${requirement.contains ?? ''}\n`,
        };
        break;
      }

      case 'file_mode':
        world.files[requirement.path] = { type: 'file', ...world.files[requirement.path], mode: requirement.mode };
        break;

      case 'file_owner':
        world.files[requirement.path] = { type: 'file', ...world.files[requirement.path], owner: requirement.owner };
        break;

      case 'file_group':
        world.files[requirement.path] = { type: 'file', ...world.files[requirement.path], group: requirement.group };
        break;

      case 'file_content_absent': {
        // Remove only the forbidden text. Clearing the file wholesale would
        // undo an earlier `file_content` on the same path — which LINUX-010
        // has, deliberately: one line must be present and another gone.
        const existing = world.files[requirement.path] ?? { type: 'file' as const, content: '' };
        world.files[requirement.path] = {
          ...existing,
          type: 'file',
          content: (existing.content ?? '').split(requirement.contains).join(''),
          truncated: false,
        };
        break;
      }

      case 'path_absent':
        delete world.files[requirement.path];
        break;

      case 'script_executable':
        world.files[requirement.path] = {
          type: 'file',
          ...world.files[requirement.path],
          mode: '750',
          owner: 'student',
        };
        break;

      case 'script_runs':
        world.files[requirement.path] = {
          type: 'file',
          ...world.files[requirement.path],
          mode: '750',
          owner: 'student',
        };
        world.scripts[[requirement.path, ...requirement.args].join(' ')] = {
          exitCode: requirement.expected_exit_code,
          stdout: requirement.output_contains.join('\n'),
        };
        break;

      case 'process_running':
        for (let i = 0; i < requirement.min_count; i += 1) {
          world.processes.push(`  ${nextId++} student  ${requirement.pattern}`);
        }
        break;

      case 'process_not_running':
        world.processes = world.processes.filter((p) => !p.includes(requirement.pattern));
        break;

      case 'port_listening':
        world.listening.push({ protocol: requirement.protocol, port: requirement.port });
        break;

      case 'port_not_listening':
        world.listening = world.listening.filter(
          (s) => !(s.port === requirement.port && (s.protocol ?? 'tcp') === requirement.protocol),
        );
        break;

      case 'user_exists':
        world.users[requirement.name] ??= { uid: String(nextId++), gid: String(nextId++) };
        break;

      case 'group_exists':
        world.groups[requirement.name] ??= { gid: String(nextId++), members: [] };
        break;

      case 'user_in_group': {
        const group = (world.groups[requirement.group] ??= { gid: String(nextId++), members: [] });
        world.users[requirement.user] ??= { uid: String(nextId++), gid: String(nextId++) };
        group.members = [...(group.members ?? []), requirement.user];
        break;
      }

      case 'command_exit_code':
        world.commands[[requirement.command, ...requirement.args].join(' ')] = {
          exitCode: requirement.expected_exit_code,
        };
        break;

      case 'command_output': {
        /*
         * Accumulate rather than overwrite. One command is often asserted
         * several times with different expected text — LINUX-018 reads three
         * separate facts out of one `cat` of a crontab — and a world that kept
         * only the last of them could never satisfy the lab it was built from.
         */
        const key = [requirement.command, ...requirement.args].join(' ');
        const previous = world.commands[key]?.stdout ?? '';
        world.commands[key] = {
          exitCode: 0,
          stdout: `${previous}${requirement.contains}\n`,
        };
        break;
      }

      /*
       * The systemd checks read one parsed file, so satisfying them means
       * building a unit rather than setting a flag. Sections and directives are
       * collected per path and the file is rendered at the end — which is also
       * why this is the one requirement family whose world cannot be built
       * independently per requirement.
       */
      case 'systemd_unit_section':
        unitFor(requirement.path).sections.add(requirement.section);
        break;

      case 'systemd_unit_directive': {
        const unit = unitFor(requirement.path);
        unit.sections.add(requirement.section);
        if (requirement.absent === true) break;
        const value = requirement.equals ?? requirement.contains ?? '';
        unit.directives.push({
          section: requirement.section,
          directive: requirement.directive,
          value,
        });
        break;
      }

      default:
        throw new Error(`worldSatisfying does not know how to satisfy '${requirement.type}'`);
    }
  }

  // Render each collected unit into a real file, in section order, so the
  // parser under test sees something a person could plausibly have written.
  for (const [path, unit] of units) {
    const lines: string[] = [];
    for (const section of ['Unit', 'Service', 'Install']) {
      if (!unit.sections.has(section)) continue;
      lines.push(`[${section}]`);
      for (const d of unit.directives.filter((x) => x.section === section)) {
        lines.push(`${d.directive}=${d.value}`);
      }
      lines.push('');
    }
    const existing = world.files[path];
    world.files[path] = { ...existing, type: 'file', content: lines.join('\n') };
  }

  return world;
}
