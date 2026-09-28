/**
 * The cleanup event: the moment a lab's sandbox was confirmed gone.
 *
 * Every teardown — the student's End, the reaper's idle or lifetime expiry, an
 * operator's or a staff member's end, the reaper finishing an End whose owner
 * died — ends in the session manager's `onSessionClosed`, exactly once, and
 * only after the provider confirmed the sandbox is gone. So this is the one
 * place that can truthfully say "cleanup finished", whoever started it; an End
 * that answered `pending` is followed by this event when the reaper completes it.
 */
import {
  ABANDONED_START_REASON,
  OPERATOR_END_REASON,
  type SessionClosedEvent,
  type SessionLifecycleListener,
} from '@jumptotech/lab-orchestrator';
import type { Logger } from '@jumptotech/observability';

import { recordSafely, type SessionEventStore } from './session-events.js';

/** Why a session closed, as a code: never the reason's free text. */
export function closedReasonCode(event: Pick<SessionClosedEvent, 'status' | 'reason'>): string {
  if (event.status === 'ENDED') return 'ENDED_BY_STUDENT';
  if (event.reason === OPERATOR_END_REASON) return 'ENDED_BY_STAFF';
  if (event.reason === ABANDONED_START_REASON) return 'START_ABANDONED';
  return event.reason.toLowerCase().includes('idle') ? 'IDLE_TIMEOUT' : 'LIFETIME_REACHED';
}

export class CleanupEventListener implements SessionLifecycleListener {
  constructor(
    private readonly events: SessionEventStore,
    /** The session's owner, read from the row the teardown just finished. */
    private readonly ownerOf: (sessionId: string) => Promise<string | undefined>,
    private readonly logger?: Pick<Logger, 'warn'>,
    /** The listener this one wraps (the attempt closer). Always runs first. */
    private readonly inner?: SessionLifecycleListener,
  ) {}

  async onSessionClosed(event: SessionClosedEvent): Promise<void> {
    try {
      await this.inner?.onSessionClosed?.(event);
    } finally {
      let owner: string | undefined;
      try {
        owner = await this.ownerOf(event.sessionId);
      } catch {
        owner = undefined;
      }
      await recordSafely(this.events, this.logger, {
        sessionId: event.sessionId,
        labId: event.labId,
        ...(owner ? { ownerUserId: owner } : {}),
        operation: 'cleanup',
        outcome: 'ok',
        code: closedReasonCode(event),
      });
    }
  }
}
