/**
 * Giving an account a role through the operator socket.
 *
 * Until this, an INSTRUCTOR or ADMIN existed only by hand-written SQL against
 * `users`: a sign-in never sets a role (users.ts refuses to take one from a
 * token), and nothing else could. This is the one supported way, at the same
 * trust level as `access grant` — `docker exec` into the api container — with
 * the same rules: the account named by internal id, who and why required, and
 * the change logged with both.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
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

async function compose(options: { withUsers?: boolean } = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'operator-roles-test-secret-value',
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  const operations = createOperationsMetrics(registry);
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });
  const k8s = new FakeKubernetes();
  const provider = new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', sleep: async () => undefined });
  const sessions = new SessionManager({
    registry: labs,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });
  const users = new InMemoryUserRepository('oidc');
  const teacher = await users.upsert({ issuer: 'https://issuer.example.com/', subject: 't-1', email: 'teacher@example.com', displayName: 'Teacher' });

  const dir = mkdtempSync('/tmp/jttrole-');
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
      retentionSeconds: 900,
      reaperLastSuccessMs: () => Date.now(),
      reaperIntervalSeconds: 60,
      ...(options.withUsers === false ? {} : { users }),
    }),
  });
  servers.push(server!);

  const call = (method: 'GET' | 'POST', urlPath: string, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ socketPath, method, path: urlPath, headers: payload ? { 'content-type': 'application/json' } : {} }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end(payload);
    });

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

  const metric = async (labels: Record<string, string>) => {
    const found = (await registry.getMetricsAsJSON()).find((m) => m.name === 'jtt_operator_actions_total');
    return ((found?.values ?? []) as Array<{ value: number; labels: Record<string, string | number> }>)
      .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
      .reduce((sum, v) => sum + v.value, 0);
  };

  return { users, teacher, call, run, lines, metric };
}

describe('ops role', () => {
  it('shows a role, sets it with who and why, logs both, and is idempotent', async () => {
    const { users, teacher, run, lines, metric } = await compose();

    const shown = await run('role', 'show', teacher.userId);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('STUDENT');

    const set = await run('role', 'set', teacher.userId, 'instructor', '--by', 'aisalkyn', '--reason', 'teaches cohort 3');
    expect(set.code, set.err + set.out).toBe(0);
    expect(set.out).toMatch(/changed: .* is now INSTRUCTOR \(was STUDENT\)/);
    expect((await users.findById(teacher.userId))!.role).toBe('INSTRUCTOR');

    const changed = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === 'ops.operator.role_changed');
    expect(changed).toMatchObject({ userId: teacher.userId, result: 'STUDENT->INSTRUCTOR', level: 'warn' });
    expect(changed.msg).toContain('by aisalkyn: teaches cohort 3');
    expect(await metric({ action: 'role_set', outcome: 'ok' })).toBe(1);

    const again = await run('role', 'set', teacher.userId, 'INSTRUCTOR', '--by', 'aisalkyn', '--reason', 'again');
    expect(again.code).toBe(0);
    expect(again.out).toContain('unchanged');
    expect(lines.filter((line) => line.includes('ops.operator.role_changed'))).toHaveLength(1);
  });

  it('refuses a role that does not exist, a missing who or why, and a reason with a newline', async () => {
    const { users, teacher, run, call } = await compose();

    const bogus = await run('role', 'set', teacher.userId, 'SUPERUSER', '--by', 'x', '--reason', 'y');
    expect(bogus.code).toBe(1);
    expect(bogus.out).toContain('INVALID_ROLE');

    expect((await run('role', 'set', teacher.userId, 'ADMIN', '--reason', 'y')).code).toBe(2);
    expect((await run('role', 'set', teacher.userId, 'ADMIN', '--by', 'x')).code).toBe(2);

    const smuggled = await call('POST', `/v1/users/${teacher.userId}/role`, { role: 'ADMIN', by: 'x', reason: 'ok\nFAKE LOG LINE' });
    expect(smuggled.status).toBe(400);
    expect(smuggled.body.error.code).toBe('INVALID_REASON');
    const actor = await call('POST', `/v1/users/${teacher.userId}/role`, { role: 'ADMIN', by: 'two words', reason: 'r' });
    expect(actor.body.error.code).toBe('INVALID_ACTOR');

    expect((await users.findById(teacher.userId))!.role).toBe('STUDENT');
  });

  it('names accounts by internal id only, and says where to find one', async () => {
    const { call } = await compose();
    const byEmail = await call('GET', `/v1/users/${encodeURIComponent('teacher@example.com')}/role`);
    expect(byEmail.status).toBe(400);
    expect(byEmail.body.error.code).toBe('INVALID_USER_ID');
    const unknown = await call('GET', '/v1/users/usr-99999999/role');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toContain('access find');
  });

  it('does not exist where no user store was composed', async () => {
    const { teacher, call } = await compose({ withUsers: false });
    expect((await call('GET', `/v1/users/${teacher.userId}/role`)).status).toBe(404);
  });

  it('parses the CLI strictly', () => {
    expect(parseArgs(['role'])).toEqual({ error: 'role needs a command: show, set' });
    expect(parseArgs(['role', 'show'])).toMatchObject({ error: expect.stringContaining('exactly one') });
    expect(parseArgs(['role', 'show', 'u', '--by', 'x'])).toMatchObject({ error: '--by is for role set' });
    expect(parseArgs(['role', 'set', 'u', 'admin', '--by', 'me', '--reason', 'why'])).toEqual({
      command: { kind: 'role-set', userId: 'u', body: { role: 'ADMIN', by: 'me', reason: 'why' } },
      json: false,
    });
  });
});
