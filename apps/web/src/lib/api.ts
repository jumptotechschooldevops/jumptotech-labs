import type {
  ApiEnvelope,
  ApiError,
  LabDetail,
  LabSummary,
  ResetResponse,
  StartLabResponse,
  StatusResponse,
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

export const api = {
  listLabs: () => request<{ labs: LabSummary[]; tracks: string[]; count: number }>('/api/labs'),

  getLab: (id: string) => request<LabDetail>(`/api/labs/${encodeURIComponent(id)}`),

  startLab: (id: string) =>
    request<StartLabResponse>(`/api/labs/${encodeURIComponent(id)}/start`, { method: 'POST' }),

  getStatus: (id: string) => request<StatusResponse>(`/api/labs/${encodeURIComponent(id)}/status`),

  checkSolution: (id: string) =>
    request<VerificationResult>(`/api/labs/${encodeURIComponent(id)}/check`, { method: 'POST' }),

  resetLab: (id: string) =>
    request<ResetResponse>(`/api/labs/${encodeURIComponent(id)}/reset`, { method: 'POST' }),
};

export { API_URL };
