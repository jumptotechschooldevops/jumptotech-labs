/**
 * The session guard when the session store cannot answer.
 *
 * The guard looks the session up before it authorises anything, and used to
 * answer *every* failure of that lookup as "no such session": 404
 * SESSION_NOT_FOUND, audited as `denied-not-owner`. A lost database connection
 * or a pool timeout on that one query therefore
 *
 *   - told a student their running lab no longer existed (the web shows that
 *     as final, not retryable), and
 *   - recorded a cross-student access attempt, which is what
 *     `AuthzOwnershipDenialSpike` pages on — five students polling their labs
 *     through a database blip look exactly like someone probing session ids.
 *
 * An unknown session is still a 404 and still audited; a lookup that could not
 * run is the platform's failure, reported as one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  SessionManager,
  type LabSession,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AuthAuditEvent } from '../src/auth/middleware.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ALICE = { Authorization: 'Developer alice' };

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
});

/** A store whose reads can be made to fail, as a dropped connection does. */
class FlakyStore extends InMemorySessionStore {
  failReads = false;
  override async get(sessionId: string): Promise<LabSession | null> {
    if (this.failReads) throw new Error('Connection terminated unexpectedly');
    return super.get(sessionId);
  }
}

function compose() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'session-guard-store-failure-secret',
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);
  const store = new FlakyStore();
  const sessions = new SessionManager({
    registry: labs,
    provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }),
    store,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });
  const audits: AuthAuditEvent[] = [];
  const app = createApp({
    registry: labs,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    authAudit: (event) => void audits.push(event),
  });
  return { app, store, audits };
}

describe('the session guard when the store cannot answer', () => {
  it('is not "no such session", and is not audited as a cross-student attempt', async () => {
    const { app, store, audits } = compose();
    const started = await request(app).post('/api/labs/LINUX-001/start').set(ALICE);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const sessionId = started.body.data.session.sessionId as string;

    store.failReads = true;
    audits.length = 0;
    for (const [method, url] of [
      ['get', `/api/sessions/${sessionId}`],
      ['post', `/api/sessions/${sessionId}/check`],
      ['post', `/api/sessions/${sessionId}/activity`],
      ['delete', `/api/sessions/${sessionId}`],
    ] as const) {
      const res = await request(app)[method](url).set(ALICE);
      expect(res.status, `${method} ${url}`).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      // The driver's words never reach the browser.
      expect(JSON.stringify(res.body)).not.toContain('Connection terminated');
    }
    expect(audits.filter((a) => a.authorizationResult === 'denied-not-owner')).toEqual([]);

    // Once the store answers again, the lab is exactly where it was.
    store.failReads = false;
    const back = await request(app).get(`/api/sessions/${sessionId}`).set(ALICE);
    expect(back.status).toBe(200);
    expect(back.body.data.session.status).toBe('ACTIVE');
  });

  it('still answers an unknown session 404 and audits it', async () => {
    const { app, audits } = compose();
    const res = await request(app).get('/api/sessions/sess-00000000000000000000000000000000').set(ALICE);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
    expect(audits.map((a) => a.authorizationResult)).toContain('denied-not-owner');
  });

  it('still answers somebody else’s session exactly like an unknown one', async () => {
    const { app, audits } = compose();
    const started = await request(app).post('/api/labs/LINUX-001/start').set(ALICE);
    const sessionId = started.body.data.session.sessionId as string;

    const res = await request(app).get(`/api/sessions/${sessionId}`).set({ Authorization: 'Developer bob' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
    expect(audits.at(-1)?.authorizationResult).toBe('denied-not-owner');
  });
});
