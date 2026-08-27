/**
 * PLATFORM-003 — the logger's fail-closed field contract.
 *
 * The property under test is not "does it format JSON". It is: **a field the
 * schema does not know cannot reach the output**, by any route, including the
 * routes a future developer will try when they are in a hurry.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_LOG_FIELDS, createLogger, type Logger } from '../src/logger.js';
import { withContext } from '../src/context.js';

interface Capture {
  logger: Logger;
  raw: string[];
  /** A function, not a getter: destructuring a getter would freeze it empty. */
  lines(): Array<Record<string, unknown>>;
}

function capture(): Capture {
  const raw: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'debug',
    sink: (line) => raw.push(line),
    now: () => new Date('2026-08-27T00:00:00.000Z'),
  });
  return {
    logger,
    raw,
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('every line is well-formed', () => {
  it('emits single-line JSON with the required fields', () => {
    const { logger, raw, lines } = capture();
    logger.info('lab.start.succeeded', { labId: 'K8S-001' }, 'started');

    expect(raw[0]).not.toContain('\n');
    expect(lines()[0]).toMatchObject({
      ts: '2026-08-27T00:00:00.000Z',
      level: 'info',
      service: 'test',
      event: 'lab.start.succeeded',
      msg: 'started',
      labId: 'K8S-001',
    });
  });

  it('honours the level threshold', () => {
    const raw: string[] = [];
    const logger = createLogger({ service: 't', level: 'warn', sink: (l) => raw.push(l) });
    logger.debug('process.started');
    logger.info('process.started');
    logger.warn('process.started');
    logger.error('process.started');
    expect(raw).toHaveLength(2);
  });
});

describe('gate one: unknown fields never reach the output', () => {
  it('drops a field that is not on the allow-list', () => {
    const { logger, raw, lines } = capture();
    logger.info('authn.failed', {
      outcome: 'invalid_token',
      // Exactly the mistake the gate exists for. Typed as never in real code;
      // cast here to prove the *runtime* behaviour, which is what protects a
      // build where the type was widened or `any` crept in.
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sig',
      password: 'hunter2',
      cookie: 'jtt_session=abc',
      authorization: 'Bearer abc',
      kubeconfig: '-----BEGIN CERTIFICATE-----',
      command: 'sudo cat /etc/shadow',
      stdout: 'root:x:0:0',
      sql: 'SELECT * FROM users',
      email: 'student@example.edu',
    } as never);

    const line = lines()[0]!;
    expect(line.outcome).toBe('invalid_token');
    for (const dropped of [
      'token', 'password', 'cookie', 'authorization', 'kubeconfig',
      'command', 'stdout', 'sql', 'email',
    ]) {
      expect(line, `${dropped} must not be copied`).not.toHaveProperty(dropped);
    }
    // Belt and braces: not present under any key, not nested, not stringified.
    expect(raw[0]).not.toContain('hunter2');
    expect(raw[0]).not.toContain('sudo cat');
    expect(raw[0]).not.toContain('student@example.edu');
  });

  it('the runtime allow-list matches the LogFields interface', () => {
    /*
     * The type is erased at build time, so the runtime array is what actually
     * enforces the gate. A field added to the interface and forgotten in the
     * array would silently stop being logged — a quiet observability hole
     * rather than a loud one — so the two are pinned to each other here.
     */
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/logger.ts'),
      'utf8',
    );
    const body = source.slice(
      source.indexOf('export interface LogFields'),
      source.indexOf('const ALLOWED_FIELDS'),
    );
    const declared = [...body.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]!);

    expect(declared.length).toBeGreaterThan(20);
    expect([...declared].sort()).toEqual([...ALLOWED_LOG_FIELDS].sort());
  });
});

