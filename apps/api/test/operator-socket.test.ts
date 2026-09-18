/**
 * The operator socket (apps/api/src/operator.ts) and its CLI.
 *
 * What an operator on the host can ask the running api — capacity, whether a
 * new lab can start, who holds a slot — and the one thing it can do: end one
 * student's lab through the platform's own fenced teardown. The suite drives a
 * real socket in a private directory, over real session-manager state, and
 * proves both what it answers and what it refuses.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createConnection, createServer, type Server } from 'node:net';
import path from 'node:path';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
  type LabSession,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import {
  createLogger,
  createOperationsMetrics,
  createRegistry,
  createSessionMetrics,
} from '@jumptotech/observability';

import { sessionMetricsHooks } from '../src/observability.js';
import { loadConfig } from '../src/config.js';
import {
  OperatorSocketError,
  createOperatorHandler,
  prepareOperatorSocketPath,
  startOperatorSocket,
} from '../src/operator.js';
import { main as cli, parseArgs } from '../src/operator-cli.js';

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
});

// Unix socket paths are limited to ~104 bytes; a macOS TMPDIR is longer.
const dirs: string[] = [];
function privateDir(): string {
  const dir = mkdtempSync('/tmp/jttop-');
  dirs.push(dir);
  return dir;
}
const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Shaped like the POSTGRES_PASSWORD `make setup` generates (openssl rand -hex 24). */
const DB_PASSWORD_SENTINEL = '5e17c0ffee5e17c0ffee5e17c0ffee5e17c0ffee5e17c0ff';

class BrokenStore extends InMemorySessionStore {
  broken = false;
  override async listOccupying(): Promise<LabSession[]> {
    if (this.broken) throw new Error(`connect ECONNREFUSED postgres:5432 (password ${DB_PASSWORD_SENTINEL})`);
    return super.listOccupying();
  }
  override async list(): Promise<LabSession[]> {
    if (this.broken) throw new Error('connect ECONNREFUSED postgres:5432');
    return super.list();
  }
}

async function compose(options: { paused?: boolean; maxActive?: number; reaperLastSuccessMs?: number } = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'operator-socket-test-secret-value',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_ACTIVE_SESSIONS: String(options.maxActive ?? 3),
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
  } as NodeJS.ProcessEnv);

  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  const sessionMetrics = createSessionMetrics(registry);
  const operations = createOperationsMetrics(registry);
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });

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
  const store = new BrokenStore();
  const sessions = new SessionManager({
    registry: labs,
    provider,
    store,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    metrics: sessionMetricsHooks(sessionMetrics),
  });

  const socketPath = path.join(privateDir(), 'operator', 'api.sock');
  const server = await startOperatorSocket({
    socketPath,
    logger,
    handler: createOperatorHandler({
      sessions,
      logger,
      actions: operations.operatorActions,
      launchesPaused: options.paused === true,
      retentionSeconds: 15 * 60,
      reaperLastSuccessMs: () => options.reaperLastSuccessMs ?? Date.now() - 10_000,
      reaperIntervalSeconds: 60,
    }),
  });
  expect(server).not.toBeNull();
  servers.push(server!);

  const call = (method: 'GET' | 'POST', urlPath: string) =>
    new Promise<{ status: number; body: any; raw: string }>((resolve, reject) => {
      const req = request({ socketPath, method, path: urlPath }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), raw }));
      });
      req.on('error', reject);
      req.end();
    });

  const metric = async (name: string, labels: Record<string, string> = {}): Promise<number> => {
    const found = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
    return ((found?.values ?? []) as Array<{ value: number; labels: Record<string, string | number> }>)
      .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
      .reduce((sum, v) => sum + v.value, 0);
  };

  return { sessions, store, provider, socketPath, call, lines, metric };
}

/** Every key an operator view may carry. Anything else is a leak. */
const VIEW_KEYS = new Set([
  'sessionId', 'labId', 'provider', 'status', 'statusReason', 'sandboxRef', 'namespace', 'ownerUserId',
  'createdAt', 'statusChangedAt', 'lastActivityAt', 'expiresAt', 'endedAt',
  'ageSeconds', 'inStatusSeconds', 'idleSeconds', 'secondsUntilExpiry', 'occupiesSlot',
]);

