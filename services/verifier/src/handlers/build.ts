/**
 * Handlers that run the project, rather than read it.
 *
 * A CI lab claiming "your build works" without ever building would be exactly
 * the fake result this platform refuses to produce. These three handlers run
 * the real thing: the student's own build script, the student's own tests, in
 * the student's own workspace, and report the real exit code and the real
 * output.
 *
 * Bounds, all enforced below the handler in `workspace/tasks.ts` and
 * `FsWorkspace.runTask`:
 *
 *   - the argv is a fixed array in platform code, never composed from lab.yaml;
 *   - no shell, so nothing in the workspace becomes syntax;
 *   - a minimal environment — nothing from the API process is inherited;
 *   - a wall-clock timeout and a capped output buffer;
 *   - the reader memoises by task id, so `project_builds` and a following
 *     `artifact_exists` describe the same single build.
 */
import { workspaceTask } from '@jumptotech/lab-orchestrator';
import { fail, pass, type HandlerOutcome, type VerifierHandler } from '../contract.js';
import type { WorkspaceTaskResult } from '@jumptotech/lab-orchestrator';

/** Longest excerpt of a failing run to show. Enough to see the error line. */
const EXCERPT_LINES = 6;

/**
 * The most useful lines of a failed run.
 *
 * Tail rather than head: a build or a test runner puts the reason it failed at
 * the end, and a student reading a check result wants that, not the banner.
 */
function excerpt(result: WorkspaceTaskResult): string {
  const combined = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (combined.length === 0) return 'the command produced no output';
  return combined.slice(-EXCERPT_LINES).join(' · ');
}

function timeoutOutcome(result: WorkspaceTaskResult): HandlerOutcome {
  return fail(
    `\`${workspaceTask(result.task).label}\` did not finish within the time limit and was stopped`,
  );
}

export const commandExitCode: VerifierHandler<'command_exit_code'> = {
  type: 'command_exit_code',
  label: (r) => `\`${workspaceTask(r.command).label}\` exits with ${r.expected_exit_code}`,
  async run(requirement, reader) {
    const result = await reader.task(requirement.command);
    if (result.timedOut) return timeoutOutcome(result);

    if (result.exitCode !== requirement.expected_exit_code) {
      return fail(
        `\`${workspaceTask(requirement.command).label}\` exited with ${result.exitCode}, expected ${requirement.expected_exit_code} — ${excerpt(result)}`,
      );
    }
    return pass(`exit ${result.exitCode} in ${result.durationMs}ms`);
  },
};

export const projectBuilds: VerifierHandler<'project_builds'> = {
  type: 'project_builds',
  label: () => 'The project builds',
  async run(requirement, reader) {
    const result = await reader.task('app_build');
    if (result.timedOut) return timeoutOutcome(result);

    if (result.exitCode !== 0) {
      return fail(
        `\`${workspaceTask('app_build').label}\` failed with exit code ${result.exitCode} — ${excerpt(result)}`,
      );
    }

    // A build that exits 0 without producing anything is a build in name only,
    // which is precisely the CICD-010 fault where the output path is wrong.
    if (requirement.produces) {
      const stat = await reader.fileStat(requirement.produces);
      if (!stat) {
        return fail(
          `the build succeeded but produced no '${requirement.produces}' — check where it writes its output`,
        );
      }
      if (stat.size === 0) {
        return fail(`the build produced '${requirement.produces}' but it is empty`);
      }
      return pass(`built in ${result.durationMs}ms → ${requirement.produces} (${stat.size} bytes)`);
    }

    return pass(`built in ${result.durationMs}ms`);
  },
};

export const testsPass: VerifierHandler<'tests_pass'> = {
  type: 'tests_pass',
  label: () => 'The test suite passes',
  async run(_requirement, reader) {
    const result = await reader.task('app_test');
    if (result.timedOut) return timeoutOutcome(result);

    if (result.exitCode !== 0) {
      return fail(
        `\`${workspaceTask('app_test').label}\` reported failures (exit code ${result.exitCode}) — ${excerpt(result)}`,
      );
    }

    /*
     * A suite that matched no files also exits 0, and passing that would be the
     * emptiest kind of false pass. The runner's own summary line is the
     * evidence that tests actually ran — written `# pass N` by the TAP reporter
     * and `ℹ pass N` by the spec reporter, and which one appears depends on
     * whether stdout is a terminal, so both are accepted.
     */
    const summary = /^\s*(?:#|ℹ)\s*pass (\d+)/m.exec(result.stdout);
    const passed = summary?.[1] ? Number.parseInt(summary[1], 10) : null;
    if (passed === 0) {
      return fail('the test command succeeded but ran no tests');
    }

    return pass(passed === null ? `passed in ${result.durationMs}ms` : `${passed} tests passed`);
  },
};
