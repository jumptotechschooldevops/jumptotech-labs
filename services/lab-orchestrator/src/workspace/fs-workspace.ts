/**
 * `WorkspacePort` backed by a real directory on disk.
 *
 * One instance is bound to one session's workspace root at construction. The
 * root is not a parameter of any method, so a handler cannot name a different
 * session's workspace — the same shape as `VerifyReader`, which fixes the
 * Kubernetes namespace at construction for the same reason.
 *
 * Containment is enforced twice on every call:
 *
 *   1. the relative path is validated as a string (`assertSafeRelativePath`);
 *   2. the resolved absolute path is re-checked against the root, *after*
 *      `realpath`, so a symlink planted inside the workspace cannot be followed
 *      out of it.
 *
 * Step 2 is the one that matters: a student has a shell in this directory and
 * can create `ln -s /etc/passwd secrets.txt` at will. Reading that link would
 * hand host content to a verification detail message. Instead, a path whose
 * real location is outside the root reads as absent.
 */
import { execFile } from 'node:child_process';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSafeRelativePath,
  InvalidWorkspacePathError,
  isInside,
} from './paths.js';
import type { WorkspacePort, WorkspaceStat, WorkspaceTaskResult } from './port.js';
import {
  TASK_BINARY_ALLOWLIST,
  isWorkspaceTaskId,
  workspaceTask,
  type WorkspaceTaskId,
} from './tasks.js';

/** Cap on a single `readText`, so one huge file cannot exhaust memory. */
export const DEFAULT_MAX_READ_BYTES = 256 * 1024;

/** Cap on captured task output. Enough for a stack trace, not for a log dump. */
export const MAX_TASK_OUTPUT_BYTES = 64 * 1024;

/** Guard against a runaway directory walk when sizing a directory. */
const MAX_WALK_ENTRIES = 5_000;

export interface FsWorkspaceOptions {
  /** Absolute path of this session's workspace directory. */
  root: string;
  /**
   * Environment handed to tasks.
   *
   * Defaults to a minimal set. Nothing from `process.env` is inherited: the API
   * process holds the internal service secret, the namespace derivation secret,
   * and a cluster kubeconfig path, and none of them may reach a student's build.
   */
  taskEnv?: Record<string, string>;
}

export class FsWorkspace implements WorkspacePort {
  readonly root: string;
  readonly #taskEnv: Record<string, string>;

  constructor(options: FsWorkspaceOptions) {
    this.root = path.resolve(options.root);
    this.#taskEnv = options.taskEnv ?? defaultTaskEnv(this.root);
  }

