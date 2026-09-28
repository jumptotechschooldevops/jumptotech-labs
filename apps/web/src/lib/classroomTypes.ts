/**
 * The classroom view's payloads — `/api/admin/*` (apps/api/src/routes/admin.ts).
 *
 * Everything here is what the server decided an instructor may see: labels,
 * states, codes and times. Nothing is computed from browser memory; a refresh
 * or a second instructor's screen renders the same row from the same answer.
 */

export type Tone = 'ok' | 'progress' | 'attention' | 'problem' | 'done';

export interface StudentRef {
  userId: string;
  name: string;
  email?: string;
}

export interface Attention {
  code: string;
  message: string;
  nextStep: string;
  severity: 'attention' | 'problem';
}

export interface OperationSummary {
  at: string;
  outcome: string;
  code?: string;
  text: string;
}

export interface ClassroomRow {
  sessionId: string;
  student: StudentRef | null;
  lab: { id: string; title: string; track: string };
  provider: string;
  runtime: string;
  status: string;
  state: { label: string; tone: Tone };
  occupiesSlot: boolean;
  startedAt: string;
  statusChangedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  endedAt?: string;
  secondsRemaining: number;
  secondsUntilIdle: number;
  lastCheck: OperationSummary | null;
  lastReset: OperationSummary | null;
  cleanup: 'not-started' | 'in-progress' | 'confirmed' | 'not-needed';
  attention: Attention[];
  /** ADMIN only. */
  operator?: { sandboxRef: string; namespace?: string; statusReason?: string };
}

export interface ClassroomEvent {
  eventId: string;
  at: string;
  operation: string;
  outcome: string;
  code?: string;
  durationMs?: number;
  text: string;
  problem: boolean;
  sessionId?: string;
  lab: { id: string; title: string; track: string };
  student: StudentRef | null;
  by: 'student' | 'staff' | 'platform';
}

export interface ClassroomOverview {
  generatedAt: string;
  viewer: { role: 'INSTRUCTOR' | 'ADMIN'; canEndSessions: boolean; operatorDetail: boolean };
  capacity: { active: number; max: number; available: number; full: boolean; perStudentLimit: number | null };
  newLabs: { verdict: 'yes' | 'degraded' | 'no'; summary: string; reasons: string[]; operatorReasons?: string[] };
  runtimes: Array<{ provider: string; label: string; state: 'available' | 'unavailable' | 'disabled'; detail?: string }>;
  cleanupWorker: { healthy: boolean; lastRunAt: string | null };
  sessions: ClassroomRow[];
  recent: ClassroomRow[];
  problems: ClassroomEvent[];
}

export interface AttemptView {
  attemptId: string;
  labId: string;
  labTitle?: string;
  status: string;
  statusReason?: string | null;
  startedAt: string;
  completedAt?: string | null;
  endedAt?: string | null;
  checkCount: number;
  resetCount: number;
}

export interface SessionDetailResponse {
  sessionId: string;
  tracked: boolean;
  session?: ClassroomRow;
  summary?: { student: StudentRef | null; lab: { id: string; title: string; track: string }; note: string };
  environment: { phase: string; checkedAt: string; reason?: string } | null;
  attempt: AttemptView | null;
  timeline: ClassroomEvent[];
  actions: { canEnd: boolean };
}

export interface StudentSearchResponse {
  query: string;
  limit: number;
  students: Array<{ student: StudentRef; role: string; liveSessions: ClassroomRow[] }>;
}

export interface StudentDetailResponse {
  student: StudentRef;
  role: string;
  liveSessions: ClassroomRow[];
  history: AttemptView[] | null;
  historyLimit: number;
  timeline: ClassroomEvent[];
}

export interface LabAvailabilityResponse {
  count: number;
  labs: Array<{
    id: string;
    title: string;
    track: string;
    provider: string;
    runtime: string;
    runnable: boolean | null;
    availability: string;
    running: number;
  }>;
}

export interface StaffEndResponse {
  before: string;
  after: string;
  cleanup: 'confirmed' | 'pending';
  note?: string;
  session: ClassroomRow;
}

/** A Support ID as students read it out: `sess-` and letters/digits. */
export const SUPPORT_ID_SHAPE = /^sess-[A-Za-z0-9-]{4,59}$/;
