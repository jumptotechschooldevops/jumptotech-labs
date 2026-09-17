/**
 * The browser E2E overlay can never become a production configuration.
 *
 * e2e/docker-compose.e2e.yml points the api at a test identity provider that
 * authenticates anybody who types a username. That is safe only while two
 * things hold, and this suite pins both:
 *
 *   1. the api refuses to start with the overlay's authentication settings
 *      under NODE_ENV=production — through `loadConfig`, the real startup path;
 *   2. nothing shipped (the production and runtime compose files, the Makefile,
 *      the images) refers to the e2e directory or its provider.
 *
 * The overlay values are read from the file itself, so an edit to the overlay
 * is checked here rather than a copy of it that could drift.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OVERLAY = readFileSync(path.join(REPO_ROOT, 'e2e/docker-compose.e2e.yml'), 'utf8');
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

/** `KEY: value` as the overlay writes it for the api service, with ${…} filled the way e2e/stack.sh fills it. */
function overlayValue(key: string): string {
  const match = new RegExp(`^\\s+${key}:\\s*(.+)$`, 'm').exec(OVERLAY);
  if (!match) throw new Error(`the overlay no longer sets ${key}`);
  return match[1]!
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\$\{WEB_PORT:\?[^}]*\}/g, '33700')
    .replace(/\$\{E2E_OIDC_CLIENT_SECRET:\?[^}]*\}/g, hex('e2e-overlay-client-secret'));
}

function overlayAuthEnv(nodeEnv: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: nodeEnv,
    AUTH_MODE: overlayValue('AUTH_MODE'),
    OIDC_ISSUER: overlayValue('OIDC_ISSUER'),
    OIDC_CLIENT_ID: overlayValue('OIDC_CLIENT_ID'),
    OIDC_CLIENT_SECRET: overlayValue('OIDC_CLIENT_SECRET'),
    OIDC_AUDIENCE: overlayValue('OIDC_AUDIENCE'),
    PUBLIC_ORIGIN: overlayValue('PUBLIC_ORIGIN'),
    ALLOWED_ORIGINS: overlayValue('ALLOWED_ORIGINS'),
    DEV_STUDENT_HEADER_ENABLED: overlayValue('DEV_STUDENT_HEADER_ENABLED'),
    TERMINAL_SESSION_SECRET: hex('e2e-terminal'),
    INTERNAL_SERVICE_SECRET: hex('e2e-internal'),
    NAMESPACE_DERIVATION_SECRET: hex('e2e-namespace'),
    OBSERVABILITY_SCRAPE_TOKEN: hex('e2e-scrape'),
    RUNTIME_OWNER_ID: 'jtt-e2e',
    DATABASE_URL: `postgresql://jumptotech:${hex('e2e-database').slice(0, 32)}@127.0.0.1:5432/jumptotech_labs`,
  } as NodeJS.ProcessEnv;
}

describe('the browser E2E overlay', () => {
  it('is what the suite needs outside production: OIDC browser sign-in on plain-http loopback', () => {
    const config = loadConfig(overlayAuthEnv('development'));
    expect(config.auth.mode).toBe('oidc');
    expect(config.auth.browserFlow?.redirectUri).toBe('http://127.0.0.1:33700/auth/callback');
    expect(config.auth.cookie.secure).toBe(false);
  });

  function refusal(env: NodeJS.ProcessEnv): string {
    try {
      loadConfig(env);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(hex('e2e-overlay-client-secret'));
      return message;
    }
    throw new Error('expected loadConfig to refuse');
  }

  it('is refused under NODE_ENV=production, at the loopback public origin', () => {
    expect(refusal(overlayAuthEnv('production'))).toMatch(/PUBLIC_ORIGIN/);
  });

  it('is still refused under NODE_ENV=production with a real https origin, because of its http issuer', () => {
    const env = {
      ...overlayAuthEnv('production'),
      PUBLIC_ORIGIN: 'https://labs.example.com',
      ALLOWED_ORIGINS: 'https://labs.example.com',
    };
    expect(refusal(env)).toMatch(/OIDC_ISSUER/);
  });

  it('never sets NODE_ENV=production for any service', () => {
    expect(OVERLAY).not.toMatch(/NODE_ENV:\s*"?production/);
  });

  it('is referenced by no shipped compose file, Dockerfile or Makefile target', () => {
    const shipped = [
      ...readdirSync(REPO_ROOT).filter((name) => /^docker-compose.*\.ya?ml$/.test(name)),
      'Makefile',
      ...readdirSync(path.join(REPO_ROOT, 'infrastructure/docker'))
        .filter((name) => name.endsWith('.Dockerfile'))
        .map((name) => `infrastructure/docker/${name}`),
    ];
    expect(shipped.length).toBeGreaterThan(5);
    for (const file of shipped) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/e2e\/|oidc-provider|E2E_OIDC/);
    }
  });
});
