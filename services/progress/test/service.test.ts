/**
 * The use-case layer.
 *
 * The storage behaviour itself is covered by the contract suite; what is tested
 * here is the part the routes depend on: writes are addressed by session id,
 * a session with no attempt degrades to `null` instead of throwing, and the
 * read paths refuse to serve one student another student's history.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryProgressRepository } from '../src/memory-repository.js';
import { ProgressService } from '../src/service.js';
import { DevStudentIdentity } from '../src/identity.js';
import { ProgressError } from '../src/types.js';

function build() {
  let clock = Date.UTC(2026, 7, 17, 9, 0, 0);
  const repository = new InMemoryProgressRepository();
  const service = new ProgressService({ repository, now: () => clock });
  return {
    service,
    repository,
    advance(seconds: number) {
      clock += seconds * 1000;
    },
    at: () => new Date(clock).toISOString(),
  };
}

async function startBound(
  service: ProgressService,
  options: { studentId?: string; labId?: string; track?: string; sessionId?: string } = {},
) {
  const attempt = await service.startAttempt({
    studentId: options.studentId ?? 'dev-student-001',
    labId: options.labId ?? 'K8S-001',
    track: options.track ?? 'kubernetes',
    identitySource: 'development-default',
  });
  const sessionId = options.sessionId ?? `sess-${attempt.attemptId.slice(0, 12)}`;
  await service.bindSession(attempt.attemptId, sessionId);
  return { attempt, sessionId };
}

describe('ProgressService', () => {
  it('creates the student and the attempt together', async () => {
    const { service, repository } = build();
    const attempt = await service.startAttempt({
      studentId: 'dev-student-001',
      labId: 'LINUX-001',
      track: 'linux',
      identitySource: 'development-default',
    });

    expect(attempt.status).toBe('IN_PROGRESS');
    expect(await repository.listProgress('dev-student-001')).toHaveLength(1);
  });

  it('routes every session-scoped write through the attempt that owns it', async () => {
    const { service, advance } = build();
    const { sessionId } = await startBound(service);

    advance(60);
    const failed = await service.recordCheck(sessionId, false);
    expect(failed?.attempt.checkCount).toBe(1);
    expect(failed?.newlyCompleted).toBe(false);

    advance(60);
    await service.recordReset(sessionId);

    advance(60);
    const passed = await service.recordCheck(sessionId, true);
    expect(passed?.newlyCompleted).toBe(true);
    expect(passed?.attempt.resetCount).toBe(1);
    expect(passed?.attempt.status).toBe('PASSED');

    advance(60);
    const ended = await service.closeSession({
      sessionId,
      outcome: 'ENDED',
      reason: 'ended by student',
    });
    expect(ended?.status).toBe('PASSED');
    expect(ended?.endedAt).not.toBeNull();
  });

  it('degrades to null for a session that has no attempt', async () => {
    const { service } = build();

    // A session started before this feature existed, or one whose attempt could
    // not be written. Checking your work must still work.
    expect(await service.recordCheck('sess-unknown00000', true)).toBeNull();
    expect(await service.recordReset('sess-unknown00000')).toBeNull();
    expect(await service.recordHint('sess-unknown00000', 1)).toBeNull();
    expect(
      await service.closeSession({ sessionId: 'sess-unknown00000', outcome: 'EXPIRED' }),
    ).toBeNull();
  });

  it('validates the hint index before touching the store', async () => {
    const { service } = build();
    const { sessionId } = await startBound(service);

    for (const bad of [0, -1, 1.5, 999]) {
      await expect(service.recordHint(sessionId, bad)).rejects.toBeInstanceOf(ProgressError);
    }
    await expect(service.recordHint(sessionId, 1)).resolves.toMatchObject({ recorded: true });
  });

  it('records the same hint once however often the frontend replays it', async () => {
    const { service, advance } = build();
    const { sessionId } = await startBound(service);

    const first = await service.recordHint(sessionId, 1);
    advance(5);
    const replay = await service.recordHint(sessionId, 1);
    advance(5);
    const next = await service.recordHint(sessionId, 2);

    expect(first?.recorded).toBe(true);
    expect(replay?.recorded).toBe(false);
    expect(replay?.revealedCount).toBe(1);
    expect(next?.revealedCount).toBe(2);
  });

  it('serves an attempt only to the student who owns it', async () => {
    const { service } = build();
    const mine = await startBound(service, { studentId: 'dev-student-001' });
    const theirs = await startBound(service, {
      studentId: 'dev-student-002',
      sessionId: 'sess-other0000000',
    });

    expect(await service.attemptDetail('dev-student-001', mine.attempt.attemptId)).not.toBeNull();
    expect(await service.attemptDetail('dev-student-002', mine.attempt.attemptId)).toBeNull();
    expect(await service.attemptDetail('dev-student-001', theirs.attempt.attemptId)).toBeNull();
  });

  it('bounds the attempt page size', async () => {
    const { service, advance } = build();
    for (let i = 0; i < 5; i += 1) {
      advance(60);
      await startBound(service, { labId: `K8S-00${i + 1}`, sessionId: `sess-page${i}00000000` });
    }

    expect(await service.listAttempts('dev-student-001', 3)).toHaveLength(3);
    // A caller asking for a million rows gets the cap, not the table.
    expect(await service.listAttempts('dev-student-001', 1_000_000)).toHaveLength(5);
    expect(await service.listAttempts('dev-student-001', -5)).toHaveLength(1);
  });

  it('marks an attempt FAILED when its sandbox never came up', async () => {
    const { service } = build();
    const attempt = await service.startAttempt({
      studentId: 'dev-student-001',
      labId: 'TF-001',
      track: 'terraform',
      identitySource: 'development-default',
    });

    const failed = await service.failAttempt(attempt.attemptId, 'PROVIDER_UNAVAILABLE');
    expect(failed?.status).toBe('FAILED');
    expect(failed?.sessionId).toBeNull();
  });

  it('closes an attempt whose sandbox outlived the platform restarting', async () => {
    const { service, advance } = build();
    const abandoned = await startBound(service, { sessionId: 'sess-abandoned000' });

    // Two hours later: the absolute session lifetime is an hour, so no sandbox
    // for this attempt can still exist — whatever happened to the API.
    advance(2 * 60 * 60);
    const fresh = await startBound(service, { labId: 'K8S-002', sessionId: 'sess-fresh0000000' });

    const closed = await service.expireAbandonedAttempts({ maxSessionSeconds: 3600 });
    expect(closed).toBe(1);

    const history = await service.listAttempts('dev-student-001');
    const byId = new Map(history.map((attempt) => [attempt.attemptId, attempt]));
    expect(byId.get(abandoned.attempt.attemptId)?.status).toBe('EXPIRED');
    expect(byId.get(abandoned.attempt.attemptId)?.endedAt).not.toBeNull();
    // The lab a student is working on right now is left alone.
    expect(byId.get(fresh.attempt.attemptId)?.status).toBe('IN_PROGRESS');

    // And it is idempotent.
    expect(await service.expireAbandonedAttempts({ maxSessionSeconds: 3600 })).toBe(0);
  });

  it('ensures a student row exists for a first-time visitor', async () => {
    const { service } = build();
    const identity = new DevStudentIdentity().resolve();
    const student = await service.ensureStudent(identity);

    expect(student.studentId).toBe('dev-student-001');
    expect(student.identitySource).toBe('development-default');
    expect(await service.progressFor(student.studentId)).toEqual([]);
    expect(await service.listAttempts(student.studentId)).toEqual([]);
  });
});
