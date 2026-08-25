/**
 * LINUX-014 — a process existing is not a service working.
 *
 * The rest of the Linux suite proves each requirement handler reads the right
 * thing. This file proves something about one lab's *requirement set*: that it
 * distinguishes a supervised process which exists from a service that is
 * actually doing its job, and fails the host the lab hands the student.
 *
 * That distinction is the entire subject of the lab, so it is asserted
 * directly rather than left to the generic "fails on an untouched sandbox"
 * pass. The dangerous regression here is not a broken handler — it is someone
 * later simplifying the requirement list down to `process_running` and
 * shipping a lab that goes green on a completely broken host.
 *
 * Every world below is stated explicitly. Nothing is derived from running the
 * seed script, so no assertion here can read as "the fake proved the lab
 * works" — that belongs to the container integration suites.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAB_YAML = path.resolve(here, '../../../labs/linux/linux-014-environment/lab.yaml');
const SANDBOX = 'jtt-lab-000000000014';

const RUNNER = '/usr/local/lib/jumptotech/report-runner';
const FORMATTER = '/usr/local/libexec/jumptotech/jtt-format';
const STATUS = '/var/lib/jumptotech/report-runner.status';
const LOG = '/var/log/jumptotech/report-runner.log';
const EVIDENCE = '/home/student/ops/service-env.txt';
const RUN_SCRIPT = '/etc/sv/report-runner/run';

/** runit's own supervision state, read as root from its supervise directory. */
const SUPERVISE_STAT = 'cat /etc/service/report-runner/supervise/stat';
/** `find -mmin -1` prints the path only when it was touched in the last minute. */
const STATUS_FRESH = `find ${STATUS} -mmin -1`;

/** The seeded run script: supervised, but supplying none of what the app needs. */
const RUN_SCRIPT_BROKEN = ['#!/bin/sh', 'exec 2>&1', 'JTT_SUPERVISED=1', 'export JTT_SUPERVISED', `exec ${RUNNER}`, ''].join('\n');
/** The run script once the student has put the environment where it belongs. */
const RUN_SCRIPT_FIXED = [
  '#!/bin/sh',
  'exec 2>&1',
  'JTT_SUPERVISED=1',
  'export JTT_SUPERVISED',
  'JTT_ENV=production',
  'export JTT_ENV',
  'PATH="$PATH:/usr/local/libexec/jumptotech"',
  'export PATH',
  `exec ${RUNNER}`,
  '',
].join('\n');

function lab() {
  return loadLabDefinition(LAB_YAML);
}

async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}

