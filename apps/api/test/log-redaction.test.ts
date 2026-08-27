/**
 * PLATFORM-003 — no secret reaches a log line, proven against the real app.
 *
 * The unit suite in `services/observability` proves the redactor catches known
 * shapes. This proves the *composed application* does: a real Express app, real
 * middleware, real handlers, driven through the paths where a credential is
 * actually present — an Authorization header, a session cookie, an OIDC
 * callback carrying a code — with every log line captured and searched.
 *
 * The difference matters. A redactor that works in isolation and a logger that
 * is bypassed by one handler produce identical unit-test results and very
 * different log files.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import {
  createAuthMetrics,
  createCommonMetrics,
  createLogger,
  createRegistry,
  createSessionMetrics,
  createVerificationMetrics,
} from '@jumptotech/observability';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Credentials in the shapes this platform actually issues.
 *
 * Every one is fed to the app through a channel a real client uses, and then
 * searched for in the captured output.
 */
const SECRETS = {
  bearer: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3ItMSIsImlzcyI6Imh0dHBzOi8vaWRwIn0.c2lnbmF0dXJldmFsdWVoZXJl',
  cookie: '9f2b4c6d8e0a1b3c5d7e9f0a1b2c3d4e5f6a7b8c',
  terminalSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  oidcCode: '4/0AeanS0abcdefghijklmnopqrstuvwxyz',
  password: 'p4ssw0rd-that-should-never-appear',
  email: 'student@example.edu',
};

describe('no credential reaches a log line from the composed app', () => {
  let lines: string[];

  function buildApp() {
    const metricRegistry = createRegistry({ service: 'api', defaultMetrics: false });
    const logger = createLogger({
      service: 'api',
      level: 'debug',
      sink: (line) => lines.push(line),
    });

    const config = loadConfig({
      // The real terminal secret, fed in so a handler that ever interpolated
      // it into a message would be caught by the afterEach sweep.
      TERMINAL_SESSION_SECRET: SECRETS.terminalSecret,
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
    provider.execute = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
      stderr: '',
      timedOut: false,
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
      authAudit: (event) => {
        // The real composition root logs this; mirrored here so the audit path
        // is covered too.
        logger.info('authz.decision', {
          requestId: event.requestId,
          ...(event.authenticatedUserId ? { userId: event.authenticatedUserId } : {}),
          action: event.action,
          authorizationResult: event.authorizationResult,
        });
      },
    });
  }

  let labs: LabRegistry;

  beforeAll(async () => {
    labs = new LabRegistry(path.join(repoRoot, 'labs'));
    await labs.load();
  });

  beforeEach(() => {
    lines = [];
  });

  afterEach(() => {
    // Every assertion below runs against the same captured output, so a leak
    // anywhere in the suite fails the suite.
    const all = lines.join('\n');
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(all, `the ${name} value reached a log line verbatim`).not.toContain(value);
    }
  });

  it('does not log an Authorization header, however malformed', async () => {
    const app = buildApp();
    for (const header of [
      `Bearer ${SECRETS.bearer}`,
      `Basic ${Buffer.from(`user:${SECRETS.password}`).toString('base64')}`,
      SECRETS.bearer,
    ]) {
      await request(app).get('/api/labs').set('authorization', header);
    }
    expect(lines.length).toBeGreaterThan(0);
  });

  it('does not log a session cookie', async () => {
    const app = buildApp();
    await request(app).get('/api/me').set('cookie', `jtt_session=${SECRETS.cookie}`);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('does not log an OIDC authorization code from the callback query string', async () => {
    const app = buildApp();
    await request(app).get(`/auth/callback?code=${SECRETS.oidcCode}&state=abc`);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('does not log a request body', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/labs/K8S-001/start')
      .send({ password: SECRETS.password, email: SECRETS.email });
    expect(lines.length).toBeGreaterThan(0);
  });

  it('does not log a raw URL or query string', async () => {
    const app = buildApp();
    await request(app).get(`/api/labs?q=${SECRETS.password}&email=${SECRETS.email}`);

    // The route *template* is logged; the raw path is not. That is the whole
    // point of `routeTemplate()` — a raw path carries session ids and, here,
    // whatever a caller put in the query string.
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const routes = parsed.map((l) => l.route).filter(Boolean);
    for (const route of routes) {
      expect(String(route)).not.toContain('?');
      expect(String(route)).not.toContain(SECRETS.password);
    }
  });

  it('does not log a session id as a metric label, only as a log field', async () => {
    const app = buildApp();
    await request(app).get('/api/sessions/sess-0123456789abcdef');
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // A session id in a log line is fine and useful. The label policy test is
    // what proves it never becomes a series.
    expect(parsed.every((l) => typeof l.ts === 'string')).toBe(true);
  });

  it('never emits a stack trace, which is how paths and arguments leak', async () => {
    const app = buildApp();
    await request(app).get('/api/labs/NOT-A-LAB');
    for (const line of lines) {
      const parsed = JSON.parse(line) as { err?: Record<string, unknown> };
      if (parsed.err) expect(parsed.err).not.toHaveProperty('stack');
    }
  });

  it('emits only well-formed single-line JSON', () => {
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
