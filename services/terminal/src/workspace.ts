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
 *
 * **Symlinks are resolved, not trusted.** A student owns their workspace, so
 * they can put a symlink in it, and `path.resolve` is string arithmetic that
 * cannot see one. Unresolved, `Dockerfile -> /proc/self/environ` would redirect
 * a verifier read into whatever *this service* can open — including its own
 * environment, which the drop to uid 1001 deliberately made unreadable to the
 * shells it hosts — and a lab reset would write the baseline *through* the
 * link, outside the session, with the service's identity. So every read
 * resolves the link and re-checks containment, and every write refuses to
 * follow one. See `realWorkspacePath` and `seed`.
 */
import { createHmac } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
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
 * Resolve a relative path inside a workspace directory, as a string.
 *
 * Rejects absolute paths and `..` before resolving, then re-checks the resolved
 * result — so no crafted string can name a path outside the session's own
 * directory. It is pure path arithmetic and touches no filesystem, so it cannot
 * see a symlink: `realWorkspacePath` is what proves where a path really leads,
 * and every read goes through it.
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

/**
 * Where a workspace path really leads, proven to be inside the session's own
 * directory after every symlink in it has been resolved.
 *
 * `null` when the file — or a directory on the way to it — does not exist,
 * which every caller here already treats as "no such file". A path that exists
 * and resolves *outside* the workspace is a refusal, not an absence: it is the
 * one case a student can arrange deliberately.
 *
 * The workspace root itself is resolved too, so a deployment whose
 * `TERMINAL_WORKSPACE_ROOT` sits under a symlinked parent (`/home` on a
 * container image that links it elsewhere) is compared like with like rather
 * than refusing every read.
 */
