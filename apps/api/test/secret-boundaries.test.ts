/**
 * BETA-P0-010 — the API's secrets: each its own value, only the ones it uses,
 * and none of them visible from outside.
 *
 * Three claims, each against the real code path:
 *
 *   1. Under NODE_ENV=production `loadConfig` refuses a missing, placeholder or
 *      shared secret, a broker capability the API needs but lacks, and the one
 *      it must never hold (`attach`). In development INTERNAL_SERVICE_SECRET
 *      and NAMESPACE_DERIVATION_SECRET may still fall back, and say so.
 *   2. OIDC_CLIENT_SECRET and the database password are in the startup
 *      redaction self-test, and provider-shaped values do not stop the boot.
 *   3. A composed app configured with sentinel secrets never returns one — not
 *      from /health, the auth routes, a refused /internal call, a 404, the
 *      metrics registry, or a log line.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import {
  createAuthMetrics,
  createCommonMetrics,
  createLogger,
  createRegistry,
  createSessionMetrics,
  createVerificationMetrics,
  redactString,
} from '@jumptotech/observability';
import { createApp } from '../src/app.js';
import { API_FORBIDDEN_SECRETS, loadConfig } from '../src/config.js';
import { buildApiObservability } from '../src/observability.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

const PRODUCTION = {
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://issuer.example.com',
  OIDC_CLIENT_ID: 'jumptotech-labs',
  OIDC_AUDIENCE: 'jumptotech-labs',
  PUBLIC_ORIGIN: 'https://labs.example.com',
  ALLOWED_ORIGINS: 'https://labs.example.com',
  TERMINAL_SESSION_SECRET: hex('terminal-session'),
  INTERNAL_SERVICE_SECRET: hex('internal-service'),
  NAMESPACE_DERIVATION_SECRET: hex('namespace-derivation'),
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape-token'),
  // Required under production since BETA-P0-008; not a secret.
  RUNTIME_OWNER_ID: 'labs-prod',
} as NodeJS.ProcessEnv;

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadConfig to refuse');
}

describe('API secrets under NODE_ENV=production', () => {
  it('accepts a complete, distinct configuration with no fallbacks', () => {
    const config = loadConfig(PRODUCTION);
    expect(config.developmentSecretFallbacks).toEqual([]);
    expect(config.internalServiceSecret).toBe(PRODUCTION.INTERNAL_SERVICE_SECRET);
    expect(config.namespaceSecret).toBe(PRODUCTION.NAMESPACE_DERIVATION_SECRET);
  });

  for (const name of ['INTERNAL_SERVICE_SECRET', 'NAMESPACE_DERIVATION_SECRET']) {
    it(`refuses to fall back to TERMINAL_SESSION_SECRET for ${name}`, () => {
      expect(refusal({ ...PRODUCTION, [name]: undefined })).toContain(`${name} is not set`);
    });

    it(`refuses ${name} equal to TERMINAL_SESSION_SECRET`, () => {
      expect(refusal({ ...PRODUCTION, [name]: PRODUCTION.TERMINAL_SESSION_SECRET })).toMatch(/same value/);
    });
  }

  it('refuses the TERMINAL_SESSION_SECRET placeholder .env.example ships', () => {
    expect(refusal({ ...PRODUCTION, TERMINAL_SESSION_SECRET: 'dev-only-insecure-secret-change-me' })).toMatch(
      /TERMINAL_SESSION_SECRET is a placeholder/,
    );
  });

  for (const name of API_FORBIDDEN_SECRETS) {
    it(`refuses to hold ${name}`, () => {
      expect(refusal({ ...PRODUCTION, [name]: hex(name) })).toContain(`${name} is set, but api`);
    });
  }

  describe('broker capabilities', () => {
    const BROKERED = { ...PRODUCTION, SANDBOX_BROKER_URL: 'http://sandboxd:4002' } as NodeJS.ProcessEnv;

    it('requires runtime and docker when both are brokered', () => {
      const message = refusal(BROKERED);
      expect(message).toContain('SANDBOXD_RUNTIME_SECRET is not set');
      expect(message).toContain('SANDBOXD_DOCKER_SECRET is not set');
    });

    it('requires docker only when the Docker track is on', () => {
      expect(() =>
        loadConfig({
          ...BROKERED,
          SANDBOXD_RUNTIME_SECRET: hex('runtime').slice(0, 48),
          DOCKER_TRACK_ENABLED: 'false',
        }),
      ).not.toThrow();
    });

    it('requires neither without a broker', () => {
      expect(() => loadConfig(PRODUCTION)).not.toThrow();
    });
  });

  describe('credentials the platform is issued', () => {
    it('refuses a placeholder database password inside DATABASE_URL, without echoing it', () => {
      const message = refusal({
        ...PRODUCTION,
        DATABASE_URL: 'postgresql://jumptotech:dev-only-change-me@postgres:5432/jumptotech_labs',
      });
      expect(message).toContain('the password in DATABASE_URL is a placeholder');
      expect(message).not.toContain('dev-only-change-me');
    });

    it('refuses a configured database with no password at all', () => {
      expect(refusal({ ...PRODUCTION, POSTGRES_HOST: 'db.internal' })).toContain('POSTGRES_PASSWORD is not set');
    });

    it('accepts a real database password in either form', () => {
      const password = hex('db').slice(0, 32);
      expect(() =>
        loadConfig({ ...PRODUCTION, DATABASE_URL: `postgresql://jumptotech:${password}@postgres:5432/db` }),
      ).not.toThrow();
      expect(() =>
        loadConfig({ ...PRODUCTION, POSTGRES_HOST: 'db.internal', POSTGRES_PASSWORD: password }),
      ).not.toThrow();
    });

    it('checks OIDC_CLIENT_SECRET only when set, and accepts a provider-issued shape', () => {
      expect(refusal({ ...PRODUCTION, OIDC_CLIENT_SECRET: 'your-client-secret' })).toContain(
        'OIDC_CLIENT_SECRET is a placeholder',
      );
      expect(() =>
        loadConfig({ ...PRODUCTION, OIDC_CLIENT_SECRET: 'GOCSPX-kQ3vZ8nB1mT6rW4yH9pL2sD7fJ0' }),
      ).not.toThrow();
    });
  });
});

describe('the secret gate alongside runtime ownership and session capacity', () => {
  it('keeps the configured owner and the beta capacity policy in a valid production config', () => {
    const config = loadConfig({ ...PRODUCTION, MAX_ACTIVE_SESSIONS: '5', MAX_ACTIVE_SESSIONS_PER_STUDENT: '1' });
    expect(config.sandbox.runtimeOwner).toBe('labs-prod');
    expect(config.sandbox.runtimeOwnerSource).toBe('configured');
    expect(config.lifetimes).toMatchObject({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });
  });

  it('still refuses a production API with valid secrets but no runtime owner', () => {
    expect(refusal({ ...PRODUCTION, RUNTIME_OWNER_ID: undefined })).toMatch(/RUNTIME_OWNER_ID must be set/);
  });

  it('still refuses a placeholder secret when the runtime owner is valid', () => {
    const message = refusal({ ...PRODUCTION, INTERNAL_SERVICE_SECRET: 'dev-only-insecure-secret-change-me' });
    expect(message).toContain('INTERNAL_SERVICE_SECRET is a placeholder');
    expect(message).not.toContain('dev-only-insecure-secret-change-me');
  });
});

describe('API secrets in development', () => {
  it('falls back for both, and reports which', () => {
    const config = loadConfig({ TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret' } as NodeJS.ProcessEnv);
    expect(config.developmentSecretFallbacks).toEqual(['INTERNAL_SERVICE_SECRET', 'NAMESPACE_DERIVATION_SECRET']);
    expect(config.internalServiceSecret).toBe('a-long-enough-dev-secret');
  });
});

describe('the startup redaction self-test covers issued credentials', () => {
  it('boots with provider-shaped secrets and redacts them from then on', () => {
    const clientSecret = 'Xk9_qL2-vB7nR4-tY8wZ1_cF6hJ3-mP0sD5_gA2kE9-uI4oW7_yT1rQ6-zN3bV8x';
    const dbPassword = 'correct-Horse!battery*staple';
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: hex('t'),
      INTERNAL_SERVICE_SECRET: hex('i'),
      NAMESPACE_DERIVATION_SECRET: hex('n'),
      OIDC_ISSUER: 'https://issuer.example.com',
      OIDC_CLIENT_ID: 'client',
      OIDC_AUDIENCE: 'aud',
      OIDC_CLIENT_SECRET: clientSecret,
      DATABASE_URL: `postgresql://jumptotech:${encodeURIComponent(dbPassword)}@postgres:5432/db`,
      LOG_LEVEL: 'error',
    } as NodeJS.ProcessEnv);

    expect(() => buildApiObservability(config)).not.toThrow();
    expect(redactString(`token endpoint rejected ${clientSecret}`)).not.toContain(clientSecret);
    expect(redactString(`auth failed for ${dbPassword}`)).not.toContain(dbPassword);
  });
});

describe('no configured secret leaves the composed app', () => {
  const SENTINELS = {
    TERMINAL_SESSION_SECRET: hex('sentinel-terminal'),
    INTERNAL_SERVICE_SECRET: hex('sentinel-internal'),
    NAMESPACE_DERIVATION_SECRET: hex('sentinel-namespace'),
    SANDBOXD_RUNTIME_SECRET: hex('sentinel-runtime').slice(0, 48),
    SANDBOXD_DOCKER_SECRET: hex('sentinel-docker').slice(0, 48),
    OIDC_CLIENT_SECRET: 'GOCSPX-sentinelOidcClientSecret00',
    OBSERVABILITY_SCRAPE_TOKEN: hex('sentinel-scrape'),
  };

  let labs: LabRegistry;
  const lines: string[] = [];
  const metricRegistry = createRegistry({ service: 'api', defaultMetrics: false });

  beforeAll(async () => {
    labs = await realCatalog();
  });

  function buildApp() {
    const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });
    const config = loadConfig({
      ...SENTINELS,
      LABS_DIR: path.join(repoRoot, 'labs'),
      ALLOWED_ORIGINS: 'http://localhost:3000',
    } as NodeJS.ProcessEnv);

    const k8s = new FakeKubernetes();
    const provider = new KindLabProvider({
      k8s,
      clusterName: 'jumptotech-labs',
      resetDrainTimeoutMs: 2_000,
      destroyTimeoutMs: 2_000,
      sleep: async () => undefined,
    });
    const sessions = new SessionManager({
      registry: labs,
      provider,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: config.lifetimes,
      namespaceSecret: config.namespaceSecret,
    });

    return createApp({
      registry: labs,
      sessions,
      k8s,
      config,
      observability: {
        logger,
        metrics: {
          common: createCommonMetrics(metricRegistry, 'api'),
          sessions: createSessionMetrics(metricRegistry),
          verification: createVerificationMetrics(metricRegistry),
          auth: createAuthMetrics(metricRegistry),
        },
      },
    });
  }

  it('in any response, metric or log line', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      request(app).get('/health'),
      request(app).get('/auth/config'),
      request(app).get('/auth/session'),
      request(app).get('/auth/login'),
      request(app).get('/api/labs'),
      request(app).get('/api/me'),
      request(app).get('/definitely-not-a-route'),
      request(app)
        .post('/internal/sessions/sess-0123456789abcdef/credentials')
        .set('x-internal-secret', 'wrong-secret-value')
        .send({ ownerUserId: 'someone' }),
      request(app).post('/api/labs/K8S-001/start').send({}),
    ]);

    const surfaces = [
      ...responses.map((response) => `${JSON.stringify(response.headers)}\n${response.text}`),
      await metricRegistry.metrics(),
      lines.join('\n'),
    ].join('\n');

    expect(lines.length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(surfaces.includes(value), `${name} left the app`).toBe(false);
    }
  });
});
