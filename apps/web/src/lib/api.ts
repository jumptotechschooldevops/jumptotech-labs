import type {
  ApiEnvelope,
  ApiError,
  EndLabResponse,
  LabDetail,
  LabSummary,
  ResetResponse,
  SessionInfo,
  SessionStatusResponse,
  StartLabResponse,
  TrackSummary,
  VerificationResult,
} from './types';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

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
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    // Network-level failure: the API is not running or is unreachable.
    throw new ApiRequestError(0, {
      code: 'API_UNREACHABLE',
      message: `Cannot reach the JumpToTech Labs API at ${API_URL}.`,
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

  if (!body.ok) throw new ApiRequestError(response.status, body.error);
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

export const api = {
  listLabs: () =>
    request<{ labs: LabSummary[]; tracks: TrackSummary[]; count: number }>('/api/labs'),

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
};

export { API_URL };
