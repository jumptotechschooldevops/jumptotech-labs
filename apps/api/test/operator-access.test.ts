/**
 * Managing lab access through the operator socket — docs/commercial-access.md §4.
 *
 * The one place access can be granted, suspended, restored or revoked. A real
 * socket in a private directory, the real CLI, real session-manager state: the
 * suite proves what an operator can do, that every change is attributed and
 * recorded, what is refused, and that nothing in a reply is a credential.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createLogger, createOperationsMetrics, createRegistry } from '@jumptotech/observability';

import { loadConfig } from '../src/config.js';
import { createOperatorHandler, startOperatorSocket } from '../src/operator.js';
import { main as cli, parseArgs } from '../src/operator-cli.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { InMemoryAccessStore, type AccessPolicy } from '../src/access/entitlements.js';

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
});

const dirs: string[] = [];
const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

async function compose(policy: AccessPolicy = 'entitlement') {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'operator-access-test-secret-value',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_ACTIVE_SESSIONS: '5',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
  } as NodeJS.ProcessEnv);
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
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
  provider.execute = async () => ({ exitCode: 0, stdout: '{"clientVersion":{"gitVersion":"v1.34.2"}}', stderr: '', timedOut: false });
  const sessions = new SessionManager({
    registry: labs,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });

  const users = new InMemoryUserRepository('oidc');
  const alice = await users.upsert({ issuer: 'https://issuer.example.com/', subject: 'a-1', email: 'alice@example.com', displayName: 'Alice' });
  const bob = await users.upsert({ issuer: 'https://issuer.example.com/', subject: 'b-2', email: 'bob@example.com' });
  const store = new InMemoryAccessStore(users);
  const clock = { now: NOW };

  const dir = mkdtempSync('/tmp/jttacc-');
  dirs.push(dir);
  const socketPath = path.join(dir, 'operator', 'api.sock');
  const server = await startOperatorSocket({
    socketPath,
    logger,
    handler: createOperatorHandler({
      sessions,
      logger,
      actions: operations.operatorActions,
      launchesPaused: false,
      retentionSeconds: 15 * 60,
      reaperLastSuccessMs: () => clock.now,
      reaperIntervalSeconds: 60,
      access: { store, policy },
      now: () => clock.now,
    }),
  });
  expect(server).not.toBeNull();
  servers.push(server!);

  const call = (method: 'GET' | 'POST', urlPath: string, body?: unknown) =>
    new Promise<{ status: number; body: any; raw: string }>((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const req = request({ socketPath, method, path: urlPath, headers: payload ? { 'content-type': 'application/json' } : {} }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), raw }));
      });
      req.on('error', reject);
      req.end(payload);
    });

  /** Run the CLI and capture what it printed. */
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const code = await cli(argv, { OPERATOR_SOCKET_PATH: socketPath });
      return { code, out: out.join(''), err: err.join('') };
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    }
  };

  const metric = async (name: string, labels: Record<string, string>) => {
    const found = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
    return ((found?.values ?? []) as Array<{ value: number; labels: Record<string, string | number> }>)
      .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
      .reduce((sum, v) => sum + v.value, 0);
  };

  return { alice, bob, store, sessions, call, run, lines, clock, metric };
}

