/**
 * One stand-in for the API client, shared by the page tests.
 *
 * Kept free of any `src/` import (types excepted) so a `vi.mock` factory can
 * import it without a cycle. Each test file wires it in with:
 *
 * ```ts
 * vi.mock('../src/lib/api', async () => {
 *   const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
 *   const { apiMock } = await import('./api-mock');
 *   return { ...actual, api: apiMock };
 * });
 * ```
 *
 * The builders below produce payloads in the shape the API really serves (see
 * `live-payloads.test.tsx` for the captured ones) — small and explicit, so a
 * test says exactly which fields it depends on.
 */
import { vi } from 'vitest';
import type {
  ActiveSessionEntry,
  AttemptSummary,
  LabDetail,
  LabSummary,
  ProgressSnapshot,
  SessionInfo,
  TrackSummary,
  VerificationResult,
} from '../src/lib/types';

export const apiMock = {
  listLabs: vi.fn(),
  listTracks: vi.fn(),
  listTrackLabs: vi.fn(),
  getLab: vi.fn(),
  startLab: vi.fn(),
  listMySessions: vi.fn(),
  getSession: vi.fn(),
  issueTerminal: vi.fn(),
  recordActivity: vi.fn(),
  checkSolution: vi.fn(),
  resetLab: vi.fn(),
  endLab: vi.fn(),
  recordHint: vi.fn(),
  getIdentity: vi.fn(),
  getProgress: vi.fn(),
  listAttempts: vi.fn(),
  getAttempt: vi.fn(),
};

export function labSummary(overrides: Partial<LabSummary> = {}): LabSummary {
  return {
    id: 'LINUX-001',
    slug: 'linux-001-files',
    title: 'Files and Directories',
    track: 'linux',
    provider: 'linux',
    availability: { available: true },
    topic: 'linux-fundamentals',
    topicTitle: 'Linux Fundamentals',
    difficulty: 'beginner',
    level: 'practice',
    durationMinutes: 20,
    order: 1,
    summary: 'Build a small project directory tree and move a log file into an archive.',
    skills: ['linux.files.navigate', 'linux.files.create'],
    hasSetup: false,
    certifications: ['LFCS'],
    prerequisites: [],
    hintCount: 3,
    ...overrides,
  };
}

export function trackSummary(overrides: Partial<TrackSummary> = {}): TrackSummary {
  return {
    track: 'linux',
    title: 'Linux',
    tagline: 'Files, permissions, processes, and the shell on a real container.',
    labCount: 2,
    topics: [{ topic: 'linux-fundamentals', title: 'Linux Fundamentals', labCount: 2 }],
    difficulties: ['beginner', 'intermediate'],
    providers: ['linux'],
    availability: { available: true },
    ...overrides,
  };
}

export const LABS: LabSummary[] = [
  labSummary(),
  labSummary({
    id: 'LINUX-002',
    slug: 'linux-002-permissions',
    title: 'File Permissions',
    order: 2,
    difficulty: 'intermediate',
    summary: 'Fix the permissions on a shared directory.',
    skills: ['linux.permissions.chmod'],
    prerequisites: [{ id: 'LINUX-001', title: 'Files and Directories', available: true }],
  }),
  labSummary({
    id: 'K8S-001',
    slug: 'k8s-001-pods',
    title: 'Create Your First Pod',
    track: 'kubernetes',
    provider: 'kubernetes',
    topic: 'pods',
    topicTitle: 'Pods',
    durationMinutes: 30,
    summary: 'Create a Kubernetes Pod named nginx.',
    skills: ['kubernetes.pods.create'],
    certifications: ['CKA'],
  }),
];

export const TRACKS: TrackSummary[] = [
  trackSummary({ track: 'kubernetes', title: 'Kubernetes', tagline: 'Pods, workloads, and the cluster APIs that schedule them.', labCount: 1, topics: [{ topic: 'pods', title: 'Pods', labCount: 1 }], difficulties: ['beginner'], providers: ['kubernetes'], order: 10 }),
  trackSummary(),
];

export function progressSnapshot(
  statuses: Record<string, 'COMPLETED' | 'IN_PROGRESS'> = {},
  labs: LabSummary[] = LABS,
  tracks: TrackSummary[] = TRACKS,
): ProgressSnapshot {
  const trackProgress = tracks.map((track) => {
    const entries = labs
      .filter((lab) => lab.track === track.track)
      .map((lab) => ({
        labId: lab.id,
        title: lab.title,
        status: statuses[lab.id] ?? ('NOT_STARTED' as const),
        attemptCount: statuses[lab.id] ? 1 : 0,
        completionCount: statuses[lab.id] === 'COMPLETED' ? 1 : 0,
        completedAt: statuses[lab.id] === 'COMPLETED' ? '2026-09-01T10:00:00Z' : null,
        lastCompletedAt: statuses[lab.id] === 'COMPLETED' ? '2026-09-01T10:00:00Z' : null,
      }));
    const completed = entries.filter((e) => e.status === 'COMPLETED').length;
    const inProgress = entries.filter((e) => e.status === 'IN_PROGRESS').length;
    return {
      track: track.track,
      title: track.title,
      total: entries.length,
      completed,
      inProgress,
      notStarted: entries.length - completed - inProgress,
      percent: entries.length ? Math.round((completed / entries.length) * 100) : 0,
      labs: entries,
    };
  });
  const total = trackProgress.reduce((sum, t) => sum + t.total, 0);
  const completed = trackProgress.reduce((sum, t) => sum + t.completed, 0);
  const inProgress = trackProgress.reduce((sum, t) => sum + t.inProgress, 0);
  return {
    student: { studentId: 'student-1', authenticated: true, identitySource: 'oidc', durable: true },
    overall: {
      total,
      completed,
      inProgress,
      notStarted: total - completed - inProgress,
      percent: total ? Math.round((completed / total) * 100) : 0,
    },
    tracks: trackProgress,
  };
}

