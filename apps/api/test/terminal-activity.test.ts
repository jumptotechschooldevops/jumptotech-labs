/**
 * BETA-P0-005 — the API side of terminal activity.
 *
 * `POST /internal/sessions/:id/activity` is how the terminal service reports
 * that a student typed. It must hold the same line the credential exchange
 * does: the service secret, then the owner claim from the verified token
 * compared with the live record. And it must record activity the way the store
 * defines it — the idle clock only, never the absolute deadline, and never on a
 * session that has already finished.
 *
 * `services/terminal/test/session-activity.test.ts` drives this over a real
 * WebSocket; this file pins the route's own contract with a controlled clock.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  type LabSession,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'terminal-activity-secret-value';
const OWNER_A = 'usr-0000000a';
const OWNER_B = 'usr-0000000b';

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

let app: Express;
let manager: SessionManager;
let clock: { now: number };
let a: LabSession;
let b: LabSession;

beforeEach(async () => {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
  } as NodeJS.ProcessEnv);

  clock = { now: Date.parse('2026-09-13T12:00:00.000Z') };
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  manager = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
    now: () => clock.now,
  });
  app = createApp({ registry, sessions: manager, k8s: new FakeKubernetes(), config });

  a = (await manager.start('LINUX-001', OWNER_A)).session;
  b = (await manager.start('LINUX-001', OWNER_B)).session;
  // Ten quiet minutes, so any movement of the clock is unambiguous.
  clock.now += 10 * 60_000;
});

/** Exactly what the terminal service sends after verifying a token. */
function activity(sessionId: string, body: Record<string, unknown> = {}, secret: string | null = SECRET) {
  const call = request(app).post(`/internal/sessions/${sessionId}/activity`);
  return (secret === null ? call : call.set('x-internal-secret', secret)).send(body);
}

const stored = async (session: LabSession) => (await manager.get(session.sessionId))!;

describe('the internal activity report', () => {
  it('moves the owner’s idle clock to now, and nothing else', async () => {
    const res = await activity(a.sessionId, { ownerUserId: OWNER_A });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recorded: true });
    const after = await stored(a);
    expect(after.lastActivityAt).toBe(new Date(clock.now).toISOString());
    expect(after.expiresAt).toBe(a.expiresAt);
    expect(after.status).toBe('ACTIVE');
  });

  it('refuses one student’s owner id on another student’s session', async () => {
    const res = await activity(b.sessionId, { ownerUserId: OWNER_A });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SESSION_NOT_OWNED');
    expect((await stored(b)).lastActivityAt).toBe(b.lastActivityAt);
    expect((await stored(a)).lastActivityAt).toBe(a.lastActivityAt);
  });

  it('refuses a caller without the internal service secret', async () => {
    for (const secret of [null, 'wrong-secret-value-of-some-length']) {
      const res = await activity(a.sessionId, { ownerUserId: OWNER_A }, secret);
      expect(res.status).toBe(401);
    }
    expect((await stored(a)).lastActivityAt).toBe(a.lastActivityAt);
  });

  it('refuses a report that names no owner, or a non-string one', async () => {
    for (const body of [{}, { ownerUserId: '' }, { ownerUserId: null }, { ownerUserId: ['usr-0000000a'] }]) {
      const res = await activity(a.sessionId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('OWNER_REQUIRED');
    }
    expect((await stored(a)).lastActivityAt).toBe(a.lastActivityAt);
  });

  it('refuses unknown and malformed session ids', async () => {
    expect((await activity('sess-00000000deadbeef', { ownerUserId: OWNER_A })).status).toBe(404);
    expect((await activity('not-a-session', { ownerUserId: OWNER_A })).status).toBe(400);
  });

  it('never revives a session that has ended', async () => {
    await manager.end(a.sessionId);
    const ended = await stored(a);
    clock.now += 60_000;

    const res = await activity(a.sessionId, { ownerUserId: OWNER_A });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recorded: false });
    const after = await stored(a);
    expect(after.status).toBe('ENDED');
    expect(after.lastActivityAt).toBe(ended.lastActivityAt);
  });
});