describe('operator access — the support workflow', () => {
  it('finds a student by email, grants them, and explains their state at each step', async () => {
    const { alice, run, metric } = await compose();

    const found = await run('access', 'find', '--email', 'ALICE@example.com');
    expect(found.code).toBe(0);
    expect(found.out).toContain(alice.userId);
    expect(found.out).toContain('NONE');

    const before = await run('access', 'show', alice.userId);
    expect(before.out).toMatch(/access:\s+NONE — may NOT use labs/);
    expect(before.out).toContain('Signed in, never granted');

    const granted = await run(
      'access', 'grant', alice.userId, '--until', '2026-12-31T23:59:59Z', '--by', 'aisalkyn', '--reason', 'cohort 1 paid',
    );
    expect(granted.code, granted.err + granted.out).toBe(0);
    expect(granted.out).toContain('grant: done');
    expect(granted.out).toContain('ACTIVE');

    const after = await run('access', 'show', alice.userId);
    expect(after.out).toMatch(/access:\s+ACTIVE — may use labs/);
    expect(after.out).toContain('window:         2026-10-01T12:00:00.000Z … 2026-12-31T23:59:59.000Z');
    // The history names who and why.
    expect(after.out).toMatch(/GRANT\s+by aisalkyn: NONE → ACTIVE .* — cohort 1 paid/);

    const list = await run('access', 'list', '--state', 'active');
    expect(list.out).toContain(alice.userId);
    expect(list.out).not.toContain('bob@example.com');
    expect(await metric('jtt_operator_actions_total', { action: 'access_grant', outcome: 'ok' })).toBe(1);
  });

  it('suspends, restores and revokes, recording every change in order', async () => {
    const { alice, run, call } = await compose();
    await run('access', 'grant', alice.userId, '--no-expiry', '--by', 'ops', '--reason', 'scholarship');
    expect((await run('access', 'suspend', alice.userId, '--by', 'support', '--reason', 'payment disputed')).code).toBe(0);
    expect((await run('access', 'restore', alice.userId, '--by', 'support', '--reason', 'dispute resolved')).code).toBe(0);
    expect((await run('access', 'revoke', alice.userId, '--by', 'ops', '--reason', 'left the programme')).code).toBe(0);

    const shown = await call('GET', `/v1/access/${alice.userId}`);
    expect(shown.body.data.account.state).toBe('REVOKED');
    expect(shown.body.data.history.map((h: { action: string; by: string }) => `${h.action}:${h.by}`)).toEqual([
      'REVOKE:ops',
      'RESTORE:support',
      'SUSPEND:support',
      'GRANT:ops',
    ]);
    expect(shown.body.data.diagnosis[0]).toMatch(/Revoked by an operator/);
  });

  it('is idempotent: repeating a change writes nothing and says so', async () => {
    const { alice, run, store } = await compose();
    await run('access', 'grant', alice.userId, '--no-expiry', '--by', 'ops', '--reason', 'paid');
    await run('access', 'suspend', alice.userId, '--by', 'ops', '--reason', 'x');
    const again = await run('access', 'suspend', alice.userId, '--by', 'ops', '--reason', 'x again');
    expect(again.code).toBe(0);
    expect(again.out).toContain('already in effect — nothing changed, nothing recorded');
    expect(await store.events(alice.userId, 10)).toHaveLength(2);
  });

  it('shows the running labs a suspension leaves, and ends them only when told to with --yes', async () => {
    const { alice, run, sessions } = await compose();
    await run('access', 'grant', alice.userId, '--no-expiry', '--by', 'ops', '--reason', 'paid');
    const started = await sessions.start('K8S-001', alice.userId);

    const suspended = await run('access', 'suspend', alice.userId, '--by', 'ops', '--reason', 'chargeback');
    expect(suspended.out).toContain(`still running: ${started.session.sessionId}`);
    expect(suspended.out).toContain('keep their slot until');
    expect((await sessions.require(started.session.sessionId)).status).toBe('ACTIVE');

    // Tearing down a student's work needs the explicit confirmation.
    const unconfirmed = await run('access', 'revoke', alice.userId, '--by', 'ops', '--reason', 'r', '--end-sessions');
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain('--yes');

    const revoked = await run('access', 'revoke', alice.userId, '--by', 'ops', '--reason', 'r', '--end-sessions', '--yes');
    expect(revoked.code, revoked.err + revoked.out).toBe(0);
    expect(revoked.out).toContain(`ended ${started.session.sessionId}`);
    expect((await sessions.listOccupying()).filter((s) => s.ownerUserId === alice.userId)).toEqual([]);
  });

  it('says plainly when the deployment does not enforce access at all', async () => {
    const { alice, run } = await compose('open');
    const shown = await run('access', 'show', alice.userId);
    expect(shown.out).toContain('policy:         open');
    expect(shown.out).toContain('ACCESS_POLICY=open');
    expect(shown.out).toMatch(/NONE — may use labs/);
  });
});

