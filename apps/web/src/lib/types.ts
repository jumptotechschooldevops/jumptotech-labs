/** Mirrors the structured JSON envelope produced by apps/api. */

export interface ApiError {
  code: string;
  message: string;
  remediation?: string;
  details?: unknown;
}

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface PrerequisiteSummary {
  id: string;
  title: string;
  available: boolean;
}

export interface LabSummary {
  id: string;
  slug: string;
  title: string;
  track: string;
  topic: string;
  topicTitle: string;
  difficulty: string;
  level: string;
  durationMinutes: number;
  order: number;
  summary: string;
  skills: string[];
  hasSetup: boolean;
  certifications: string[];
  prerequisites: PrerequisiteSummary[];
  /** How many progressive hints exist. The hint text is not in the catalog. */
  hintCount: number;
}

export interface TrackSummary {
  track: string;
  title: string;
  labCount: number;
  topics: Array<{ topic: string; title: string; labCount: number }>;
  difficulties: string[];
}

export interface DocumentationLink {
  title: string;
  url: string;
}

export interface LabHint {
  level: number;
  text: string;
}

export interface LabCertification {
  certification: string;
  domains: string[];
}

export interface LabDetail {
  id: string;
  slug: string;
  title: string;
  track: string;
  topic: string;
  topicTitle: string;
  difficulty: string;
  level: string;
  durationMinutes: number;
  environment: { provider: string; isolation: string };
  /** The realistic scenario the lab is set in. Optional in the schema. */
  story?: string;
  objectives: string[];
  task: { summary: string; description: string };
  /**
   * Student-facing checklist labels only.
   *
   * The API deliberately does not serve the requirement objects themselves —
   * their expected values are the solution.
   */
  requirements: string[];
  hints: LabHint[];
  references: DocumentationLink[];
  skills: string[];
  certifications: LabCertification[];
  prerequisites: PrerequisiteSummary[];
  /** False in PLATFORM-003: prerequisites are guidance, not a gate. */
  prerequisitesEnforced: boolean;
  hasSetup: boolean;
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
  sessionId?: string;
  /** One line describing the environment, written by whichever provider made it. */
  summary?: string;
  kubernetesVersion?: string;
  nodes?: NodeInfo[];
  message?: string;
}

/**
 * The session lifecycle, mirrored from the orchestrator.
 *
 * Explicit states, never an `active: true` boolean — the UI has to distinguish
 * "still provisioning" from "being torn down" from "gone", and a boolean
 * cannot.
 */
export type SessionStatus =
  | 'CREATING'
  | 'ACTIVE'
  | 'RESETTING'
  | 'EXPIRING'
  | 'EXPIRED'
  | 'ENDING'
  | 'ENDED'
  | 'FAILED';

export interface SessionInfo {
  sessionId: string;
  labId: string;
  status: SessionStatus;
  /** Shown only in the developer panel; it is not a student-facing concept. */
  namespace: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  endedAt?: string;
  statusReason?: string;
  /** Seconds until the absolute deadline. Activity never raises this. */
  secondsRemaining: number;
  /** Seconds until the idle deadline. "Continue Lab" resets this. */
  secondsUntilIdle: number;
  idleWarning: boolean;
  idleTimeoutSeconds: number;
  warningSeconds: number;
}

export interface StartLabResponse {
  session: SessionInfo;
  environment: EnvironmentInfo;
  steps: ProvisionStep[];
  terminal: { url: string; token: string };
}

export interface SessionStatusResponse {
  session: SessionInfo;
  environment: EnvironmentInfo | null;
}

export interface CheckResult {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
}

export interface VerificationResult {
  labId: string;
  namespace: string;
  passed: boolean;
  summary: 'LAB PASSED' | 'LAB NOT COMPLETE';
  checks: CheckResult[];
  checkedAt: string;
  session?: SessionInfo;
}

export interface ResetResponse {
  message: string;
  removed: string[];
  restored: string[];
  steps: ProvisionStep[];
  environment: EnvironmentInfo;
  session: SessionInfo;
  clearTerminal: boolean;
}

export interface EndLabResponse {
  message: string;
  session: SessionInfo;
  steps: ProvisionStep[];
}
