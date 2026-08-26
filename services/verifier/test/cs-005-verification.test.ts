/**
 * CS-005 — grading the process contract.
 *
 * The lab's subject is that a process talks to the world through four separate
 * channels, and the verifier has to respect that separation to grade it.
 * `script_runs` compares `output_contains` against stdout and stderr
 * *concatenated*, so it can prove the exit-code contract but can say nothing
 * about which stream a message came out of. Stream separation is therefore
 * graded from the two capture files the student produces with `>` and `2>`:
 * the diagnostic must be in the stderr capture and absent from the stdout one.
 *
 * The environment is graded the same way — by behaviour rather than assertion.
 * `script_runs` cannot set environment variables, so the check is run bare and
 * must report a misconfiguration instead of inventing a default, while the
 * success and failure paths go through the student's own launcher, which has
 * to place the value in the child's environment rather than merely assigning
 * a shell variable.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_005 = path.join(LABS_DIR, 'cs', 'cs-005-process-contract', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000005';

const CHECK = '/home/student/py/deploy-check.py';
const LAUNCHER = '/home/student/bin/run-check.sh';
const OUT = '/home/student/ops/out.txt';
const ERR = '/home/student/ops/err.txt';

const CHECK_SOURCE = '#!/usr/bin/env python3\nimport os, sys\n# ...\n';
const LAUNCHER_SOURCE = '#!/bin/bash\nexport KESTREL_MAX_FAILURES=5\nexec "$HOME/py/deploy-check.py" "$1"\n';

/** A correct implementation's behaviour, keyed as the verifier invokes it. */
function correctRuns(): FakeWorld['scripts'] {
  return {
    // Run bare, with no environment: a misconfiguration, on stderr, exit 2.
    [`${CHECK} 1`]: { exitCode: 2, stdout: '', stderr: 'DEPLOY_CHECK=misconfigured\n' },
    // Through the launcher, which supplies the limit the pipeline specifies.
    [`${LAUNCHER} 1`]: { exitCode: 0, stdout: 'DEPLOY_CHECK=ok failures=1 limit=5\n', stderr: '' },
    [`${LAUNCHER} 6`]: { exitCode: 3, stdout: '', stderr: 'DEPLOY_CHECK=failed failures=6 limit=5\n' },
    [`${LAUNCHER} 99`]: { exitCode: 3, stdout: '', stderr: 'DEPLOY_CHECK=failed failures=99 limit=5\n' },
  };
}

function pipelineEvidence(): FakeWorld['files'] {
  return {
    '/srv/kestrel/pipeline/deploy-check.py': { content: '#!/usr/bin/env python3\n', owner: 'root', mode: '555' },
    '/srv/kestrel/pipeline/run-check.sh': { content: '#!/bin/bash\nKESTREL_MAX_FAILURES=5\n', owner: 'root', mode: '555' },
    '/srv/kestrel/pipeline/pipeline.yml': { content: '  max_failures: 5\n', owner: 'root', mode: '444' },
    '/srv/kestrel/pipeline/job-4417.log': { content: 'exit status: 0\n', owner: 'root', mode: '444' },
  };
}

interface Solution {
  check?: string;
  launcher?: string;
  out?: string;
  err?: string;
  runs?: FakeWorld['scripts'];
  checkMode?: string;
}

function worldWith(s: Solution): FakeWorld {
  const world: FakeWorld = { files: pipelineEvidence(), scripts: s.runs ?? correctRuns() };
  if (s.check !== undefined) world.files![CHECK] = { content: s.check, mode: s.checkMode ?? '755' };
  if (s.launcher !== undefined) world.files![LAUNCHER] = { content: s.launcher, mode: '755' };
  if (s.out !== undefined) world.files![OUT] = { content: s.out };
  if (s.err !== undefined) world.files![ERR] = { content: s.err };
  return world;
}

/** Everything a finished student leaves behind. */
function solved(overrides: Solution = {}): FakeWorld {
  return worldWith({
    check: CHECK_SOURCE,
    launcher: LAUNCHER_SOURCE,
    out: '',
    err: 'DEPLOY_CHECK=misconfigured\n',
    ...overrides,
  });
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_005);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-005 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify({ files: pipelineEvidence() });
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