function failedLabels(checks: Array<{ status: string; label: string }>): string[] {
  return checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

/** The host as the seed script leaves it: enabled, supervised, and useless. */
const DEGRADED: FakeWorld = {
  processes: [
    '    1 root     /usr/bin/runsvdir -P /etc/service',
    '  204 root     runsv report-runner',
    `  205 root     /bin/sh ${RUNNER}`,
  ],
  commands: {
    'test -d /etc/service/report-runner': { exitCode: 0 },
    // runit reports the service as supervised; it is the *application* that is
    // broken, which is the whole premise of the lab.
    [SUPERVISE_STAT]: { exitCode: 0, stdout: 'run\n' },
    // The status file is being rewritten every five seconds — it is current,
    // and current is not the same as healthy.
    [STATUS_FRESH]: { exitCode: 0, stdout: `${STATUS}\n` },
  },
  files: {
    [RUN_SCRIPT]: { type: 'file', mode: '755', owner: 'root', group: 'root', content: RUN_SCRIPT_BROKEN },
    [STATUS]: {
      type: 'file',
      content: [
        'STATUS=DEGRADED',
        'REASON=JTT_ENV is not set, so this instance does not know which deployment it belongs to',
        'JTT_ENV=',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        '',
      ].join('\n'),
    },
    [LOG]: {
      type: 'file',
      content: '2026-08-23T09:00:01+00:00 report-runner: not producing rollups — REASON=JTT_ENV is not set\n',
    },
    [FORMATTER]: { type: 'file', mode: '755', owner: 'root', group: 'root', content: '#!/bin/sh\n' },
  },
};

/** The host once the service has the environment it needs. */
const HEALTHY: FakeWorld = {
  ...DEGRADED,
  files: {
    ...DEGRADED.files,
    [RUN_SCRIPT]: { type: 'file', mode: '755', owner: 'root', group: 'root', content: RUN_SCRIPT_FIXED },
    [STATUS]: {
      type: 'file',
      content: [
        'STATUS=OK',
        `FORMATTER=${FORMATTER}`,
        'JTT_ENV=production',
        `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${path.dirname(FORMATTER)}`,
        '',
      ].join('\n'),
    },
    [LOG]: {
      type: 'file',
      content:
        '2026-08-23T09:00:01+00:00 report-runner: not producing rollups — REASON=JTT_ENV is not set\n' +
        '2026-08-23T09:31:06+00:00 report-runner: formatted=OK subject=daily-balance\n',
    },
    [EVIDENCE]: { type: 'file', content: `the service needed ${path.dirname(FORMATTER)} on its PATH\n` },
  },
};

// ------------------------------------------------- the property under test

describe('LINUX-014 separates "a process exists" from "the service works"', () => {
  it('fails the baseline host, where the service is enabled, supervised and running', async () => {
    const result = await verify(DEGRADED);

    // The premise: by the process table alone this host looks fine.
    const processCheck = result.checks.find((c) => c.label.includes('is running'));
    expect(processCheck?.status).toBe('pass');
    const enabledCheck = result.checks.find((c) => c.label.includes('still enabled'));
    expect(enabledCheck?.status).toBe('pass');

    // And the lab still fails it, because the service is not doing its job.
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    expect(failedLabels(result.checks)).toContain('The reporting service reports itself healthy');
    expect(failedLabels(result.checks)).toContain('A rollup was actually produced');
  });

  it('passes only once the service publishes health and a rollup reaches the log', async () => {
    const result = await verify(HEALTHY);

    expect(failedLabels(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('is not satisfied by a status file alone — the service must produce output', async () => {
    // A host where the status file says OK but nothing was ever formatted:
    // the shape a forged or stale status file would take.
    const forged: FakeWorld = {
      ...HEALTHY,
      files: {
        ...HEALTHY.files,
        [LOG]: { type: 'file', content: '2026-08-23T09:00:01+00:00 report-runner: starting\n' },
      },
    };

    const result = await verify(forged);
    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual(['A rollup was actually produced']);
  });

  it('fails when only the environment variable was supplied and the formatter is still unresolvable', async () => {
    // The second fault, which the first one hides on the real host.
    const halfFixed: FakeWorld = {
      ...DEGRADED,
      files: {
        ...DEGRADED.files,
        [STATUS]: {
          type: 'file',
          content: [
            'STATUS=DEGRADED',
            'REASON=jtt-format could not be resolved on PATH',
            'JTT_ENV=production',
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            '',
          ].join('\n'),
        },
      },
    };

    const result = await verify(halfFixed);
    expect(result.passed).toBe(false);
    // Progress is visible — the deployment variable check has gone green —
    // without the lab being satisfied.
    expect(
      result.checks.find((c) => c.label.includes('which deployment it belongs to'))?.status,
    ).toBe('pass');
    expect(failedLabels(result.checks)).toContain(
      'The service can resolve the formatter it shells out to',
    );
  });

  it('fails when the service was fixed but disabled instead of left under supervision', async () => {
    // A student who stops the supervisor and runs the program by hand.
    const unsupervised: FakeWorld = {
      ...HEALTHY,
      commands: {
        ...HEALTHY.commands,
        'test -d /etc/service/report-runner': { exitCode: 1 },
      },
    };

    const result = await verify(unsupervised);
    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual(['The reporting service is still enabled']);
  });

  it('fails a service that was stopped and re-run by hand outside the supervisor', async () => {
    /*
     * The bypass this hardening exists to close. `sv stop` leaves the symlink
     * in place, so "is it enabled" still passes, and a manually started copy
     * with the right environment produces every other piece of evidence. What
     * it cannot produce is runit's own supervision state, which reads `down`.
     */
    const manuallyRun: FakeWorld = {
      ...HEALTHY,
      commands: {
        ...HEALTHY.commands,
        [SUPERVISE_STAT]: { exitCode: 0, stdout: 'down\n' },
      },
    };

    const result = await verify(manuallyRun);
    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual([
      'The supervisor is running the reporting service, not just holding it enabled',
    ]);
  });

  it('fails a host where every artefact the service writes was forged by hand', async () => {
    /*
     * The false positive this hardening exists to close. A student with sudo
     * can write the status file, append a rollup line to the log and create the
     * evidence file — three commands, no understanding. Reading the run script
     * is what defeats it: the only way to satisfy those two checks is to write
     * the correct service definition, which is the task itself.
     */
    const forgedEverything: FakeWorld = {
      ...HEALTHY,
      files: {
        ...HEALTHY.files,
        [RUN_SCRIPT]: {
          type: 'file',
          mode: '755',
          owner: 'root',
          group: 'root',
          content: RUN_SCRIPT_BROKEN,
        },
      },
    };

    const result = await verify(forgedEverything);
    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual([
      'The service definition supplies the deployment variable',
      "The service definition puts the formatter's directory on the service's PATH",
    ]);
  });

  it('fails when the health report is stale rather than current', async () => {
    // `find -mmin -1` prints nothing when the file has not been touched
    // recently, so a status file left saying OK cannot stand in for a live one.
    const stale: FakeWorld = {
      ...HEALTHY,
      commands: { ...HEALTHY.commands, [STATUS_FRESH]: { exitCode: 0, stdout: '' } },
    };

    const result = await verify(stale);
    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual([
      'That health report is current rather than a leftover from earlier',
    ]);
  });

  it('fails when nothing has been done at all', async () => {
    const result = await verify({});

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength((await lab()).requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

// ------------------------------------------------------------- lab hygiene

describe('LINUX-014 grades state, and never the route taken to it', () => {
  it('asks for no check that could observe a command the student typed', async () => {
    const definition = await lab();

    for (const requirement of [...definition.requirements, ...definition.setup.verify]) {
      // `script_runs` is the only vocabulary entry that executes anything the
      // student authored, and this lab has no student-authored script: every
      // check reads state the host is in.
      expect(requirement.type).not.toBe('script_runs');
    }
  });

  it('names only allow-listed, read-only inspection commands with fixed arguments', async () => {
    const definition = await lab();

    // Three commands, all read-only, all with argv fixed in the lab file. No
    // shell, no globbing, nothing derived from anything the student controls.
    const permitted = new Map<string, string[][]>([
      ['test', [['-d', '/etc/service/report-runner']]],
      ['cat', [['/etc/service/report-runner/supervise/stat']]],
      ['find', [['/var/lib/jumptotech/report-runner.status', '-mmin', '-1']]],
    ]);

    for (const requirement of [...definition.requirements, ...definition.setup.verify]) {
      if (requirement.type !== 'command_exit_code' && requirement.type !== 'command_output') continue;
      const allowed = permitted.get(requirement.command);
      expect(allowed, `unexpected command '${requirement.command}'`).toBeDefined();
      expect(allowed).toContainEqual([...requirement.args]);
    }
  });

  it('never names the fix in a failure detail', async () => {
    const result = await verify(DEGRADED);

    for (const check of result.checks.filter((c) => c.status !== 'pass')) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /\b(export|JTT_ENV|PATH=|chmod|sv start|libexec)\b/,
      );
    }
  });

  it('states the healthy end state in its labels rather than the fault', async () => {
    const definition = await lab();
    const labels = definition.requirements.map((r) => r.label ?? '');

    expect(labels.every(Boolean)).toBe(true);
    for (const label of labels) {
      expect(label).not.toMatch(/\b(missing|unset|not set|broken|wrong)\b/i);
    }
  });
});
