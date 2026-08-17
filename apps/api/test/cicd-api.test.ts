/**
 * PLATFORM-CICD-001 — the CI/CD track through the real API.
 *
 * This is the acceptance walk-through, driven over HTTP rather than by hand:
 * open the catalog, find CI/CD, open CICD-002, start it, create the workflow
 * in the session's own workspace, check (fail, then pass), reset, start a
 * second session, confirm isolation, end the first, confirm the second still
 * works.
 *
 * A real `WorkspaceLabProvider` over a real temporary directory backs it. The
 * Kubernetes side is faked, as everywhere else in this file's neighbours,
 * because a CI/CD session never touches a cluster — which is itself one of the
 * things asserted here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  CompositeLabProvider,
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
  WorkspaceLabProvider,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { waitForRequirements } from '@jumptotech/verifier';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/*
 * These tests deliberately spawn real processes — a workspace build, a real
 * test run — so the 5s default meant for pure unit tests does not apply. The
 * budget below is generous on purpose: a timeout here should mean something is
 * genuinely wrong, not that the machine was busy running the rest of the suite.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

const WORKFLOW_PATH = '.github/workflows/ci.yml';

/** The workflow a CICD-002 student ends up with. */
const CORRECT_WORKFLOW = `name: CI

on:
  push:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Say hello
        run: echo "continuous integration is on"
`;

/** Valid YAML, but not a workflow GitHub would ever run. */
const INVALID_WORKFLOW = `name: CI

jobs:
  build:
    steps:
      - run: echo hi
`;

let registry: LabRegistry;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

interface Harness {
  app: ReturnType<typeof createApp>;
  sessions: SessionManager;
  workspaces: WorkspaceLabProvider;
  root: string;
}

let harness: Harness;

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jtt-api-workspaces-'));
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    LAB_WORKSPACE_ROOT: root,
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const k8s = new FakeKubernetes();
  const kubernetes = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
  });
  kubernetes.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const workspaces = new WorkspaceLabProvider({
    root: config.workspaceRoot,
    waitForRequirements: (input) => waitForRequirements(input),
  });

  const sessions = new SessionManager({
    registry,
    provider: new CompositeLabProvider({ providers: { kubernetes, workspace: workspaces } }),
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });

  harness = { app: createApp({ registry, sessions, k8s, config }), sessions, workspaces, root };
});

afterEach(async () => {
  await rm(harness.root, { recursive: true, force: true });
});

interface StartedSession {
  sessionId: string;
  namespace: string;
  status: string;
}

