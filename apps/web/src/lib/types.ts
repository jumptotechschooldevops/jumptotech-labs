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

/**
 * Whether the backend behind a lab or a track can actually run it here.
 *
 * The catalog states this rather than inferring it: a missing sandbox image, a
 * stopped container runtime and a provider that is architecture-only all arrive
 * as `available: false` with a real reason, so the UI never offers a Start Lab
 * button that was always going to fail.
 */
export interface ProviderAvailability {
  available: boolean;
  reason?: string;
  remediation?: string;
}

export interface ProviderReadiness extends ProviderAvailability {
  provider: string;
}

export interface LabSummary {
  id: string;
  slug: string;
  title: string;
  track: string;
  /** Which sandbox backend the lab needs. Lab metadata, never a UI decision. */
  provider: string;
  availability?: ProviderAvailability;
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
  /** The providers this track's labs declare. */
  providers?: string[];
  availability?: ProviderAvailability;
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
  /** Whether this lab's provider can run it on this deployment. */
  availability?: ProviderAvailability;
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

export type SandboxKind = 'namespace' | 'container' | 'cloud-session' | 'none';

export interface EnvironmentInfo {
  environmentId: string;
  /** Implementation name, e.g. `kind`, `docker-linux`. */
  provider: string;
  providerId?: string;
  phase: 'not_created' | 'provisioning' | 'ready' | 'degraded' | 'error';
  /** The sandbox handle: namespace name, container name, … */
  sandboxRef?: string;
  sandboxKind?: SandboxKind;
  namespace: string;
  sessionId?: string;
  kubernetesVersion?: string;
  nodes?: NodeInfo[];
  image?: string;
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
  /** Which sandbox backend runs this session. */
  provider: string;
  sandboxKind: SandboxKind;
  /**
   * The sandbox's handle. Shown only as a developer detail: no endpoint accepts
   * one as input, so possessing it grants nothing.
   */
  sandboxRef: string;
  /** Kubernetes namespace. Served only for Kubernetes sessions. */
  namespace?: string;
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
  sandboxRef?: string;
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
  /**
   * True when the reset replaced the sandbox itself.
   *
   * Container-backed providers reset by rebuilding the container, which ends
   * the shell attached to the old one; the terminal reconnects to the new
   * sandbox rather than sitting there dead.
   */
  reconnectTerminal?: boolean;
}

export interface EndLabResponse {
  message: string;
  session: SessionInfo;
  steps: ProvisionStep[];
}
