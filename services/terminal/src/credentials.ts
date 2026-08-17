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

export interface SshCredentialsResponse {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  workdir?: string;
}

export interface StudentCredentialsResponse {
  kubeconfig: string;
  namespace: string;
  serviceAccountName: string;
  expiresAt: string;
  /**
   * How to attach a student to this sandbox.
   *
   * `local` — spawn a shell in this container with the kubeconfig above.
   * `ssh`   — open a session on the sandbox's own control node.
   *
   * Absent means `local`, which is what every Kubernetes lab used before the
   * Ansible track existed and what they still use.
   */
  shell?: 'local' | 'ssh';
  ssh?: SshCredentialsResponse;
}

/** Which attachment mode a credential response describes. */
export function credentialMode(credentials: StudentCredentialsResponse): 'local' | 'ssh' {
  return credentials.shell === 'ssh' ? 'ssh' : 'local';
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

  const data = body.data;
  if (credentialMode(data) === 'ssh') {
    const ssh = data.ssh;
    if (
      !ssh ||
      typeof ssh.privateKey !== 'string' ||
      ssh.privateKey.length === 0 ||
      typeof ssh.host !== 'string' ||
      !Number.isInteger(ssh.port) ||
      typeof ssh.user !== 'string'
    ) {
      throw new CredentialsUnavailableError(
        'CREDENTIALS_UNAVAILABLE',
        'The lab API returned incomplete SSH credentials.',
      );
    }
    return data;
  }

  if (typeof data.kubeconfig !== 'string' || data.kubeconfig.length === 0) {
    throw new CredentialsUnavailableError(
      'CREDENTIALS_UNAVAILABLE',
      'The lab API returned an empty kubeconfig.',
    );
  }
  return data;
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

/**
 * Write a session's SSH private key and return its path.
 *
 * Same handling rules as a kubeconfig, and one extra that OpenSSH enforces for
 * us: a key file readable by anyone else is refused by `ssh` outright, so 0600
 * is not merely good practice here — it is the only mode that works.
 */
export async function writeSessionPrivateKey(
  dir: string,
  sessionId: string,
  privateKey: string,
): Promise<string> {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (safe.length === 0) throw new Error('refusing to write credentials for an unnamed session');

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safe}.key`);
  await writeFile(file, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
  return file;
}

/** Remove a session's private key. Safe to call twice. */
export const removeSessionPrivateKey = removeSessionKubeconfig;
