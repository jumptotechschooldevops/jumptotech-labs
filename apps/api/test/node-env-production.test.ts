/**
 * `NODE_ENV=production` means the same thing to every api gate.
 *
 * The secret, TLS and browser-session gates trim the value; the public-origin
 * gate, the development-auth gate and the student-header default compared it
 * exactly. Under `NODE_ENV="production "` a localhost public origin was
 * accepted, AUTH_MODE=development was allowed, and the development student
 * header defaulted to on — while every other gate treated the deployment as
 * production.
 */
import { describe, expect, it } from 'vitest';
import { assertAuthModeAllowed } from '../src/auth/resolvers.js';
import { assertPublicOriginConfigured, loadProgressConfig } from '../src/config.js';

const PADDED = 'production ';

describe('api production gates under a padded NODE_ENV', () => {
  it('keeps the development student header off by default', () => {
    expect(loadProgressConfig({ NODE_ENV: PADDED }).allowStudentHeader).toBe(false);
  });

  it('refuses a localhost public origin', () => {
    expect(() =>
      assertPublicOriginConfigured({ nodeEnv: PADDED, appUrl: 'http://localhost:3000', looksLocal: true }),
    ).toThrow(/public origin/);
  });

  it('refuses development authentication', () => {
    expect(() => assertAuthModeAllowed({ mode: 'development', nodeEnv: PADDED })).toThrow(/AUTH_MODE=development/);
  });
});
