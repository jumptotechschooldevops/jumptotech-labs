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

export interface TopicSummary {
  topic: string;
  title: string;
  labCount: number;
}

export interface TrackSummary {
  track: string;
  title: string;
  /** One-line description from `labs/<track>/track.yaml`, when present. */
  tagline?: string;
  labCount: number;
  topics: TopicSummary[];
  difficulties: string[];
  /** The providers this track's labs declare. */
  providers?: string[];
  availability?: ProviderAvailability;
  /** Catalog sort position. Tracks without one sort last, alphabetically. */
  order?: number;
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
  /** What that handle names. Lets the UI label it honestly per track. */
  isolation?: 'namespace' | 'container';
  sessionId?: string;
  kubernetesVersion?: string;
  nodes?: NodeInfo[];
  /** Container-backed sessions: the sandbox image, and the OS it reports. */
  image?: string;
  osRelease?: string;
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
  | 'DEGRADED'
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

// --- persistent learning history (PLATFORM-005) ------------------------------

/**
 * Who the API attributed this request to.
 *
 * `authenticated` is always false today and is shown to the student rather than
 * hidden: there is no login yet, and the UI says so instead of implying one.
 * `durable` is false when the deployment is running without a database, which
 * means the history on screen will not survive a restart.
 */
export interface StudentIdentity {
  studentId: string;
  authenticated: boolean;
  identitySource: string;
  durable: boolean;
}

/** A lab's standing for this student. Never a boolean. */
export type LabProgressStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

/**
 * The lifecycle of one attempt.
 *
 * `PASSED` outranks the sandbox: an attempt that passed and was then ended or
 * expired is still PASSED, and carries both timestamps.
 */
export type AttemptStatus = 'IN_PROGRESS' | 'PASSED' | 'FAILED' | 'ENDED' | 'EXPIRED';

export interface LabProgressEntry {
  labId: string;
  title: string;
  status: LabProgressStatus;
  attemptCount: number;
  completionCount: number;
  /** When the lab was first completed. */
  completedAt: string | null;
  lastCompletedAt: string | null;
}

export interface TrackProgress {
  track: string;
  title: string;
  total: number;
  completed: number;
  inProgress: number;
  notStarted: number;
  percent: number;
  labs: LabProgressEntry[];
}

export interface ProgressSnapshot {
  student: StudentIdentity;
  overall: {
    total: number;
    completed: number;
    inProgress: number;
    notStarted: number;
    percent: number;
  };
  tracks: TrackProgress[];
}

/**
 * One attempt at one lab.
 *
 * There is deliberately no session id here: the API does not serve one, because
 * possessing a session id is what authorises acting on a sandbox.
 */
export interface AttemptSummary {
  attemptId: string;
  labId: string;
  labTitle: string;
  track: string;
  status: AttemptStatus;
  statusReason?: string;
  startedAt: string;
  /** When the verifier first returned PASS. */
  completedAt: string | null;
  /** When the sandbox went away. Independent of `completedAt`. */
  endedAt: string | null;
  checkCount: number;
  resetCount: number;
}

export interface AttemptDetail extends AttemptSummary {
  hints: Array<{ level: number; revealedAt: string }>;
  hintsUsed: number;
}

/** The reply to reporting a revealed hint. Idempotent per (attempt, level). */
export interface HintRecordResponse {
  /** False when this hint was already recorded — a replay, not a new reveal. */
  recorded: boolean;
  /** False when there was nothing to record against, or the store is down. */
  persisted: boolean;
  hint?: { level: number; revealedAt: string };
  revealedCount: number | null;
}

/** Where the terminal service is, and a token for one session. Held in memory only. */
export interface TerminalGrant {
  url: string;
  token: string;
}

export interface StartLabResponse {
  session: SessionInfo;
  /** Absent when the progress store could not record the attempt. */
  attempt?: AttemptSummary;
  environment: EnvironmentInfo;
  steps: ProvisionStep[];
  terminal: TerminalGrant;
}

/** One of the caller's own live sessions, from `GET /api/sessions`. */
export interface ActiveSessionEntry {
  session: SessionInfo;
  labTitle: string;
  attempt?: AttemptSummary;
}

export interface MySessionsResponse {
  sessions: ActiveSessionEntry[];
  count: number;
  /** The caller's own quota. `null` when the deployment sets none. */
  limits: { maxActiveSessionsPerStudent: number | null };
}

/** `POST /api/sessions/:id/terminal` — a fresh token for a session the caller owns. */
export interface TerminalGrantResponse {
  session: SessionInfo;
  terminal: TerminalGrant;
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
  /** The persisted attempt, absent when nothing could be recorded. */
  attempt?: AttemptSummary;
  /** True only for the check that first completed this attempt. */
  newlyCompleted?: boolean;
}

export interface ResetResponse {
  message: string;
  /** Reset increments `resetCount`; it never withdraws a completion. */
  attempt?: AttemptSummary;
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
  /** The attempt as it was closed. A passed attempt stays PASSED. */
  attempt?: AttemptSummary;
  steps: ProvisionStep[];
}

// --- learning paths (V1 EPIC-02) ----------------------------------------------

/**
 * `required`: the stage waits on this one, and the next-lab rule will not start
 * it early. `recommended`: advice. Neither stops a student opening a lab.
 */
export type PrerequisiteKind = 'required' | 'recommended';

export interface LearningPathTotals {
  stages: number;
  /** Stages with no labs yet — curriculum gaps, never counted as done. */
  comingSoonStages: number;
  labs: number;
  coreLabs: number;
  skills: number;
  /** Skills no lab in the path covers yet. */
  gapSkills: number;
  /** Sums of the labs' own estimated durations. */
  estimatedMinutes: { core: number; all: number };
}

export interface LearningPathSummary {
  id: string;
  title: string;
  summary: string;
  audience: string;
  totals: LearningPathTotals;
}

export interface LearningPathSkill {
  id: string;
  title: string;
  description: string;
  /** Labs anywhere in the path that practise this skill. Empty means Coming soon. */
  labIds: string[];
}

export interface LearningPathLab {
  labId: string;
  title: string;
  summary: string;
  track: string;
  trackTitle: string;
  difficulty: string;
  durationMinutes: number;
  /** Extra practice: not needed to complete the stage. */
  optional: boolean;
  /** Why this lab is at this point of the path. */
  why: string;
  skills: string[];
  prerequisites: Array<{ id: string; title: string }>;
  availability: { available: boolean };
}

export interface LearningStage {
  id: string;
  /** 1-based. */
  position: number;
  title: string;
  summary: string;
  why: string;
  objectives: string[];
  /** What is missing from this stage, when something is. */
  comingSoon?: string;
  prerequisites: Array<{ stageId: string; title: string; kind: PrerequisiteKind }>;
  estimatedMinutes: { core: number; all: number };
  skills: LearningPathSkill[];
  /** In recommended order. */
  labs: LearningPathLab[];
}

export interface LearningPathDetail extends LearningPathSummary {
  outcomes: string[];
  stages: LearningStage[];
}

export type StageStatus = 'COMING_SOON' | 'LOCKED' | 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export type SkillStatus = 'COMING_SOON' | 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

export type RecommendationKind =
  | 'RESUME_ACTIVE'
  | 'ACTIVE_SESSION_UNKNOWN'
  | 'CONTINUE_ATTEMPT'
  | 'PREREQUISITE_FIRST'
  | 'START_STAGE'
  | 'NEXT_IN_STAGE'
  | 'EXTRA_PRACTICE'
  | 'PATH_COMPLETE'
  | 'NONE_AVAILABLE';

/** The server's deterministic answer to "what should I do next?". */
export interface LearningRecommendation {
  kind: RecommendationKind;
  labId?: string;
  labTitle?: string;
  stageId?: string;
  reason: string;
}

export interface StageProgressEntry {
  stageId: string;
  status: StageStatus;
  prerequisitesMet: boolean;
  prerequisites: Array<{ stageId: string; kind: PrerequisiteKind; met: boolean }>;
  labs: { total: number; completed: number; inProgress: number };
  /** Completed only when every core lab passed Verify. */
  core: { total: number; completed: number };
  nextLabId: string | null;
}

export interface SkillProgressEntry {
  skillId: string;
  status: SkillStatus;
  labs: { total: number; completed: number };
}

export interface LearningPathProgress {
  student: StudentIdentity;
  pathId: string;
  overall: {
    labs: { total: number; completed: number; inProgress: number; notStarted: number };
    core: { total: number; completed: number };
    stages: { total: number; completed: number; comingSoon: number };
    skills: { total: number; completed: number; comingSoon: number };
  };
  currentStageId: string | null;
  stages: StageProgressEntry[];
  skills: SkillProgressEntry[];
  labs: Array<{ labId: string; status: LabProgressStatus }>;
  recommendation: LearningRecommendation;
}
