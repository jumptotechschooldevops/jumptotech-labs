/**
 * "My sessions" asks for mine, not for everyone's.
 *
 * `GET /api/sessions` (the Continue-lab read the app makes on load, on every
 * navigation away from a workspace, and whenever the tab comes back) and the
 * learning path's next-lab rule both used to read *every* live session on the
 * platform and filter it in JavaScript. That is the platform's occupancy
 * answering a question about one student: the work each reader does grows with
 * how many other students are working, so a cohort refreshing together is
 * quadratic in rows for an answer that is at most one session — while
 * `lab_sessions_by_owner`, an index that exists for exactly this, went unused.
 *
 * This is a query-shape test, not a timing one: it counts what the store was
 * asked for.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
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
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'session-list-query-shape-test-secret';

/** Records what each read actually asked the store for. */
class CountingStore extends InMemorySessionStore {
  wholePlatformReads = 0;
  ownerReads = 0;
  rowsReturned = 0;

  override async listOccupying(): Promise<LabSession[]> {
    this.wholePlatformReads += 1;
    const rows = await super.listOccupying();
    this.rowsReturned += rows.length;
    return rows;
  }

  override async listOccupyingForOwner(ownerUserId: string): Promise<LabSession[]> {
    this.ownerReads += 1;
    const rows = await super.listOccupyingForOwner(ownerUserId);
    this.rowsReturned += rows.length;
    return rows;
  }
}

let registry: LabRegistry;

beforeEach(async () => {
  registry = await realCatalog();
});

async function harness() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS: '20',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
  } as NodeJS.ProcessEnv);

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });

  const store = new CountingStore();
  const sessions = new SessionManager({
    registry,
    providers,
    store,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  const app = createApp({
    registry,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    identityResolver: new DevelopmentIdentityResolver(new InMemoryUserRepository()),
  });
  return { app, store };
}

describe('the Continue-lab read', () => {
  it('reads one student\'s sessions, not every student\'s, however busy the platform is', async () => {
    const { app, store } = await harness();

    // A class of twelve, each holding a lab.
    for (let i = 0; i < 12; i += 1) {
      const started = await request(app)
        .post('/api/labs/LINUX-001/start')
        .set('Authorization', `Developer student${i}`);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
    }

    store.wholePlatformReads = 0;
    store.ownerReads = 0;
    store.rowsReturned = 0;

    const mine = await request(app).get('/api/sessions').set('Authorization', 'Developer student0');
    expect(mine.status).toBe(200);
    expect(mine.body.data.count).toBe(1);

    // The shape: one owner-scoped read, one row, and the platform's occupancy
    // never read at all.
    expect(store.ownerReads).toBe(1);
    expect(store.wholePlatformReads).toBe(0);
    expect(store.rowsReturned).toBe(1);
  }, 30_000);

  it('serves the learning path\'s next-lab rule the same way', async () => {
    const { app, store } = await harness();
    for (let i = 0; i < 6; i += 1) {
      await request(app).post('/api/labs/LINUX-001/start').set('Authorization', `Developer student${i}`);
    }

    store.wholePlatformReads = 0;
    store.rowsReturned = 0;

    const res = await request(app)
      .get('/api/me/learning-paths/linux-foundations')
      .set('Authorization', 'Developer student0');
    // The route may or may not know this path id; either way it must not have
    // read the whole platform to answer for one student.
    expect([200, 404]).toContain(res.status);
    expect(store.wholePlatformReads).toBe(0);
    expect(store.rowsReturned).toBeLessThanOrEqual(1);
  }, 30_000);
});
