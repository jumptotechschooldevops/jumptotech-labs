/**
 * The classroom view's vocabulary: labels, stuck detection, event sentences.
 *
 * Pure functions of a stored session, its latest events and the clock, so the
 * thresholds can be pinned without waiting minutes. They are the lifecycle's
 * own (the reaper's graces): "taking long" is said before the platform acts.
 */
import { describe, expect, it } from 'vitest';
import { OPERATOR_END_REASON, ABANDONED_START_REASON, type LabSession, type SessionStatus } from '@jumptotech/lab-orchestrator';
import { attentionFor, describeEvent, statusLabel } from '../src/classroom/view.js';
import { authorize } from '../src/auth/policy.js';
import type { AuthenticatedUser, Role } from '../src/auth/identity.js';
import type { SessionEvent } from '../src/classroom/session-events.js';

const NOW = Date.parse('2026-09-28T10:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const calm = { secondsUntilIdle: 900, idleWarning: false };

function session(status: SessionStatus, inStatusMinutes: number, extra: Partial<LabSession> = {}): LabSession {
  return {
    sessionId: 'sess-1',
    labId: 'LINUX-001',
    provider: 'linux',
    sandboxKind: 'container',
    sandboxRef: 'jtt-lab-x',
    namespace: 'jtt-lab-x',
    serviceAccountName: 'student',
    status,
    environmentId: 'e',
    createdAt: minutesAgo(60),
    lastActivityAt: minutesAgo(1),
    statusChangedAt: minutesAgo(inStatusMinutes),
    expiresAt: minutesAgo(-60),
    idleTimeoutSeconds: 1200,
    idleWarningSeconds: 120,
    ownerUserId: 'u1',
    ...extra,
  };
}

const event = (id: number, operation: SessionEvent['operation'], outcome: SessionEvent['outcome'], code?: string): SessionEvent => ({
  eventId: String(id),
  sessionId: 'sess-1',
  labId: 'LINUX-001',
  operation,
  outcome,
  ...(code ? { code } : {}),
  occurredAt: minutesAgo(1),
});

describe('status labels', () => {
  it.each([
    ['CREATING', undefined, 'Starting'],
    ['ACTIVE', undefined, 'Running'],
    ['RESETTING', undefined, 'Resetting'],
    ['DEGRADED', undefined, 'Needs Reset'],
    ['ENDING', undefined, 'Cleaning up'],
    ['EXPIRING', undefined, 'Cleaning up'],
    ['ENDED', 'ended by student', 'Ended by student'],
    ['EXPIRED', OPERATOR_END_REASON, 'Ended by staff'],
    ['EXPIRED', ABANDONED_START_REASON, 'Failed to start'],
    ['EXPIRED', 'idle for more than 1200s', 'Expired (inactive)'],
    ['EXPIRED', 'maximum lifetime reached', 'Expired (time limit)'],
    ['FAILED', 'provision failed: docker said …', 'Failed to start'],
  ] as const)('%s (%s) reads “%s”', (status, reason, label) => {
    expect(statusLabel({ status, ...(reason ? { statusReason: reason } : {}) }).label).toBe(label);
  });
});

describe('what needs attention', () => {
  it('nothing for a healthy running lab', () => {
    expect(attentionFor(session('ACTIVE', 30), {}, calm, NOW)).toEqual([]);
  });

  it('a start is slow at 5 minutes and a problem at 10, when the platform cleans it up', () => {
    expect(attentionFor(session('CREATING', 4), {}, calm, NOW)).toEqual([]);
    expect(attentionFor(session('CREATING', 6), {}, calm, NOW)[0]).toMatchObject({ code: 'START_SLOW', severity: 'attention' });
    expect(attentionFor(session('CREATING', 11), {}, calm, NOW)[0]).toMatchObject({ code: 'START_SLOW', severity: 'problem' });
  });

  it('cleanup is slow at 5 minutes and stuck at 15, with an escalation', () => {
    expect(attentionFor(session('ENDING', 3), {}, calm, NOW)).toEqual([]);
    expect(attentionFor(session('ENDING', 6), {}, calm, NOW)[0]).toMatchObject({ code: 'CLEANUP_SLOW', severity: 'attention' });
    const stuck = attentionFor(session('EXPIRING', 16), {}, calm, NOW)[0]!;
    expect(stuck).toMatchObject({ code: 'CLEANUP_STUCK', severity: 'problem' });
    expect(stuck.nextStep).toMatch(/Escalate/);
  });

  it('a broken environment says what the student can do', () => {
    const [broken] = attentionFor(session('DEGRADED', 1), {}, calm, NOW);
    expect(broken).toMatchObject({ code: 'ENVIRONMENT_BROKEN', severity: 'problem' });
    expect(broken!.nextStep).toMatch(/Reset/);
  });

  it('a reset running past 5 minutes is flagged', () => {
    expect(attentionFor(session('RESETTING', 6), {}, calm, NOW)[0]).toMatchObject({ code: 'RESET_SLOW' });
  });

  it('a Check error is flagged until a later reset or start supersedes it; a failed grade never is', () => {
    expect(attentionFor(session('ACTIVE', 1), { check: event(5, 'check', 'error', 'X') }, calm, NOW)[0]).toMatchObject({ code: 'CHECK_ERROR' });
    expect(attentionFor(session('ACTIVE', 1), { check: event(5, 'check', 'error'), reset: event(6, 'reset', 'ok') }, calm, NOW)).toEqual([]);
    expect(attentionFor(session('ACTIVE', 1), { check: event(5, 'check', 'fail') }, calm, NOW)).toEqual([]);
  });

  it('warns before idle expiry', () => {
    expect(attentionFor(session('ACTIVE', 1), {}, { secondsUntilIdle: 90, idleWarning: true }, NOW)[0]).toMatchObject({ code: 'IDLE_SOON' });
  });

  it('puts problems before attention', () => {
    const list = attentionFor(
      session('ACTIVE', 1),
      { check: event(5, 'check', 'error') },
      { secondsUntilIdle: 90, idleWarning: true },
      NOW,
    );
    expect(list.map((a) => a.code)).toEqual(['CHECK_ERROR', 'IDLE_SOON']);
  });
});

describe('event sentences', () => {
  it('says what happened and why, and marks problems', () => {
    expect(describeEvent({ operation: 'check', outcome: 'fail' })).toEqual({ text: 'Check ran — not complete yet', problem: false });
    expect(describeEvent({ operation: 'check', outcome: 'error', code: 'ENVIRONMENT_UNREACHABLE' })).toEqual({
      text: 'Check could not run (platform problem)',
      problem: true,
    });
    expect(describeEvent({ operation: 'start', outcome: 'refused', code: 'STUDENT_SESSION_LIMIT_REACHED' }).text).toBe(
      'Start refused — the student already had a lab running',
    );
    expect(describeEvent({ operation: 'end', outcome: 'pending' })).toMatchObject({ problem: true });
    // An unknown code is not turned into words it does not have.
    expect(describeEvent({ operation: 'reset', outcome: 'failed', code: 'SOMETHING_NEW' }).text).toBe('Reset failed');
  });
});

describe('the policy behind it', () => {
  const user = (role: Role): AuthenticatedUser => ({ userId: `u-${role}`, issuer: 'i', subject: role, role, source: 'development' });
  it.each([
    ['STUDENT', false, false],
    ['INSTRUCTOR', true, false],
    ['ADMIN', true, true],
  ] as const)('%s: classroom:read %s, operator detail %s', (role, read, detail) => {
    expect(authorize(user(role), 'classroom:read').allowed).toBe(read);
    expect(authorize(user(role), 'classroom:operator-detail').allowed).toBe(detail);
  });

  it('ending another student’s lab stays ADMIN only', () => {
    const other = { sessionId: 's', ownerUserId: 'someone-else' };
    expect(authorize(user('STUDENT'), 'session:end', other).allowed).toBe(false);
    expect(authorize(user('INSTRUCTOR'), 'session:end', other).allowed).toBe(false);
    expect(authorize(user('ADMIN'), 'session:end', other)).toEqual({ allowed: true, reason: 'role' });
  });
});
