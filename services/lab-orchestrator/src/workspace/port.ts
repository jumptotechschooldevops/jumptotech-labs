/**
 * The narrow filesystem surface a file-backed lab needs.
 *
 * This is the workspace equivalent of `k8s/port.ts`: verifier handlers reason
 * about *snapshots* — a stat, a text body, a task result — and never touch
 * `node:fs` themselves. That keeps handlers unit-testable against an in-memory
 * fake, and it keeps the containment rules in exactly one implementation
 * instead of scattered across every handler that opens a file.
 *
 * Everything here is read-only except `runTask`, which runs one entry from the
 * platform's closed task table (`tasks.ts`). There is no write method: the
 * platform seeds a workspace and the student changes it from their own shell.
 * Nothing in the verification path can modify what it is grading.
 */
import type { WorkspaceTaskId } from './tasks.js';

export type WorkspaceEntryKind = 'file' | 'directory';

export interface WorkspaceStat {
  /** Workspace-relative path, canonicalised. */
  path: string;
  kind: WorkspaceEntryKind;
  /** Bytes for a file; the sum of contained file sizes for a directory. */
  size: number;
  /** Entries directly inside, for a directory. */
  entries?: number;
}

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

/** Raised when a workspace-backed check runs without a workspace to read. */
export class WorkspaceUnavailableError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WorkspaceUnavailableError';
  }
}

export interface WorkspacePort {
  /** Absolute path of the workspace root. Never sent to a browser. */
  readonly root: string;

  /** Stat one entry. Resolves to `null` when it does not exist. */
  stat(relativePath: string): Promise<WorkspaceStat | null>;

  /**
   * Read a regular file as UTF-8.
   *
   * Resolves to `null` when the path is absent or is not a regular file — a
   * missing file is an ordinary verification outcome, not an exception.
   * Content longer than `maxBytes` is truncated rather than refused, so a
   * student who commits a large artifact still gets a useful check.
   */
  readText(relativePath: string, maxBytes?: number): Promise<string | null>;

  /** Names directly inside a directory, sorted. Empty when absent. */
  list(relativeDirectory: string): Promise<string[]>;

  /** Run one allow-listed task with the workspace as its working directory. */
  runTask(task: WorkspaceTaskId): Promise<WorkspaceTaskResult>;
}