async function start(labId: string): Promise<StartedSession> {
  const res = await request(harness.app).post(`/api/labs/${labId}/start`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.session as StartedSession;
}

/** Write a file into one session's workspace, as the student's shell would. */
async function writeInWorkspace(
  session: StartedSession,
  relative: string,
  contents: string,
): Promise<void> {
  const absolute = path.join(harness.workspaces.workspacePath(session.namespace), relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function checkSolution(session: StartedSession) {
  return request(harness.app).post(`/api/sessions/${session.sessionId}/check`);
}

// -------------------------------------------------------------- the catalog

describe('the catalog serves CI/CD (acceptance steps 1–3)', () => {
  it('lists CI/CD as a track alongside Kubernetes', async () => {
    const res = await request(harness.app).get('/api/labs');
    expect(res.status).toBe(200);

    const tracks = res.body.data.tracks as Array<{ track: string; title: string; labCount: number }>;
    expect(tracks.map((t) => t.track)).toEqual(expect.arrayContaining(['cicd', 'kubernetes']));
    expect(tracks.find((t) => t.track === 'cicd')).toMatchObject({ title: 'CI/CD', labCount: 10 });
  });

  it('lists CICD-001 through CICD-010 when the track is selected', async () => {
    const res = await request(harness.app).get('/api/labs?track=cicd');
    expect(res.status).toBe(200);
    expect((res.body.data.labs as Array<{ id: string }>).map((l) => l.id)).toEqual([
      'CICD-001',
      'CICD-002',
      'CICD-003',
      'CICD-004',
      'CICD-005',
      'CICD-006',
      'CICD-007',
      'CICD-008',
      'CICD-009',
      'CICD-010',
    ]);
  });

  it('serves a lab page without revealing the answer', async () => {
    const res = await request(harness.app).get('/api/labs/CICD-002');
    expect(res.status).toBe(200);

    const lab = res.body.data;
    expect(lab.id).toBe('CICD-002');
    expect(lab.environment).toEqual({ provider: 'workspace', isolation: 'workspace' });
    expect(lab.requirements.every((r: string) => typeof r === 'string')).toBe(true);
    // The requirement *objects* — which name the expected job id, runner and
    // trigger — are never projected.
    expect(JSON.stringify(lab)).not.toContain('github_workflow_job_exists');
    expect(lab.setup).toBeUndefined();
  });

  it('keeps the catalog generic — no route or payload names a track', async () => {
    const res = await request(harness.app).get('/api/tracks');
    expect(res.status).toBe(200);
    const tracks = res.body.data.tracks as Array<{ track: string }>;
    expect(tracks.length).toBeGreaterThanOrEqual(2);
  });
});

// -------------------------------------------------- start, check, reset, end

describe('a CI/CD session (acceptance steps 4–12)', () => {
  it('starts, seeds a private workspace, and issues no cluster credential', async () => {
    const res = await request(harness.app).post('/api/labs/CICD-002/start');
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const { session, environment, steps, terminal } = res.body.data;
    expect(session.status).toBe('ACTIVE');
    expect(environment.provider).toBe('workspace');
    expect(environment.phase).toBe('ready');
    expect(steps.map((s: { id: string }) => s.id)).toEqual([
      'environment-created',
      'toolchain',
      'lab-initial-state',
    ]);
    expect(terminal.token).toBeTruthy();
    // Nothing credential-shaped and no filesystem path reaches the browser.
    expect(JSON.stringify(res.body)).not.toContain(harness.root);
    expect(JSON.stringify(res.body)).not.toMatch(/kubeconfig|BEGIN [A-Z ]*PRIVATE KEY/i);

    const workspaceRoot = harness.workspaces.workspacePath(session.namespace);
    expect(await readdir(workspaceRoot)).toEqual(
      expect.arrayContaining(['README.md', 'build.mjs', 'src', 'test']),
    );
  });

  it('gives the terminal a workspace and no kubeconfig', async () => {
    const session = await start('CICD-002');

    const res = await request(harness.app)
      .post(`/internal/sessions/${session.sessionId}/credentials`)
      .set('x-internal-secret', SECRET);

    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('workspace');
    expect(res.body.data.workspacePath).toBe(harness.workspaces.workspacePath(session.namespace));
    expect(res.body.data.kubeconfig).toBeUndefined();
  });

  it('returns LAB NOT COMPLETE for an invalid workflow (acceptance step 10)', async () => {
    const session = await start('CICD-002');
    await writeInWorkspace(session, WORKFLOW_PATH, INVALID_WORKFLOW);

    const res = await checkSolution(session);

    // A failing lab is a successful check: HTTP 200 with passed:false.
    expect(res.status).toBe(200);
    expect(res.body.data.passed).toBe(false);
    expect(res.body.data.summary).toBe('LAB NOT COMPLETE');

    const failed = (res.body.data.checks as Array<{ status: string; detail?: string }>).filter(
      (c) => c.status === 'fail',
    );
    expect(failed.length).toBeGreaterThan(0);
    // The detail describes what is wrong, and never how to fix it.
    expect(failed.some((c) => /no 'on:' trigger/.test(c.detail ?? ''))).toBe(true);
  });

  it('returns LAB PASSED for a correct workflow (acceptance step 11)', async () => {
    const session = await start('CICD-002');
    await writeInWorkspace(session, WORKFLOW_PATH, CORRECT_WORKFLOW);

    const res = await checkSolution(session);

    expect(res.status).toBe(200);
    expect(
      res.body.data.checks.filter((c: { status: string }) => c.status !== 'pass'),
      JSON.stringify(res.body.data.checks, null, 2),
    ).toEqual([]);
    expect(res.body.data.passed).toBe(true);
    expect(res.body.data.summary).toBe('LAB PASSED');
  });

  it('validates the actual pipeline structure of a Jenkinsfile (acceptance steps 13–15)', async () => {
    const session = await start('CICD-006');

    // A file that exists but is not a pipeline.
    await writeInWorkspace(session, 'Jenkinsfile', 'echo "this is not a declarative pipeline"\n');
    const first = await checkSolution(session);
    expect(first.body.data.passed).toBe(false);
    expect(
      (first.body.data.checks as Array<{ detail?: string }>).some((c) =>
        /pipeline/.test(c.detail ?? ''),
      ),
    ).toBe(true);

    await writeInWorkspace(
      session,
      'Jenkinsfile',
      "pipeline {\n    agent any\n\n    stages {\n        stage('Build') {\n            steps {\n                sh 'node build.mjs'\n            }\n        }\n    }\n}\n",
    );
    const second = await checkSolution(session);
    expect(
      second.body.data.checks.filter((c: { status: string }) => c.status !== 'pass'),
      JSON.stringify(second.body.data.checks, null, 2),
    ).toEqual([]);
    expect(second.body.data.passed).toBe(true);
  });

  it('reset restores the original project files (acceptance step 12)', async () => {
    const session = await start('CICD-002');
    await writeInWorkspace(session, WORKFLOW_PATH, CORRECT_WORKFLOW);
    await writeInWorkspace(session, 'README.md', 'I replaced the README');

    const res = await request(harness.app).post(`/api/sessions/${session.sessionId}/reset`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.clearTerminal).toBe(true);
    expect(res.body.data.restored).toContain('README.md');

    const workspace = harness.workspaces.workspaceFor(session.namespace);
    expect(await workspace.readText(WORKFLOW_PATH)).toBeNull();
    expect(await workspace.readText('README.md')).toContain('jumptotech-statements');

    // ...and the lab is back to not complete.
    const after = await checkSolution(session);
    expect(after.body.data.passed).toBe(false);
  });
});

// ------------------------------------------------------------ isolation

describe('five simultaneous CI/CD sessions (acceptance steps 16–19)', () => {
  it('keeps every workspace independent, and End Lab affects only one', async () => {
    const sessions: StartedSession[] = [];
    for (let i = 0; i < 5; i += 1) sessions.push(await start('CICD-002'));

    expect(new Set(sessions.map((s) => s.namespace)).size).toBe(5);

    // Four students write a correct workflow; one writes an invalid one.
    for (const [i, session] of sessions.entries()) {
      await writeInWorkspace(
        session,
        WORKFLOW_PATH,
        i === 4 ? INVALID_WORKFLOW : CORRECT_WORKFLOW.replace('name: CI', `name: CI-${i}`),
      );
    }

    // Each student's result reflects their own workspace, and nobody else's.
    for (const [i, session] of sessions.entries()) {
      const res = await checkSolution(session);
      expect(res.body.data.passed, `session ${i}`).toBe(i !== 4);
    }

    // Nobody can read anybody else's file.
    for (const [i, session] of sessions.entries()) {
      if (i === 4) continue;
      const text = await harness.workspaces.workspaceFor(session.namespace).readText(WORKFLOW_PATH);
      expect(text).toContain(`name: CI-${i}`);
      for (let other = 0; other < 4; other += 1) {
        if (other === i) continue;
        expect(text).not.toContain(`name: CI-${other}`);
      }
    }

    // Ending one session destroys exactly one workspace.
    const [first, ...rest] = sessions;
    if (!first) throw new Error('unreachable');
    const ended = await request(harness.app).delete(`/api/sessions/${first.sessionId}`);
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.data.session.status).toBe('ENDED');
    expect(
      await stat(harness.workspaces.workspacePath(first.namespace)).catch(() => null),
    ).toBeNull();

    // The others are untouched and still checkable.
    for (const [i, session] of rest.entries()) {
      const status = await request(harness.app).get(`/api/sessions/${session.sessionId}`);
      expect(status.body.data.session.status, `session ${i + 1}`).toBe('ACTIVE');
      expect(status.body.data.environment.phase).toBe('ready');

      const res = await checkSolution(session);
      expect(res.body.data.passed, `session ${i + 1}`).toBe(i + 1 !== 4);
    }

    // Acting on the ended session is refused, not silently reattached.
    const afterEnd = await checkSolution(first);
    expect(afterEnd.status).toBe(409);
    expect(afterEnd.body.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('runs a Kubernetes session and a CI/CD session side by side', async () => {
    const cicd = await start('CICD-002');
    const k8s = await start('K8S-001');

    expect(cicd.namespace).not.toBe(k8s.namespace);

    // The CI/CD session got a workspace; the Kubernetes one did not.
    expect(
      (await stat(harness.workspaces.workspacePath(cicd.namespace))).isDirectory(),
    ).toBe(true);
    expect(
      await stat(harness.workspaces.workspacePath(k8s.namespace)).catch(() => null),
    ).toBeNull();

    // ...and each gets the credential kind its provider issues.
    const cicdCredentials = await request(harness.app)
      .post(`/internal/sessions/${cicd.sessionId}/credentials`)
      .set('x-internal-secret', SECRET);
    const k8sCredentials = await request(harness.app)
      .post(`/internal/sessions/${k8s.sessionId}/credentials`)
      .set('x-internal-secret', SECRET);

    expect(cicdCredentials.body.data.kind).toBe('workspace');
    expect(k8sCredentials.body.data.kind).toBe('kubeconfig');
  });
});
