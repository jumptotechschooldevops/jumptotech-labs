/**
 * BETA-P0-014 — production authentication fails closed.
 *
 * Every case is one configuration that used to *start*, and now refuses to:
 * a production API nobody could sign in to, one that sent codes to another
 * origin, one whose session cookie travelled over plain HTTP, one that let a
 * browser header choose a student. Each runs through `loadConfig`, the real
 * startup path, against an otherwise valid production environment — so the
 * refusal is caused by exactly the one thing the case changes.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  MAX_AUTH_SESSION_TTL_SECONDS,
  MIN_AUTH_SESSION_TTL_SECONDS,
  assertDurableStoresInProduction,
  bareOrigin,
  cookieDomainMatches,
} from '../src/auth/production-auth.js';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');
const CLIENT_SECRET = hex('p0014-oidc-client-secret').slice(0, 40);

const PRODUCTION = {
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://issuer.example.com/',
  OIDC_CLIENT_ID: 'jumptotech-labs',
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
  OIDC_AUDIENCE: 'jumptotech-labs-api',
  PUBLIC_ORIGIN: 'https://labs.example.com',
  ALLOWED_ORIGINS: 'https://labs.example.com',
  TERMINAL_SESSION_SECRET: hex('p0014-terminal'),
  INTERNAL_SERVICE_SECRET: hex('p0014-internal'),
  NAMESPACE_DERIVATION_SECRET: hex('p0014-namespace'),
  OBSERVABILITY_SCRAPE_TOKEN: hex('p0014-scrape'),
  RUNTIME_OWNER_ID: 'labs-prod',
  // Durable browser sessions; loopback passes the BETA-P0-012 transport gate.
  DATABASE_URL: `postgresql://jumptotech:${hex('p0014-database').slice(0, 32)}@127.0.0.1:5432/jumptotech_labs`,
} as NodeJS.ProcessEnv;

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    const message = (error as Error).message;
    // Whatever else a refusal says, it never says the client secret.
    expect(message).not.toContain(CLIENT_SECRET);
    return message;
  }
  throw new Error('expected loadConfig to refuse');
}

describe('a production configuration that is ready', () => {
  it('loads, with browser sign-in on, a Secure cookie and a callback on the public origin', () => {
    const config = loadConfig(PRODUCTION);
    expect(config.auth.mode).toBe('oidc');
    expect(config.auth.browserFlow).not.toBeNull();
    expect(config.auth.browserFlow!.redirectUri).toBe('https://labs.example.com/auth/callback');
    expect(config.auth.browserFlow!.scopes).toEqual(['openid', 'profile', 'email']);
    expect(config.auth.cookie).toMatchObject({ secure: true, domain: undefined, ttlSeconds: 43_200 });
    expect(config.progress.allowStudentHeader).toBe(false);
  });

  it('accepts an explicit callback on the public origin, a trailing slash, and a parent cookie domain', () => {
    expect(() =>
      loadConfig({
        ...PRODUCTION,
        PUBLIC_ORIGIN: 'https://labs.example.com/',
        OIDC_REDIRECT_URI: 'https://labs.example.com/auth/callback',
        ALLOWED_ORIGINS: 'https://labs.example.com,https://admin.example.com',
        AUTH_COOKIE_DOMAIN: 'example.com',
      }),
    ).not.toThrow();
  });

  it('defaults AUTH_MODE to oidc, so a lost line fails closed rather than open', () => {
    expect(loadConfig({ ...PRODUCTION, AUTH_MODE: undefined }).auth.mode).toBe('oidc');
  });
});

describe('production rejects development authentication', () => {
  it('refuses AUTH_MODE=development at configuration load', () => {
    expect(refusal({ ...PRODUCTION, AUTH_MODE: 'development' })).toMatch(/AUTH_MODE must be oidc/);
  });

  it('refuses an AUTH_MODE it does not recognise instead of guessing', () => {
    expect(refusal({ ...PRODUCTION, AUTH_MODE: 'none' })).toMatch(/AUTH_MODE must be 'oidc' or 'development'/);
  });

  it('refuses the development student header', () => {
    expect(refusal({ ...PRODUCTION, DEV_STUDENT_HEADER_ENABLED: 'true' })).toContain(
      'DEV_STUDENT_HEADER_ENABLED must not be true',
    );
  });
});

describe('production rejects missing OIDC configuration', () => {
  for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_AUDIENCE']) {
    it(`refuses a missing ${name}, and a blank one`, () => {
      expect(refusal({ ...PRODUCTION, [name]: undefined })).toContain(`${name} is not set`);
      expect(refusal({ ...PRODUCTION, [name]: '   ' })).toContain(`${name} is not set`);
    });
  }

  it('refuses a missing OIDC_CLIENT_SECRET: a confidential client with no credential', () => {
    expect(refusal({ ...PRODUCTION, OIDC_CLIENT_SECRET: undefined })).toContain('OIDC_CLIENT_SECRET is not set');
  });

  it('reports every missing value in one refusal, so a deploy is fixed in one pass', () => {
    const message = refusal({ ...PRODUCTION, OIDC_ISSUER: undefined, OIDC_CLIENT_ID: undefined, OIDC_AUDIENCE: undefined });
    expect(message).toContain('OIDC_ISSUER is not set');
    expect(message).toContain('OIDC_CLIENT_ID is not set');
    expect(message).toContain('OIDC_AUDIENCE is not set');
  });
});

describe('production sign-in requires durable sessions', () => {
  it('refuses a production API with no database, rather than signing students in to memory', () => {
    const message = refusal({ ...PRODUCTION, DATABASE_URL: undefined });
    expect(message).toContain('DATABASE_URL is not set: production sign-in requires durable PostgreSQL-backed sessions');
  });

  it('accepts either database form, over a transport production allows', () => {
    const password = hex('p0014-database-host').slice(0, 32);
    expect(loadConfig({ ...PRODUCTION, DATABASE_URL: undefined, POSTGRES_HOST: 'db.internal', POSTGRES_PASSWORD: password, DATABASE_SSL: 'true' }).progress.database).not.toBeNull();
  });

  it('does not weaken the BETA-P0-012 transport gate to satisfy the requirement', () => {
    const remotePlaintext = `postgresql://jumptotech:${hex('p0014-database').slice(0, 32)}@db.internal.example:5432/labs`;
    expect(refusal({ ...PRODUCTION, DATABASE_URL: remotePlaintext })).toMatch(/api refuses to send the database password/);
  });

  it('lists the missing database with every other problem, in one refusal', () => {
    const message = refusal({ ...PRODUCTION, DATABASE_URL: undefined, AUTH_COOKIE_SECURE: 'false' });
    expect(message).toContain('DATABASE_URL is not set');
    expect(message).toContain('AUTH_COOKIE_SECURE must not be false');
  });

  it('keeps the in-memory fallback for local development, explicitly outside production', () => {
    for (const env of [
      { TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret', AUTH_MODE: 'development' },
      { TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret', NODE_ENV: 'test', OIDC_ISSUER: 'http://127.0.0.1:9/', OIDC_CLIENT_ID: 'client', OIDC_AUDIENCE: 'api', OIDC_CLIENT_SECRET: 'local-client-secret' },
    ]) {
      expect(loadConfig(env as NodeJS.ProcessEnv).progress.database).toBeNull();
    }
  });

  it('refuses again at the composition root, where the stores are chosen', () => {
    expect(() => assertDurableStoresInProduction({ nodeEnv: 'production', durable: false })).toThrow(
      /without a PostgreSQL database: browser sessions would be in memory/,
    );
    expect(() => assertDurableStoresInProduction({ nodeEnv: 'production', durable: true })).not.toThrow();
    for (const nodeEnv of ['development', 'test', '']) {
      expect(() => assertDurableStoresInProduction({ nodeEnv, durable: false })).not.toThrow();
    }
  });

  it('is wired into the composition root before any store is chosen', () => {
    const source = readFileSync(path.join(API_ROOT, 'src/index.ts'), 'utf8');
    const gate = source.indexOf('assertDurableStoresInProduction(');
    expect(gate).toBeGreaterThan(-1);
    for (const fallback of ['new InMemorySessionStore()', 'new InMemoryUserRepository(', 'new InMemoryAuthSessionStore()']) {
      expect(source.indexOf(fallback), fallback).toBeGreaterThan(gate);
    }
  });
});

describe('production rejects an unsafe identity provider address', () => {
  it('refuses a plain-http issuer', () => {
    expect(refusal({ ...PRODUCTION, OIDC_ISSUER: 'http://issuer.example.com/' })).toContain('OIDC_ISSUER must use https:');
  });

  it('refuses an issuer that is not a URL, or that carries a query or fragment', () => {
    expect(refusal({ ...PRODUCTION, OIDC_ISSUER: 'issuer.example.com' })).toContain('OIDC_ISSUER is not an absolute URL');
    expect(refusal({ ...PRODUCTION, OIDC_ISSUER: 'https://issuer.example.com/?tenant=a' })).toContain('query string');
    expect(refusal({ ...PRODUCTION, OIDC_ISSUER: 'https://issuer.example.com/#x' })).toContain('fragment');
  });

  it('refuses a plain-http JWKS override', () => {
    expect(refusal({ ...PRODUCTION, OIDC_JWKS_URI: 'http://issuer.example.com/keys' })).toContain(
      'OIDC_JWKS_URI must use https:',
    );
  });
});

describe('production rejects an unsafe callback or origin', () => {
  it('refuses a missing PUBLIC_ORIGIN even when ALLOWED_ORIGINS could stand in for it', () => {
    expect(refusal({ ...PRODUCTION, PUBLIC_ORIGIN: undefined })).toContain('PUBLIC_ORIGIN is not set');
  });

  it('refuses a plain-http public origin', () => {
    expect(
      refusal({ ...PRODUCTION, PUBLIC_ORIGIN: 'http://labs.example.com', ALLOWED_ORIGINS: 'http://labs.example.com' }),
    ).toContain('PUBLIC_ORIGIN must use https:');
  });

  it('refuses a public origin that is not a bare origin', () => {
    for (const hostile of [
      'https://labs.example.com/app',
      'https://labs.example.com?x=1',
      'https://labs.example.com@evil.example',
      'https://LABS.example.com',
    ]) {
      expect(refusal({ ...PRODUCTION, PUBLIC_ORIGIN: hostile }), hostile).toContain('is not a bare origin');
    }
  });

  it('refuses a callback on any origin but the public one', () => {
    for (const hostile of [
      'https://evil.example/auth/callback',
      'https://labs.example.com.evil.example/auth/callback',
      'https://labs.example.com:8443/auth/callback',
      'https://sibling.example.com/auth/callback',
    ]) {
      expect(refusal({ ...PRODUCTION, OIDC_REDIRECT_URI: hostile }), hostile).toContain(
        'OIDC_REDIRECT_URI must be on PUBLIC_ORIGIN',
      );
    }
  });

  it('refuses a callback over http, with a query, a fragment, credentials, or another path', () => {
    expect(refusal({ ...PRODUCTION, OIDC_REDIRECT_URI: 'http://labs.example.com/auth/callback' })).toContain(
      'OIDC_REDIRECT_URI must use https:',
    );
    expect(refusal({ ...PRODUCTION, OIDC_REDIRECT_URI: 'https://labs.example.com/auth/callback?next=/x' })).toContain(
      'must not carry a query string',
    );
    expect(refusal({ ...PRODUCTION, OIDC_REDIRECT_URI: 'https://labs.example.com/auth/callback#x' })).toContain(
      'must not carry a fragment',
    );
    expect(refusal({ ...PRODUCTION, OIDC_REDIRECT_URI: 'https://u:p@labs.example.com/auth/callback' })).toContain(
      'must not carry credentials',
    );
    expect(refusal({ ...PRODUCTION, OIDC_REDIRECT_URI: 'https://labs.example.com/login/done' })).toContain(
      'path must be /auth/callback',
    );
  });

  it('refuses credentialed CORS origins that are not https, not bare, or omit the public origin', () => {
    expect(refusal({ ...PRODUCTION, ALLOWED_ORIGINS: 'https://labs.example.com,http://labs.example.com' })).toContain(
      "entry 'http://labs.example.com' must use https:",
    );
    expect(refusal({ ...PRODUCTION, ALLOWED_ORIGINS: 'https://labs.example.com,*' })).toContain(
      "entry '*' is not a bare origin",
    );
    expect(refusal({ ...PRODUCTION, ALLOWED_ORIGINS: 'https://other.example.com' })).toContain(
      'ALLOWED_ORIGINS must include PUBLIC_ORIGIN',
    );
  });
});

describe('production cookie and session bounds', () => {
  it('refuses AUTH_COOKIE_SECURE=false', () => {
    expect(refusal({ ...PRODUCTION, AUTH_COOKIE_SECURE: 'false' })).toContain('AUTH_COOKIE_SECURE must not be false');
  });

  it('refuses a cookie domain the public origin is not inside', () => {
    expect(refusal({ ...PRODUCTION, AUTH_COOKIE_DOMAIN: 'evil.example' })).toContain('does not domain-match');
    // A suffix that is not a label boundary is not a parent domain.
    expect(refusal({ ...PRODUCTION, AUTH_COOKIE_DOMAIN: 'ample.com' })).toContain('does not domain-match');
  });

  it('bounds the session lifetime in every environment', () => {
    const dev = { TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret' } as NodeJS.ProcessEnv;
    expect(() => loadConfig({ ...dev, AUTH_SESSION_TTL_SECONDS: String(MAX_AUTH_SESSION_TTL_SECONDS + 1) })).toThrow(
      /AUTH_SESSION_TTL_SECONDS must be between/,
    );
    expect(() => loadConfig({ ...dev, AUTH_SESSION_TTL_SECONDS: String(MIN_AUTH_SESSION_TTL_SECONDS - 1) })).toThrow(
      /AUTH_SESSION_TTL_SECONDS must be between/,
    );
    expect(refusal({ ...PRODUCTION, AUTH_SESSION_TTL_SECONDS: '31536000' })).toMatch(/AUTH_SESSION_TTL_SECONDS/);
  });

  it('refuses a cookie name that could not be written', () => {
    expect(() =>
      loadConfig({ TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret', AUTH_COOKIE_NAME: 'jtt session;' } as NodeJS.ProcessEnv),
    ).toThrow(/AUTH_COOKIE_NAME/);
  });
});

describe('scopes', () => {
  it('refuses offline_access, in production and wherever browser sign-in is configured', () => {
    expect(refusal({ ...PRODUCTION, OIDC_SCOPES: 'openid profile offline_access' })).toContain("'offline_access'");
    expect(() =>
      loadConfig({
        TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret',
        OIDC_ISSUER: 'http://127.0.0.1:1/',
        OIDC_CLIENT_ID: 'c',
        OIDC_AUDIENCE: 'a',
        OIDC_CLIENT_SECRET: 'dev-client-secret',
        OIDC_SCOPES: 'openid offline_access',
      } as NodeJS.ProcessEnv),
    ).toThrow(/offline_access/);
  });

  it('refuses scopes without openid, which would yield no ID token', () => {
    expect(refusal({ ...PRODUCTION, OIDC_SCOPES: 'profile email' })).toContain("must include 'openid'");
  });
});

describe('the development exception', () => {
  it('keeps development authentication available outside production, explicitly', () => {
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret',
      AUTH_MODE: 'development',
    } as NodeJS.ProcessEnv);
    expect(config.auth.mode).toBe('development');
    expect(config.auth.browserFlow).toBeNull();
    // Plain-HTTP localhost is the one place the cookie is not Secure.
    expect(config.auth.cookie.secure).toBe(false);
  });

  it('lets a test run use a loopback http provider, which production never could', () => {
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret',
      NODE_ENV: 'test',
      OIDC_ISSUER: 'http://127.0.0.1:9/',
      OIDC_CLIENT_ID: 'client',
      OIDC_AUDIENCE: 'api',
      OIDC_CLIENT_SECRET: 'local-client-secret',
    } as NodeJS.ProcessEnv);
    expect(config.auth.browserFlow?.redirectUri).toBe('http://localhost:3000/auth/callback');
  });
});

describe('TLS verification is never disabled', () => {
  it('refuses NODE_TLS_REJECT_UNAUTHORIZED in production', () => {
    expect(refusal({ ...PRODUCTION, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('has no code path in the authentication layer that relaxes certificate checks', () => {
    const files = [
      ...readdirSync(path.join(API_ROOT, 'src/auth')).map((f) => path.join(API_ROOT, 'src/auth', f)),
      path.join(API_ROOT, 'src/routes/auth.ts'),
      path.join(API_ROOT, 'src/config.ts'),
      path.join(API_ROOT, 'src/index.ts'),
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/rejectUnauthorized\s*:/);
      expect(source, file).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED\s*=/);
      expect(source, file).not.toMatch(/checkServerIdentity/);
      expect(source, file).not.toMatch(/\bdispatcher\s*:/);
    }
  });
});

describe('origin and domain helpers', () => {
  it('accepts only canonical bare origins', () => {
    expect(bareOrigin('https://labs.example.com')).toBe('https://labs.example.com');
    expect(bareOrigin('https://labs.example.com/')).toBe('https://labs.example.com');
    expect(bareOrigin('https://labs.example.com:8443')).toBe('https://labs.example.com:8443');
    for (const bad of ['https://labs.example.com:443', 'https://x.example.com/p', 'javascript:alert(1)', 'null', '*', '']) {
      expect(bareOrigin(bad), bad).toBeNull();
    }
  });

  it('domain-matches on label boundaries only', () => {
    expect(cookieDomainMatches('labs.example.com', 'example.com')).toBe(true);
    expect(cookieDomainMatches('labs.example.com', '.example.com')).toBe(true);
    expect(cookieDomainMatches('labs.example.com', 'labs.example.com')).toBe(true);
    expect(cookieDomainMatches('labs.example.com', 'ample.com')).toBe(false);
    expect(cookieDomainMatches('labs.example.com', 'other.example.com')).toBe(false);
  });
});