describe('operator socket — reading', () => {
  it('reports an empty platform as able to start labs', async () => {
    const { call } = await compose();
    const reply = await call('GET', '/v1/status');
    expect(reply.status).toBe(200);
    expect(reply.body.data.newLabs).toEqual({ verdict: 'yes', reasons: [] });
    expect(reply.body.data.capacity).toMatchObject({ occupying: 0, maxActive: 3, available: 3, perStudentLimit: 1 });
    expect(reply.body.data.database.ok).toBe(true);
    expect(reply.body.data.launchesPaused).toBe(false);
    expect(reply.body.data.providers).toEqual([expect.objectContaining({ provider: 'kubernetes', available: true })]);
  });

  it('lists who holds a slot, which lab, since when — and nothing credential-shaped', async () => {
    const { sessions, call } = await compose();
    const alice = await sessions.start('K8S-001', 'user-alice');
    await sessions.start('K8S-002', 'user-bob');

    const reply = await call('GET', '/v1/sessions');
    expect(reply.status).toBe(200);
    expect(reply.body.data.count).toBe(2);
    const first = reply.body.data.sessions[0];
    expect(first).toMatchObject({
      sessionId: alice.session.sessionId,
      labId: 'K8S-001',
      provider: 'kubernetes',
      status: 'ACTIVE',
      ownerUserId: 'user-alice',
      sandboxRef: alice.session.sandboxRef,
      occupiesSlot: true,
    });
    for (const view of reply.body.data.sessions) {
      for (const key of Object.keys(view)) expect(VIEW_KEYS.has(key), `unexpected key ${key}`).toBe(true);
    }
    // No kubeconfig, token, service-account detail or environment id anywhere in the reply.
    expect(reply.raw).not.toMatch(/kubeconfig|token|serviceAccount|secret|environmentId/i);

    const one = await call('GET', `/v1/sessions/${alice.session.sessionId}`);
    expect(one.status).toBe(200);
    expect(one.body.data.sessionId).toBe(alice.session.sessionId);
  });

  it('says NO, with the reason, when capacity is full or launches are paused', async () => {
    const full = await compose({ maxActive: 1 });
    await full.sessions.start('K8S-001', 'user-alice');
    const status = await full.call('GET', '/v1/status');
    expect(status.body.data.newLabs.verdict).toBe('no');
    expect(status.body.data.newLabs.reasons.join('\n')).toMatch(/capacity is full: 1 of 1/);

    const paused = await compose({ paused: true });
    const pausedStatus = await paused.call('GET', '/v1/status');
    expect(pausedStatus.body.data.launchesPaused).toBe(true);
    expect(pausedStatus.body.data.newLabs.verdict).toBe('no');
    expect(pausedStatus.body.data.newLabs.reasons.join('\n')).toMatch(/LAB_LAUNCHES_PAUSED/);
  });

  it('does not count a track switched off by configuration against the verdict', async () => {
    const { sessions, call } = await compose();
    const statuses = sessions.providers.statuses.bind(sessions.providers);
    sessions.providers.statuses = async () => [
      ...(await statuses()),
      {
        providerId: 'aws',
        implementation: 'aws',
        sandboxKind: 'none',
        registered: true,
        available: false,
        disabled: true,
        reason: 'AWS labs are architecture only.',
      },
    ];
    const status = await call('GET', '/v1/status');
    expect(status.body.data.newLabs).toEqual({ verdict: 'yes', reasons: [] });
    expect(status.body.data.providers).toContainEqual(expect.objectContaining({ provider: 'aws', disabled: true }));

    // An enabled provider failing its probe is news.
    sessions.providers.statuses = async () =>
      (await statuses()).map((s) => ({ ...s, available: false, reason: 'the cluster is not reachable' }));
    const down = await call('GET', '/v1/status');
    expect(down.body.data.newLabs.verdict).toBe('no');
    expect(down.body.data.newLabs.reasons).toContain('no enabled sandbox provider is available');
  });

  it('calls a reaper that has missed five sweeps stalled', async () => {
    const { call } = await compose({ reaperLastSuccessMs: Date.now() - 400_000 });
    const status = await call('GET', '/v1/status');
    expect(status.body.data.reaper.stalled).toBe(true);
    expect(status.body.data.newLabs.verdict).toBe('degraded');
  });

  it('keeps answering when the database is gone, and never echoes the driver error', async () => {
    const { store, call, lines } = await compose();
    store.broken = true;

    const status = await call('GET', '/v1/status');
    expect(status.status).toBe(200);
    expect(status.body.data.database.ok).toBe(false);
    expect(status.body.data.capacity.occupying).toBeNull();
    expect(status.body.data.newLabs.verdict).toBe('no');

    const list = await call('GET', '/v1/sessions');
    expect(list.status).toBe(500);
    expect(list.body.error.code).toBe('OPERATOR_REQUEST_FAILED');
    expect(list.raw).not.toMatch(/ECONNREFUSED/);
    expect(list.raw).not.toContain(DB_PASSWORD_SENTINEL);
    // The operator finds the cause in the log, redacted.
    const logged = lines.find((line) => line.includes('"event":"ops.operator.request"') && line.includes('"outcome":"failed"'));
    expect(logged).toBeDefined();
    expect(logged).toContain('ECONNREFUSED');
    expect(logged).not.toContain(DB_PASSWORD_SENTINEL);
  });

  it('shows finished sessions and their reasons only when asked for recent ones', async () => {
    const { sessions, call } = await compose();
    const started = await sessions.start('K8S-001', 'user-alice');
    await sessions.end(started.session.sessionId);

    expect((await call('GET', '/v1/sessions')).body.data.count).toBe(0);
    const recent = await call('GET', '/v1/sessions?scope=recent');
    expect(recent.body.data.sessions).toEqual([
      expect.objectContaining({ sessionId: started.session.sessionId, status: 'ENDED', occupiesSlot: false }),
    ]);
    expect((await call('GET', '/v1/sessions?scope=everything')).status).toBe(400);
  });

  it('survives a request line URL cannot parse, and keeps serving', async () => {
    const { socketPath, call } = await compose();
    for (const target of ['http://[', '//[::1', 'http://%zz/']) {
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(socketPath, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let data = '';
        socket.on('data', (chunk) => (data += chunk));
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(raw, target).toMatch(/^HTTP\/1\.1 (400|404)/);
    }
    expect((await call('GET', '/v1/status')).status).toBe(200);
  });

  it('refuses malformed ids, unknown sessions, unknown paths and wrong methods', async () => {
    const { call } = await compose();
    expect((await call('GET', '/v1/sessions/..%2F..%2Fetc')).status).toBe(400);
    expect((await call('GET', '/v1/sessions/%E0%A4%A')).status).toBe(400);
    expect((await call('GET', '/v1/sessions/sess-0000000000000000')).status).toBe(404);
    expect((await call('GET', '/v1/sessions/sess-0000000000000000/end')).status).toBe(404);
    expect((await call('POST', '/v1/status')).status).toBe(404);
    expect((await call('GET', '/v1/sql')).status).toBe(404);
    expect((await call('GET', '/metrics')).status).toBe(404);
  });
});

describe('operator socket — ending one session', () => {
  it('ends a live session through the fenced teardown and gives the slot back', async () => {
    const { sessions, call, lines, metric } = await compose({ maxActive: 1 });
    const started = await sessions.start('K8S-001', 'user-alice');
    expect(await sessions.activeCount()).toBe(1);

    const reply = await call('POST', `/v1/sessions/${started.session.sessionId}/end`);
    expect(reply.status).toBe(200);
    expect(reply.body.data).toMatchObject({ before: 'ACTIVE', after: 'EXPIRED', sandboxGone: true });
    expect(reply.body.data.session.statusReason).toBe('ended by operator');

    const after = await sessions.require(started.session.sessionId);
    expect(after.status).toBe('EXPIRED');
    expect(after.statusReason).toBe('ended by operator');
    expect(await sessions.activeCount()).toBe(0);

    // Recorded as the operator's, not the student's and not a timeout.
    expect(await metric('jtt_lab_end_total', { reason: 'operator' })).toBe(1);
    expect(await metric('jtt_operator_actions_total', { action: 'end_session', outcome: 'ok' })).toBe(1);
    expect(lines.some((line) => line.includes('"event":"ops.operator.session_ended"') && line.includes('"outcome":"ended"'))).toBe(true);

    // The freed slot is usable at once.
    await expect(sessions.start('K8S-002', 'user-bob')).resolves.toBeDefined();
  });

  it('refuses to end a finished session, and records nothing as the operator\'s', async () => {
    const { sessions, call, lines, metric } = await compose();
    const started = await sessions.start('K8S-001', 'user-alice');
    await sessions.end(started.session.sessionId);

    const reply = await call('POST', `/v1/sessions/${started.session.sessionId}/end`);
    expect(reply.status).toBe(409);
    expect(reply.body.error.code).toBe('SESSION_ALREADY_FINISHED');
    expect(reply.body.error.message).toMatch(/already ENDED \(ended by student\)/);
    expect((await sessions.require(started.session.sessionId)).statusReason).toBe('ended by student');
    expect(lines.some((line) => line.includes('"event":"ops.operator.session_ended"'))).toBe(false);
    expect(await metric('jtt_operator_actions_total', { action: 'end_session', outcome: 'rejected' })).toBe(1);
  });

  it('finishes an expiry already in flight without relabelling it', async () => {
    const { sessions, provider, call, lines } = await compose();
    const started = await sessions.start('K8S-001', 'user-alice');
    const destroy = provider.destroy.bind(provider);
    provider.destroy = async () => ({ ok: true, namespaceGone: false, steps: [] });
    await sessions.expire(started.session.sessionId, 'idle for more than 1200s');
    expect((await sessions.require(started.session.sessionId)).status).toBe('EXPIRING');

    provider.destroy = destroy;
    const reply = await call('POST', `/v1/sessions/${started.session.sessionId}/end`);
    expect(reply.status).toBe(200);
    expect(reply.body.data).toMatchObject({ before: 'EXPIRING', after: 'EXPIRED', endedBy: 'existing_teardown' });
    expect((await sessions.require(started.session.sessionId)).statusReason).toBe('idle for more than 1200s');
    const logged = lines.find((line) => line.includes('"event":"ops.operator.session_ended"'));
    expect(logged).toContain('"outcome":"finished_existing_teardown"');
  });

  it('keeps the slot and says so when the delete is not confirmed, and finishes on retry', async () => {
    const { sessions, provider, call } = await compose();
    const started = await sessions.start('K8S-001', 'user-alice');
    const destroy = provider.destroy.bind(provider);
    provider.destroy = async () => ({
      ok: false,
      namespaceGone: false,
      steps: [],
      error: { code: 'DESTROY_FAILED', message: 'the API server did not answer' },
    });

    const pending = await call('POST', `/v1/sessions/${started.session.sessionId}/end`);
    expect(pending.status).toBe(202);
    expect(pending.body.data).toMatchObject({ after: 'EXPIRING', sandboxGone: false, destroyError: 'DESTROY_FAILED' });
    expect(await sessions.activeCount()).toBe(1);

    provider.destroy = destroy;
    const done = await call('POST', `/v1/sessions/${started.session.sessionId}/end`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ before: 'EXPIRING', after: 'EXPIRED' });
    expect(await sessions.activeCount()).toBe(0);
  });

  it("resumes a student's own End as that End rather than relabelling it", async () => {
    const { sessions, provider, call } = await compose();
    const started = await sessions.start('K8S-001', 'user-alice');
    const destroy = provider.destroy.bind(provider);
    provider.destroy = async () => ({ ok: true, namespaceGone: false, steps: [] });
    await sessions.end(started.session.sessionId);
    expect((await sessions.require(started.session.sessionId)).status).toBe('ENDING');

    provider.destroy = destroy;
    const reply = await call('POST', `/v1/sessions/${started.session.sessionId}/end`);
    expect(reply.body.data).toMatchObject({ before: 'ENDING', after: 'ENDED', endedBy: 'existing_teardown' });
    expect((await sessions.require(started.session.sessionId)).statusReason).toBe('ended by student');
  });
});

