-- ---------------------------------------------------------------------------
-- PLATFORM-010 — browser authentication sessions.
--
-- Forward-only and checksum-verified like 001–003: the runner stores this
-- file's checksum and refuses to start if it is edited afterwards. To change
-- this, add 005_*.sql.
--
-- ## What a row is
--
-- One signed-in browser. The API is the confidential OIDC client (see
-- docs/authentication.md), so after the authorization-code exchange the browser
-- is handed an opaque id in an HttpOnly cookie and this table is what that id
-- indexes.
--
-- ## What is deliberately NOT here
--
-- No access token, no ID token, no refresh token, no client secret, no email.
-- The ID token is verified at callback time and discarded; only its claims
-- survive, as a `users` row that already existed before this migration. So a
-- copy of this table cannot be replayed against the identity provider and
-- cannot be mined for personal data — it is a hash, a foreign key and two
-- timestamps.
--
-- ## Why the primary key is a hash
--
-- `auth_session_id` stores SHA-256 of the cookie value, never the value itself.
-- A database read therefore yields nothing a caller could present. The input is
-- already 256 bits of uniform randomness, so a plain hash is right: there is no
-- dictionary to defend against, and a slow KDF would add latency to every
-- authenticated request for no gain.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_sessions (
  -- SHA-256 of the cookie value, lowercase hex. Never the cookie itself.
  auth_session_id  CHAR(64)     PRIMARY KEY,

  -- ON DELETE CASCADE is the revocation path: removing a user removes every
  -- browser session they hold, in one statement, with no application code
  -- involved and no window in which a deleted account still has a live cookie.
  user_id          UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ  NOT NULL,

  -- A session that expires before it was created is a clock or a caller bug,
  -- and it is cheaper to refuse the row than to debug the lookup later.
  CONSTRAINT auth_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

-- The purge sweep deletes by expiry; without this it is a sequential scan over
-- every live session on every tick.
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
    ON auth_sessions (expires_at);

-- "Sign this user out everywhere" — used when an account is disabled, and by
-- the cascade above.
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
    ON auth_sessions (user_id);
