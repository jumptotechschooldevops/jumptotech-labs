/**
 * The E2E identity provider accepts any username, so it must refuse to run
 * anywhere that could be production. No browser involved: this starts the
 * provider as a process with each unsafe configuration and requires it to exit
 * with the refusal code before listening.
 *
 * Lives here rather than in a Vitest suite because unit suites deny host
 * process execution (test-support/host-execution.ts), and it should not be
 * bypassed for this.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../oidc-provider/server.mjs');

const SAFE = {
  E2E_OIDC_PORT: '0',
  E2E_OIDC_ISSUER: 'http://oidc:9500',
  E2E_OIDC_BROWSER_BASE: 'http://127.0.0.1:39799',
  E2E_OIDC_CLIENT_ID: 'jumptotech-labs-e2e',
  E2E_OIDC_CLIENT_SECRET: randomBytes(32).toString('hex'),
  E2E_OIDC_REDIRECT_URI: 'http://127.0.0.1:33700/auth/callback',
};

function start(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? '', ...SAFE, ...overrides },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('[guard] the test identity provider refuses production and non-loopback configurations', () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['NODE_ENV=production', { NODE_ENV: 'production' }, /NODE_ENV=production/],
    ['https public issuer', { E2E_OIDC_ISSUER: 'https://login.example.com' }, /E2E_OIDC_ISSUER/],
    ['public browser base', { E2E_OIDC_BROWSER_BASE: 'http://idp.example.com' }, /E2E_OIDC_BROWSER_BASE/],
    ['public redirect URI', { E2E_OIDC_REDIRECT_URI: 'https://labs.example.com/auth/callback' }, /E2E_OIDC_REDIRECT_URI/],
    ['short client secret', { E2E_OIDC_CLIENT_SECRET: 'short' }, /E2E_OIDC_CLIENT_SECRET/],
  ];
  for (const [name, overrides, reason] of cases) {
    const result = start(overrides);
    expect(result.status, `${name}: ${result.stderr}`).toBe(2);
    expect(result.stderr, name).toMatch(reason);
    // A refusal names variables, never a value.
    expect(result.stderr, name).not.toContain(SAFE.E2E_OIDC_CLIENT_SECRET);
  }
});
