/**
 * The classroom view's vocabulary: what an instructor reads instead of status
 * codes.
 *
 * Two audiences, kept apart on purpose (docs/runbooks/instructor-guide.md):
 *
 * ```text
 *   instructor   "Lab failed to start"           label, attention, next step
 *   operator     SESSION_PROVISION_FAILED, the   code, sandbox handle and the
 *                sandbox handle, statusReason     raw reason — ADMIN only
 * ```
 *
 * Everything here is a pure function of a stored session, its latest events and
 * the clock, so the same row renders the same way on every instructor's screen
 * and after every refresh: nothing is remembered by the browser.
 *
 * The thresholds are the lifecycle's own. The reaper finishes an End whose owner
 * died after 5 minutes, turns a reset that never finished into DEGRADED after
 * 10, and tears down a start that never finished after 10
 * (services/lab-orchestrator/src/session/reaper.ts). An instructor is told
 * "this is taking long" before the platform acts, and what it will do.
 */
import {
  ABANDONED_START_REASON,
  OPERATOR_END_REASON,
  type LabSession,
  type SessionStatus,
} from '@jumptotech/lab-orchestrator';

import type { LatestEvents, SessionEvent, SessionOperation, SessionOutcome } from './session-events.js';

export type Tone = 'ok' | 'progress' | 'attention' | 'problem' | 'done';

export interface StatusLabel {
  label: string;
  tone: Tone;
}

/** A session's status, as an instructor says it. */
export function statusLabel(session: Pick<LabSession, 'status' | 'statusReason'>): StatusLabel {
  switch (session.status as SessionStatus) {
    case 'CREATING':
      return { label: 'Starting', tone: 'progress' };
    case 'ACTIVE':
      return { label: 'Running', tone: 'ok' };
    case 'RESETTING':
      return { label: 'Resetting', tone: 'progress' };
    case 'DEGRADED':
      return { label: 'Needs Reset', tone: 'problem' };
    case 'ENDING':
    case 'EXPIRING':
      return { label: 'Cleaning up', tone: 'progress' };
    case 'ENDED':
      return { label: 'Ended by student', tone: 'done' };
    case 'EXPIRED':
      if (session.statusReason === OPERATOR_END_REASON) return { label: 'Ended by staff', tone: 'done' };
      if (session.statusReason === ABANDONED_START_REASON) return { label: 'Failed to start', tone: 'problem' };
      if (session.statusReason?.toLowerCase().includes('idle')) return { label: 'Expired (inactive)', tone: 'done' };
      return { label: 'Expired (time limit)', tone: 'done' };
    case 'FAILED':
      return { label: 'Failed to start', tone: 'problem' };
    default:
      return { label: String(session.status), tone: 'attention' };
  }
}

export interface Attention {
  code: string;
  /** What is wrong, in one sentence. */
  message: string;
  /** What to do about it. */
  nextStep: string;
  severity: 'attention' | 'problem';
}

const MINUTE = 60;
/** A healthy start is seconds for a container lab and a minute or two for Kubernetes. */
const SLOW_START_SECONDS = 5 * MINUTE;
/** The reaper recovers a reset that has not finished after 10 minutes. */
const SLOW_RESET_SECONDS = 5 * MINUTE;
/** The reaper resumes an abandoned End after 5 minutes and retries every sweep. */
const SLOW_CLEANUP_SECONDS = 5 * MINUTE;
/** Past this, a cleanup has had several reaper retries: somebody should look. */
const STUCK_CLEANUP_SECONDS = 15 * MINUTE;

function secondsSince(iso: string, nowMs: number): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.round((nowMs - at) / 1000)) : 0;
}

/**
 * What needs an instructor's attention about one live session, most urgent first.
 *
 * Detection only. Nothing here acts: the platform's own recovery (the reaper)
 * does, on the thresholds above, and a `nextStep` says what it will do.
 */
