-- ---------------------------------------------------------------------------
-- Commercial access — a billing provider as a second source of entitlements.
--
-- Forward-only and checksum-verified like every file before it. See
-- docs/commercial-access.md §9 and docs/billing.md.
--
-- Until this file an account had at most one entitlement row: the one an
-- operator wrote. A paid subscription is a different decision by a different
-- party, so it gets its own row (granted_via = 'billing') instead of
-- overwriting the operator's: a manual beta row and a subscription can
-- coexist, cancelling one never removes the other, and the history says which
-- was which. Suspension stays account-wide and stays an operator's: the api
-- refuses lab use while any of an account's rows is SUSPENDED.
--
-- The billing tables hold provider *references* and product state only. There
-- is no column for a card number, a CVV, a bank account, an address or a
-- payment credential, and there never should be: payment details stay with
-- the provider's hosted pages.
--
-- Additive for existing data: every existing entitlement is an operator row
-- and keeps exactly its meaning. The primary key widens from (user, scope) to
-- (user, scope, source), which every existing row already satisfies.
-- ---------------------------------------------------------------------------

-- Sources ----------------------------------------------------------------

ALTER TABLE access_entitlements DROP CONSTRAINT IF EXISTS access_entitlements_granted_via_check;
ALTER TABLE access_entitlements
    ADD CONSTRAINT access_entitlements_granted_via CHECK (granted_via IN ('operator', 'billing'));

-- One row per (user, scope, source): an operator row and a billing row may
-- coexist; two billing rows for one account may not.
ALTER TABLE access_entitlements DROP CONSTRAINT IF EXISTS access_entitlements_pkey;
ALTER TABLE access_entitlements
    ADD CONSTRAINT access_entitlements_pkey PRIMARY KEY (user_id, scope, granted_via);

-- SUBSCRIPTION is the kind a paid subscription's row carries. Which source may
-- write which kind is part of the schema, so an operator row can never claim
-- to be a subscription and a billing row can never claim to be a beta.
ALTER TABLE access_entitlements DROP CONSTRAINT IF EXISTS access_entitlements_kind;
ALTER TABLE access_entitlements
    ADD CONSTRAINT access_entitlements_kind CHECK (kind IN ('STANDARD', 'BETA', 'TRIAL', 'SUBSCRIPTION'));
ALTER TABLE access_entitlements
    ADD CONSTRAINT access_entitlements_kind_by_source CHECK (
        (granted_via = 'operator' AND kind IN ('STANDARD', 'BETA', 'TRIAL'))
        OR (granted_via = 'billing' AND kind IN ('SUBSCRIPTION', 'TRIAL'))
    );

-- The history names the source of each change, and a billing change is SYNCED:
-- the row was brought in line with the provider's state.
ALTER TABLE access_events
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'operator'
        CONSTRAINT access_events_source CHECK (source IN ('operator', 'billing'));
ALTER TABLE access_events DROP CONSTRAINT IF EXISTS access_events_action_check;
ALTER TABLE access_events
    ADD CONSTRAINT access_events_action CHECK (action IN ('GRANTED', 'SUSPENDED', 'RESTORED', 'REVOKED', 'SYNCED'));
ALTER TABLE access_events DROP CONSTRAINT IF EXISTS access_events_before_kind;
ALTER TABLE access_events
    ADD CONSTRAINT access_events_before_kind CHECK (before_kind IN ('STANDARD', 'BETA', 'TRIAL', 'SUBSCRIPTION'));
ALTER TABLE access_events DROP CONSTRAINT IF EXISTS access_events_after_kind;
ALTER TABLE access_events
    ADD CONSTRAINT access_events_after_kind CHECK (after_kind IN ('STANDARD', 'BETA', 'TRIAL', 'SUBSCRIPTION'));

-- Billing ------------------------------------------------------------------
--
-- `provider` is the configured provider's id (`test` today). Every external
-- identifier is opaque text with a bound; none is ever taken from a browser.

-- Which provider customer is which account. Written only from a verified
-- webhook for a checkout this platform created for that account.
CREATE TABLE IF NOT EXISTS billing_customers (
    provider      TEXT         NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,15}$'),
    customer_ref  TEXT         NOT NULL CHECK (length(customer_ref) BETWEEN 1 AND 255),
    user_id       UUID         NOT NULL REFERENCES users (user_id),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, customer_ref),
    -- One customer per account per provider: the portal link is unambiguous.
    CONSTRAINT billing_customers_one_per_user UNIQUE (provider, user_id)
);

-- Checkouts this platform started, for whom and for which offer. A completed
-- checkout the provider reports that is not in here is not ours to act on.
CREATE TABLE IF NOT EXISTS billing_checkouts (
    provider      TEXT         NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,15}$'),
    checkout_ref  TEXT         NOT NULL CHECK (length(checkout_ref) BETWEEN 1 AND 255),
    user_id       UUID         NOT NULL REFERENCES users (user_id),
    offer_id      TEXT         NOT NULL CHECK (offer_id ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ,
    PRIMARY KEY (provider, checkout_ref)
);
CREATE INDEX IF NOT EXISTS billing_checkouts_by_user ON billing_checkouts (user_id, created_at DESC);

-- The provider's subscriptions, as last reported. `provider_state_at` is when
-- the provider produced the state stored here: an event carrying an older
-- state than this is recorded and ignored, never applied over a newer one.
CREATE TABLE IF NOT EXISTS billing_subscriptions (
    provider              TEXT         NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,15}$'),
    subscription_ref      TEXT         NOT NULL CHECK (length(subscription_ref) BETWEEN 1 AND 255),
    user_id               UUID         NOT NULL REFERENCES users (user_id),
    customer_ref          TEXT         NOT NULL CHECK (length(customer_ref) BETWEEN 1 AND 255),
    price_ref             TEXT         NOT NULL CHECK (length(price_ref) BETWEEN 1 AND 255),
    -- The plan the price maps to when this state was applied; NULL = no plan.
    plan_id               TEXT         CHECK (plan_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
    status                TEXT         NOT NULL CHECK (status IN (
                                           'incomplete', 'incomplete_expired', 'trialing', 'active',
                                           'past_due', 'unpaid', 'canceled', 'paused')),
    current_period_start  TIMESTAMPTZ  NOT NULL,
    current_period_end    TIMESTAMPTZ  NOT NULL,
    cancel_at_period_end  BOOLEAN      NOT NULL,
    ended_at              TIMESTAMPTZ,
    provider_state_at     TIMESTAMPTZ  NOT NULL,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subscription_ref),
    CONSTRAINT billing_subscriptions_period CHECK (current_period_end > current_period_start)
);
CREATE INDEX IF NOT EXISTS billing_subscriptions_by_user ON billing_subscriptions (user_id);

-- Every provider event that was processed, keyed by the provider's own id.
-- Written in the same transaction as the change it caused, so a retried event
-- is recognised and changes nothing, and an event whose processing failed is
-- absent and is processed again when the provider retries it. The payload is
-- not stored.
CREATE TABLE IF NOT EXISTS billing_events (
    provider          TEXT         NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,15}$'),
    event_id          TEXT         NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
    event_type        TEXT         NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
    outcome           TEXT         NOT NULL CHECK (outcome IN ('applied', 'stale', 'ignored')),
    subscription_ref  TEXT         CHECK (length(subscription_ref) BETWEEN 1 AND 255),
    occurred_at       TIMESTAMPTZ  NOT NULL,
    processed_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, event_id)
);
CREATE INDEX IF NOT EXISTS billing_events_by_time ON billing_events (processed_at DESC);
