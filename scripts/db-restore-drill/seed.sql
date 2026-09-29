-- BETA-P0-013 restore drill: representative, deterministic application data.
--
-- Loaded by scripts/db-restore-drill.sh into a disposable server after the real
-- migrations have run. Every durable table the api writes gets rows, with
-- foreign keys, CHECK constraints and a BIGSERIAL in play, so a restore that
-- lost an ordering, a constraint or a sequence position shows up.
--
--   users 6 · students 6 · lab_attempts 60 · lab_progress 60 · hint_usage 60
--   lab_sessions 12 · auth_sessions 6 · user_roles 3 (from 003) · schema_migrations
--   access_entitlements 6 · access_events 9 · session_events 37
--   billing_customers, billing_checkouts, billing_subscriptions, billing_events 1 each
--
-- Known record: drill-student-003 has 10 labs, 7 of them COMPLETED.
-- Nothing here is a credential: auth_sessions holds hashes of made-up ids.

BEGIN;

INSERT INTO users (user_id, issuer, subject, email, display_name, role, created_at, updated_at)
SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
       'https://idp.drill.invalid',
       'drill-subject-' || n,
       'student' || n || '@drill.invalid',
       'Drill Student ' || n,
       CASE WHEN n = 1 THEN 'INSTRUCTOR' ELSE 'STUDENT' END,
       timestamptz '2026-09-01 09:00:00+00' + n * interval '1 minute',
       timestamptz '2026-09-01 09:00:00+00' + n * interval '1 minute'
  FROM generate_series(1, 6) AS n;

INSERT INTO students (student_id, display_name, identity_source, created_at, last_seen_at)
SELECT 'drill-student-' || lpad(n::text, 3, '0'),
       'Drill Student ' || n,
       'oidc',
       timestamptz '2026-09-01 09:00:00+00' + n * interval '1 minute',
       timestamptz '2026-09-02 09:00:00+00' + n * interval '1 minute'
  FROM generate_series(1, 6) AS n;

-- Every third lab failed; the rest passed.
INSERT INTO lab_attempts (attempt_id, student_id, lab_id, track, session_id, status, status_reason,
                          started_at, completed_at, ended_at, check_count, reset_count, updated_at)
SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(s * 100 + l), 12, '0'))::uuid,
       'drill-student-' || lpad(s::text, 3, '0'),
       'K8S-' || lpad(l::text, 3, '0'),
       'kubernetes',
       'sess-drill-' || s || '-' || l,
       CASE WHEN l % 3 = 0 THEN 'FAILED' ELSE 'PASSED' END,
       CASE WHEN l % 3 = 0 THEN 'checks failed' END,
       started,
       CASE WHEN l % 3 = 0 THEN NULL ELSE started + interval '20 minutes' END,
       started + interval '25 minutes',
       l % 4,
       l % 2,
       started + interval '25 minutes'
  FROM generate_series(1, 6) AS s,
       generate_series(1, 10) AS l,
       LATERAL (SELECT timestamptz '2026-09-02 10:00:00+00' + (s * 10 + l) * interval '1 hour' AS started) AS t
 ORDER BY s, l;

INSERT INTO lab_progress (student_id, lab_id, track, status, attempt_count, completion_count,
                          first_completed_at, last_completed_at, last_attempt_id, first_attempt_at, updated_at)
SELECT student_id, lab_id, track,
       CASE WHEN status = 'PASSED' THEN 'COMPLETED' ELSE 'IN_PROGRESS' END,
       1,
       CASE WHEN status = 'PASSED' THEN 1 ELSE 0 END,
       completed_at, completed_at, attempt_id, started_at, updated_at
  FROM lab_attempts;

INSERT INTO hint_usage (hint_usage_id, student_id, attempt_id, lab_id, hint_index, revealed_at)
SELECT md5(a.attempt_id::text || '/' || h)::uuid, a.student_id, a.attempt_id, a.lab_id, h,
       a.started_at + h * interval '5 minutes'
  FROM lab_attempts AS a, generate_series(1, 2) AS h
 WHERE a.check_count % 2 = 0;

