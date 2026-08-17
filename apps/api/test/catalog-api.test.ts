/**
 * PLATFORM-003 — the catalog API.
 *
 * Story test requirements 30–33: `GET /api/labs` returns the catalog,
 * `GET /api/labs/:id` returns the correct student-safe definition, an unknown
 * lab returns an appropriate error, and the PLATFORM-002 session APIs still
 * work unchanged.
 *
 * The cluster is faked here: these tests assert routing, projection, and the
 * catalog-safety rules. Cluster behaviour is proved against real kind in the
 * orchestrator's integration suite.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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
import { FakeKubernetes, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

let registry: LabRegistry;

function buildApp(k8s = new FakeKubernetes()) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
    waitForRequirements: async () => ({ ok: true, checks: [] }),
  });
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

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

// -------------------------------------------------------- 30. GET /api/labs

describe('GET /api/labs — the catalog (test requirement 30)', () => {
  it('returns every lab with its tracks', async () => {
    const res = await request(buildApp().app).get('/api/labs');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.count).toBe(20);

    const idsIn = (track: string) =>
      res.body.data.labs
        .filter((l: { track: string }) => l.track === track)
        .map((l: { id: string }) => l.id);

    expect(idsIn('kubernetes')).toEqual([
      'K8S-001',
      'K8S-002',
      'K8S-003',
      'K8S-004',
      'K8S-005',
      'K8S-006',
      'K8S-007',
      'K8S-008',
      'K8S-009',
      'K8S-010',
    ]);
    expect(idsIn('ansible')).toEqual([
      'ANSIBLE-001',
      'ANSIBLE-002',
      'ANSIBLE-003',
      'ANSIBLE-004',
      'ANSIBLE-005',
      'ANSIBLE-006',
      'ANSIBLE-007',
      'ANSIBLE-008',
      'ANSIBLE-009',
      'ANSIBLE-010',
    ]);

    // Track discovery is data-driven — the catalog reports whatever labs/ holds.
    expect(res.body.data.tracks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ track: 'kubernetes', title: 'Kubernetes', labCount: 10 }),
        expect.objectContaining({ track: 'ansible', title: 'Ansible', labCount: 10 }),
      ]),
    );
  });

  it('gives a card everything it needs to render', async () => {
    const res = await request(buildApp().app).get('/api/labs');
    const card = res.body.data.labs.find((l: { id: string }) => l.id === 'K8S-002');

    expect(card).toMatchObject({
      id: 'K8S-002',
      title: 'Run an Application with a Deployment',
      track: 'kubernetes',
      topic: 'workloads',
      difficulty: 'beginner',
      durationMinutes: 30,
      certifications: ['CKA'],
    });
    expect(card.skills).toContain('kubernetes.deployments.scale');
    expect(card.prerequisites).toEqual([
      { id: 'K8S-001', title: 'Create Your First Pod', available: true },
    ]);
  });

  it('filters by track, topic, difficulty and free text', async () => {
    const { app } = buildApp();

    const byTrack = await request(app).get('/api/labs?track=kubernetes');
    expect(byTrack.body.data.count).toBe(10);

    const byOtherTrack = await request(app).get('/api/labs?track=ansible');
    expect(byOtherTrack.body.data.count).toBe(10);

    const byTopic = await request(app).get('/api/labs?topic=batch');
    expect(byTopic.body.data.labs.map((l: { id: string }) => l.id)).toEqual(['K8S-006', 'K8S-007']);

    const byDifficulty = await request(app).get('/api/labs?track=kubernetes&difficulty=intermediate');
    expect(byDifficulty.body.data.count).toBe(3);

    const byQuery = await request(app).get('/api/labs?q=secret');
    expect(byQuery.body.data.labs.map((l: { id: string }) => l.id)).toEqual(['K8S-005']);
  });

  it('treats an unknown filter value as matching nothing, not as an error', async () => {
    const res = await request(buildApp().app).get('/api/labs?track=does-not-exist');

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(0);
  });

  it('states plainly that prerequisites are not enforced', async () => {
    const res = await request(buildApp().app).get('/api/labs');
    expect(res.body.data.prerequisitesEnforced).toBe(false);
  });

  it('never leaks requirements, setup manifests, or reset policy', async () => {
    const body = JSON.stringify((await request(buildApp().app).get('/api/labs')).body);

    expect(body).not.toContain('requirements');
    expect(body).not.toContain('setup/');
    expect(body).not.toContain('purge_namespaced_resources');
    // K8S-010's faults are not discoverable from the catalog.
    expect(body).not.toContain('nginx:stabel');
  });

  it('creates nothing in the cluster', async () => {
    const { app, k8s } = buildApp();
    await request(app).get('/api/labs');
    await request(app).get('/api/labs/K8S-010');

    // Browsing the catalog must cost nothing — no namespace, no API object.
    expect(k8s.deletedNamespaces).toEqual([]);
    expect([...k8s.applied.keys()]).toEqual([]);
    expect([...k8s.namespaces.keys()].sort()).toEqual(['default', 'kube-system']);
  });
});

// ---------------------------------------------------- 31. GET /api/labs/:id

describe('GET /api/labs/:id — the student-safe definition (test requirement 31)', () => {
  it('returns the full brief for a lab', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-003');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 'K8S-003',
      title: 'Expose a Workload with a Service',
      topic: 'networking',
      topicTitle: 'Networking',
      difficulty: 'beginner',
      durationMinutes: 30,
      hasSetup: true,
      prerequisitesEnforced: false,
    });
    expect(res.body.data.story).toContain('accounts service');
    expect(res.body.data.objectives.length).toBeGreaterThan(0);
    expect(res.body.data.certifications).toEqual([
      { certification: 'CKA', domains: ['services-and-networking'] },
    ]);
  });

  it('serves requirements as student-facing labels only', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-003');

    expect(res.body.data.requirements).toEqual([
      'Service accounts exists',
      'Service type is ClusterIP',
      'Service selects the accounts Pods',
      'Service accepts port 80 and forwards to container port 80',
      'Both accounts Pods are registered as ready endpoints',
    ]);
    // Never the requirement objects themselves.
    for (const requirement of res.body.data.requirements) {
      expect(typeof requirement).toBe('string');
    }
  });

  it('serves the progressive hint ladder in order', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-006');

    expect(res.body.data.hints.map((h: { level: number }) => h.level)).toEqual([1, 2, 3]);
    expect(res.body.data.hints[0].text).toBeTruthy();
  });

  it('serves only official documentation links', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-010');

    expect(res.body.data.references.length).toBeGreaterThan(0);
    for (const ref of res.body.data.references) {
      expect(new URL(ref.url).hostname).toBe('kubernetes.io');
    }
  });

  it('resolves prerequisites to titles', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-010');

    expect(res.body.data.prerequisites).toEqual([
      { id: 'K8S-003', title: 'Expose a Workload with a Service', available: true },
      { id: 'K8S-008', title: 'Signal Readiness with a Probe', available: true },
    ]);
  });

  it('does not reveal a troubleshooting lab\'s injected fault', async () => {
    const body = JSON.stringify((await request(buildApp().app).get('/api/labs/K8S-010')).body);

    // The student is told what "working" looks like, never what is broken or
    // which manifest broke it.
    expect(body).not.toContain('nginx:stabel');
    expect(body).not.toContain('setup/ledger-api.yaml');
    expect(body).not.toContain('purge_namespaced_resources');
    expect(body).toContain('Deployment runs the correct application image');
  });

  it('renders every shipped lab through the same projection', async () => {
    const { app } = buildApp();

    for (const lab of registry.all()) {
      const res = await request(app).get(`/api/labs/${lab.id}`);
      expect(res.status, lab.id).toBe(200);
      expect(res.body.data.id).toBe(lab.id);
      // The generic lab page needs these on every lab, with no special cases.
      expect(Array.isArray(res.body.data.requirements)).toBe(true);
      expect(Array.isArray(res.body.data.objectives)).toBe(true);
      expect(Array.isArray(res.body.data.hints)).toBe(true);
      expect(Array.isArray(res.body.data.prerequisites)).toBe(true);
      expect(res.body.data.task.summary).toBeTruthy();
    }
  });
});

// ------------------------------------------------------------- 32. errors

describe('GET /api/labs/:id — unknown labs (test requirement 32)', () => {
  it('returns 404 LAB_NOT_FOUND for a well-formed id that does not exist', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-999');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('LAB_NOT_FOUND');
  });

  it('returns 400 INVALID_LAB_ID for a malformed id', async () => {
    for (const bad of ['not-a-lab', '../../etc/passwd', 'k8s-1']) {
      const res = await request(buildApp().app).get(`/api/labs/${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error.code).toBe('INVALID_LAB_ID');
    }
  });

  it('refuses to start an unknown lab, and creates nothing', async () => {
    const { app, k8s } = buildApp();
    const res = await request(app).post('/api/labs/K8S-999/start');

    expect(res.status).toBe(404);
    expect([...k8s.namespaces.keys()].sort()).toEqual(['default', 'kube-system']);
  });
});

// -------------------------------------------------------------- tracks API

describe('GET /api/tracks', () => {
  it('lists tracks', async () => {
    const res = await request(buildApp().app).get('/api/tracks');

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);

    const tracks = res.body.data.tracks as Array<{
      track: string;
      title: string;
      labCount: number;
      topics: Array<{ topic: string }>;
    }>;
    const kubernetes = tracks.find((t) => t.track === 'kubernetes');
    const ansible = tracks.find((t) => t.track === 'ansible');

    expect(kubernetes).toMatchObject({ track: 'kubernetes', title: 'Kubernetes', labCount: 10 });
    expect(kubernetes?.topics.map((t) => t.topic)).toContain('batch');

    expect(ansible).toMatchObject({ track: 'ansible', title: 'Ansible', labCount: 10 });
    expect(ansible?.topics.map((t) => t.topic)).toContain('troubleshooting');
  });

  it('returns the ansible track with its labs', async () => {
    const res = await request(buildApp().app).get('/api/tracks/ansible');

    expect(res.status).toBe(200);
    expect(res.body.data.track).toMatchObject({ track: 'ansible', labCount: 10 });
    expect(res.body.data.labs).toHaveLength(10);
    expect(res.body.data.labs[0]).toMatchObject({ id: 'ANSIBLE-001', track: 'ansible' });
  });

  it('returns one track with its labs', async () => {
    const res = await request(buildApp().app).get('/api/tracks/kubernetes');

    expect(res.status).toBe(200);
    expect(res.body.data.track).toMatchObject({ track: 'kubernetes', labCount: 10 });
    expect(res.body.data.labs).toHaveLength(10);
  });

  it('returns the labs in a track', async () => {
    const res = await request(buildApp().app).get('/api/tracks/kubernetes/labs');

    expect(res.status).toBe(200);
    expect(res.body.data.track).toBe('kubernetes');
    expect(res.body.data.count).toBe(10);
    expect(res.body.data.prerequisitesEnforced).toBe(false);
  });

  it('applies filters within the track', async () => {
    const res = await request(buildApp().app).get('/api/tracks/kubernetes/labs?difficulty=intermediate');

    expect(res.body.data.labs.map((l: { id: string }) => l.id)).toEqual([
      'K8S-008',
      'K8S-009',
      'K8S-010',
    ]);
  });

  it('ignores a track query parameter that contradicts the path', async () => {
    // The path pins the track; a query parameter must not widen the result.
    const res = await request(buildApp().app).get('/api/tracks/kubernetes/labs?track=terraform');

    expect(res.body.data.track).toBe('kubernetes');
    expect(res.body.data.count).toBe(10);
  });

  it('returns 404 for an unknown track and 400 for a malformed one', async () => {
    const missing = await request(buildApp().app).get('/api/tracks/terraform');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('TRACK_NOT_FOUND');

    const malformed = await request(buildApp().app).get('/api/tracks/NOT_A_TRACK');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_TRACK_ID');

    const missingLabs = await request(buildApp().app).get('/api/tracks/terraform/labs');
    expect(missingLabs.status).toBe(404);
  });

  it('never leaks lab internals through the track endpoints', async () => {
    const body = JSON.stringify((await request(buildApp().app).get('/api/tracks/kubernetes/labs')).body);

    expect(body).not.toContain('requirements');
    expect(body).not.toContain('setup/');
    expect(body).not.toContain('nginx:stabel');
  });
});

// ------------------------------------------ 33. PLATFORM-002 still intact

describe('PLATFORM-002 session APIs still work (test requirement 33)', () => {
  it('starts, checks, resets and ends a session on a PLATFORM-003 lab', async () => {
    const harness = buildApp();

    const started = await request(harness.app).post('/api/labs/K8S-002/start');
    expect(started.status).toBe(200);
    const { sessionId, namespace } = started.body.data.session;

    // Every PLATFORM-002 property still holds for a new lab.
    expect(sessionId).toMatch(/^sess-[0-9a-f]+$/);
    expect(namespace).toMatch(/^lab-[0-9a-f]+$/);
    expect(namespace).not.toBe('default');
    expect(started.body.data.terminal.token).toBeTruthy();

    const status = await request(harness.app).get(`/api/sessions/${sessionId}`);
    expect(status.status).toBe(200);
    expect(status.body.data.session.status).toBe('ACTIVE');

    const check = await request(harness.app).post(`/api/sessions/${sessionId}/check`);
    expect(check.status).toBe(200);
    expect(check.body.data.labId).toBe('K8S-002');
    expect(check.body.data.namespace).toBe(namespace);
    expect(check.body.data.passed).toBe(false);

    const activity = await request(harness.app).post(`/api/sessions/${sessionId}/activity`);
    expect(activity.status).toBe(200);

    const reset = await request(harness.app).post(`/api/sessions/${sessionId}/reset`);
    expect(reset.status).toBe(200);

    const ended = await request(harness.app).delete(`/api/sessions/${sessionId}`);
    expect(ended.status).toBe(200);
    expect(ended.body.data.session.status).toBe('ENDED');
    expect(harness.k8s.deletedNamespaces).toContain(namespace);
  });

  it('gives two sessions of the same lab two namespaces', async () => {
    const harness = buildApp();

    const a = await request(harness.app).post('/api/labs/K8S-010/start');
    const b = await request(harness.app).post('/api/labs/K8S-010/start');

    expect(a.body.data.session.namespace).not.toBe(b.body.data.session.namespace);
    expect(a.body.data.session.sessionId).not.toBe(b.body.data.session.sessionId);
  });

  it('seeds a lab fixture into the starting session namespace only', async () => {
    const harness = buildApp();

    const a = await request(harness.app).post('/api/labs/K8S-010/start');
    const b = await request(harness.app).post('/api/labs/K8S-002/start');
    const nsA = a.body.data.session.namespace;
    const nsB = b.body.data.session.namespace;

    // K8S-010 seeds a fixture; K8S-002 does not. Neither can see the other's.
    expect(harness.k8s.appliedKinds(nsA, 'Deployment').map((o) => o.metadata.name)).toEqual([
      'ledger-api',
    ]);
    expect(harness.k8s.appliedKinds(nsB, 'Deployment')).toEqual([]);
  });

  it('verifies each session against its own namespace only', async () => {
    const harness = buildApp();

    const a = await request(harness.app).post('/api/labs/K8S-001/start');
    const b = await request(harness.app).post('/api/labs/K8S-001/start');
    const nsA = a.body.data.session.namespace;

    // Only session A has the correct Pod.
    harness.k8s.pods.set(nsA, [podSnapshot({ namespace: nsA })]);

    const checkA = await request(harness.app).post(`/api/sessions/${a.body.data.session.sessionId}/check`);
    const checkB = await request(harness.app).post(`/api/sessions/${b.body.data.session.sessionId}/check`);

    expect(checkA.body.data.passed).toBe(true);
    expect(checkB.body.data.passed).toBe(false);
  });

  it('still exposes no endpoint that executes a command', async () => {
    const { app } = buildApp();

    for (const route of ['/api/labs/K8S-002/exec', '/api/sessions/sess-0000000a/exec', '/api/exec']) {
      const res = await request(app).post(route).send({ command: 'id' });
      expect(res.status, route).toBe(404);
    }
  });
});