describe('operator access — what is refused', () => {
  it('requires who and why on every change, and an explicit expiry decision on a grant', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseArgs(['access', 'grant', id, '--no-expiry', '--reason', 'x'])).toEqual({ error: expect.stringContaining('--by') });
    expect(parseArgs(['access', 'grant', id, '--no-expiry', '--by', 'ops'])).toEqual({ error: expect.stringContaining('--reason') });
    expect(parseArgs(['access', 'grant', id, '--by', 'ops', '--reason', 'x'])).toEqual({
      error: expect.stringContaining('unlimited access is never a default'),
    });
    expect(parseArgs(['access', 'grant', id, '--no-expiry', '--until', '2027-01-01T00:00:00Z', '--by', 'o', '--reason', 'x'])).toEqual({
      error: expect.stringContaining('exactly one'),
    });
    expect(parseArgs(['access', 'restore', id, '--end-sessions', '--by', 'o', '--reason', 'x'])).toEqual({
      error: expect.stringContaining('unknown option --end-sessions'),
    });
    expect(parseArgs(['access', 'grant', '--email', 'a@b.c', '--no-expiry', '--by', 'o', '--reason', 'x'])).toEqual({
      error: expect.stringContaining('unknown option --email'),
    });
    expect(parseArgs(['access', 'delete', id])).toEqual({ error: 'unknown access command delete' });
  });

  it('refuses on the socket what the CLI would never send', async () => {
    const { alice, call, store } = await compose();
    const grant = (body: unknown) => call('POST', `/v1/access/${alice.userId}/grant`, body);

    expect((await grant({ by: 'ops', reason: 'x' })).body.error.code).toBe('EXPIRY_REQUIRED');
    expect((await grant({ by: 'ops', reason: 'x', until: '2026-12-31' })).body.error.code).toBe('INVALID_TIME');
    expect((await grant({ by: 'ops', reason: 'x', until: '2026-01-01T00:00:00Z' })).body.error.code).toBe('INVALID_WINDOW');
    expect((await grant({ reason: 'x', noExpiry: true })).body.error.code).toBe('INVALID_ACTOR');
    expect((await grant({ by: 'ops', noExpiry: true })).body.error.code).toBe('INVALID_REASON');
    // Mass assignment: a field the verb does not take is refused, not ignored.
    const smuggled = await grant({ by: 'ops', reason: 'x', noExpiry: true, status: 'ACTIVE', grantedVia: 'payment', userId: 'x' });
    expect(smuggled.status).toBe(400);
    expect(smuggled.body.error.code).toBe('INVALID_REQUEST');
    expect((await grant('{not json')).body.error.code).toBe('INVALID_REQUEST');
    expect((await grant(JSON.stringify({ by: 'ops', reason: 'x'.repeat(5000), noExpiry: true }))).status).toBe(400);

    // Nothing above wrote anything.
    expect(await store.get(alice.userId)).toBeNull();
    expect(await store.events(alice.userId, 10)).toEqual([]);
  });

  it('names accounts by internal id only, and refuses an unknown one', async () => {
    const { call } = await compose();
    expect((await call('POST', '/v1/access/alice@example.com/grant', { by: 'o', reason: 'x', noExpiry: true })).body.error.code).toBe(
      'INVALID_USER_ID',
    );
    const unknown = await call('POST', '/v1/access/usr-00000999/grant', { by: 'o', reason: 'x', noExpiry: true });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('USER_NOT_FOUND');
    expect((await call('GET', '/v1/access/usr-00000999')).status).toBe(404);
    expect((await call('POST', '/v1/access/usr-00000001/delete', {})).status).toBe(404);
    expect((await call('GET', '/v1/access?state=whatever')).status).toBe(400);
  });

  it('refuses transitions that would undo another decision silently', async () => {
    const { alice, call } = await compose();
    const post = (verb: string, body: Record<string, unknown> = {}) =>
      call('POST', `/v1/access/${alice.userId}/${verb}`, { by: 'ops', reason: 'x', ...body });
    expect((await post('suspend')).status).toBe(404); // nothing to suspend
    await post('grant', { noExpiry: true });
    await post('suspend');
    const grantOverSuspension = await post('grant', { noExpiry: true });
    expect(grantOverSuspension.status).toBe(409);
    expect(grantOverSuspension.body.error.code).toBe('ENTITLEMENT_SUSPENDED');
    await post('revoke');
    expect((await post('restore')).body.error.code).toBe('ENTITLEMENT_REVOKED');
  });
});

describe('operator access — what is logged', () => {
  it('logs each change with ids and states, never the reason, an email or a name', async () => {
    const { alice, run, lines } = await compose();
    await run('access', 'grant', alice.userId, '--no-expiry', '--by', 'ops', '--reason', 'invoice 1042 for Alice Smith');
    const changed = lines.map((line) => JSON.parse(line)).filter((line) => line.event === 'ops.operator.access_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ userId: alice.userId, action: 'grant', outcome: 'changed', accessState: 'ACTIVE' });
    const all = lines.join('\n');
    expect(all).not.toContain('invoice 1042');
    expect(all).not.toContain('alice@example.com');
    expect(all).not.toContain('Alice Smith');
  });

  it('never serves a credential-shaped field', async () => {
    const { alice, call, run } = await compose();
    await run('access', 'grant', alice.userId, '--no-expiry', '--by', 'ops', '--reason', 'paid');
    for (const url of ['/v1/access', `/v1/access/${alice.userId}`, '/v1/access/find?email=alice@example.com']) {
      const reply = await call('GET', url);
      expect(reply.status).toBe(200);
      expect(reply.raw).not.toMatch(/token|secret|password|cookie|kubeconfig|subject/i);
    }
  });
});

describe('the documented commands exist', () => {
  /**
   * Every `ops access …` line in the runbooks, parsed by the real CLI parser.
   * A documented command that the CLI refuses is a runbook that fails an
   * operator mid-incident.
   */
  it('parses every `ops access` command in docs/commercial-access.md and the operations runbook', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const docs = ['docs/commercial-access.md', 'docs/runbooks/private-beta-operations.md'].map((file) =>
      readFileSync(path.join(repoRoot, file), 'utf8'),
    );
    const commands = docs
      .flatMap((text) => text.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.startsWith('ops access '))
      // A trailing `# comment` is the doc's, not the command's.
      .map((line) => line.replace(/\s+#.*$/, ''));
    expect(commands.length).toBeGreaterThanOrEqual(12);

    for (const command of commands) {
      const argv = (command.slice('ops '.length).match(/"[^"]*"|\S+/g) ?? [])
        .map((word) => word.replace(/^"|"$/g, ''))
        .map((word) =>
          word === '<user-id>' ? '0f8fad5b-d9cb-469f-a165-70867728950e' : word === '<address>' ? 'a@example.com' : word,
        );
      const parsed = parseArgs(argv);
      expect(parsed, command).not.toHaveProperty('error');
    }
  });
});