INSERT INTO lab_sessions (session_id, lab_id, provider, sandbox_kind, sandbox_ref, namespace,
                          service_account_name, status, environment_id, created_at, last_activity_at,
                          expires_at, ended_at, status_reason, idle_timeout_seconds, idle_warning_seconds,
                          revision, owner_user_id, status_changed_at)
SELECT 'sess-drill-live-' || n,
       'K8S-' || lpad((n % 9 + 1)::text, 3, '0'),
       'kubernetes',
       'namespace',
       'jtt-lab-drill-' || n,
       'jtt-lab-drill-' || n,
       'student',
       (ARRAY['ACTIVE', 'ENDED', 'EXPIRED', 'DEGRADED', 'FAILED'])[n % 5 + 1],
       'env-drill-' || n,
       created,
       created + interval '5 minutes',
       created + interval '1 hour',
       CASE WHEN n % 5 IN (1, 2, 4) THEN created + interval '30 minutes' END,
       CASE WHEN n % 5 = 4 THEN 'provider unavailable' END,
       1200,
       300,
       n,
       ('00000000-0000-4000-8000-' || lpad(to_hex(n % 6 + 1), 12, '0'))::uuid,
       created + interval '30 minutes'
  FROM generate_series(1, 12) AS n,
       LATERAL (SELECT timestamptz '2026-09-03 08:00:00+00' + n * interval '10 minutes' AS created) AS t;

INSERT INTO auth_sessions (auth_session_id, user_id, created_at, expires_at)
SELECT encode(sha256(convert_to('drill-auth-session-' || n, 'UTF8')), 'hex'),
       ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
       created,
       created + interval '12 hours'
  FROM generate_series(1, 6) AS n,
       LATERAL (SELECT timestamptz '2026-09-04 08:00:00+00' + n * interval '1 minute' AS created) AS t;

-- Lab access (006, 009, 010): operator rows for users 2–6 — a trial on a plan,
-- a beta grant, one suspended, one revoked — and user 6 also pays, so an
-- operator row and a billing row share an account. access_events is an
-- identity column; its position is fingerprinted like any sequence.
INSERT INTO access_entitlements (user_id, scope, status, starts_at, expires_at, granted_via, created_at, updated_at)
SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, 'platform',
       (ARRAY['ACTIVE','ACTIVE','SUSPENDED','REVOKED','ACTIVE'])[n-1],
       timestamptz '2026-09-01 00:00:00+00', CASE WHEN n = 6 THEN NULL ELSE timestamptz '2026-12-01 00:00:00+00' END,
       'operator', timestamptz '2026-09-01 00:00:00+00', timestamptz '2026-09-05 00:00:00+00'
  FROM generate_series(2, 6) AS n;
INSERT INTO access_events (user_id, scope, action, actor, reason, before_status, after_status, after_starts_at, after_expires_at, occurred_at)
SELECT user_id, scope, 'GRANTED', 'drill-operator', 'drill grant', NULL, 'ACTIVE', starts_at, expires_at, created_at FROM access_entitlements;
INSERT INTO access_events (user_id, scope, action, actor, reason, before_status, after_status, after_starts_at, after_expires_at, occurred_at)
SELECT user_id, scope, CASE status WHEN 'SUSPENDED' THEN 'SUSPENDED' ELSE 'REVOKED' END, 'drill-operator', 'drill change', 'ACTIVE', status, starts_at, expires_at, updated_at
  FROM access_entitlements WHERE status <> 'ACTIVE';