export function labDetail(overrides: Partial<LabDetail> = {}): LabDetail {
  return {
    id: 'LINUX-001',
    slug: 'linux-001-files',
    title: 'Files and Directories',
    track: 'linux',
    topic: 'linux-fundamentals',
    topicTitle: 'Linux Fundamentals',
    difficulty: 'beginner',
    level: 'practice',
    durationMinutes: 20,
    environment: { provider: 'linux', isolation: 'container' },
    story: 'Your first week on the platform team.',
    objectives: ['Create directories and empty files from the command line'],
    task: {
      summary: 'Build a small project directory tree and move a log file into an archive.',
      description: 'Create a directory called `project` in your home directory.\n\nThen move `app.log` into `archive`.',
    },
    requirements: ['The project directory exists', 'app.log was moved, not copied'],
    hints: [
      { level: 1, text: 'Think about which command family each step belongs to.' },
      { level: 2, text: 'man mkdir, man touch and man mv are available.' },
    ],
    references: [{ title: 'mkdir(1)', url: 'https://man7.org/linux/man-pages/man1/mkdir.1.html' }],
    skills: ['linux.files.create'],
    certifications: [{ certification: 'LFCS', domains: [] }],
    prerequisites: [],
    prerequisitesEnforced: false,
    hasSetup: false,
    availability: { available: true },
    ...overrides,
  };
}

let sessionCounter = 0;

export function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = Date.now();
  return {
    sessionId: 'sess-0000000000000001',
    labId: 'LINUX-001',
    status: 'ACTIVE',
    provider: 'linux',
    sandboxKind: 'container',
    sandboxRef: 'lab-sbx-test',
    createdAt: new Date(now).toISOString(),
    lastActivityAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(),
    secondsRemaining: 3600,
    secondsUntilIdle: 1200,
    idleWarning: false,
    idleTimeoutSeconds: 1200,
    warningSeconds: 300,
    ...overrides,
  };
}

export function uniqueSessionId(): string {
  sessionCounter += 1;
  return `sess-${sessionCounter.toString(16).padStart(16, '0')}`;
}

export function attemptSummary(overrides: Partial<AttemptSummary> = {}): AttemptSummary {
  return {
    attemptId: 'attempt-1',
    labId: 'LINUX-001',
    labTitle: 'Files and Directories',
    track: 'linux',
    status: 'IN_PROGRESS',
    startedAt: '2026-09-14T10:00:00Z',
    completedAt: null,
    endedAt: null,
    checkCount: 0,
    resetCount: 0,
    ...overrides,
  };
}

export function sessionsResponse(entries: ActiveSessionEntry[] = [], limit: number | null = 1) {
  return { sessions: entries, count: entries.length, limits: { maxActiveSessionsPerStudent: limit } };
}

export function verification(passed: boolean, overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    labId: 'LINUX-001',
    namespace: 'lab-sbx-test',
    passed,
    summary: passed ? 'LAB PASSED' : 'LAB NOT COMPLETE',
    checks: [
      { id: 'directory_exists-1', label: 'The project directory exists', status: 'pass' },
      passed
        ? { id: 'path_absent-2', label: 'app.log was moved, not copied', status: 'pass' }
        : {
            id: 'path_absent-2',
            label: 'app.log was moved, not copied',
            status: 'fail',
            detail: 'The path still exists',
          },
    ],
    checkedAt: '2026-09-15T10:00:00Z',
    ...overrides,
  };
}

/** Defaults for a signed-in student with nothing running and nothing done. */
export function resetApiMock() {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.listLabs.mockResolvedValue({ labs: LABS, tracks: TRACKS, providers: [], count: LABS.length });
  apiMock.getProgress.mockResolvedValue(progressSnapshot());
  apiMock.listMySessions.mockResolvedValue(sessionsResponse());
  apiMock.listAttempts.mockResolvedValue({ student: progressSnapshot().student, attempts: [], count: 0 });
  apiMock.getLab.mockImplementation((id: string) => Promise.resolve(labDetail({ id })));
  apiMock.recordHint.mockResolvedValue({ recorded: true, persisted: true, revealedCount: 1 });
}
