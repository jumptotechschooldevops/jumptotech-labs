/**
 * PLATFORM-006 AC-2 — `process_environ`.
 *
 * The gap this closes: a lab that teaches "configure the service's
 * environment" could previously only be graded by reading a file the service
 * was supposed to have written. A student with a shell writes that file
 * directly and passes without configuring anything — the LINUX-014 bypass.
 * Reading `/proc/<pid>/environ` of the running process makes the only way to
 * pass be actually running the service with that environment.
 *
 * The second property, and the reason these tests are as much about output as
 * about verdicts: **the verifier reports a verdict, never a value.** A check
 * that leaked what a variable is set to would turn a grading primitive into an
 * exfiltration primitive, and `AWS_SECRET_ACCESS_KEY expected X but found Y`
 * is the exact message that must be unreachable.
 */
import { describe, expect, it } from 'vitest';
import type { Requirement } from '@jumptotech/lab-orchestrator';
import { SandboxReader, verifyRequirement } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

/** A secret that must never appear in anything a check produces. */
const SECRET = 'AKIA-NEVER-SHOW-THIS-VALUE';

/** `/proc/<pid>/environ` is NUL-separated `NAME=value` entries. */
const environ = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0');

const PID = 412;

function world(vars: Record<string, string>, extra: FakeWorld = {}): FakeWorld {
  return {
    processes: [`  ${PID} root     /usr/local/lib/report-runner --serve`],
    commands: { [`cat /proc/${PID}/environ`]: { stdout: environ(vars) } },
    ...extra,
  };
}

function check(requirement: Requirement, w: FakeWorld) {
  return verifyRequirement(requirement, { sandbox: new SandboxReader(new FakeSandbox(w)) });
}

const requirement = (variables: unknown[], overrides: Record<string, unknown> = {}): Requirement =>
  ({
    type: 'process_environ',
    pattern: '/usr/local/lib/report-runner',
    min_count: 1,
    variables,
    label: 'The report runner has the required environment',
    ...overrides,
  }) as unknown as Requirement;

// --------------------------------------------------------------- verdicts

