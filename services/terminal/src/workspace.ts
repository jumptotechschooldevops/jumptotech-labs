/**
 * Per-session workspaces.
 *
 * A Docker lab sometimes asks the student to write a file — a Dockerfile, an
 * env file — and then build from it. That file has to live where the student's
 * shell can edit it and where `docker build` will pick it up as a build
 * context, which is this container.
 *
 * ```text
 *   PTY  cwd=$HOME=/workspaces/<hmac(sid)>   ← student edits here
 *                     ▲                   ▲
 *      seeded from    │                   │  read-only, over the internal API
 *      lab.yaml ──────┘                   └──── verifier (file_exists,
 *                                                dockerfile_valid)
 * ```
 *
 * **Cross-session containment.** Every student shell in this service runs as
 * the same OS user, so file permissions alone cannot separate them. Two things
 * are done instead:
 *
 *   - the directory name is an HMAC of the session id keyed by a server-side
 *     secret, so it cannot be derived from anything a student can see;
 *   - the root is created mode `0711` — traversable but **not listable** — so a
 *     shell cannot enumerate the sessions it does not belong to.
 *
 * That is containment by unguessability, not by kernel enforcement, and it is
 * recorded as such in README → Known limitations. The isolation that actually
 * matters for this track — containers, images, volumes, networks — is enforced
 * by separate Docker daemons and per-session mutual TLS, not by this file.
 */
import { createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Refuse to read anything larger; a Dockerfile is a few hundred bytes. */
export const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;

export interface WorkspaceFileSpec {
  path: string;
  content: string;
}

export class WorkspacePathError extends Error {
  readonly code = 'INVALID_WORKSPACE_PATH';
  constructor(reason: string) {
    super(`Invalid workspace path: ${reason}`);
    this.name = 'WorkspacePathError';
  }
}

/**
 * The directory for one session.
 *
 * Keyed by a secret so the mapping cannot be recomputed by anyone holding only
 * a session id, and so two deployments never derive the same name.
 */
export function workspaceDirFor(root: string, sessionId: string, secret: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (safe.length === 0) throw new WorkspacePathError('session id has no usable characters');
  const digest = createHmac('sha256', secret).update(`workspace:${safe}`).digest('hex').slice(0, 16);
  return path.join(root, `ws-${digest}`);
}

/**
 * Resolve a relative path inside a workspace directory.
 *
 * Rejects absolute paths and `..` before resolving, then re-checks the resolved
 * result — so neither a crafted string nor a symlinked component can escape the
 * session's own directory.
 */
export function resolveWorkspaceFile(dir: string, relative: string): string {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new WorkspacePathError('must not be empty');
  }
  if (relative.length > 255) throw new WorkspacePathError('too long');
  if (relative.includes('\0')) throw new WorkspacePathError('must not contain null bytes');
  if (path.isAbsolute(relative)) throw new WorkspacePathError('must be relative');
  if (relative.includes('\\')) throw new WorkspacePathError('must use forward slashes');
  if (relative.split('/').includes('..')) throw new WorkspacePathError('must not traverse upwards');

  const resolved = path.resolve(dir, relative);
  const root = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(root)) {
    throw new WorkspacePathError('resolves outside the session workspace');
  }
  return resolved;
}

export interface WorkspaceOptions {
  /** Parent directory holding every session's workspace. */
  root: string;
  /** Keys the session-id → directory-name derivation. */
  secret: string;
}

export class SessionWorkspaces {
  constructor(private readonly options: WorkspaceOptions) {}

  dirFor(sessionId: string): string {
    return workspaceDirFor(this.options.root, sessionId, this.options.secret);
  }

  /**
   * Create a session's workspace and write its baseline files.
   *
   * Idempotent, because it runs both when a shell starts and on every lab
   * reset, and both must leave the same result.
   */
  async seed(sessionId: string, files: readonly WorkspaceFileSpec[]): Promise<string> {
    const dir = this.dirFor(sessionId);
    // 0711 on the root: a shell can enter its own workspace by name but cannot
    // list the root to discover anyone else's.
    await mkdir(this.options.root, { recursive: true, mode: 0o711 });
    await mkdir(dir, { recursive: true, mode: 0o700 });

    for (const file of files) {
      const target = resolveWorkspaceFile(dir, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { mode: 0o644 });
    }
    return dir;
  }

  /** Read one file from a session's workspace, or `null` when absent. */
  async read(sessionId: string, relative: string): Promise<string | null> {
    const target = resolveWorkspaceFile(this.dirFor(sessionId), relative);
    try {
      const content = await readFile(target, 'utf8');
      // Truncate rather than refuse: a student who accidentally created a huge
      // file should still get a useful answer about its first lines.
      return content.length > MAX_WORKSPACE_FILE_BYTES
        ? content.slice(0, MAX_WORKSPACE_FILE_BYTES)
        : content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if ((error as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw error;
    }
  }

  /** Remove a session's workspace. Safe to call twice. */
  async destroy(sessionId: string): Promise<void> {
    const dir = this.dirFor(sessionId);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
