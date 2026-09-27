/**
 * The abandoned-attempt sweep must not close the attempt of a lab that is
 * still running.
 *
 * Sessions persist with the deadline they were created under, so a lab can be
 * older than the sweep's cutoff and still live: `MAX_SESSION_MINUTES` was
 * lowered across a restart, or the reaper is behind. Closing its attempt shows
 * the student EXPIRED mid-lab, and the End that follows cannot record ENDED.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryProgressRepository, ProgressService } from '@jumptotech/progress';
import { AbandonedAttemptSweeper } from '../src/progress.js';

function build() {
  let clock = Date.parse('2026-09-27T10:00:00.000Z');
  const service = new ProgressService({
    repository: new InMemoryProgressRepository(),
    now: () => clock,
  });
  return {
    service,
    advance(seconds: number) {
      clock += seconds * 1000;
    },
  };
}

async function startBound(service: ProgressService, labId: string, sessionId: string) {
  const attempt = await service.startAttempt({
    studentId: 'dev-student-001',
    labId,
    track: 'linux',
    identitySource: 'development-default',
  });
  await service.bindSession(attempt.attemptId, sessionId);
  return attempt;
}

async function statusOf(service: ProgressService, attemptId: string) {
  const history = await service.listAttempts('dev-student-001');
  return history.find((attempt) => attempt.attemptId === attemptId)?.status;
}

describe('AbandonedAttemptSweeper', () => {
  it('keeps the attempt of a session that still occupies a slot, however old', async () => {
    const { service, advance } = build();
    const live = await startBound(service, 'LINUX-001', 'sess-live00000000');
    const gone = await startBound(service, 'LINUX-002', 'sess-gone00000000');

    // Created under a 120-minute lifetime; the platform now runs with 60.
    advance(90 * 60);
    const sweeper = new AbandonedAttemptSweeper({
      progress: service,
      maxSessionSeconds: 60 * 60,
      liveSessionIds: async () => ['sess-live00000000'],
      intervalMs: 60_000,
    });

    expect(await sweeper.sweep()).toBe(1);
    expect(await statusOf(service, live.attemptId)).toBe('IN_PROGRESS');
    expect(await statusOf(service, gone.attemptId)).toBe('EXPIRED');
  });

  it('skips the sweep when it cannot tell which sessions are live', async () => {
    const { service, advance } = build();
    const attempt = await startBound(service, 'LINUX-001', 'sess-maybe0000000');
    advance(3 * 60 * 60);
    const logged: string[] = [];
    const sweeper = new AbandonedAttemptSweeper({
      progress: service,
      maxSessionSeconds: 60 * 60,
      liveSessionIds: async () => {
        throw new Error('session store unavailable');
      },
      intervalMs: 60_000,
      log: (message) => logged.push(message),
    });

    expect(await sweeper.sweep()).toBe(0);
    expect(await statusOf(service, attempt.attemptId)).toBe('IN_PROGRESS');
    expect(logged).toEqual(['could not close abandoned attempts: session store unavailable']);
  });
});
