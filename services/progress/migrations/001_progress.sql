-- ---------------------------------------------------------------------------
-- PLATFORM-005 — persistent student progress and lab attempts.
--
-- Forward-only. This file is applied exactly once per database and is then
-- immutable: the migration runner stores its checksum and refuses to start if
-- an already-applied migration was edited afterwards. To change the schema,
-- add 002_*.sql.
--
-- Nothing here drops, truncates, or rewrites data, and nothing here is
-- provider-specific: `track` and `session_id` are plain identifiers, so
-- deleting a Kubernetes namespace or a Linux container cannot reach any row.
-- ---------------------------------------------------------------------------

-- Students ------------------------------------------------------------------
--
-- `identity_source` records how the identity was established. Every row
-- created in PLATFORM-005 says `development-*`, because there is no login yet
-- (see services/progress/src/identity.ts). Keeping the column means the rows
-- written before authentication are not silently reinterpreted as
-- authenticated users afterwards.
CREATE TABLE students (
    student_id      TEXT PRIMARY KEY,
    display_name    TEXT,
    identity_source TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    last_seen_at    TIMESTAMPTZ NOT NULL,
    CONSTRAINT students_id_shape CHECK (student_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$')
);

-- Lab attempts ---------------------------------------------------------------
--
-- One row per "the student pressed Start Lab". The row is created *before* a
-- sandbox exists and outlives it by design:
--
--   session_id     the sandbox that hosted the attempt, if one was created.
--                  Nullable and deliberately NOT a foreign key — sessions live
--                  in the orchestrator and are deleted on cleanup, and history
--                  must not be deletable by a namespace teardown.
--   completed_at   when the verifier first returned PASS.  Learning.
--   ended_at       when the sandbox went away.             Infrastructure.
--
-- Those two timestamps are what makes "pass, then let the lab expire" record
-- the truth instead of one fact overwriting the other.
CREATE TABLE lab_attempts (
    attempt_id    UUID        PRIMARY KEY,
    seq           BIGSERIAL   NOT NULL,
    student_id    TEXT        NOT NULL REFERENCES students (student_id) ON DELETE CASCADE,
    lab_id        TEXT        NOT NULL,
    track         TEXT        NOT NULL,
    session_id    TEXT,
    status        TEXT        NOT NULL
                  CHECK (status IN ('IN_PROGRESS', 'PASSED', 'FAILED', 'ENDED', 'EXPIRED')),
    status_reason TEXT,
    started_at    TIMESTAMPTZ NOT NULL,
    completed_at  TIMESTAMPTZ,
    ended_at      TIMESTAMPTZ,
    check_count   INTEGER     NOT NULL DEFAULT 0 CHECK (check_count >= 0),
    reset_count   INTEGER     NOT NULL DEFAULT 0 CHECK (reset_count >= 0),
    updated_at    TIMESTAMPTZ NOT NULL,
    -- A passing attempt must carry the moment it passed, and only a passing
    -- attempt may. Enforced here so no code path can produce a half-truth.
    CONSTRAINT lab_attempts_completed_at_matches_status
        CHECK ((status = 'PASSED') = (completed_at IS NOT NULL))
);

-- The dashboard's "recent attempts" query.
CREATE INDEX lab_attempts_by_student ON lab_attempts (student_id, started_at DESC, seq DESC);

-- Every session-scoped write resolves its attempt through this.
CREATE UNIQUE INDEX lab_attempts_by_session ON lab_attempts (session_id) WHERE session_id IS NOT NULL;

-- Lab progress ---------------------------------------------------------------
--
-- The student's standing on one lab, independent of any sandbox and of any
-- single attempt. The primary key is what makes repeated passes structurally
-- incapable of creating a duplicate completion: there is one row per
-- (student, lab), and a second pass updates it.
CREATE TABLE lab_progress (
    student_id         TEXT        NOT NULL REFERENCES students (student_id) ON DELETE CASCADE,
    lab_id             TEXT        NOT NULL,
    track              TEXT        NOT NULL,
    status             TEXT        NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
    attempt_count      INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    completion_count   INTEGER     NOT NULL DEFAULT 0 CHECK (completion_count >= 0),
    first_completed_at TIMESTAMPTZ,
    last_completed_at  TIMESTAMPTZ,
    last_attempt_id    UUID,
    first_attempt_at   TIMESTAMPTZ NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (student_id, lab_id),
    CONSTRAINT lab_progress_completed_has_timestamp
        CHECK ((status = 'COMPLETED') = (first_completed_at IS NOT NULL))
);

CREATE INDEX lab_progress_by_track ON lab_progress (student_id, track);

-- Hint usage -----------------------------------------------------------------
--
-- One row per hint actually revealed. The uniqueness constraint is the
-- idempotence guarantee: a frontend that replays the same reveal — or two tabs
-- racing on the same attempt — cannot inflate the count, because the second
-- insert conflicts instead of writing.
CREATE TABLE hint_usage (
    hint_usage_id UUID        PRIMARY KEY,
    student_id    TEXT        NOT NULL REFERENCES students (student_id) ON DELETE CASCADE,
    attempt_id    UUID        NOT NULL REFERENCES lab_attempts (attempt_id) ON DELETE CASCADE,
    lab_id        TEXT        NOT NULL,
    hint_index    INTEGER     NOT NULL CHECK (hint_index >= 1),
    revealed_at   TIMESTAMPTZ NOT NULL,
    CONSTRAINT hint_usage_once_per_attempt UNIQUE (attempt_id, hint_index)
);

CREATE INDEX hint_usage_by_student ON hint_usage (student_id, revealed_at DESC);
