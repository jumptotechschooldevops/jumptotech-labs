-- ---------------------------------------------------------------------------
-- Session events — what happened to a student's lab, for the people helping.
--
-- Forward-only and checksum-verified like every file before it. To change
-- this, add 009_*.sql.
--
-- An instructor asked "did Check fail, or did Check break?", "did Reset
-- arrive, and did it work?", "did End actually clean up?" had no answer short
-- of reading the api log on the host. `lab_sessions` holds a session's *current*
-- status and is purged SESSION_RETENTION_MINUTES after it finishes;
-- `lab_attempts` counts checks and resets but records only a grade, never a
-- check that could not read the environment. This table is the missing record:
-- one row per operation, with its outcome.
--
-- What a row carries, and what it never does:
--
--   - identifiers (session, lab, owner, the account that asked), an operation,
--     a closed outcome, a short machine code, a duration and a time;
--   - never a message, a command, terminal output, a requirement's expected
--     value, a credential, or anything a student typed. `code` is constrained
--     to an identifier shape so a provider's prose cannot land in it.
--
-- Append-only from the application's side, except for the retention purge,
-- which removes rows older than the retention window (see
-- apps/api/src/classroom/session-events.ts). No foreign keys, on purpose: an
-- event outlives the `lab_sessions` row it describes, and recording one must
-- never be able to fail the operation it records.
--
-- Additive only. No existing table, column or row is touched.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_events (
    event_id        BIGSERIAL    PRIMARY KEY,

    -- NULL only for a Start refused before any session existed (capacity full,
    -- the student already holds a lab, the lab's provider is down).
    session_id      TEXT,
    lab_id          TEXT         NOT NULL,
    -- The student whose lab this is.
    owner_user_id   UUID,
    -- Who asked: the student, a staff account, or NULL for the platform itself
    -- (the reaper's expiry and cleanup).
    actor_user_id   UUID,

    operation       TEXT         NOT NULL
                    CHECK (operation IN ('start', 'check', 'reset', 'end', 'cleanup', 'staff_end')),
    outcome         TEXT         NOT NULL
                    CHECK (outcome IN ('ok', 'pass', 'fail', 'error', 'refused', 'failed', 'pending')),
    code            TEXT,
    duration_ms     INTEGER,
    occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT session_events_code_shape CHECK (code IS NULL OR code ~ '^[A-Za-z0-9_.-]{1,64}$'),
    CONSTRAINT session_events_lab_shape CHECK (length(lab_id) BETWEEN 1 AND 64),
    CONSTRAINT session_events_duration CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

-- One session's history, newest first: the session detail view.
CREATE INDEX IF NOT EXISTS session_events_by_session
    ON session_events (session_id, event_id DESC) WHERE session_id IS NOT NULL;

-- One student's recent history: the student lookup.
CREATE INDEX IF NOT EXISTS session_events_by_owner
    ON session_events (owner_user_id, event_id DESC) WHERE owner_user_id IS NOT NULL;

-- The classroom's recent problems, and the retention purge.
CREATE INDEX IF NOT EXISTS session_events_by_time
    ON session_events (occurred_at);