describe('process_environ — verdicts', () => {
  it('passes when the running process has the required environment', async () => {
    const result = await check(
      requirement([
        { name: 'JTT_ENV', equals: 'production', sensitive: false },
        { name: 'FORMATTER', equals: '/usr/local/libexec/jtt-format', sensitive: false },
      ]),
      world({ JTT_ENV: 'production', FORMATTER: '/usr/local/libexec/jtt-format' }),
    );

    expect(result.status).toBe('pass');
  });

  it('fails when a required variable is missing', async () => {
    const result = await check(
      requirement([{ name: 'JTT_ENV', equals: 'production', sensitive: false }]),
      world({ SOMETHING_ELSE: 'x' }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('JTT_ENV');
    expect(result.detail).toContain('not set');
  });

  it('fails when a variable is set to the wrong value', async () => {
    const result = await check(
      requirement([{ name: 'JTT_ENV', equals: 'production', sensitive: false }]),
      world({ JTT_ENV: 'staging' }),
    );

    expect(result.status).toBe('fail');
    // Neither the actual value nor the expected one appears.
    expect(result.detail).not.toContain('staging');
    expect(result.detail).not.toContain('production');
  });

  it('fails when a forbidden variable is present', async () => {
    const result = await check(
      requirement([{ name: 'DEBUG', absent: true, sensitive: false }]),
      world({ DEBUG: '1' }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('must not');
  });

  it('fails when a variable holds a forbidden value', async () => {
    const result = await check(
      requirement([{ name: 'MODE', not_equals: 'debug', sensitive: false }]),
      world({ MODE: 'debug' }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain('debug');
  });

  it('proves existence without ever comparing a secret', async () => {
    const present = await check(
      requirement([{ name: 'API_TOKEN', present: true, sensitive: false }]),
      world({ API_TOKEN: SECRET }),
    );
    expect(present.status).toBe('pass');

    const missing = await check(
      requirement([{ name: 'API_TOKEN', present: true, sensitive: false }]),
      world({ OTHER: 'x' }),
    );
    expect(missing.status).toBe('fail');
    expect(JSON.stringify(missing)).not.toContain(SECRET);
  });

  it('requires every matching process to satisfy the assertions', async () => {
    // A second process with the right environment must not mask a wrong one:
    // otherwise starting a decoy is a bypass.
    const result = await check(
      requirement([{ name: 'JTT_ENV', equals: 'production', sensitive: false }], { min_count: 1 }),
      {
        processes: [
          '  412 root     /usr/local/lib/report-runner --serve',
          '  413 root     /usr/local/lib/report-runner --worker',
        ],
        commands: {
          'cat /proc/412/environ': { stdout: environ({ JTT_ENV: 'production' }) },
          'cat /proc/413/environ': { stdout: environ({ JTT_ENV: 'staging' }) },
        },
      },
    );

    expect(result.status).toBe('fail');
  });
});

// ---------------------------------------------------------------- secrecy

describe('process_environ — a verdict never carries a value', () => {
  it('keeps a secret out of the check result entirely', async () => {
    for (const variables of [
      [{ name: 'AWS_SECRET_ACCESS_KEY', equals: 'expected-value', sensitive: false }],
      [{ name: 'AWS_SECRET_ACCESS_KEY', not_equals: SECRET, sensitive: false }],
      [{ name: 'AWS_SECRET_ACCESS_KEY', absent: true, sensitive: false }],
    ]) {
      const result = await check(requirement(variables), world({ AWS_SECRET_ACCESS_KEY: SECRET }));

      // The whole result object, not just `detail`: nothing anywhere in it.
      const serialised = JSON.stringify(result);
      expect(serialised, JSON.stringify(variables)).not.toContain(SECRET);
      expect(serialised).not.toContain('expected-value');
    }
  });

  it('withholds even the variable name when it is marked sensitive', async () => {
    const result = await check(
      requirement([{ name: 'AWS_SECRET_ACCESS_KEY', equals: 'x', sensitive: true }]),
      world({ AWS_SECRET_ACCESS_KEY: SECRET }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(result.detail).not.toContain(SECRET);
    expect(result.detail).toContain('A required environment variable');
  });

  it('reads only the variables the lab named, and nothing else', async () => {
    const sandbox = new FakeSandbox(
      world({ WANTED: 'yes', AWS_SECRET_ACCESS_KEY: SECRET, OTHER_SECRET: SECRET }),
    );
    const reader = new SandboxReader(sandbox);

    const found = await reader.environForPid(PID, ['WANTED']);

    // The reader is name-bounded: unnamed variables never enter the verifier,
    // so there is no code path that obtains an environment wholesale.
    expect([...found!.keys()]).toEqual(['WANTED']);
    expect(JSON.stringify([...found!])).not.toContain(SECRET);
  });
});

// -------------------------------------------------------------- robustness

describe('process_environ — unreadable state is never a pass', () => {
  it('fails, rather than passes, when the process is gone', async () => {
    const result = await check(
      requirement([{ name: 'JTT_ENV', equals: 'production', sensitive: false }]),
      {
        processes: [`  ${PID} root     /usr/local/lib/report-runner --serve`],
        // `cat` on a dead pid exits non-zero.
        commands: { [`cat /proc/${PID}/environ`]: { exitCode: 1, stderr: 'No such file' } },
      },
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Could not read the environment');
  });

  it('fails when no process matches at all', async () => {
    const result = await check(
      requirement([{ name: 'JTT_ENV', present: true, sensitive: false }]),
      { processes: ['    1 root     /sbin/init'] },
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('No running process');
  });

  it('treats an invalid pid as unreadable rather than assembling a path from it', async () => {
    const sandbox = new FakeSandbox(world({ A: 'b' }));
    const reader = new SandboxReader(sandbox);

    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await reader.environForPid(pid, ['A']), String(pid)).toBeNull();
    }
    // None of those reached the sandbox at all.
    expect(sandbox.inspections.filter((i) => i.startsWith('cat /proc'))).toEqual([]);
  });
});

// ----------------------------------------------------------- session bound

describe('process_environ — a check cannot cross into another sandbox', () => {
  it('reads only the sandbox its reader was constructed with', async () => {
    const mine = new FakeSandbox(world({ JTT_ENV: 'production' }));
    const theirs = new FakeSandbox(world({ JTT_ENV: 'someone-elses' }));

    const result = await verifyRequirement(
      requirement([{ name: 'JTT_ENV', equals: 'production', sensitive: false }]),
      { sandbox: new SandboxReader(mine) },
    );

    expect(result.status).toBe('pass');
    // The other student's sandbox was never touched: there is no field on the
    // requirement, and no argument on the reader, that can name a sandbox.
    expect(theirs.inspections).toEqual([]);
    expect(mine.inspections).toContain(`cat /proc/${PID}/environ`);
  });
});