  /**
   * Resolve a workspace-relative path to a real absolute path inside the root.
   *
   * Returns `null` — rather than throwing — when the path is absent or escapes,
   * because both are "there is nothing there to check" from a handler's point
   * of view. A *malformed* path still throws: that is a lab authoring bug.
   */
  async #resolve(relativePath: string): Promise<{ canonical: string; absolute: string } | null> {
    const canonical = assertSafeRelativePath(relativePath);
    const absolute = path.resolve(this.root, canonical);
    if (!isInside(this.root, absolute, path.sep)) return null;

    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      return null;
    }
    // `realpath` on the root itself may differ from the configured string (a
    // symlinked temp directory on macOS, for instance), so compare real to real.
    let realRoot: string;
    try {
      realRoot = await realpath(this.root);
    } catch {
      return null;
    }
    if (!isInside(realRoot, real, path.sep)) return null;

    return { canonical, absolute: real };
  }

  async stat(relativePath: string): Promise<WorkspaceStat | null> {
    const resolved = await this.#resolve(relativePath);
    if (!resolved) return null;

    // `lstat` on the already-`realpath`'d target: the link has been followed and
    // proven to land inside the root, so this reports the real entry.
    const info = await lstat(resolved.absolute).catch(() => null);
    if (!info) return null;

    if (info.isDirectory()) {
      const { bytes } = await this.#walk(resolved.absolute);
      const entries = await readdir(resolved.absolute).catch(() => []);
      return {
        path: resolved.canonical,
        kind: 'directory',
        size: bytes,
        entries: entries.length,
      };
    }
    if (!info.isFile()) return null;

    return { path: resolved.canonical, kind: 'file', size: info.size };
  }

  async readText(relativePath: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<string | null> {
    const resolved = await this.#resolve(relativePath);
    if (!resolved) return null;

    const info = await lstat(resolved.absolute).catch(() => null);
    if (!info || !info.isFile()) return null;

    const handle = await open(resolved.absolute, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const length = Math.min(info.size, Math.max(0, maxBytes));
      if (length === 0) return '';
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async list(relativeDirectory: string): Promise<string[]> {
    const resolved = await this.#resolve(relativeDirectory);
    if (!resolved) return [];
    const entries = await readdir(resolved.absolute).catch(() => []);
    return [...entries].sort();
  }

  /** Total bytes and file count under a directory, bounded. */
  async #walk(absolute: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0;
    let files = 0;
    let visited = 0;

    const stack = [absolute];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (visited >= MAX_WALK_ENTRIES) return { bytes, files };
        visited += 1;
        const child = path.join(dir, entry.name);
        // Symlinks are counted as present but never followed: following one
        // would let a link into `/` inflate the size of a lab artifact.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(child);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await lstat(child).catch(() => null);
        if (!info) continue;
        bytes += info.size;
        files += 1;
      }
    }
    return { bytes, files };
  }

  // ------------------------------------------------------------------ tasks

  async runTask(task: WorkspaceTaskId): Promise<WorkspaceTaskResult> {
    if (!isWorkspaceTaskId(task)) {
      throw new Error(`'${String(task)}' is not a known workspace task`);
    }
    const definition = workspaceTask(task);
    const [binary, ...args] = definition.argv;
    if (!binary || !TASK_BINARY_ALLOWLIST.has(binary)) {
      throw new Error(`Task '${task}' names a binary that is not allow-listed`);
    }

    const startedAt = Date.now();
    return new Promise<WorkspaceTaskResult>((resolve) => {
      execFile(
        // Resolved to an absolute path rather than looked up on PATH. It is
        // the interpreter already running this process, so it is guaranteed to
        // exist wherever the platform runs — and there is no PATH search for
        // anything in the workspace to intercept.
        resolveBinary(binary),
        args,
        {
          cwd: this.root,
          env: this.#taskEnv,
          timeout: definition.timeoutMs,
          maxBuffer: MAX_TASK_OUTPUT_BYTES,
          // No shell, ever: argv stays argv, so nothing in the workspace can
          // turn a filename into syntax.
          shell: false,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const errno = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
          const timedOut = Boolean(errno && (errno.killed === true || errno.code === 'ETIMEDOUT'));
          let exitCode = 0;
          if (error) {
            const code = (error as { code?: unknown }).code;
            exitCode = typeof code === 'number' ? code : 1;
          }
          resolve({
            task,
            argv: definition.argv,
            exitCode,
            stdout: clip(String(stdout)),
            stderr: clip(String(stderr) || (error && exitCode !== 0 ? error.message : '')),
            timedOut,
            durationMs: Date.now() - startedAt,
          });
        },
      );
    });
  }
}

/**
 * The absolute path of an allow-listed binary.
 *
 * `node` resolves to the interpreter running this process. That is the same
 * runtime the platform itself is built against, it exists by definition, and
 * resolving it this way removes PATH from the picture entirely — which matters
 * because the working directory of these tasks is a directory a student
 * controls.
 */
export function resolveBinary(binary: string): string {
  return binary === 'node' ? process.execPath : binary;
}

/**
 * The environment a workspace task runs in.
 *
 * Explicit and small. `HOME` and `TMPDIR` point at the workspace so a build
 * that writes a cache writes it inside the sandbox rather than into a shared
 * host directory, and `CI=true` is set because that is what a CI environment
 * genuinely looks like to a build script — the labs teach that variable.
 *
 * The Node.js binary's own directory is on `PATH` so that a build script which
 * shells out to `node` finds the same runtime the task was started with,
 * rather than whatever a bare `/usr/bin` happens to hold.
 */
export function defaultTaskEnv(root: string): Record<string, string> {
  return {
    PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: root,
    TMPDIR: root,
    LANG: 'C.UTF-8',
    CI: 'true',
    NODE_ENV: 'test',
    // npm/yarn are not on the task path, but if a future task adds them this
    // keeps a build from reaching the network by accident.
    npm_config_offline: 'true',
  };
}

function clip(text: string): string {
  return text.length > MAX_TASK_OUTPUT_BYTES
    ? `${text.slice(0, MAX_TASK_OUTPUT_BYTES)}\n…output truncated…`
    : text;
}

export { InvalidWorkspacePathError };