describe('operator socket — the socket itself', () => {
  it('lives in a 0700 directory, as a 0600 socket', async () => {
    const { socketPath } = await compose();
    expect(lstatSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('refuses a directory that group or other can enter, a symlink, a relative path, or a non-socket at the path', () => {
    const open = path.join(privateDir(), 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => prepareOperatorSocketPath(path.join(open, 'api.sock'))).toThrow(OperatorSocketError);

    expect(() => prepareOperatorSocketPath('tmp/api.sock')).toThrow(/absolute/);

    const target = path.join(privateDir(), 'target');
    mkdirSync(target, { mode: 0o700 });
    const link = path.join(privateDir(), 'link');
    symlinkSync(target, link);
    expect(() => prepareOperatorSocketPath(path.join(link, 'api.sock'))).toThrow(OperatorSocketError);

    const dir = path.join(privateDir(), 'private');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(path.join(dir, 'api.sock'), 'not a socket');
    expect(() => prepareOperatorSocketPath(path.join(dir, 'api.sock'))).toThrow(/not a socket/);
  });

  it('replaces a stale socket left by a previous process', async () => {
    const dir = path.join(privateDir(), 'stale');
    mkdirSync(dir, { mode: 0o700 });
    const socketPath = path.join(dir, 'api.sock');
    // A crashed process leaves its socket file behind. Node unlinks on a clean
    // close, so make the leftover by hard-linking a live socket and closing it.
    const donorPath = path.join(dir, 'donor.sock');
    const old: Server = createServer();
    await new Promise<void>((resolve) => old.listen(donorPath, resolve));
    linkSync(donorPath, socketPath);
    await new Promise<void>((resolve) => old.close(() => resolve()));
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    const server = await startOperatorSocket({
      socketPath,
      logger: createLogger({ service: 'api', sink: () => undefined }),
      handler: (_req, res) => res.end('{"ok":true}'),
    });
    expect(server).not.toBeNull();
    servers.push(server!);
    const answered = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath, path: '/' }, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve(raw));
      });
      req.on('error', reject);
      req.end();
    });
    expect(answered).toBe('{"ok":true}');
  });

  it('never throws into the api when it cannot start', async () => {
    const lines: string[] = [];
    const server = await startOperatorSocket({
      socketPath: 'relative/api.sock',
      logger: createLogger({ service: 'api', sink: (line) => lines.push(line) }),
      handler: (_req, res) => res.end(),
    });
    expect(server).toBeNull();
    expect(lines.some((line) => line.includes('"event":"ops.operator_socket.failed"'))).toBe(true);
  });

  it('is off unless OPERATOR_SOCKET_PATH is set, and refuses a relative one', () => {
    const base = { TERMINAL_SESSION_SECRET: 'operator-socket-test-secret-value', ALLOWED_ORIGINS: 'http://localhost:3000' };
    expect(loadConfig(base as NodeJS.ProcessEnv).operations.operatorSocketPath).toBeUndefined();
    expect(
      loadConfig({ ...base, OPERATOR_SOCKET_PATH: '/tmp/jtt-operator/api.sock' } as NodeJS.ProcessEnv).operations
        .operatorSocketPath,
    ).toBe('/tmp/jtt-operator/api.sock');
    expect(() => loadConfig({ ...base, OPERATOR_SOCKET_PATH: 'api.sock' } as NodeJS.ProcessEnv)).toThrow(/absolute/);
  });
});

