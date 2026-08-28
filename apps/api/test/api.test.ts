/**
 * API surface tests. The cluster is faked, so these assert routing,
 * validation, response shape, and the session-scoping rules — not cluster
 * behaviour, which `integration.test.ts` proves against real kind.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { terminalCredentialBody } from './terminal-owner.js';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
  verifySessionToken,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

interface Harness {
  app: ReturnType<typeof createApp>;
  k8s: FakeKubernetes;
  sessions: SessionManager;
}

function buildApp(
  k8s: FakeKubernetes,
  registry: LabRegistry,
  env: Partial<NodeJS.ProcessEnv> = {},
): Harness {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    ...env,
  } as NodeJS.ProcessEnv);

  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
  });
  // Health-check kubectl without touching a real binary.
  provider.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const sessions = new SessionManager({
    registry,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });

  return { app: createApp({ registry, sessions, k8s, config }), k8s, sessions };
}

/** Start a lab and return the session payload plus the harness. */
async function startSession(harness: Harness) {
  const res = await request(harness.app).post('/api/labs/K8S-001/start');
  expect(res.status).toBe(200);
  return res.body.data as {
    session: { sessionId: string; namespace: string; status: string };
    terminal: { token: string };
    steps: Array<{ id: string; status: string }>;
    environment: { phase: string };
  };
}

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

describe('GET /health', () => {
  it('reports service status, loaded labs, and session capacity', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry).app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.labsLoaded).toBeGreaterThanOrEqual(1);
    expect(res.body.data.sessions).toEqual({ active: 0, maxActive: 20 });
  });
});

describe('GET /api/labs', () => {
  it('lists K8S-001 under the kubernetes track', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry).app).get('/api/labs');

    expect(res.status).toBe(200);
    expect(res.body.data.tracks.map((t: { track: string }) => t.track)).toContain('kubernetes');
    expect(res.body.data.labs.map((l: { id: string }) => l.id)).toContain('K8S-001');
  });
});

describe('GET /api/labs/:id', () => {
  it('returns lab content sourced from lab.yaml', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry).app).get('/api/labs/K8S-001');

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Create Your First Pod');
    expect(res.body.data.requirements).toEqual([
      'Pod nginx exists',
      'Image nginx:stable is correct',
      'Pod is Running',
      'Container is Ready',
    ]);
    expect(res.body.data.references[0].url).toMatch(/^https:\/\/kubernetes\.io\//);
  });

  it('exposes no namespace for the lab itself', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry).app).get('/api/labs/K8S-001');

    // `isolation: "namespace"` names the *strategy*; nothing here names an
    // actual namespace, so lab content has no way to point at one.
    expect(res.body.data.environment).toEqual({ provider: 'kubernetes', isolation: 'namespace' });
    expect(JSON.stringify(res.body.data)).not.toMatch(/"namespace"\s*:/);
  });

  it('accepts a lowercase id', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry).app).get('/api/labs/k8s-001');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('K8S-001');
  });

  it('returns 404 for a valid but unknown id', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry).app).get('/api/labs/K8S-404');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LAB_NOT_FOUND');
  });

  it.each([
    ['..%2F..%2Fetc%2Fpasswd', 400],
    ['K8S-001;id', 400],
    ['not-a-lab', 400],
  ])('rejects a malformed id (%s)', async (id, status) => {
    const res = await request(buildApp(new FakeKubernetes(), registry).app).get(`/api/labs/${id}`);

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe('INVALID_LAB_ID');
  });
});

