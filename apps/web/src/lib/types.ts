/** Mirrors the structured JSON envelope produced by apps/api. */

export interface ApiError {
  code: string;
  message: string;
  remediation?: string;
  details?: unknown;
}

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface LabSummary {
  id: string;
  slug: string;
  title: string;
  track: string;
  difficulty: string;
  durationMinutes: number;
  summary: string;
}

export interface DocumentationLink {
  title: string;
  url: string;
}

export interface LabDetail {
  id: string;
  slug: string;
  title: string;
  track: string;
  difficulty: string;
  durationMinutes: number;
  environment: { provider: string; namespace: string };
  task: { summary: string; description: string };
  requirements: string[];
  target: { podName: string; namespace: string; image: string; status: string };
  hint: string;
  documentation: DocumentationLink[];
}

export interface ProvisionStep {
  id: string;
  label: string;
  status: 'pending' | 'ok' | 'failed';
  detail?: string;
  durationMs?: number;
}

export interface NodeInfo {
  name: string;
  ready: boolean;
  roles: string[];
  version: string;
}

export interface EnvironmentInfo {
  environmentId: string;
  provider: string;
  phase: 'not_created' | 'provisioning' | 'ready' | 'degraded' | 'error';
  namespace: string;
  kubernetesVersion?: string;
  nodes?: NodeInfo[];
  message?: string;
}

export interface SessionInfo {
  sessionId: string;
  startedAt: string;
  expiresAt: string;
  durationSeconds: number;
}

export interface StartLabResponse {
  session: SessionInfo;
  environment: EnvironmentInfo;
  steps: ProvisionStep[];
  terminal: { url: string; token: string };
}

export interface StatusResponse {
  environment: EnvironmentInfo;
  session: SessionInfo | null;
}

export interface CheckResult {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
}

export interface VerificationResult {
  labId: string;
  passed: boolean;
  summary: 'LAB PASSED' | 'LAB NOT COMPLETE';
  checks: CheckResult[];
  checkedAt: string;
}

export interface ResetResponse {
  message: string;
  removed: string[];
  steps: ProvisionStep[];
  environment: EnvironmentInfo;
  clearTerminal: boolean;
}
