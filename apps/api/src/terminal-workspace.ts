/**
 * `WorkspacePort` implemented over the terminal service's internal API.
 *
 * A Docker student's authored files live in the terminal container, because
 * that is where their shell runs and where `docker build` reads its context.
 * The verifier runs here, in the API. Rather than share a filesystem between
 * the two services — which would put every session's files on one mount — the
 * API asks the terminal service for one named file at a time.
 *
 * ```text
 *   verifier ──sid + relative path + service secret──► terminal svc
 *            ◄──────── file contents, size-capped ────
 * ```
 *
 * The terminal service resolves that path inside the named session's own
 * workspace and refuses anything that escapes it, so the API cannot name
 * another session's file even if it tried.
 *
 * Failures are surfaced, not swallowed: a check that cannot read the workspace
 * must say so rather than quietly report "the file is missing" and tell a
 * student their correct work is wrong.
 */
import {
  WorkspaceUnavailableError,
  type WorkspaceFile,
  type WorkspacePort,
} from '@jumptotech/lab-orchestrator';

export interface HttpWorkspaceOptions {
  /** Base URL of the terminal service, e.g. `http://terminal:4001`. */
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
}

interface InternalReply<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

export class HttpTerminalWorkspace implements WorkspacePort {
  constructor(private readonly options: HttpWorkspaceOptions) {}

  async #post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': this.options.secret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new WorkspaceUnavailableError(
        `Could not reach the terminal service to read the lab workspace: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => null)) as InternalReply<T> | null;
    if (!response.ok || !payload?.ok) {
      throw new WorkspaceUnavailableError(
        payload?.error?.message ?? `The terminal service replied ${response.status}.`,
      );
    }
    return payload.data as T;
  }

  async seed(sessionId: string, files: readonly WorkspaceFile[]): Promise<void> {
    await this.#post('/internal/workspace/seed', { sessionId, files });
  }

  async read(sessionId: string, path: string): Promise<string | null> {
    const data = await this.#post<{ exists: boolean; content: string | null }>(
      '/internal/workspace/read',
      { sessionId, path },
    );
    return data.exists ? (data.content ?? '') : null;
  }

  async destroy(sessionId: string): Promise<void> {
    // Teardown must never be blocked by an unreachable terminal service: the
    // workspace lives in a container that is itself disposable, so a failure
    // here leaks nothing that outlives the service.
    await this.#post('/internal/workspace/destroy', { sessionId }).catch(() => undefined);
  }
}