export function attentionFor(
  session: LabSession,
  latest: LatestEvents,
  view: { secondsUntilIdle: number; idleWarning: boolean },
  nowMs: number,
): Attention[] {
  const out: Attention[] = [];
  const inStatus = secondsSince(session.statusChangedAt, nowMs);

  switch (session.status) {
    case 'DEGRADED':
      out.push({
        code: 'ENVIRONMENT_BROKEN',
        message: 'The lab environment is broken: a Reset failed or was interrupted.',
        nextStep: 'Ask the student to press Reset. If Reset fails again, they should press End Lab and start again.',
        severity: 'problem',
      });
      break;
    case 'CREATING':
      if (inStatus >= SLOW_START_SECONDS) {
        out.push({
          code: 'START_SLOW',
          message: `Starting for ${Math.round(inStatus / MINUTE)} minutes — longer than a healthy start.`,
          nextStep:
            'Wait. A start that never finishes is cleaned up automatically after 10 minutes and the student can start again. If several students are stuck, escalate.',
          severity: inStatus >= 2 * SLOW_START_SECONDS ? 'problem' : 'attention',
        });
      }
      break;
    case 'RESETTING':
      if (inStatus >= SLOW_RESET_SECONDS) {
        out.push({
          code: 'RESET_SLOW',
          message: `Resetting for ${Math.round(inStatus / MINUTE)} minutes.`,
          nextStep: 'After 10 minutes the platform marks it Needs Reset, and the student can Reset again or End Lab.',
          severity: 'attention',
        });
      }
      break;
    case 'ENDING':
    case 'EXPIRING':
      if (inStatus >= SLOW_CLEANUP_SECONDS) {
        out.push({
          code: inStatus >= STUCK_CLEANUP_SECONDS ? 'CLEANUP_STUCK' : 'CLEANUP_SLOW',
          message: `Cleanup has been running for ${Math.round(inStatus / MINUTE)} minutes. The slot stays taken until it finishes.`,
          nextStep:
            inStatus >= STUCK_CLEANUP_SECONDS
              ? 'The platform keeps retrying, but this is longer than it should take. Escalate to DevOps with the Support ID.'
              : 'Nothing to do yet: the platform retries cleanup automatically every minute.',
          severity: inStatus >= STUCK_CLEANUP_SECONDS ? 'problem' : 'attention',
        });
      }
      break;
    default:
      break;
  }

  if (session.status === 'ACTIVE') {
    const check = latest.check;
    // Only a check newer than the last reset or start still describes this environment.
    if (check?.outcome === 'error' && isNewest(check, latest)) {
      out.push({
        code: 'CHECK_ERROR',
        message: 'The last Check could not run — a platform problem, not the student’s answer.',
        nextStep: 'Ask the student to wait a minute and press Check again. If it keeps failing for several students, escalate.',
        severity: 'problem',
      });
    }
    if (view.idleWarning) {
      out.push({
        code: 'IDLE_SOON',
        message: `No activity recently: the lab closes in ${Math.max(1, Math.round(view.secondsUntilIdle / MINUTE))} minute(s) unless the student continues.`,
        nextStep: 'If the student is still working, they should type in the terminal or press Continue.',
        severity: 'attention',
      });
    }
  }

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1));
}

/** True when no later start or reset superseded this event. */
function isNewest(event: SessionEvent, latest: LatestEvents): boolean {
  const id = Number(event.eventId);
  return [latest.reset, latest.start].every((other) => !other || Number(other.eventId) < id);
}

/** A code, as an instructor needs to hear it. Unknown codes fall back to the outcome's own words. */
const CODE_WORDS: Record<string, string> = {
  LAB_CAPACITY_REACHED: 'classroom capacity was full',
  STUDENT_SESSION_LIMIT_REACHED: 'the student already had a lab running',
  PROVIDER_UNAVAILABLE: 'this kind of lab is unavailable right now',
  ACCESS_NOT_ACTIVE: 'the student’s lab access is not active',
  LAB_LAUNCHES_PAUSED: 'starting labs is paused for maintenance',
  SESSION_NOT_ACTIVE: 'the lab was not ready',
  SESSION_CHANGED_DURING_CHECK: 'the lab changed while it was being checked',
  ENDED_BY_STUDENT: 'the student ended it',
  ENDED_BY_STAFF: 'staff ended it',
  IDLE_TIMEOUT: 'it expired after inactivity',
  LIFETIME_REACHED: 'it reached the maximum lab time',
  START_ABANDONED: 'a start that never finished was cleaned up',
};

/**
 * One event, as a sentence. The code stays alongside for operators; it is the
 * reason, not the description.
 */
export function describeEvent(event: Pick<SessionEvent, 'operation' | 'outcome' | 'code'>): { text: string; problem: boolean } {
  const why = event.code ? CODE_WORDS[event.code] : undefined;
  const because = why ? ` — ${why}` : '';
  const table: Record<SessionOperation, Partial<Record<SessionOutcome, string>>> = {
    start: {
      ok: 'Lab started',
      refused: 'Start refused',
      failed: 'Lab failed to start',
    },
    check: {
      pass: 'Check passed',
      fail: 'Check ran — not complete yet',
      error: 'Check could not run (platform problem)',
      refused: 'Check not run',
    },
    reset: {
      ok: 'Reset completed',
      failed: 'Reset failed',
      refused: 'Reset not run',
    },
    end: {
      ok: 'Student ended the lab',
      pending: 'Student ended the lab — cleanup still running',
      failed: 'End failed (platform problem)',
      refused: 'End not run',
    },
    cleanup: {
      ok: 'Cleanup confirmed',
    },
    staff_end: {
      ok: 'Ended by staff',
      pending: 'Ended by staff — cleanup still running',
      refused: 'Staff end not run',
    },
  };
  const base = table[event.operation]?.[event.outcome] ?? `${event.operation}: ${event.outcome}`;
  // A grade is never a problem; an error, a failure, a refusal or a pending cleanup is worth a look.
  const problem = event.outcome === 'error' || event.outcome === 'failed' || event.outcome === 'pending' || event.outcome === 'refused';
  return { text: `${base}${because}`, problem };
}

/** The outcomes the "recent problems" feed shows. Grades are not problems. */
export const PROBLEM_OUTCOMES: readonly SessionOutcome[] = ['error', 'failed', 'refused', 'pending'];

/** A provider id, as a lab category an instructor recognises. */
export function runtimeLabel(provider: string): string {
  const labels: Record<string, string> = {
    kubernetes: 'Kubernetes labs',
    linux: 'Linux labs',
    docker: 'Docker labs',
    terraform: 'Terraform labs',
    ansible: 'Ansible labs',
    cicd: 'CI/CD labs',
    aws: 'AWS labs',
  };
  return labels[provider] ?? `${provider} labs`;
}
