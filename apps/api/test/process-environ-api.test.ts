/**
 * PLATFORM-006 AC-2 — `process_environ` at the browser boundary.
 *
 * The verifier's own suite proves a check result never carries a value. This
 * proves the same thing one layer out, where it actually matters: the JSON body
 * `POST /api/sessions/:id/check` sends to a browser. The check route spreads the
 * whole verifier result into that body, so "the result is clean" and "the
 * response is clean" are different claims, and only the second one is the
 * promise made to a student.
 *
 * The lab is a fixture in a temporary directory, not a curriculum lab: this is
 * shared-platform work, and no track owns a lab that exists to test the
 * platform.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'integration-test-secret-value';
/** The value that must not appear anywhere in a browser-facing payload. */
const TOKEN = 'AKIA-THIS-MUST-NEVER-REACH-A-BROWSER';
const PID = 731;

const LAB = `id: FX-901
slug: fx-901-environ
title: Fixture Environment Lab
track: fixture
topic: fixtures
difficulty: beginner
duration_minutes: 15
order: 1
environment:
  provider: linux
  isolation: container
story: A fixture lab that exists only to test the platform.
objectives:
  - Prove a verdict reaches the browser without a value
task:
  summary: Configure the service environment.
  description: A longer description of the thing.
requirements:
  - type: process_environ
    pattern: /usr/local/lib/report-runner
    variables:
      - name: JTT_ENV
        equals: production
      - name: API_TOKEN
        present: true
    label: The report runner has the required environment
references:
  - title: environ(7)
    url: https://man7.org/linux/man-pages/man7/environ.7.html
skills:
  - linux.services.configure
hints:
  - level: 1
    text: Look at how the service is started.
  - level: 2
    text: Consult the manual page.
`;

let registry: LabRegistry;
let labsDir: string;
let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'jtt-environ-api-'));
  labsDir = path.join(tempRoot, 'labs');
  await mkdir(path.join(labsDir, 'fixture', 'fx-901-environ'), { recursive: true });
  await writeFile(path.join(labsDir, 'fixture', 'fx-901-environ', 'lab.yaml'), LAB, 'utf8');

  registry = new LabRegistry(labsDir);
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function buildApp(runtime: FakeContainerRuntime) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: labsDir,
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  const k8s = new FakeKubernetes();
  return { app: createApp({ registry, sessions, k8s, config }), runtime };
}

/** A sandbox whose service runs with a secret in its environment. */
function runtimeWith(env: Record<string, string>): FakeContainerRuntime {
  return new FakeContainerRuntime({
    processes: [`  ${PID} root     /usr/local/lib/report-runner --serve`],
    environs: {
      [PID]: Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\0'),
    },
  });
}

async function startAndCheck(runtime: FakeContainerRuntime) {
  const { app } = buildApp(runtime);
  const started = await request(app).post('/api/labs/FX-901/start');
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const sessionId = String(started.body.data.session.sessionId);
  return request(app).post(`/api/sessions/${sessionId}/check`);
}

describe('process_environ over the HTTP boundary', () => {
  it('passes when the process genuinely has the required environment', async () => {
    const response = await startAndCheck(
      runtimeWith({ JTT_ENV: 'production', API_TOKEN: TOKEN }),
    );

    expect(response.status).toBe(200);
    expect(response.body.data.passed, JSON.stringify(response.body.data.checks)).toBe(true);
    // Even a passing payload must not carry the value it proved the existence of.
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });

  it('fails without putting the wrong value, or the secret, in the response', async () => {
    const response = await startAndCheck(
      runtimeWith({ JTT_ENV: 'staging', API_TOKEN: TOKEN }),
    );

    expect(response.status).toBe(200);
    expect(response.body.data.passed).toBe(false);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(TOKEN);
    // Neither the actual value nor the expected one is disclosed.
    expect(body).not.toContain('staging');
    expect(body).not.toContain('production');
    // What the student does get: which variable, and that it is wrong.
    expect(body).toContain('JTT_ENV');
  });

  it('cannot be made to pass by a student who never set the variable', async () => {
    const response = await startAndCheck(runtimeWith({ JTT_ENV: 'production' }));

    expect(response.body.data.passed).toBe(false);
    expect(JSON.stringify(response.body)).toContain('API_TOKEN');
  });

  it('never serialises the process environment into any browser-facing route', async () => {
    const runtime = runtimeWith({ JTT_ENV: 'production', API_TOKEN: TOKEN });
    const { app } = buildApp(runtime);
    const started = await request(app).post('/api/labs/FX-901/start');
    const sessionId = String(started.body.data.session.sessionId);

    const responses = await Promise.all([
      request(app).get('/api/labs'),
      request(app).get('/api/labs/FX-901'),
      request(app).get('/api/tracks'),
      request(app).get(`/api/sessions/${sessionId}`),
      request(app).post(`/api/sessions/${sessionId}/check`),
      request(app).post(`/api/sessions/${sessionId}/activity`),
    ]);

    for (const response of responses) {
      const body = JSON.stringify(response.body);
      // The value itself, on every route a browser can reach.
      expect(body).not.toContain(TOKEN);
      /*
       * And no field of the machine-readable requirement. A check *id* carries
       * the requirement type — `1-process_environ-target`, the same shape as
       * the long-standing `1-pod_exists-nginx` — which is the platform's check
       * identifier, not the requirement. What must never appear is the
       * requirement's own content: which process is matched, which variables
       * are asserted, and what they are compared against.
       */
      expect(body).not.toContain('/usr/local/lib/report-runner');
      expect(body).not.toContain('variables');
      expect(body).not.toContain('equals');
    }
  });

  it('keeps the requirement itself out of the catalog, as for every other type', async () => {
    const { app } = buildApp(runtimeWith({ JTT_ENV: 'production', API_TOKEN: TOKEN }));

    for (const route of ['/api/labs', '/api/labs/FX-901', '/api/tracks/fixture/labs']) {
      const body = JSON.stringify((await request(app).get(route)).body);
      expect(body, route).not.toContain('process_environ');
      expect(body, route).not.toContain('/usr/local/lib/report-runner');
    }
  });
});
