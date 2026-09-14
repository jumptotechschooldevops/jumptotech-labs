-- BETA-P0-013 restore drill: representative, deterministic application data.
--
-- Loaded by scripts/db-restore-drill.sh into a disposable server after the real
-- migrations have run. Every durable table the api writes gets rows, with
-- foreign keys, CHECK constraints and a BIGSERIAL in play, so a restore that
-- lost an ordering, a constraint or a sequence position shows up.
--
--   users 6 · students 6 · lab_attempts 60 · lab_progress 60 · hint_usage 60
--   lab_sessions 12 · auth_sessions 6 · user_roles 3 (from 003) · schema_migrations
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

COMMIT;
