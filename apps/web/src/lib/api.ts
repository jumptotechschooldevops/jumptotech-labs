import type {
  ApiEnvelope,
  ApiError,
  AttemptDetail,
  AttemptSummary,
  EndLabResponse,
  HintRecordResponse,
  ProgressSnapshot,
  StudentIdentity,
  LabDetail,
  LabSummary,
  ProviderReadiness,
  ResetResponse,
  SessionInfo,
  SessionStatusResponse,
  StartLabResponse,
  TrackSummary,
  VerificationResult,
} from './types';
import { announceAuthExpired } from './auth';
import { describeApiTarget, resolveApiBase } from './urls';

const API_URL = resolveApiBase();

/** Thrown for any non-success response, carrying the API's structured error. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      /*
       * Send the session cookie — PLATFORM-010.
       *
       * The cookie is HttpOnly, so this is the *only* way the browser can
       * present it, and there is nothing here to read or attach by hand. The
       * API pairs this with an explicit origin allow-list; a wildcard CORS
       * origin cannot be combined with credentials at all.
       */
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    // Network-level failure: the API is not running or is unreachable.
    throw new ApiRequestError(0, {
      code: 'API_UNREACHABLE',
      message: `Cannot reach ${describeApiTarget()}.`,
      remediation: 'Is the api service running? Try: docker compose ps',
    });
  }

  let body: ApiEnvelope<T>;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiRequestError(response.status, {
      code: 'BAD_RESPONSE',
      message: `The API returned a non-JSON response (HTTP ${response.status}).`,
    });
  }

  if (!body.ok) {
    /*
     * A 401 means the session this browser thought it had is gone — expired,
     * signed out elsewhere, or never real. Announce it once, here, so the auth
     * provider re-queries the server; every caller then gets the same answer
     * instead of each deciding for itself what a 401 meant.
     *
     * The error is still thrown: the call that failed did fail, and the caller
     * has its own error state to render.
     */
    if (response.status === 401) announceAuthExpired();
    throw new ApiRequestError(response.status, body.error);
  }
  return body.data;
}

/**
 * Everything that acts on a running environment is addressed by session id, not
 * by lab id — two students on the same lab have two different sandboxes.
 *
 * The browser never sees, sends, or stores a namespace or a kubeconfig. The
 * session id is the only handle it holds.
 */
const session = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

/** Serialise catalog filters, omitting empty ones. */
function query(filters: LabFilters = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export interface LabFilters {
  track?: string | undefined;
  topic?: string | undefined;
  difficulty?: string | undefined;
  level?: string | undefined;
  q?: string | undefined;
  [key: string]: string | undefined;
}

export const api = {
  listLabs: (filters: LabFilters = {}) =>
    request<{
      labs: LabSummary[];
      tracks: TrackSummary[];
      /** Readiness of every provider, including ones with no labs yet. */
      providers?: ProviderReadiness[];
      count: number;
    }>(`/api/labs${query(filters)}`),

  listTracks: () => request<{ tracks: TrackSummary[]; count: number }>('/api/tracks'),

  listTrackLabs: (trackId: string, filters: LabFilters = {}) =>
    request<{ track: string; labs: LabSummary[]; count: number }>(
      `/api/tracks/${encodeURIComponent(trackId)}/labs${query(filters)}`,
    ),

  getLab: (id: string) => request<LabDetail>(`/api/labs/${encodeURIComponent(id)}`),

  startLab: (id: string) =>
    request<StartLabResponse>(`/api/labs/${encodeURIComponent(id)}/start`, { method: 'POST' }),

  getSession: (sessionId: string) => request<SessionStatusResponse>(session(sessionId)),

  /** Backs "Continue Lab". Moves the idle deadline; never the absolute one. */
  recordActivity: (sessionId: string) =>
    request<{ session: SessionInfo }>(`${session(sessionId)}/activity`, { method: 'POST' }),

  checkSolution: (sessionId: string) =>
    request<VerificationResult>(`${session(sessionId)}/check`, { method: 'POST' }),

  resetLab: (sessionId: string) =>
    request<ResetResponse>(`${session(sessionId)}/reset`, { method: 'POST' }),

  endLab: (sessionId: string) =>
    request<EndLabResponse>(session(sessionId), { method: 'DELETE' }),

  /**
   * Report that a hint was revealed.
   *
   * Addressed by session, like every other write: the browser never names an
   * attempt or a student. Safe to call twice — the server records the same
   * (attempt, level) once and says whether this call was the one that counted.
   */
  recordHint: (sessionId: string, level: number) =>
    request<HintRecordResponse>(`${session(sessionId)}/hints`, {
      method: 'POST',
      body: JSON.stringify({ level }),
    }),

  /*
   * Learning history (PLATFORM-005).
   *
   * `me`, never `/students/:id` — there is no authentication yet, and a client
   * that could name a student would be fake security. The server decides who
   * the caller is.
   */
  getIdentity: () => request<{ student: StudentIdentity; notice?: string }>('/api/me'),

  getProgress: () => request<ProgressSnapshot>('/api/me/progress'),

  listAttempts: (limit?: number) =>
    request<{ student: StudentIdentity; attempts: AttemptSummary[]; count: number }>(
      `/api/me/attempts${limit ? `?limit=${limit}` : ''}`,
    ),

  getAttempt: (attemptId: string) =>
    request<{ student: StudentIdentity; attempt: AttemptDetail }>(
      `/api/me/attempts/${encodeURIComponent(attemptId)}`,
    ),
};

export { API_URL };
