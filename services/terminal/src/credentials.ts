/**
 * Per-session student credentials.
 *
 * The terminal service holds no cluster credential of its own. For each
 * authenticated session it asks the API for a kubeconfig scoped to that
 * session's namespace, writes it to a private file, and points that one PTY's
 * `KUBECONFIG` at it.
 *
 * ```text
 *   auth frame (sid) ──► fetchStudentCredentials(sid)
 *                        └─► POST /internal/sessions/:sid/credentials
 *                            └─► kubeconfig: 1 cluster, 1 SA token, 1 namespace
 * ```
 *
 * Handling rules, all enforced here:
 *   - the file is created 0600 and lives in a directory the process owns;
 *   - it is deleted when the session ends, and on process shutdown;
 *   - the kubeconfig body is never logged, never echoed to the socket, and
 *     never returned to the browser.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What the API hands back for one session.
 *
 * A discriminated union, because the two sandbox kinds give a shell genuinely
 * different things: a Kubernetes session gets a namespace-scoped kubeconfig; a
 * workspace session gets a directory and *no cluster credential at all*.
 * Branching on `kind` is the only place the terminal service distinguishes
 * them — there is no lab id, track, or provider name in this service.
 */
export type StudentCredentialsResponse =
  | KubeconfigCredentialsResponse
  | WorkspaceCredentialsResponse;

export interface KubeconfigCredentialsResponse {
  kind: 'kubeconfig';
  kubeconfig: string;
  namespace: string;
  serviceAccountName: string;
  expiresAt: string;
}

export interface WorkspaceCredentialsResponse {
  kind: 'workspace';
  namespace: string;
  /** Absolute path of this session's private workspace. */
  workspacePath: string;
  /** Extra shell environment. Contains no secret, by construction. */
  environment: Record<string, string>;
  expiresAt: string;
}

export class CredentialsUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialsUnavailableError';
  }
}

export interface FetchOptions {
  apiInternalUrl: string;
  secret: string;
  sessionId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Exchange a session id for that session's namespace-scoped kubeconfig. */
export async function fetchStudentCredentials(
  options: FetchOptions,
): Promise<StudentCredentialsResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  let response: Response;
  try {
    response = await doFetch(
      `${options.apiInternalUrl.replace(/\/$/, '')}/internal/sessions/${encodeURIComponent(options.sessionId)}/credentials`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': options.secret },
        signal: controller.signal,
      },
    );
  } catch (error) {
    throw new CredentialsUnavailableError(
      'CREDENTIALS_UNAVAILABLE',
      `Could not reach the lab API to obtain session credentials: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: StudentCredentialsResponse; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || !body?.ok || !body.data) {
    throw new CredentialsUnavailableError(
      body?.error?.code ?? 'CREDENTIALS_UNAVAILABLE',
      body?.error?.message ?? `The lab API rejected the credential request (${response.status}).`,
    );
  }

  return assertUsableCredentials(body.data);
}

/**
 * Refuse anything that would produce a half-configured shell.
 *
 * The API is trusted, but a shape mismatch after a deploy skew must fail loudly
 * here rather than spawning a PTY with no credential and no explanation. The
 * workspace path is additionally required to be absolute and to end in the
 * session's own sandbox name, so a malformed response can never point a shell
 * at an arbitrary directory.
 */
export function assertUsableCredentials(data: StudentCredentialsResponse): StudentCredentialsResponse {
  if (data?.kind === 'kubeconfig') {
    if (typeof data.kubeconfig !== 'string' || data.kubeconfig.length === 0) {
      throw new CredentialsUnavailableError(
        'CREDENTIALS_UNAVAILABLE',
        'The lab API returned an empty kubeconfig.',
      );
    }
    return data;
  }

  if (data?.kind === 'workspace') {
    if (typeof data.workspacePath !== 'string' || !data.workspacePath.startsWith('/')) {
      throw new CredentialsUnavailableError(
        'CREDENTIALS_UNAVAILABLE',
        'The lab API returned no workspace path for this session.',
      );
    }
    if (data.workspacePath.includes('..')) {
      throw new CredentialsUnavailableError(
        'CREDENTIALS_UNAVAILABLE',
        'The lab API returned a workspace path containing a parent reference.',
      );
    }
    if (typeof data.namespace !== 'string' || !data.workspacePath.endsWith(`/${data.namespace}`)) {
      throw new CredentialsUnavailableError(
        'CREDENTIALS_UNAVAILABLE',
        "The lab API returned a workspace path that does not belong to this session's sandbox.",
      );
    }
    return data;
  }

  throw new CredentialsUnavailableError(
    'CREDENTIALS_UNAVAILABLE',
    `The lab API returned credentials of an unknown kind ('${String((data as { kind?: unknown })?.kind)}').`,
  );
}

/**
 * Write a kubeconfig for one session and return its path.
 *
 * The filename is derived from the session id, which is already constrained to
 * `sess-<hex>` by the API; it is re-sanitised here anyway so that no value
 * arriving over the network can ever shape a path.
 */
export async function writeSessionKubeconfig(
  dir: string,
  sessionId: string,
  kubeconfig: string,
): Promise<string> {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (safe.length === 0) throw new Error('refusing to write credentials for an unnamed session');

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safe}.kubeconfig`);
  await writeFile(file, kubeconfig, { mode: 0o600 });
  return file;
}

/** Remove a session's kubeconfig. Safe to call twice. */
export async function removeSessionKubeconfig(file: string | undefined): Promise<void> {
  if (!file) return;
  await rm(file, { force: true }).catch(() => undefined);
}
