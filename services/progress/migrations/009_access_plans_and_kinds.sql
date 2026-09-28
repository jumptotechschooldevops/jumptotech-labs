-- ---------------------------------------------------------------------------
-- Commercial access — a kind and a plan on every entitlement.
--
-- Forward-only and checksum-verified like every file before it. Numbered 009,
-- not 008: the migrator applies any version it has not seen, in name order,
-- and requires no contiguous numbering, so this file does not depend on
-- whatever 008 turns out to be. Nothing here touches another feature's tables.
--
-- `kind` says what sort of access a row is — ordinary, private beta, or a
-- trial — for people reading it; `plan_id` says what the access covers (which
-- tracks, how many labs at once), as defined in ACCESS_PLANS_FILE. See
-- docs/commercial-access.md §10.
--
-- Additive only. Every existing row becomes kind STANDARD with no plan, which
-- is exactly what it meant before this file: every track, the deployment's own
-- session limits. A release that predates this migration still reads and
-- writes these tables correctly — its INSERT names neither column and gets the
-- defaults — so a rolling deploy is safe in both directions.
-- ---------------------------------------------------------------------------

ALTER TABLE access_entitlements
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'STANDARD'
        CONSTRAINT access_entitlements_kind CHECK (kind IN ('STANDARD', 'BETA', 'TRIAL'));

-- NULL = no plan. A plan id is a reference into configuration, not a foreign
-- key: plans are not stored in the database. The api refuses lab use on an
-- entitlement whose plan the configuration no longer defines, rather than
-- reading a missing plan as "everything".
ALTER TABLE access_entitlements
    ADD COLUMN IF NOT EXISTS plan_id TEXT
        CONSTRAINT access_entitlements_plan_id CHECK (plan_id ~ '^[a-z0-9][a-z0-9-]{0,31}$');

-- The history records kind and plan before and after, like status and window.
-- Existing events predate kinds: they were all STANDARD with no plan.
ALTER TABLE access_events
    ADD COLUMN IF NOT EXISTS before_kind TEXT
        CONSTRAINT access_events_before_kind CHECK (before_kind IN ('STANDARD', 'BETA', 'TRIAL'));
ALTER TABLE access_events
    ADD COLUMN IF NOT EXISTS before_plan_id TEXT
        CONSTRAINT access_events_before_plan_id CHECK (before_plan_id ~ '^[a-z0-9][a-z0-9-]{0,31}$');
ALTER TABLE access_events
    ADD COLUMN IF NOT EXISTS after_kind TEXT NOT NULL DEFAULT 'STANDARD'
        CONSTRAINT access_events_after_kind CHECK (after_kind IN ('STANDARD', 'BETA', 'TRIAL'));
ALTER TABLE access_events
    ADD COLUMN IF NOT EXISTS after_plan_id TEXT
        CONSTRAINT access_events_after_plan_id CHECK (after_plan_id ~ '^[a-z0-9][a-z0-9-]{0,31}$');

-- "Has this account ever had a trial?" is asked under the user's lock on every
-- trial start; a trial is once per account, ever.
CREATE INDEX IF NOT EXISTS access_events_trials ON access_events (user_id) WHERE after_kind = 'TRIAL';