describe('CS-005 when the contract is honoured', () => {
  it('passes', async () => {
    const result = await verify(solved());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('passes a launcher that uses env(1) instead of export', async () => {
    // `env NAME=value command` places the variable in that child's environment
    // without exporting it in the current shell. Same contract, different
    // technique — the lab grades what the child received, not how.
    const launcher = '#!/bin/sh\nexec env KESTREL_MAX_FAILURES=5 "$HOME/py/deploy-check.py" "$1"\n';
    const result = await verify(solved({ launcher }));

    expect(result.passed).toBe(true);
  });
});

describe('CS-005 rejects each contract violation', () => {
  it('rejects diagnostics written to stdout — the bug that shipped the build', async () => {
    // The runner pipes this step's stdout onward, which is how a failure was
    // read as data. Only the capture files can catch it.
    const result = await verify(solved({ out: 'DEPLOY_CHECK=misconfigured\n', err: '' }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The diagnostic went to standard error',
      'Nothing went to standard output on the failing path',
    ]);
  });

  it('rejects a check that always exits 0', async () => {
    const runs = correctRuns();
    runs![`${CHECK} 1`] = { exitCode: 0, stdout: '', stderr: 'DEPLOY_CHECK=misconfigured\n' };
    runs![`${LAUNCHER} 6`] = { exitCode: 0, stdout: '', stderr: 'DEPLOY_CHECK=failed failures=6 limit=5\n' };
    runs![`${LAUNCHER} 99`] = { exitCode: 0, stdout: '', stderr: 'DEPLOY_CHECK=failed failures=99 limit=5\n' };

    const result = await verify(solved({ runs }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(3);
  });

  it('rejects a check that invents a default limit when unconfigured', async () => {
    // Falling back to a default is what hid the real limit; run bare, the
    // check must say it cannot do its job.
    const runs = correctRuns();
    runs![`${CHECK} 1`] = { exitCode: 0, stdout: 'DEPLOY_CHECK=ok failures=1 limit=999\n', stderr: '' };

    const result = await verify(solved({ runs, out: 'DEPLOY_CHECK=ok failures=1 limit=999\n', err: '' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'Without its configuration the check reports a misconfiguration rather than guessing',
    );
  });

  it('rejects a launcher that assigns without exporting', async () => {
    // A shell variable is not part of the child's environment. The check then
    // sees nothing and reports a misconfiguration through the launcher too.
    const runs = correctRuns();
    for (const arg of ['1', '6', '99']) {
      runs![`${LAUNCHER} ${arg}`] = { exitCode: 2, stdout: '', stderr: 'DEPLOY_CHECK=misconfigured\n' };
    }

    const result = await verify(solved({ runs, launcher: '#!/bin/bash\nKESTREL_MAX_FAILURES=5\nexec "$HOME/py/deploy-check.py" "$1"\n' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A deploy within the limit passes',
      'A deploy well over the limit fails with a status the pipeline can act on',
      'The launcher supplies the limit the pipeline actually specifies',
    ]);
  });

  it('rejects a limit that is not the one the pipeline specifies', async () => {
    // Substring matching could never catch this: `limit=5` is happily found
    // inside `limit=50`. The boundary run is what pins it — six failed probes
    // are over the line only under the right limit.
    const runs = correctRuns();
    runs![`${LAUNCHER} 6`] = { exitCode: 0, stdout: 'DEPLOY_CHECK=ok failures=6 limit=50\n', stderr: '' };

    const result = await verify(solved({ runs }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The launcher supplies the limit the pipeline actually specifies']);
  });

  it('rejects a launcher that does not run the corrected check', async () => {
    const result = await verify(solved({ launcher: '#!/bin/sh\necho "DEPLOY_CHECK=ok"\nexit 0\n' }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The launcher runs the corrected check');
  });

  it('rejects streams captured into one file', async () => {
    // `> file 2>&1` merges them, which is exactly the distinction the lab is
    // about; the stdout capture must stay clean on the failing path.
    const merged = 'DEPLOY_CHECK=misconfigured\n';
    const result = await verify(solved({ out: merged, err: merged }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['Nothing went to standard output on the failing path']);
  });

  it('rejects a check that is not executable', async () => {
    const result = await verify(solved({ checkMode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The corrected check exists and can be run as a program');
  });

  it('rejects missing captures', async () => {
    const world = solved();
    delete world.files![OUT];
    delete world.files![ERR];

    const result = await verify(world);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(4);
  });

  it('rejects a check that hangs instead of answering', async () => {
    // A pipeline step that never returns is as bad as one that lies; the
    // per-run timeout must surface as a failure, not as a stuck verifier.
    const runs = correctRuns();
    runs![`${CHECK} 1`] = { exitCode: 0, stdout: '', stderr: '', timedOut: true };

    const result = await verify(solved({ runs }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'Without its configuration the check reports a misconfiguration rather than guessing',
    );
  });
});

describe('CS-005 grading hygiene', () => {
  it('keeps discovered values out of the failure details', async () => {
    const runs = correctRuns();
    for (const key of Object.keys(runs!)) runs![key] = { exitCode: 9, stdout: 'nope\n', stderr: '' };

    const result = await verify(solved({ runs, out: 'nope\n', err: 'nope\n' }));

    for (const check of result.checks) {
      // The limit and the three bugs are what the student has to find. The
      // output contract itself is stated in the task on purpose — it is the
      // interface being implemented, not an answer to be discovered.
      expect(check.detail ?? '', check.label).not.toMatch(/limit=5|max_failures|export KESTREL/);
    }
  });

  it('grades only the student’s own artifacts, never the repository copy', async () => {
    const sandbox = new FakeSandbox(solved());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([CHECK, LAUNCHER, OUT, ERR]));
    expect(new Set(sandbox.scriptRuns)).toEqual(
      new Set([`${CHECK} 1`, `${LAUNCHER} 1`, `${LAUNCHER} 6`, `${LAUNCHER} 99`]),
    );
  });

  it('bounds every program it runs', async () => {
    const definition = await lab();

    // Student code runs inside the session's own container, and every
    // invocation carries a ceiling so a hanging or runaway program fails the
    // check instead of holding the verifier open.
    for (const requirement of definition.requirements) {
      if (requirement.type !== 'script_runs') continue;
      expect(requirement.timeout_seconds, requirement.path).toBeGreaterThan(0);
      expect(requirement.timeout_seconds, requirement.path).toBeLessThanOrEqual(60);
    }
  });
});
