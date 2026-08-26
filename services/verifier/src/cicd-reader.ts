/**
 * Everything a CI/CD check may observe, and nothing else.
 *
 * A CI/CD lab is graded on two kinds of evidence, and this reader is the only
 * way either reaches a handler:
 *
 *   · **what the student wrote** — a workflow file, a Jenkinsfile, a pipeline
 *     script — read out of their own sandbox as ordinary text;
 *   · **what the project actually does** — the build runs, the tests pass —
 *     obtained by running the project's own build and test, for real.
 *
 * The second is the reason this track exists. A CI lab that claimed "your
 * build works" without ever building would be exactly the fake result the
 * platform refuses to produce, so `task()` runs the real thing and reports the
 * real exit code.
 *
 * ## What bounds the running
 *
 * A requirement names a task *id*. The argv it maps to is written in
 * `WORKSPACE_TASKS`, in platform code, and can never be composed from a lab
 * definition — so "run the student's build" cannot become "run whatever a lab
 * file says". Underneath, the sandbox's `inspect` port runs it with no shell,
 * an allow-listed binary, a wall-clock timeout and a capped output buffer, as
 * the unprivileged student user inside that session's own container.
 *
 * Results are memoised by task id, so `project_builds` and a following
 * `artifact_exists` describe the same single build rather than two.
 */
import {
  workspaceTask,
  type WorkspaceTaskId,
  type WorkspaceTaskResult,
} from '@jumptotech/lab-orchestrator';
import type { SandboxPort } from './sandbox-reader.js';

/** What a path read tells a CI/CD check. Deliberately not the file's bytes. */
export interface CicdFileStat {
  kind: 'file' | 'directory' | 'other';
  size: number;
}

export class CicdVerifyReader {
  readonly #sandbox: SandboxPort;
  readonly #tasks = new Map<WorkspaceTaskId, Promise<WorkspaceTaskResult>>();
  readonly #files = new Map<string, Promise<string | null>>();

  constructor(sandbox: SandboxPort) {
    this.#sandbox = sandbox;
  }

  /** The text of a file in the student's project, or `null` when absent. */
  async fileText(relativePath: string): Promise<string | null> {
    const existing = this.#files.get(relativePath);
    if (existing) return existing;
    const load = (async () => {
      const read = await this.#sandbox.read(relativePath);
      if (!read || read.type !== 'file' || read.content === undefined) return null;
      // A truncated read would make a `contains` check answer about a prefix.
      // Better to report nothing than to report on half a file.
      if (read.truncated) return null;
      return read.content;
    })();
    this.#files.set(relativePath, load);
    return load;
  }

  /** Stat one path in the student's project, or `null` when it is absent. */
  async fileStat(relativePath: string): Promise<CicdFileStat | null> {
    const read = await this.#sandbox.read(relativePath);
    if (!read) return null;
    const kind = read.type === 'file' ? 'file' : read.type === 'directory' ? 'directory' : 'other';
    const size = read.sizeBytes ?? Buffer.byteLength(read.content ?? '', 'utf8');
    return { kind, size };
  }

  /**
   * Run one task from the closed table, once per verification.
   *
   * Memoised deliberately: a lab that asserts the build succeeds *and* that it
   * produced an artifact is making two claims about one build, and running it
   * twice could report a pass and a fail for the same project.
   */
  async task(id: WorkspaceTaskId): Promise<WorkspaceTaskResult> {
    const existing = this.#tasks.get(id);
    if (existing) return existing;

    const definition = workspaceTask(id);
    const run = (async (): Promise<WorkspaceTaskResult> => {
      const started = Date.now();
      const [command, ...args] = definition.argv;
      if (command === undefined) {
        throw new Error(`task '${id}' has an empty argv, which the table forbids`);
      }
      if (!this.#sandbox.inspect) {
        // Fail closed: a provider that cannot run anything must not make a
        // build look as though it succeeded.
        return {
          task: id,
          argv: definition.argv,
          exitCode: -1,
          stdout: '',
          stderr: 'this lab environment cannot run project tasks',
          timedOut: false,
          durationMs: 0,
        };
      }
      const result = await this.#sandbox.inspect(command, args, {
        timeoutMs: definition.timeoutMs,
      });
      return {
        task: id,
        argv: definition.argv,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut ?? false,
        durationMs: Date.now() - started,
      };
    })();

    this.#tasks.set(id, run);
    return run;
  }
}