describe('POST /api/labs/:id/start', () => {
  it('returns a session, provisioning steps, and a session-bound terminal token', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const data = await startSession(harness);

    expect(data.steps.map((s) => s.id)).toEqual([
      'environment-created',
      'kubernetes-api',
      'kubectl',
    ]);
    expect(data.environment.phase).toBe('ready');
    expect(data.session.status).toBe('ACTIVE');
    expect(data.session.namespace).toMatch(/^lab-[0-9a-f]{12}$/);

    const claims = verifySessionToken(data.terminal.token, SECRET);
    expect(claims.labId).toBe('K8S-001');
    expect(claims.sid).toBe(data.session.sessionId);
    expect(claims.namespace).toBe(data.session.namespace);
  });

  it('gives two starts two different sessions and namespaces', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);

    const a = await startSession(harness);
    const b = await startSession(harness);

    expect(a.session.sessionId).not.toBe(b.session.sessionId);
    expect(a.session.namespace).not.toBe(b.session.namespace);
  });

  it('never returns a kubeconfig or a token to the browser', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const res = await request(harness.app).post('/api/labs/K8S-001/start');

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/kubeconfig/i);
    expect(body).not.toMatch(/BEGIN CERTIFICATE/);
    expect(body).not.toMatch(/serviceAccount/i);
  });

  it('rejects a start past MAX_ACTIVE_SESSIONS with a structured code', async () => {
    const harness = buildApp(new FakeKubernetes(), registry, { MAX_ACTIVE_SESSIONS: '1' });
    await startSession(harness);

    const res = await request(harness.app).post('/api/labs/K8S-001/start');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('LAB_CAPACITY_REACHED');
    expect(res.body.error.details).toMatchObject({ activeSessions: 1, maxActiveSessions: 1 });
  });

  it('reports the real failure instead of pretending the lab is ready', async () => {
    const k8s = new FakeKubernetes({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });

    const res = await request(buildApp(k8s, registry).app).post('/api/labs/K8S-001/start');

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toContain('ECONNREFUSED');
  });
});

describe('GET /api/sessions/:sessionId', () => {
  it('returns live status and countdowns', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);

    const res = await request(harness.app).get(`/api/sessions/${session.sessionId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.session.status).toBe('ACTIVE');
    expect(res.body.data.session.secondsRemaining).toBeGreaterThan(0);
    expect(res.body.data.session.idleWarning).toBe(false);
    expect(res.body.data.environment.phase).toBe('ready');
  });

  it('404s an unknown session and 400s a malformed one', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);

    const unknown = await request(harness.app).get('/api/sessions/sess-00000000000000ff');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('SESSION_NOT_FOUND');

    const malformed = await request(harness.app).get('/api/sessions/session-1');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_SESSION_ID');
  });

  it('does not count polling as activity', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);

    const before = (await request(harness.app).get(`/api/sessions/${session.sessionId}`)).body.data
      .session.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = (await request(harness.app).get(`/api/sessions/${session.sessionId}`)).body.data
      .session.lastActivityAt;

    expect(after).toBe(before);
  });
});

describe('POST /api/sessions/:sessionId/activity', () => {
  it('records activity so "Continue Lab" keeps the session alive', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);
    const before = (await request(harness.app).get(`/api/sessions/${session.sessionId}`)).body.data
      .session;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await request(harness.app).post(`/api/sessions/${session.sessionId}/activity`);

    expect(res.status).toBe(200);
    expect(Date.parse(res.body.data.session.lastActivityAt)).toBeGreaterThan(
      Date.parse(before.lastActivityAt),
    );
    // The absolute deadline is untouched.
    expect(res.body.data.session.expiresAt).toBe(before.expiresAt);
  });
});

describe('POST /api/sessions/:sessionId/check', () => {
  it('verifies against the session namespace and returns LAB PASSED', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);
    harness.k8s.pods.set(session.namespace, [podSnapshot({ namespace: session.namespace })]);

    const res = await request(harness.app).post(`/api/sessions/${session.sessionId}/check`);

    expect(res.status).toBe(200);
    expect(res.body.data.passed).toBe(true);
    expect(res.body.data.summary).toBe('LAB PASSED');
    expect(res.body.data.namespace).toBe(session.namespace);
  });

  it('returns LAB NOT COMPLETE with 200 when the Pod is missing', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);

    const res = await request(harness.app).post(`/api/sessions/${session.sessionId}/check`);

    expect(res.status).toBe(200);
    expect(res.body.data.passed).toBe(false);
    expect(res.body.data.summary).toBe('LAB NOT COMPLETE');
  });

  it('does not let one session pass on another session’s Pod', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const a = await startSession(harness);
    const b = await startSession(harness);
    // B solves the lab.
    harness.k8s.pods.set(b.session.namespace, [podSnapshot({ namespace: b.session.namespace })]);

    const resA = await request(harness.app).post(`/api/sessions/${a.session.sessionId}/check`);
    const resB = await request(harness.app).post(`/api/sessions/${b.session.sessionId}/check`);

    expect(resA.body.data.passed).toBe(false);
    expect(resB.body.data.passed).toBe(true);
  });

  it('returns 503 when the cluster cannot be read', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);
    harness.k8s.unreachable = 'connect ECONNREFUSED 172.18.0.2:6443';

    const res = await request(harness.app).post(`/api/sessions/${session.sessionId}/check`);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ENVIRONMENT_UNREACHABLE');
  });
});

describe('POST /api/sessions/:sessionId/reset', () => {
  it('removes the session’s resources and leaves other sessions alone', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const a = await startSession(harness);
    const b = await startSession(harness);
    harness.k8s.pods.set(a.session.namespace, [podSnapshot({ namespace: a.session.namespace })]);
    harness.k8s.pods.set(b.session.namespace, [podSnapshot({ namespace: b.session.namespace })]);

    const res = await request(harness.app).post(`/api/sessions/${a.session.sessionId}/reset`);

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Lab reset successfully.');
    expect(res.body.data.removed).toContain('pods/nginx');
    expect(res.body.data.clearTerminal).toBe(true);
    expect(await harness.k8s.countPods(b.session.namespace)).toBe(1);
  });
});

describe('DELETE /api/sessions/:sessionId (End Lab)', () => {
  it('deletes the session namespace and marks the session ENDED', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const a = await startSession(harness);
    const b = await startSession(harness);

    const res = await request(harness.app).delete(`/api/sessions/${a.session.sessionId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.session.status).toBe('ENDED');
    expect(await harness.k8s.getNamespace(a.session.namespace)).toBeNull();
    // B is untouched.
    expect(await harness.k8s.getNamespace(b.session.namespace)).not.toBeNull();
  });

  it('refuses further action on an ended session', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);
    await request(harness.app).delete(`/api/sessions/${session.sessionId}`);

    const res = await request(harness.app).post(`/api/sessions/${session.sessionId}/reset`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_NOT_ACTIVE');
  });
});

