/**
 * BETA-P0-010 — credentials the platform is issued, redacted whatever their shape.
 *
 * The startup self-test used to cover only the secrets this platform generates,
 * because only those have a shape the patterns recognise. `OIDC_CLIENT_SECRET`
 * and `POSTGRES_PASSWORD` were left out, and adding them naively would refuse
 * to boot on a perfectly good Auth0 or Keycloak client secret. Registering the
 * exact values is what lets them be in the self-test *and* redacted.
 *
 * Its own file because the registry is process state: vitest isolates files,
 * so nothing registered here can mask a missing pattern in `redact.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSecretsAreRedactable,
  containsSecret,
  redactString,
  redactValue,
  registerSecretValues,
} from '../src/redact.js';

// Shapes no pattern recognises: base64url with `-`/`_` breaking every 40-run,
// Google's `GOCSPX-` form, a Keycloak-style 32-character alphanumeric, and an
// operator-chosen database password.
const AUTH0_STYLE = 'Xk9_qL2-vB7nR4-tY8wZ1_cF6hJ3-mP0sD5_gA2kE9-uI4oW7_yT1rQ6-zN3bV8x';
const GOOGLE_STYLE = 'GOCSPX-kQ3vZ8nB1mT6rW4yH9pL2sD7fJ0';
const KEYCLOAK_STYLE = 'Zq7Rk2Lp9Wm4Tn6Yb1Vx3Hc8Js5Gd0Fa';
const DB_PASSWORD = 'correct-Horse!battery*staple';

describe('configured secrets of any shape', () => {
  it('would survive a log line without registration', () => {
    for (const value of [AUTH0_STYLE, GOOGLE_STYLE, KEYCLOAK_STYLE, DB_PASSWORD]) {
      expect(containsSecret(`token exchange failed for ${value}`)).toBe(false);
    }
    expect(() =>
      assertSecretsAreRedactable({ OIDC_CLIENT_SECRET: AUTH0_STYLE, POSTGRES_PASSWORD: DB_PASSWORD }),
    ).toThrow(/OIDC_CLIENT_SECRET, POSTGRES_PASSWORD/);
  });

  it('are redacted everywhere once registered, and pass the self-test', () => {
    registerSecretValues([AUTH0_STYLE, GOOGLE_STYLE, KEYCLOAK_STYLE, DB_PASSWORD, undefined, '']);

    for (const value of [AUTH0_STYLE, GOOGLE_STYLE, KEYCLOAK_STYLE, DB_PASSWORD]) {
      const line = redactString(`upstream said: invalid_client (${value}) at attempt 2`);
      expect(line).not.toContain(value);
      expect(line).toContain('[REDACTED:configured-secret]');
      expect(line).toContain('upstream said: invalid_client');
    }

    const nested = JSON.stringify(redactValue({ err: new Error(`auth ${GOOGLE_STYLE}`), list: [DB_PASSWORD] }));
    expect(nested).not.toContain(GOOGLE_STYLE);
    expect(nested).not.toContain(DB_PASSWORD);

    expect(() =>
      assertSecretsAreRedactable({
        OIDC_CLIENT_SECRET: AUTH0_STYLE,
        POSTGRES_PASSWORD: DB_PASSWORD,
      }),
    ).not.toThrow();
  });

  it('does not register values too short to redact safely', () => {
    registerSecretValues(['test']);
    expect(redactString('run the test suite')).toBe('run the test suite');
  });
});