describe('gate two: values are scanned even in permitted fields', () => {
  it('redacts a secret that arrived inside a legitimate field', () => {
    const { logger, raw } = capture();
    logger.error('db.query_failed', {
      reason: 'could not connect to postgres://u:s3cr3tp4sswordvalue@db:5432/x',
    });
    expect(raw[0]).toContain('[REDACTED:dsn]');
    expect(raw[0]).not.toContain('s3cr3tp4sswordvalue');
  });

  it('redacts the message itself', () => {
    const { logger, raw } = capture();
    logger.warn('authn.failed', {}, 'rejected Bearer abcdefghijklmnopqrst');
    expect(raw[0]).toContain('[REDACTED:authorization]');
  });

  it('serialises an error without a stack and redacts its message', () => {
    const { logger, raw, lines } = capture();
    const error = Object.assign(new Error('failed for jtt_session=abcdef0123456789'), {
      code: 'ECONN',
    });
    logger.error('http.request.failed', { err: error });

    expect(lines()[0]!.err).toMatchObject({ name: 'Error', code: 'ECONN' });
    expect(JSON.stringify(lines()[0]!.err)).not.toHaveProperty('stack');
    expect(raw[0]).not.toContain('abcdef0123456789');
    expect(raw[0]).toContain('[REDACTED:cookie]');
  });
});

describe('ambient correlation', () => {
  it('inherits requestId and friends from the context', () => {
    const { logger, lines } = capture();
    withContext(
      { requestId: 'req-1', userId: 'usr-1', sessionId: 'sess-1', labId: 'K8S-001' },
      () => logger.info('lab.start.succeeded'),
    );
    expect(lines()[0]).toMatchObject({
      requestId: 'req-1',
      userId: 'usr-1',
      sessionId: 'sess-1',
      labId: 'K8S-001',
    });
  });

  it('omits correlation outside a request rather than inventing it', () => {
    const { logger, lines } = capture();
    logger.info('reaper.sweep.completed', { count: 3 });
    expect(lines()[0]).not.toHaveProperty('requestId');
    expect(lines()[0]).not.toHaveProperty('sessionId');
  });

  it('lets an explicit field win over the ambient one', () => {
    // The reaper's case: one sweep touches many sessions under no request.
    const { logger, lines } = capture();
    withContext({ requestId: 'req-1', sessionId: 'ambient' }, () =>
      logger.info('reaper.sandbox.reclaimed', { sessionId: 'explicit' }),
    );
    expect(lines()[0]!.sessionId).toBe('explicit');
    expect(lines()[0]!.requestId).toBe('req-1');
  });
});

describe('the logger never throws', () => {
  it('survives a sink that throws', () => {
    const logger = createLogger({
      service: 't',
      sink: () => {
        throw new Error('stdout closed');
      },
    });
    expect(() => logger.error('process.stopped')).not.toThrow();
  });

  it('survives an unserialisable field', () => {
    const raw: string[] = [];
    const logger = createLogger({ service: 't', sink: (l) => raw.push(l) });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => logger.info('process.started', { reason: cyclic as never })).not.toThrow();
    expect(() => JSON.parse(raw[0]!)).not.toThrow();
  });
});

describe('truncation preserves valid JSON', () => {
  it('keeps the line parseable and flags it', () => {
    const raw: string[] = [];
    const logger = createLogger({ service: 't', sink: (l) => raw.push(l), maxLineBytes: 400 });
    // Ordinary words, deliberately: a long unbroken alphanumeric run would be
    // redacted as a base64-shaped secret before it ever reached the truncator,
    // and the test would pass for the wrong reason.
    logger.info('process.started', { reason: 'lab session started '.repeat(300) });

    const parsed = JSON.parse(raw[0]!) as Record<string, unknown>;
    expect(parsed.truncated).toBe(true);
    expect(parsed.event).toBe('process.started');
    expect(Buffer.byteLength(raw[0]!)).toBeLessThanOrEqual(1200);
  });
});

describe('adapters for the existing seams', () => {
  it('legacy() turns a (message: string) => void seam into a structured line', () => {
    const { logger, lines } = capture();
    const seam = logger.legacy('reaper.sweep.completed');
    seam('removed 3 sandboxes');
    expect(lines()[0]).toMatchObject({
      event: 'reaper.sweep.completed',
      msg: 'removed 3 sandboxes',
      level: 'info',
    });
  });

  it('legacy() redacts, so an un-migrated call site cannot leak', () => {
    const { logger, raw } = capture();
    logger.legacy('db.query_failed', 'error')('postgres://u:le4kedp4sswordxyz@db/x');
    expect(raw[0]).not.toContain('le4kedp4sswordxyz');
  });

  it('child() pre-binds fields', () => {
    const { logger, lines } = capture();
    logger.child({ provider: 'linux' }).info('sandbox.create.succeeded', { op: 'create' });
    expect(lines()[0]).toMatchObject({ provider: 'linux', op: 'create' });
  });
});
