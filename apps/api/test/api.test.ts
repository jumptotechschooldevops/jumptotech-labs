/**
 * API surface tests. The provider is faked, so these assert routing,
 * validation, and response shape — not cluster behaviour.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { KindLabProvider, LabRegistry, verifySessionToken } from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryLabSessionStore } from '../src/session-store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

function buildApp(k8s: FakeKubernetes, registry: LabRegistry) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
  });
  // Health-check kubectl without touching a real binary.
  provider.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  return createApp({
    registry,
    provider,
    k8s,
    sessions: new InMemoryLabSessionStore(),
    config,
  });
}

let registry: LabRegistry;
beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
});

describe('GET /health', () => {
  it('reports service status and loaded labs', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.provider).toBe('kind');
    expect(res.body.data.labsLoaded).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/labs', () => {
  it('lists K8S-001 under the kubernetes track', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).get('/api/labs');

    expect(res.status).toBe(200);
    expect(res.body.data.tracks).toContain('kubernetes');
    expect(res.body.data.labs.map((l: { id: string }) => l.id)).toContain('K8S-001');
  });
});

describe('GET /api/labs/:id', () => {
  it('returns lab content sourced from lab.yaml', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).get('/api/labs/K8S-001');

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Create Your First Pod');
    expect(res.body.data.target).toEqual({
      podName: 'nginx',
      namespace: 'default',
      image: 'nginx:stable',
      status: 'Running',
    });
    expect(res.body.data.documentation[0].url).toMatch(/^https:\/\/kubernetes\.io\//);
  });

  it('accepts a lowercase id', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).get('/api/labs/k8s-001');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('K8S-001');
  });

  it('returns 404 for a valid but unknown id', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).get('/api/labs/K8S-404');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LAB_NOT_FOUND');
  });

  it.each([
    ['..%2F..%2Fetc%2Fpasswd', 400],
    ['K8S-001;id', 400],
    ['not-a-lab', 400],
  ])('rejects a malformed id (%s)', async (id, status) => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).get(`/api/labs/${id}`);

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe('INVALID_LAB_ID');
  });
});

describe('POST /api/labs/:id/start', () => {
  it('returns provisioning steps and a signed terminal token', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).post('/api/labs/K8S-001/start');

    expect(res.status).toBe(200);
    expect(res.body.data.steps.map((s: { id: string }) => s.id)).toEqual([
      'environment-created',
      'kubernetes-api',
      'kubectl',
    ]);
    expect(res.body.data.environment.phase).toBe('ready');

    const claims = verifySessionToken(res.body.data.terminal.token, SECRET);
    expect(claims.labId).toBe('K8S-001');
    expect(claims.namespace).toBe('default');
  });

  it('reports the real failure instead of pretending the lab is ready', async () => {
    const k8s = new FakeKubernetes({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });

    const res = await request(buildApp(k8s, registry)).post('/api/labs/K8S-001/start');

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toContain('ECONNREFUSED');
    expect(res.body.error.details.steps.some((s: { status: string }) => s.status === 'failed')).toBe(true);
  });
});

describe('POST /api/labs/:id/check', () => {
  it('returns LAB PASSED for a correct Pod', async () => {
    const k8s = new FakeKubernetes({ pods: { default: [podSnapshot()] } });

    const res = await request(buildApp(k8s, registry)).post('/api/labs/K8S-001/check');

    expect(res.status).toBe(200);
    expect(res.body.data.passed).toBe(true);
    expect(res.body.data.summary).toBe('LAB PASSED');
  });

  it('returns LAB NOT COMPLETE with 200 when the Pod is missing', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).post('/api/labs/K8S-001/check');

    expect(res.status).toBe(200);
    expect(res.body.data.passed).toBe(false);
    expect(res.body.data.summary).toBe('LAB NOT COMPLETE');
  });

  it('returns 503 when the cluster cannot be read', async () => {
    const k8s = new FakeKubernetes({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });

    const res = await request(buildApp(k8s, registry)).post('/api/labs/K8S-001/check');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ENVIRONMENT_UNREACHABLE');
  });
});

describe('POST /api/labs/:id/reset', () => {
  it('removes student resources and confirms success', async () => {
    const k8s = new FakeKubernetes({ pods: { default: [podSnapshot()] } });

    const res = await request(buildApp(k8s, registry)).post('/api/labs/K8S-001/reset');

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Lab reset successfully.');
    expect(res.body.data.removed).toContain('pods/nginx');
    expect(res.body.data.clearTerminal).toBe(true);
  });
});

describe('DELETE /api/labs/:id/environment', () => {
  it('releases the environment', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).delete(
      '/api/labs/K8S-001/environment',
    );

    expect(res.status).toBe(200);
    expect(res.body.data.labId).toBe('K8S-001');
  });
});

describe('security posture', () => {
  it('exposes no endpoint that executes arbitrary commands', async () => {
    const app = buildApp(new FakeKubernetes(), registry);

    for (const route of ['/api/labs/K8S-001/exec', '/api/exec', '/api/labs/K8S-001/shell']) {
      const res = await request(app).post(route).send({ command: 'id' });
      expect(res.status).toBe(404);
    }
  });

  it('does not leak a stack trace on unknown routes', async () => {
    const res = await request(buildApp(new FakeKubernetes(), registry)).get('/api/nope');

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it('refuses to boot without a terminal session secret', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/TERMINAL_SESSION_SECRET/);
  });
});
