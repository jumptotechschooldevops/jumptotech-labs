-- ---------------------------------------------------------------------------
-- PLATFORM-009 — authenticated users, and the session ownership that hangs off
-- them.
--
-- Forward-only and checksum-verified like 001 and 002. To change this, add
-- 004_*.sql.
--
-- The identity question this settles: *what is a user, permanently?* Not the
-- email — people change those, and reusing a freed address would silently hand
-- one person another's history. Not the display name. The pair the provider
-- guarantees stable is (issuer, subject), so that pair is the external identity
-- and everything else is descriptive.
--
-- Nothing here stores a credential. No password, no access token, no refresh
-- token, no provider secret. Those live in configuration or are held only for
-- the length of a request; this table describes who someone is, not how they
-- proved it.
-- ---------------------------------------------------------------------------

-- Roles -----------------------------------------------------------------
--
-- Three, deliberately. INSTRUCTOR is not a weaker ADMIN: it exists to support
-- students, and what it may do is decided by policy rather than by ordering
-- these values. See apps/api/src/auth/policy.ts.
CREATE TABLE IF NOT EXISTS user_roles (
    role  TEXT PRIMARY KEY
);

INSERT INTO user_roles (role) VALUES ('STUDENT'), ('INSTRUCTOR'), ('ADMIN')
    ON CONFLICT (role) DO NOTHING;

-- Users -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    -- Internal surrogate key. Never exposed: the API speaks in session ids and
    -- the caller's own identity, so there is no row number for anyone to guess
    -- or enumerate.
    user_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The external identity, exactly as the provider asserts it.
    issuer        TEXT        NOT NULL,
    subject       TEXT        NOT NULL,

    -- Descriptive only. Both may change on any login and neither is ever used
    -- to decide authorization.
    email         TEXT,
    display_name  TEXT,

    role          TEXT        NOT NULL DEFAULT 'STUDENT' REFERENCES user_roles (role),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One account per (issuer, subject). Two providers may legitimately both
    -- issue subject "12345"; they are different people.
    CONSTRAINT users_external_identity UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS users_by_role ON users (role);

-- Session ownership -----------------------------------------------------
--
-- Nullable on purpose, and this is the migration's one judgement call.
-- PLATFORM-008 sessions were created before authentication existed and have no
-- owner. Assigning them to some arbitrary user would be a fabrication, and
-- deleting them would destroy live sandboxes. They keep a NULL owner, and the
-- authorization layer treats NULL as "owned by nobody" — unreachable by any
-- student, reapable as normal. New sessions always carry an owner because the
-- API sets it from the authenticated caller and there is no request field for
-- it.
ALTER TABLE lab_sessions
    ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users (user_id);

CREATE INDEX IF NOT EXISTS lab_sessions_by_owner ON lab_sessions (owner_user_id);