async function realWorkspacePath(dir: string, relative: string): Promise<string | null> {
  const target = resolveWorkspaceFile(dir, relative);

  const resolveOrNull = async (candidate: string): Promise<string | null> => {
    try {
      return await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
  };

  const root = await resolveOrNull(dir);
  if (root === null) return null;
  const real = await resolveOrNull(target);
  if (real === null) return null;

  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new WorkspacePathError('resolves outside the session workspace');
  }
  return real;
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
   * Two modes, because two different things call it:
   *
   *   - `restore` (the lab's Reset, `/internal/workspace/seed`): every
   *     baseline file is written back over whatever the student made of it.
   *     Idempotent, and discarding their edits is the point.
   *   - `fill` (every terminal attach): only files that are missing are
   *     created. An attach is a page reload, a second tab, an automatic
   *     reconnect after a network blip — and it used to restore, so each of
   *     those silently put back the baseline Dockerfile the student had spent
   *     the lab editing, and Check then graded the baseline. Nothing the
   *     student left at a baseline path — an edited file, a directory, a
   *     read-only file — stops the shell from opening.
   */
  async seed(
    sessionId: string,
    files: readonly WorkspaceFileSpec[],
    mode: 'restore' | 'fill' = 'restore',
  ): Promise<string> {
    const dir = this.dirFor(sessionId);
    // 0711 on the root: a shell can enter its own workspace by name but cannot
    // list the root to discover anyone else's.
    await mkdir(this.options.root, { recursive: true, mode: 0o711 });
    await mkdir(dir, { recursive: true, mode: 0o700 });

    for (const file of files) {
      const target = resolveWorkspaceFile(dir, file.path);
      if (mode === 'fill') {
        await fillBaselineFile(dir, target, file.content);
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeBaselineFile(dir, target, file.content);
    }
    return dir;
  }

  /**
   * Read one file from a session's workspace, or `null` when absent.
   *
   * The path is resolved through its symlinks first, so a link the student
   * planted cannot turn a read of their own workspace into a read of a file
   * only this service can open.
   */
  async read(sessionId: string, relative: string): Promise<string | null> {
    const target = await realWorkspacePath(this.dirFor(sessionId), relative);
    if (target === null) return null;

    /*
     * Opened once, and only what was opened is read.
     *
     * The student's shell writes this directory, so what sits at the path is
     * theirs to choose, and this process serves every student's terminal. A
     * whole-file `readFile` of a 150 MiB file they made by accident (a
     * `docker save` into the workspace) held several times that in this
     * process — the container is capped at 512 MiB — before cutting it to
     * 256 KiB; and a FIFO at the path blocked a libuv worker for good (four of
     * them stall every file operation here, every student's credentials
     * included). So: `O_NONBLOCK`, so opening a FIFO cannot wait for a writer;
     * `O_NOFOLLOW`, so the final component cannot have become a link since
     * `realWorkspacePath` looked; a regular file only; and at most the cap.
     */
    let handle;
    try {
      handle = await open(target, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENXIO') return null;
      // Replaced by a link after the realpath check.
      if (code === 'ELOOP' || code === 'EMLINK') throw new WorkspacePathError('resolves outside the session workspace');
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) return null;
      // Truncate rather than refuse: a student who accidentally created a huge
      // file should still get a useful answer about its first lines.
      const buffer = Buffer.alloc(MAX_WORKSPACE_FILE_BYTES);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  /** Remove a session's workspace. Safe to call twice. */
  async destroy(sessionId: string): Promise<void> {
    const dir = this.dirFor(sessionId);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `O_NOFOLLOW` where the platform has it, and 0 where it does not.
 *
 * Every platform this service is deployed on is POSIX; the fallback keeps a
 * developer machine without the flag from turning every seed into `NaN` flags,
 * which `open` would reject outright.
 */
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** `O_NONBLOCK` where the platform has it: opening a FIFO for reading then never waits. */
const NON_BLOCK = fsConstants.O_NONBLOCK ?? 0;

/**
 * Create one baseline file only if nothing is at its path yet.
 *
 * `O_EXCL` is the whole decision: whatever the student left there — their
 * edited file, a link, a directory — makes the open fail with EEXIST and is
 * left exactly as it is (`O_EXCL` never follows a final symlink). A parent
 * the student replaced with a file is theirs too: nothing is created under
 * it. Any other failure is a real one and propagates.
 */
async function fillBaselineFile(dir: string, target: string, content: string): Promise<void> {
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') return;
    throw error;
  }
  const root = await realpath(dir);
  const parent = await realpath(path.dirname(target));
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new WorkspacePathError('resolves outside the session workspace');
  }

  let handle;
  try {
    handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Write one baseline file, never through a symlink.
 *
 * `O_NOFOLLOW` is the whole guarantee: the kernel refuses to open the final
 * component if it is a link, so no race can make this write land outside the
 * workspace. The directory on the way there is checked separately, because
 * `O_NOFOLLOW` says nothing about the components before the last one.
 *
 * A link found in the way is removed and the baseline written in its place
 * rather than refused. Seeding means "restore what the lab declares", and a
 * student who plants a link at that path has broken their own reset, not
 * anyone else's — `unlink` removes the link, never what it points at.
 */
async function writeBaselineFile(dir: string, target: string, content: string): Promise<void> {
  // The directory really holding the file, after its own symlinks. `seed`
  // created both, so a failure here is a genuine problem rather than absence.
  const root = await realpath(dir);
  const parent = await realpath(path.dirname(target));
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new WorkspacePathError('resolves outside the session workspace');
  }

  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NO_FOLLOW;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(target, flags, 0o644);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt > 0) throw error;
      // ELOOP on Linux, EMLINK on some BSDs: the final component is a symlink.
      const isLink = code === 'ELOOP' || code === 'EMLINK';
      /*
       * Something the student made that cannot be written over: a file they
       * made read-only (`chmod 444 Dockerfile` — this service runs as their
       * uid, without CAP_DAC_OVERRIDE), or a directory at the baseline path.
       * Reset failed on it, the session went DEGRADED, and every further
       * Reset failed the same way until End. Removed, like a planted link:
       * the parent is inside this workspace (checked above), and `rm` removes
       * a link rather than following it.
       */
      const isInTheWay = code === 'EACCES' || code === 'EPERM' || code === 'EISDIR';
      if (!isLink && !isInTheWay) throw error;
      const planted = await lstat(target).catch(() => null);
      if (!planted) throw error;
      if (isLink && !planted.isSymbolicLink()) throw error;
      await rm(target, { force: true, recursive: planted.isDirectory() });
      continue;
    }
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    return;
  }
}
