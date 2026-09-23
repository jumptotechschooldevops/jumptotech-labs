-- ---------------------------------------------------------------------------
-- Commercial access — entitlements, separate from identity.
--
-- Forward-only and checksum-verified like 001–005. To change this, add
-- 007_*.sql.
--
-- Until this migration, a `users` row *was* lab access: any account the
-- identity provider authenticated was provisioned as STUDENT and could use
-- every lab. These two tables let access be granted, bounded in time,
-- suspended and revoked without touching the account, its sign-ins, its
-- sessions or its progress. See docs/commercial-access.md.
--
-- Additive only. No existing table, column or row is altered, so a rollout
-- with the previous release still running is unaffected, and progress and
-- session history are never at risk from this file.
-- ---------------------------------------------------------------------------

-- Entitlements -----------------------------------------------------------
--
-- One row per (user, scope): the primary key is what makes "two conflicting
-- active grants for one student" unrepresentable. A repeated grant updates the
-- row; it cannot add a second one.
CREATE TABLE IF NOT EXISTS access_entitlements (
    -- No ON DELETE CASCADE. Access is not deleted as a side effect of anything;
    -- deleting a user is its own, currently unsupported, operation.
    user_id      UUID         NOT NULL REFERENCES users (user_id),

    -- `platform` = every lab. The only scope the product sells today; a
    -- narrower one (a track, a cohort) is a later migration widening this.
    scope        TEXT         NOT NULL CHECK (scope IN ('platform')),

    -- What an operator decided. EXPIRED and SCHEDULED are not stored: they are
    -- the clock against the window below, so nothing has to run for access to
    -- lapse on time.
    status       TEXT         NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),

    starts_at    TIMESTAMPTZ  NOT NULL,
    -- NULL means "no end date", and only ever by explicit choice: the CLI has
    -- no default expiry, and requires --until or --no-expiry.
    expires_at   TIMESTAMPTZ,

    -- How the row came to exist. Only an operator grants today; a payment
    -- integration would add its own value here (docs/commercial-access.md §9).
    granted_via  TEXT         NOT NULL CHECK (granted_via IN ('operator')),

    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, scope),
    CONSTRAINT access_entitlements_window CHECK (expires_at IS NULL OR expires_at > starts_at)
);

-- `access list` filters by status.
CREATE INDEX IF NOT EXISTS access_entitlements_by_status ON access_entitlements (status);

-- Access events ----------------------------------------------------------
--
-- Append-only: the application never updates or deletes a row. One per change
-- that took effect, written in the same transaction as the change, so there is
-- no change without its record.
--
-- `actor` is who the operator said they were. The operator socket is reachable
-- only through `docker exec` into the api container, so whoever writes here
-- already holds the host; `actor` attributes the action, it does not
-- authenticate it. `reason` is the operator's own words. Neither ever holds a
-- token, a cookie, a secret or anything a student typed.
CREATE TABLE IF NOT EXISTS access_events (
    event_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id            UUID         NOT NULL REFERENCES users (user_id),
    scope              TEXT         NOT NULL CHECK (scope IN ('platform')),
    -- Past tense on purpose: what happened, and never a word that reads as a
    -- privilege statement to a reviewer (or to backup-restore-safety.test.ts).
    action             TEXT         NOT NULL CHECK (action IN ('GRANTED', 'SUSPENDED', 'RESTORED', 'REVOKED')),
    actor              TEXT         NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
    reason             TEXT         NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),

    -- The row before (NULL for a first grant) and after the change.
    before_status      TEXT         CHECK (before_status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
    before_starts_at   TIMESTAMPTZ,
    before_expires_at  TIMESTAMPTZ,
    after_status       TEXT         NOT NULL CHECK (after_status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
    after_starts_at    TIMESTAMPTZ  NOT NULL,
    after_expires_at   TIMESTAMPTZ,

    occurred_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- "What happened to this student's access?" — newest first.
CREATE INDEX IF NOT EXISTS access_events_by_user ON access_events (user_id, occurred_at DESC);

-- Accounts are found by email when a student writes to support. Descriptive
-- only — never an authorization input — but a sequential scan per lookup is
-- not what a support engineer should wait on.
CREATE INDEX IF NOT EXISTS users_by_lower_email ON users (lower(email));
