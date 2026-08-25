/**
 * LINUX-015 — a sudo policy is what sudo does, not what a file says.
 *
 * The regression this file exists to prevent is someone later reducing the
 * requirement list to "the drop-in contains the right text". A drop-in can be
 * present, root-owned, mode 0440 and read exactly right while granting nothing
 * (one token misspelled, sudo refused the file) or while granting far too much
 * (the binary named without its arguments pinned).
 *
 * So the graded evidence is what a probe running *as the on-call account*
 * reports sudo would permit and refuse. The worlds below are the four shapes
 * that matter, and each is stated explicitly rather than derived from running
 * anything — proving the *lab* fails them belongs here; proving sudo behaves
 * that way belongs to the container run, which is where it was confirmed.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAB_YAML = path.resolve(here, '../../../labs/linux/linux-015-sudo-policy/lab.yaml');
const SANDBOX = 'jtt-lab-000000000015';

const DROP_IN = '/etc/sudoers.d/020-oncall';
const OWN_ACCESS = '/etc/sudoers.d/010-student';
const PROBE = '/var/lib/jumptotech/probe/sudo-probe.status';
const CTL = '/usr/local/sbin/jtt-service-control';

/** Reading the drop-in needs root: a policy sudo honours is 0440 root:root. */
const READ_POLICY = `cat ${DROP_IN}`;
/** `find -mmin -1` prints the path only when it was written in the last minute. */
const PROBE_FRESH = `find ${PROBE} -mmin -1`;

const BLANKET = 'oncall ALL=(ALL) NOPASSWD: ALL\n';
const NARROW =
  `Cmnd_Alias LEDGER_CTL = ${CTL} status ledger-api, ${CTL} restart ledger-api\n` +
  'oncall ALL=(root) NOPASSWD: LEDGER_CTL\n';
/** Names the binary but pins none of its arguments — the mistake being taught. */
const LAZY = `oncall ALL=(root) NOPASSWD: ${CTL}\n`;

/** What the probe publishes, given what sudo would actually allow. */
function probeReading(o: {
  status: 'ok' | 'denied';
  restart: 'ok' | 'denied';
  otherCmd: 'allowed' | 'denied';
  otherArg: 'allowed' | 'denied';
}): string {
  return [
    `PERMITTED_STATUS=${o.status}`,
    `PERMITTED_RESTART=${o.restart}`,
    `FORBIDDEN_CMD=${o.otherCmd}`,
    `FORBIDDEN_ARG=${o.otherArg}`,
    'PROBED_AS=oncall',
    '',
  ].join('\n');
}

function world(policy: string, reading: string, overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    processes: [
      '    1 root     /usr/bin/runsvdir -P /etc/service',
      '  310 root     runsv sudo-probe',
      '  311 oncall   /bin/sh /usr/local/lib/jumptotech/sudo-probe',
    ],
    commands: {
      [READ_POLICY]: { exitCode: 0, stdout: policy },
      [PROBE_FRESH]: { exitCode: 0, stdout: `${PROBE}\n` },
      ...(overrides.commands ?? {}),
    },
    files: {
      [DROP_IN]: { type: 'file', mode: '440', owner: 'root', group: 'root', content: '' },
      [OWN_ACCESS]: { type: 'file', mode: '440', owner: 'root', group: 'root', content: '' },
      [PROBE]: { type: 'file', mode: '644', owner: 'oncall', group: 'oncall', content: reading },
      ...(overrides.files ?? {}),
    },
  };
}

/** The audit finding the student is handed: the rotation can do anything. */
const BASELINE = world(
  BLANKET,
  probeReading({ status: 'ok', restart: 'ok', otherCmd: 'allowed', otherArg: 'allowed' }),
);

/** The intended end state: exactly two invocations, nothing else. */
const SOLVED = world(
  NARROW,
  probeReading({ status: 'ok', restart: 'ok', otherCmd: 'denied', otherArg: 'denied' }),
);

function lab() {
  return loadLabDefinition(LAB_YAML);
}

async function verify(w: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(w), namespace: SANDBOX });
}

