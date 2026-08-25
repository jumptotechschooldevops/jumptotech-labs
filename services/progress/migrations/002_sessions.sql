-- ---------------------------------------------------------------------------
-- PLATFORM-008 — durable lab sessions.
--
-- Forward-only and applied exactly once, like 001: the runner stores this
-- file's checksum and refuses to start if it is edited afterwards. To change
-- the schema, add 003_*.sql.
--
-- Why sessions live in the same database as progress: one platform database
-- was the decision for this story, and both are platform bookkeeping written
-- by the same API. Nothing here is reachable from a student sandbox — sandboxes
-- have no database credentials and no route to this host.
--
-- What this table is NOT: the authority on whether a sandbox exists. The
-- cluster and the Docker daemon remain that. This table is what lets any API
-- instance — or the same one after a restart — resolve a session it did not
-- create, and what lets the reaper find expired sessions that no process
-- remembers. The reconciliation between the two is the reaper's job, unchanged.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_sessions (
    -- The externally visible identity, generated with a CSPRNG by the session
    -- manager. Deliberately the primary key: there is no sequential id to leak
    -- or to guess, and nothing outside ever sees a row number.
    session_id            TEXT        PRIMARY KEY,

    lab_id                TEXT        NOT NULL,
    provider              TEXT        NOT NULL,
    sandbox_kind          TEXT        NOT NULL,

    -- The provider's handle for the sandbox, derived server-side from the
    -- session id. UNIQUE is the durable form of a guarantee the in-memory store
    -- made in code: two sessions can never be handed the same sandbox, and now
    -- two *instances* cannot either.
    sandbox_ref           TEXT        NOT NULL UNIQUE,

    namespace             TEXT        NOT NULL,
    service_account_name  TEXT        NOT NULL,

    status                TEXT        NOT NULL,
    environment_id        TEXT        NOT NULL,

    created_at            TIMESTAMPTZ NOT NULL,
    last_activity_at      TIMESTAMPTZ NOT NULL,
    -- Absolute deadline. Activity never moves it; only the idle window slides.
    expires_at            TIMESTAMPTZ NOT NULL,
    ended_at              TIMESTAMPTZ,

    status_reason         TEXT,
    idle_timeout_seconds  INTEGER     NOT NULL,
    idle_warning_seconds  INTEGER     NOT NULL,

    -- Optimistic concurrency. Every write bumps it, so a caller holding a stale
    -- copy of a row cannot overwrite a newer one: its conditional UPDATE simply
    -- matches nothing. This is what makes two API instances safe on one session
    -- without a process-local mutex, which could not protect the other process
    -- anyway.
    revision              BIGINT      NOT NULL DEFAULT 1,

    CONSTRAINT lab_sessions_status_known CHECK (
        status IN ('CREATING','ACTIVE','RESETTING','EXPIRING','ENDING',
                   'EXPIRED','ENDED','FAILED')
    )
);

-- Capacity accounting and the reaper's candidate scan both filter on status,
-- and the reaper additionally orders by deadline.
CREATE INDEX IF NOT EXISTS lab_sessions_by_status
    ON lab_sessions (status);

CREATE INDEX IF NOT EXISTS lab_sessions_expiry_scan
    ON lab_sessions (status, expires_at);

-- Idle expiry reads this; kept separate from the absolute deadline because the
-- two move independently.
CREATE INDEX IF NOT EXISTS lab_sessions_by_activity
    ON lab_sessions (status, last_activity_at);
