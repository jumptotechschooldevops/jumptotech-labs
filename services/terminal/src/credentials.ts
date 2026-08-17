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
 * The terminal binding the API hands back for one session.
 *
 * A closed union, re-validated here rather than trusted. Crucially it carries
 * **no command line**: the `container-exec` variant names a container, a user
 * and a working directory, and this service builds the argv itself. There is
 * no field anywhere in this shape that can become "run this string".
 */
export type TerminalContextResponse =
  | {
      kind?: 'kubernetes';
      kubeconfig: string;
      namespace: string;
      serviceAccountName: string;
      expiresAt: string;
      env?: Record<string, string>;
    }
  | {
      kind: 'container-exec';
      runtime: string;
      containerRef: string;
      user: string;
      workdir: string;
      env?: Record<string, string>;
      expiresAt: string;
    };

/** Kubernetes variant, kept under its historical name for existing callers. */
export interface StudentCredentialsResponse {
  kubeconfig: string;
  namespace: string;
  serviceAccountName: string;
  expiresAt: string;
}

export interface LinuxCredentialsResponse {
  kind: 'linux';
  sandboxId: string;
  namespace: string;
  shellUser: string;
  workDir: string;
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

/**
 * Exchange a session id for that session's terminal binding.
 *
 * The session id comes from the signed token and from nowhere else, so this is
 * the point at which "which sandbox does this socket get?" is answered — by the
 * API, from the session record, and never by the browser.
 */
export async function fetchTerminalContext(
  options: FetchOptions,
): Promise<TerminalContextResponse> {
  const data = await fetchInternal(options);

  if (data.kind === 'container-exec') {
    const container = data as Extract<TerminalContextResponse, { kind: 'container-exec' }>;
    if (typeof container.containerRef !== 'string' || container.containerRef.length === 0) {
      throw new CredentialsUnavailableError(
        'CREDENTIALS_UNAVAILABLE',
        'The lab API returned a container terminal context with no container reference.',
      );
    }
    return container;
  }

  const kubernetes = data as Extract<TerminalContextResponse, { kind?: 'kubernetes' }>;
  if (typeof kubernetes.kubeconfig !== 'string' || kubernetes.kubeconfig.length === 0) {
    throw new CredentialsUnavailableError(
      'CREDENTIALS_UNAVAILABLE',
      'The lab API returned an empty kubeconfig.',
    );
  }
  return { ...kubernetes, kind: 'kubernetes' };
}

/** Exchange a session id for that session's namespace-scoped kubeconfig. */
export async function fetchStudentCredentials(
  options: FetchOptions,
): Promise<StudentCredentialsResponse> {
  const context = await fetchTerminalContext(options);
  if (context.kind === 'container-exec') {
    throw new CredentialsUnavailableError(
      'CREDENTIALS_UNAVAILABLE',
      'This session is not backed by a Kubernetes namespace, so it has no kubeconfig.',
    );
  }
  return context;
}

async function fetchInternal(options: FetchOptions): Promise<Record<string, unknown>> {
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
    | {
        ok?: boolean;
        data?: Record<string, unknown>;
        error?: { code?: string; message?: string };
      }
    | null;

  if (!response.ok || !body?.ok || !body.data) {
    throw new CredentialsUnavailableError(
      body?.error?.code ?? 'CREDENTIALS_UNAVAILABLE',
      body?.error?.message ?? `The lab API rejected the credential request (${response.status}).`,
    );
  }
  return body.data;
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