function failed(checks: Array<{ status: string; label: string }>): string[] {
  return checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

// ------------------------------------------------------- the graded property

describe('LINUX-015 grades what sudo enforces, not what the file says', () => {
  it('fails the blanket grant the student is handed', async () => {
    const result = await verify(BASELINE);

    expect(result.passed).toBe(false);
    // The rotation can already do the two things it needs — that was never the
    // problem, and those checks pass on the baseline.
    expect(failed(result.checks)).not.toContain('The rotation may check the ledger service');
    expect(failed(result.checks)).toContain(
      'The rotation may no longer run commands outside its remit',
    );
    expect(failed(result.checks)).toContain(
      'The rotation may not point the control tool at another service',
    );
  });

  it('passes a rule scoped to both commands and their arguments', async () => {
    const result = await verify(SOLVED);

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('fails a rule that names the binary without pinning its arguments', async () => {
    /*
     * The mistake this lab exists to teach. sudo permits both required
     * invocations and refuses unrelated commands, so three of the four
     * behavioural checks are green — and the rotation can still restart any
     * service on the host.
     */
    const result = await verify(
      world(LAZY, probeReading({ status: 'ok', restart: 'ok', otherCmd: 'denied', otherArg: 'allowed' })),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The rotation may not point the control tool at another service',
    ]);
  });

  it('fails a drop-in sudo refused to parse, without needing a syntax check', async () => {
    // A syntax error makes sudo distrust the file, so the account is left with
    // nothing. The text still mentions the control tool, so only the
    // behavioural checks catch it — which is the point of having them.
    const result = await verify(
      world(
        `oncall ALL=(root) NOPASSWD ${CTL} status ledger-api\n`,
        probeReading({ status: 'denied', restart: 'denied', otherCmd: 'denied', otherArg: 'denied' }),
      ),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The rotation may check the ledger service',
      'The rotation may restart the ledger service',
    ]);
  });

  it('fails a delegation that grants only half of what the rotation needs', async () => {
    const result = await verify(
      world(
        `oncall ALL=(root) NOPASSWD: ${CTL} status ledger-api\n`,
        probeReading({ status: 'ok', restart: 'denied', otherCmd: 'denied', otherArg: 'denied' }),
      ),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The rotation may restart the ledger service']);
  });

  it('fails a perfectly forged reading once the probe has stopped writing it', async () => {
    /*
     * The forgery this lab has to survive. A student with sudo can write the
     * probe's status file by hand; what they cannot do is keep it current
     * while the probe is dead, and `find -mmin -1` is what notices.
     */
    const result = await verify(
      world(NARROW, probeReading({ status: 'ok', restart: 'ok', otherCmd: 'denied', otherArg: 'denied' }), {
        commands: { [PROBE_FRESH]: { exitCode: 0, stdout: '' } },
      }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'That reading is current rather than a leftover from earlier',
    ]);
  });

  it('fails a policy moved to a different drop-in than the one it grades', async () => {
    const moved = world(NARROW, probeReading({ status: 'ok', restart: 'ok', otherCmd: 'denied', otherArg: 'denied' }));
    delete moved.files![DROP_IN];
    moved.commands![READ_POLICY] = { exitCode: 1, stdout: '', stderr: 'No such file or directory' };

    const result = await verify(moved);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The on-call sudo policy is still in place');
  });

  it('fails when the student removed their own sudo access', async () => {
    const lockedOut = world(NARROW, probeReading({ status: 'ok', restart: 'ok', otherCmd: 'denied', otherArg: 'denied' }));
    delete lockedOut.files![OWN_ACCESS];

    const result = await verify(lockedOut);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['Your own sudo access survived the change']);
  });

  it('fails a drop-in sudo would refuse to read for being too permissive', async () => {
    const loose = world(NARROW, probeReading({ status: 'denied', restart: 'denied', otherCmd: 'denied', otherArg: 'denied' }));
    loose.files![DROP_IN] = { type: 'file', mode: '666', owner: 'root', group: 'root', content: '' };

    const result = await verify(loose);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The policy file is not writable by anyone but root');
  });

  it('fails an untouched sandbox with every check reported', async () => {
    const result = await verify({});

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength((await lab()).requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

// ------------------------------------------------------------- lab hygiene

describe('LINUX-015 grades state, and never the route taken to it', () => {
  it('runs nothing the student authored', async () => {
    const definition = await lab();
    for (const requirement of [...definition.requirements, ...definition.setup.verify]) {
      expect(requirement.type).not.toBe('script_runs');
    }
  });

  it('names only allow-listed read-only commands with fixed arguments', async () => {
    const definition = await lab();
    const permitted = new Map<string, string[][]>([
      ['cat', [[DROP_IN]]],
      ['find', [[PROBE, '-mmin', '-1']]],
    ]);

    for (const requirement of [...definition.requirements, ...definition.setup.verify]) {
      if (requirement.type !== 'command_exit_code' && requirement.type !== 'command_output') continue;
      const allowed = permitted.get(requirement.command);
      expect(allowed, `unexpected command '${requirement.command}'`).toBeDefined();
      expect(allowed).toContainEqual([...requirement.args]);
    }
  });

  it('reads the policy file as root, because sudo requires a mode the student cannot read', async () => {
    const definition = await lab();
    const read = definition.requirements.find(
      (r) => r.type === 'command_output' && r.command === 'cat',
    );
    expect(read).toBeDefined();
    expect(read && 'as_user' in read ? read.as_user : undefined).toBe('root');
  });

  it('never names the fix in a failure detail', async () => {
    const result = await verify(BASELINE);
    for (const check of result.checks.filter((c) => c.status !== 'pass')) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /\b(Cmnd_Alias|NOPASSWD|chmod|chown|visudo)\b/,
      );
    }
  });

  it('states the healthy end state in its labels rather than the fault', async () => {
    const labels = (await lab()).requirements.map((r) => r.label ?? '');
    expect(labels.every(Boolean)).toBe(true);
    for (const label of labels) {
      expect(label).not.toMatch(/\b(broken|wrong|missing|blanket grant|too permissive)\b/i);
    }
  });

  it('claims no certification coverage, because sudo is not an LFCS objective', async () => {
    // Verified against the published LFCS competency list on 2026-08-24: the
    // words sudo, sudoers and least privilege appear nowhere in it. Recorded as
    // relevant:false rather than omitted so the check stays on the record.
    const certification = (await lab()).certification;
    expect(certification).toHaveLength(1);
    expect(certification[0]?.certification).toBe('LFCS');
    expect(certification[0]?.relevant).toBe(false);
    expect(certification[0]?.domains).toEqual([]);
  });
});