UPDATE access_entitlements SET kind = 'TRIAL', plan_id = 'trial-linux' WHERE user_id = '00000000-0000-4000-8000-000000000002';
UPDATE access_entitlements SET kind = 'BETA' WHERE user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO access_events (user_id, scope, action, actor, reason, before_status, after_status, after_starts_at, after_expires_at, after_kind, after_plan_id, occurred_at)
VALUES ('00000000-0000-4000-8000-000000000002', 'platform', 'GRANTED', 'drill-operator', 'drill trial', 'ACTIVE', 'ACTIVE',
        timestamptz '2026-09-01 00:00:00+00', timestamptz '2026-12-01 00:00:00+00', 'TRIAL', 'trial-linux', timestamptz '2026-09-06 00:00:00+00');

-- What happened to each session (008): start, check, end, and one refused Start.
INSERT INTO session_events (session_id, lab_id, owner_user_id, actor_user_id, operation, outcome, code, duration_ms, occurred_at)
SELECT s.session_id, s.lab_id, s.owner_user_id, s.owner_user_id, op, CASE WHEN op = 'check' THEN 'fail' ELSE 'ok' END,
       CASE WHEN op = 'check' THEN 'CHECKS_FAILED' END, 1000 + length(op), s.created_at + interval '1 minute'
  FROM lab_sessions AS s, unnest(ARRAY['start','check','end']) AS op;
INSERT INTO session_events (session_id, lab_id, owner_user_id, operation, outcome, code, occurred_at)
VALUES (NULL, 'K8S-001', '00000000-0000-4000-8000-000000000002', 'start', 'refused', 'CAPACITY_FULL', timestamptz '2026-09-06 00:00:00+00');

-- Billing (010): one customer, checkout, subscription and processed event.
INSERT INTO billing_customers (provider, customer_ref, user_id, created_at)
VALUES ('test', 'cus_drill_6', '00000000-0000-4000-8000-000000000006', timestamptz '2026-09-07 00:00:00+00');
INSERT INTO billing_checkouts (provider, checkout_ref, user_id, offer_id, created_at, completed_at)
VALUES ('test', 'cs_drill_6', '00000000-0000-4000-8000-000000000006', 'monthly', timestamptz '2026-09-07 00:00:00+00', timestamptz '2026-09-07 00:01:00+00');
INSERT INTO billing_subscriptions (provider, subscription_ref, user_id, customer_ref, price_ref, plan_id, status,
  current_period_start, current_period_end, cancel_at_period_end, provider_state_at, created_at, updated_at)
VALUES ('test', 'sub_drill_6', '00000000-0000-4000-8000-000000000006', 'cus_drill_6', 'price_monthly', NULL, 'active',
  timestamptz '2026-09-07 00:00:00+00', timestamptz '2026-10-07 00:00:00+00', false, timestamptz '2026-09-07 00:01:00+00',
  timestamptz '2026-09-07 00:01:00+00', timestamptz '2026-09-07 00:01:00+00');
INSERT INTO billing_events (provider, event_id, event_type, outcome, subscription_ref, occurred_at, processed_at)
VALUES ('test', 'evt_drill_1', 'checkout.completed', 'applied', 'sub_drill_6', timestamptz '2026-09-07 00:01:00+00', timestamptz '2026-09-07 00:01:01+00');
INSERT INTO access_entitlements (user_id, scope, status, starts_at, expires_at, granted_via, kind, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000006', 'platform', 'ACTIVE', timestamptz '2026-09-07 00:00:00+00',
        timestamptz '2026-10-07 00:00:00+00', 'billing', 'SUBSCRIPTION', timestamptz '2026-09-07 00:01:00+00', timestamptz '2026-09-07 00:01:00+00');
INSERT INTO access_events (user_id, scope, action, actor, reason, before_status, after_status, after_starts_at, after_expires_at, after_kind, source, occurred_at)
VALUES ('00000000-0000-4000-8000-000000000006', 'platform', 'SYNCED', 'billing', 'subscription active', NULL, 'ACTIVE',
        timestamptz '2026-09-07 00:00:00+00', timestamptz '2026-10-07 00:00:00+00', 'SUBSCRIPTION', 'billing', timestamptz '2026-09-07 00:01:00+00');

COMMIT;
