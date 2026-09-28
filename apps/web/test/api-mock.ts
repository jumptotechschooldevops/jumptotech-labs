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
 * The payload builders (re-exported from `payloads.ts`, which the browser UX
 * suite shares) produce payloads in the shape the API really serves (see
 * `live-payloads.test.tsx` for the captured ones) — small and explicit, so a
 * test says exactly which fields it depends on.
 */
import { vi } from 'vitest';
import { LABS, TRACKS, labDetail, learningPathDetail, learningPathProgress, progressSnapshot, sessionsResponse } from './payloads';

export * from './payloads';

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
  getAccess: vi.fn(),
  getProgress: vi.fn(),
  listAttempts: vi.fn(),
  getAttempt: vi.fn(),
  listLearningPaths: vi.fn(),
  getLearningPath: vi.fn(),
  getLearningPathProgress: vi.fn(),
  classroom: {
    overview: vi.fn(),
    session: vi.fn(),
    searchStudents: vi.fn(),
    student: vi.fn(),
    labs: vi.fn(),
    endSession: vi.fn(),
  },
};

/** Defaults for a signed-in student with nothing running and nothing done. */
export function resetApiMock() {
  for (const value of Object.values(apiMock)) {
    if ('mockReset' in value) value.mockReset();
    else for (const fn of Object.values(value)) fn.mockReset();
  }
  apiMock.listLabs.mockResolvedValue({ labs: LABS, tracks: TRACKS, providers: [], count: LABS.length });
  apiMock.getProgress.mockResolvedValue(progressSnapshot());
  apiMock.getAccess.mockResolvedValue({
    access: { policy: 'open', state: 'NONE', active: true, startsAt: null, expiresAt: null },
  });
  apiMock.listMySessions.mockResolvedValue(sessionsResponse());
  apiMock.listAttempts.mockResolvedValue({ student: progressSnapshot().student, attempts: [], count: 0 });
  apiMock.getLab.mockImplementation((id: string) => Promise.resolve(labDetail({ id })));
  apiMock.recordHint.mockResolvedValue({ recorded: true, persisted: true, revealedCount: 1 });
  apiMock.listLearningPaths.mockResolvedValue({ learningPaths: [learningPathDetail()], count: 1 });
  apiMock.getLearningPath.mockResolvedValue({ learningPath: learningPathDetail() });
  apiMock.getLearningPathProgress.mockResolvedValue(learningPathProgress());
}