describe('operator CLI', () => {
  it('will not end a lab without --yes', () => {
    expect(parseArgs(['end', 'sess-0123456789abcdef'])).toEqual({ error: expect.stringMatching(/--yes/) });
    expect(parseArgs(['end', 'sess-0123456789abcdef', '--yes'])).toEqual({
      command: { kind: 'end', id: 'sess-0123456789abcdef' },
      json: false,
    });
    expect(parseArgs(['drop', 'everything'])).toEqual({ error: 'unknown command drop' });
    expect(parseArgs(['sessions', '--force'])).toEqual({ error: 'unknown option --force' });
  });

  it('prints the status and the session table from the socket', async () => {
    const { sessions, socketPath } = await compose();
    await sessions.start('K8S-001', 'user-alice');
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await cli(['status'], { OPERATOR_SOCKET_PATH: socketPath })).toBe(0);
      expect(await cli(['sessions'], { OPERATOR_SOCKET_PATH: socketPath })).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    const text = out.join('');
    expect(text).toMatch(/new labs:\s+YES/);
    expect(text).toMatch(/slots:\s+1 of 3 held, 2 free \(ACTIVE 1\)/);
    expect(text).toMatch(/K8S-001\s+kubernetes\s+ACTIVE/);
  });

  it('exits 3 with a pointer when the socket is not there', async () => {
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await cli(['status'], { OPERATOR_SOCKET_PATH: path.join(privateDir(), 'missing.sock') })).toBe(3);
      expect(await cli(['status'], {})).toBe(3);
    } finally {
      process.stderr.write = write;
    }
    expect(errors.join('')).toMatch(/cannot reach the api's operator socket/);
  });
});
