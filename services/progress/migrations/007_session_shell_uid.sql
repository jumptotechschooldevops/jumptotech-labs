-- ---------------------------------------------------------------------------
-- SEC-ARCH-2 — a Unix identity of its own for every session's shell.
--
-- Forward-only and applied exactly once, like every file before it.
--
-- Kubernetes- and Docker-track shells run in the terminal service's container.
-- They all ran as one uid, so one student could read another's kubeconfig or
-- Docker client key, write into their workspace and signal their processes.
-- Each session now has its own uid; see
-- services/lab-orchestrator/src/session/shell-identity.ts, which holds the same
-- bounds as the sequence and the CHECK below.
--
-- The uid is the column's DEFAULT, so PostgreSQL assigns it inside the INSERT
-- that creates the row:
--
--   - no two rows can get one value — a sequence hands each out once, and the
--     UNIQUE constraint holds even against a hand-written INSERT;
--   - an instance still running the previous release during a rollout, whose
--     INSERT names no such column, still gets a distinct uid for its session;
--   - `ADD COLUMN … DEFAULT nextval(…)` evaluates the default for every
--     existing row, so sessions already live when this runs get one each.
--
-- NO CYCLE is the "never reused" rule: when the range is spent, nextval fails,
-- the INSERT fails, and Start is refused rather than handing a new student a
-- uid something of a previous one's might still own.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS lab_session_shell_uid_seq
    AS BIGINT
    MINVALUE 1900000000
    MAXVALUE 1900999999
    START WITH 1900000000
    NO CYCLE;

ALTER TABLE lab_sessions
    ADD COLUMN IF NOT EXISTS shell_uid BIGINT
        NOT NULL
        DEFAULT nextval('lab_session_shell_uid_seq')
        CONSTRAINT lab_sessions_shell_uid_range
            CHECK (shell_uid BETWEEN 1900000000 AND 1900999999)
        CONSTRAINT lab_sessions_shell_uid_unique UNIQUE;

-- The column owns the sequence, so dropping one drops the other.
ALTER SEQUENCE lab_session_shell_uid_seq OWNED BY lab_sessions.shell_uid;
