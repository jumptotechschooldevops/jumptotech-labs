-- ---------------------------------------------------------------------------
-- BETA-P0-007 — recovering interrupted session lifecycle operations.
--
-- Forward-only and applied exactly once, like every file before it.
--
-- 1. status_changed_at
--
--    When `status` last actually changed. The reaper needs it to tell a dead
--    operation from a slow one: a RESETTING or ENDING row whose owner died used
--    to sit there until idle or absolute expiry, because nothing recorded how
--    long it had been in that state. It also fences a reset's claim — see
--    `SessionStore.transition` — so it is compared for equality and must round-
--    trip through JavaScript's millisecond timestamps unchanged. Hence the
--    millisecond truncation on the default.
--
--    Existing rows are backfilled from the closest thing they have: when they
--    ended, else their last activity. That can only make an in-flight row look
--    older than it is, and a deploy restarts every process that could have been
--    running one.
--
--    The default exists for instances still running the previous release
--    during a rollout: their INSERT names no such column and must not fail.
--
-- 2. DEGRADED
--
--    The recoverable state for a sandbox a failed or interrupted reset left in
--    an unknown condition. It is added to the status CHECK; nothing else about
--    the table changes.
-- ---------------------------------------------------------------------------

ALTER TABLE lab_sessions
    ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

UPDATE lab_sessions
   SET status_changed_at = COALESCE(ended_at, last_activity_at)
 WHERE status_changed_at IS NULL;

ALTER TABLE lab_sessions
    ALTER COLUMN status_changed_at SET DEFAULT date_trunc('milliseconds', now()),
    ALTER COLUMN status_changed_at SET NOT NULL;

ALTER TABLE lab_sessions
    DROP CONSTRAINT IF EXISTS lab_sessions_status_known;

ALTER TABLE lab_sessions
    ADD CONSTRAINT lab_sessions_status_known CHECK (
        status IN ('CREATING','ACTIVE','RESETTING','DEGRADED','EXPIRING','ENDING',
                   'EXPIRED','ENDED','FAILED')
    );

-- The reaper's stalled-operation scan filters on status and orders by age.
CREATE INDEX IF NOT EXISTS lab_sessions_by_status_change
    ON lab_sessions (status, status_changed_at);