describe('internal credential endpoint', () => {
  it('requires the shared service secret', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);

    const res = await request(harness.app).post(
      `/internal/sessions/${session.sessionId}/credentials`,
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong secret', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);

    const res = await request(harness.app)
      .post(`/internal/sessions/${session.sessionId}/credentials`)
      .set('x-internal-secret', 'not-the-secret');

    expect(res.status).toBe(401);
  });

  it('issues a namespace-scoped kubeconfig to an authenticated service', async () => {
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session, terminal } = await startSession(harness);

    const res = await request(harness.app)
      .post(`/internal/sessions/${session.sessionId}/credentials`)
      .set('x-internal-secret', SECRET)
      // PLATFORM-010: the service must name the owner the token was minted for.
      .send(terminalCredentialBody(terminal.token, SECRET));

    expect(res.status).toBe(200);
    expect(res.body.data.namespace).toBe(session.namespace);
    expect(res.body.data.serviceAccountName).toBe('student');
    expect(res.body.data.kubeconfig).toContain(`namespace: ${session.namespace}`);
    expect(res.body.data.kubeconfig).not.toContain('client-certificate');
  });
});

describe('security posture', () => {
  it('exposes no endpoint that executes arbitrary commands', async () => {
    const { app } = buildApp(new FakeKubernetes(), registry);

    for (const route of [
      '/api/labs/K8S-001/exec',
      '/api/exec',
      '/api/labs/K8S-001/shell',
      '/api/sessions/sess-000000000000000a/exec',
    ]) {
      const res = await request(app).post(route).send({ command: 'id' });
      expect(res.status).toBe(404);
    }
  });

  it('offers no route that accepts a namespace from the caller', async () => {
    // Possessing or guessing a namespace name must never grant access.
    const harness = buildApp(new FakeKubernetes(), registry);
    const { session } = await startSession(harness);

    const res = await request(harness.app)
      .post(`/api/sessions/${session.sessionId}/check`)
      .send({ namespace: 'kube-system' });

    expect(res.status).toBe(200);
    // The supplied namespace was ignored entirely.
    expect(res.body.data.namespace).toBe(session.namespace);
  });

  it('does not leak a stack trace on unknown routes', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry).app).get('/api/nope');

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it('refuses to boot without a terminal session secret', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/TERMINAL_SESSION_SECRET/);
  });

  it('refuses an idle timeout longer than the absolute session lifetime', () => {
    expect(() =>
      loadConfig({
        TERMINAL_SESSION_SECRET: SECRET,
        MAX_SESSION_MINUTES: '30',
        IDLE_TIMEOUT_MINUTES: '60',
      } as NodeJS.ProcessEnv),
    ).toThrow(/must not exceed MAX_SESSION_MINUTES/);
  });
});
