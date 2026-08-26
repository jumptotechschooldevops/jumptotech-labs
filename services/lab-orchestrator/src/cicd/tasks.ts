/**
 * The closed set of commands the platform may run inside a student workspace.
 *
 * CI/CD labs cannot be graded purely by reading files: "the pipeline builds the
 * project" and "the tests pass" are claims about *behaviour*, and the story is
 * explicit that pipeline results must not be faked. So the verifier does run
 * things — but only these things.
 *
 * The safety property is that **a lab definition never supplies a command**. A
 * requirement names a task *id* from this table; the argv it maps to is written
 * here, in platform code, as a fixed array. There is no interpolation, no
 * shell, and no way for lab.yaml (or a student, or a request body) to add an
 * entry or alter one.
 *
 * What a task *does* execute is the student's own project, in the student's own
 * workspace. That is deliberate and it is the point: a build that never runs
 * proves nothing. It is not a privilege boundary — the student already has a
 * shell in that workspace — so a task adds no capability they did not have.
 * Everything a task gets is bounded here: a minimal environment with no
 * inherited host variables, a wall-clock timeout, and a capped output buffer.
 */

/** Every runnable task, in documentation order. */
export const WORKSPACE_TASKS = {
  /**
   * Prove the toolchain is present.
   *
   * Used as a provisioning step, so a workspace is never handed to a student
   * with a Node runtime that turns out not to exist.
   */
  node_version: {
    argv: ['node', '--version'],
    label: 'node --version',
    description: 'Report the Node.js runtime version available in the workspace.',
    timeoutMs: 10_000,
  },

  /**
   * Build the workspace project.
   *
   * `build.mjs` is part of the JumpToTech sample application seeded into the
   * workspace. A student may edit it — that is what CICD-010 asks them to do —
   * and the result is whatever their edit produces.
   */
  app_build: {
    argv: ['node', 'build.mjs'],
    label: 'node build.mjs',
    description: 'Run the sample application build script.',
    timeoutMs: 60_000,
  },

  /**
   * Run the project's test suite with the Node.js built-in test runner.
   *
   * No positional argument on purpose. Node's default discovery finds
   * `**​/*.test.mjs` from the working directory on every release the platform
   * supports, whereas passing a bare directory (`--test test/`) stopped being
   * accepted in newer Node versions. A student who adds a second test file gets
   * it run without touching anything.
   */
  app_test: {
    argv: ['node', '--test'],
    label: 'node --test',
    description: 'Run the sample application test suite.',
    timeoutMs: 60_000,
  },

  /** Exercise the built application end to end, after a build. */
  app_smoke: {
    argv: ['node', 'src/cli.mjs', '--selftest'],
    label: 'node src/cli.mjs --selftest',
    description: 'Run the sample application self-check.',
    timeoutMs: 30_000,
  },
} as const;

export type WorkspaceTaskId = keyof typeof WORKSPACE_TASKS;

export const WORKSPACE_TASK_IDS = Object.keys(WORKSPACE_TASKS) as ReadonlyArray<WorkspaceTaskId>;

export function isWorkspaceTaskId(value: unknown): value is WorkspaceTaskId {
  return typeof value === 'string' && Object.hasOwn(WORKSPACE_TASKS, value);
}

export interface WorkspaceTaskDefinition {
  readonly argv: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly timeoutMs: number;
}

export function workspaceTask(id: WorkspaceTaskId): WorkspaceTaskDefinition {
  return WORKSPACE_TASKS[id];
}

/**
 * Binaries a task may name.
 *
 * A second, independent gate: even if the table above were edited carelessly,
 * nothing outside this set can be spawned.
 */
export const TASK_BINARY_ALLOWLIST: ReadonlySet<string> = new Set(['node']);

/** The outcome of running one task in a session's sandbox. */
export interface WorkspaceTaskResult {
  task: WorkspaceTaskId;
  /** The exact argv that ran. Reported so a failure detail can quote it. */
  argv: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}
