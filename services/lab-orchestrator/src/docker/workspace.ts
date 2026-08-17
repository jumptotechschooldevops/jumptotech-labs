/**
 * The session workspace — where a student authors files.
 *
 * A Docker lab sometimes asks the student to *write* something (a Dockerfile,
 * an env file) and then use it. That file has to live where the student's shell
 * can edit it and where `docker build` can pick it up as a build context, which
 * is the terminal service's container — not the sandbox, and not the API.
 *
 * ```text
 *   student shell ──edits──► /workspace/<session>/Dockerfile   (terminal svc)
 *        │                        ▲
 *        │ docker build .         │ read-only, authenticated
 *        ▼                        │
 *   session daemon           verifier (API)
 * ```
 *
 * This port is the seam. The API's implementation calls the terminal service's
 * internal endpoint; tests use an in-memory one. Nothing in the provider or the
 * verifier knows which is in play.
 *
 * **Why the verifier reads files at all.** `file_exists` and `dockerfile_valid`
 * are reads, and only reads. The platform never executes, sources, or evaluates
 * a workspace file — the student's own `docker build` is what proves their
 * Dockerfile works, and the resulting image is what gets graded.
 */

/** A file the lab seeds into the workspace before the student starts. */
export interface WorkspaceFile {
  /** Relative path inside the session workspace. Validated by the schema. */
  path: string;
  content: string;
}

export class WorkspaceUnavailableError extends Error {
  readonly code = 'WORKSPACE_UNAVAILABLE';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WorkspaceUnavailableError';
  }
}

export interface WorkspacePort {
  /**
   * Create the session's workspace and write its baseline files.
   *
   * Idempotent: called at session start and again on every reset, and it must
   * leave the same result either way.
   */
  seed(sessionId: string, files: readonly WorkspaceFile[]): Promise<void>;

  /**
   * Read one file. Returns `null` when it does not exist.
   *
   * Implementations must confine the read to the named session's own workspace
   * and must cap the size they will return.
   */
  read(sessionId: string, path: string): Promise<string | null>;

  /** Remove the session's workspace entirely. Safe to call twice. */
  destroy(sessionId: string): Promise<void>;
}

/**
 * A workspace held in this process. Used by tests and by any deployment where
 * the terminal service is not reachable.
 *
 * Deliberately not the production implementation: a real student shell writes
 * to a filesystem, not to a map in the API's heap.
 */
export class InMemoryWorkspace implements WorkspacePort {
  readonly #files = new Map<string, Map<string, string>>();

  async seed(sessionId: string, files: readonly WorkspaceFile[]): Promise<void> {
    const bucket = new Map<string, string>();
    for (const file of files) bucket.set(normalise(file.path), file.content);
    this.#files.set(sessionId, bucket);
  }

  async read(sessionId: string, path: string): Promise<string | null> {
    return this.#files.get(sessionId)?.get(normalise(path)) ?? null;
  }

  async destroy(sessionId: string): Promise<void> {
    this.#files.delete(sessionId);
  }

  /** Test hook: pretend the student wrote a file. */
  write(sessionId: string, path: string, content: string): void {
    const bucket = this.#files.get(sessionId) ?? new Map<string, string>();
    bucket.set(normalise(path), content);
    this.#files.set(sessionId, bucket);
  }
}

/** `./Dockerfile` and `Dockerfile` name the same file. */
function normalise(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** A workspace that holds nothing, for tracks that do not use one. */
export const noopWorkspace: WorkspacePort = {
  async seed() {
    /* nothing to seed */
  },
  async read() {
    return null;
  },
  async destroy() {
    /* nothing to remove */
  },
};
