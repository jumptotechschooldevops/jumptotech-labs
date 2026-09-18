/**
 * The support bundle's log sanitiser (src/support-bundle.ts).
 *
 * Every case feeds a line carrying something that must not leave the host — a
 * credential, a query string, a row value, a user id, terminal content — and
 * proves it is gone, while the line's operational meaning survives.
 */
import { describe, expect, it } from 'vitest';

import { registerSecretValues } from '../src/redact.js';
import { findSecretLeaks, sanitizeLogLines, stripQueryStrings } from '../src/support-bundle.js';

const structured = (fields: Record<string, unknown>) =>
  JSON.stringify({ ts: '2026-09-18T06:00:00.000Z', service: 'api', ...fields });

describe('structured lines (api, terminal, sandboxd)', () => {
  it('keeps warnings, errors and lifecycle events, and drops ordinary info lines', () => {
    const result = sanitizeLogLines(
      [
        structured({ level: 'info', event: 'http.request.completed', route: '/api/labs', status: 200 }),
        structured({ level: 'info', event: 'authz.decision', userId: 'u-1', action: 'session:read' }),
        structured({ level: 'warn', event: 'lab.start.failed', labId: 'K8S-001', outcome: 'platform_error', code: 'ECONNREFUSED' }),
        structured({ level: 'info', event: 'process.started', version: '0.1.0', commit: 'abc1234' }),
        structured({ level: 'error', event: 'reaper.sweep.failed', msg: 'listing sessions failed' }),
      ],
      { source: 'structured', maxLines: 100 },
    );
    expect(result.lines.map((line) => JSON.parse(line).event)).toEqual([
      'lab.start.failed',
      'process.started',
      'reaper.sweep.failed',
    ]);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({ outcome: 'platform_error', code: 'ECONNREFUSED', labId: 'K8S-001' });
    expect(result.unrecognised).toBe(0);
  });

  it('keeps only allow-listed keys: no user id, no unknown field, whatever the line carried', () => {
    const [line] = sanitizeLogLines(
      [
        structured({
          level: 'error',
          event: 'http.request.failed',
          userId: '7c0ffee0-user-uuid',
          sessionId: 'sess-0123456789abcdef',
          kubeconfig: 'apiVersion: v1',
          stdout: 'student typed this',
          body: '{"password":"x"}',
          err: { name: 'Error', message: 'boom', stack: 'at /app/secret/path.ts:1', code: 'E1' },
        }),
      ],
      { source: 'structured', maxLines: 10 },
    ).lines;
    const parsed = JSON.parse(line!);
    expect(parsed.sessionId).toBe('sess-0123456789abcdef');
    expect(parsed.err).toEqual({ name: 'Error', code: 'E1', message: 'boom' });
    expect(line).not.toMatch(/7c0ffee0|kubeconfig|student typed|password|stack|secret\/path/);
  });

  it('redacts credentials in free text, and removes query strings', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXNlbnRpbmVs';
    const [line] = sanitizeLogLines(
      [
        structured({
          level: 'warn',
          event: 'auth.callback.failed',
          msg: `callback /auth/callback?code=AUTHCODESENTINEL&state=xyz failed; Bearer ${jwt}; postgresql://jumptotech:pw-sentinel-123@postgres:5432/db; student@example.edu`,
        }),
      ],
      { source: 'structured', maxLines: 10 },
    ).lines;
    expect(line).toContain('/auth/callback?[query removed]');
    expect(line).not.toMatch(/AUTHCODESENTINEL|pw-sentinel-123|student@example\.edu/);
    expect(line).not.toContain(jwt);
  });

  it("redacts this deployment's own configured secrets whatever their shape", () => {
    registerSecretValues(['Gocspx-Provider-Chosen-Secret_Value']);
    const [line] = sanitizeLogLines(
      [structured({ level: 'error', event: 'auth.callback.failed', msg: 'token endpoint said Gocspx-Provider-Chosen-Secret_Value' })],
      { source: 'structured', maxLines: 10 },
    ).lines;
    expect(line).not.toContain('Gocspx-Provider-Chosen-Secret_Value');
    expect(line).toContain('[REDACTED:configured-secret]');
  });

  it('drops, and counts, anything that is not one of our structured lines', () => {
    const result = sanitizeLogLines(
      ['student@sandbox:~$ cat /etc/shadow', 'root:$6$saltsalt$hashhashhash:19000:0:99999:7:::', '{"not":"ours"}', '[1,2,3]'],
      { source: 'structured', maxLines: 10 },
    );
    expect(result.lines).toEqual([]);
    expect(result.unrecognised).toBe(4);
  });

  it('keeps the newest lines up to the cap', () => {
    const lines = Array.from({ length: 50 }, (_, i) => structured({ level: 'warn', event: 'lab.start.failed', count: i }));
    const result = sanitizeLogLines(lines, { source: 'structured', maxLines: 5 });
    expect(result.matched).toBe(50);
    expect(result.lines.map((line) => JSON.parse(line).count)).toEqual([45, 46, 47, 48, 49]);
  });

  it('bounds every value it keeps', () => {
    const [line] = sanitizeLogLines([structured({ level: 'warn', event: 'lab.start.failed', msg: 'the provider said no. '.repeat(300) })], {
      source: 'structured',
      maxLines: 1,
    }).lines;
    expect(line!.length).toBeLessThan(700);
    expect(line).toContain('…[truncated]');
  });
});

describe('PostgreSQL lines', () => {
  it('keeps severities and lifecycle, drops the continuation lines that quote SQL and row values', () => {
    const result = sanitizeLogLines(
      [
        '2026-09-18 06:00:00.000 UTC [1] LOG:  database system is ready to accept connections',
        '2026-09-18 06:00:01.000 UTC [42] ERROR:  duplicate key value violates unique constraint "users_email_key"',
        '2026-09-18 06:00:01.000 UTC [42] DETAIL:  Key (email)=(alice@example.edu) already exists.',
        "2026-09-18 06:00:01.000 UTC [42] STATEMENT:  INSERT INTO users (email) VALUES ('alice@example.edu')",
        '2026-09-18 06:00:02.000 UTC [43] FATAL:  password authentication failed for user "jumptotech"',
        "2026-09-18 06:00:03.000 UTC [44] ERROR:  invalid input syntax for type uuid: 'row-value-sentinel'",
        '2026-09-18 06:00:04.000 UTC [45] LOG:  connection received: host=172.18.0.3 port=5555',
      ],
      { source: 'postgres', maxLines: 100 },
    );
    const text = result.lines.join('\n');
    expect(result.lines).toHaveLength(4);
    expect(text).toContain('database system is ready');
    expect(text).toContain('users_email_key');
    expect(text).toContain('password authentication failed for user "jumptotech"');
    expect(text).not.toMatch(/alice|INSERT|row-value-sentinel|DETAIL|STATEMENT/);
    expect(result.unrecognised).toBe(1);
  });
});

describe('nginx lines', () => {
  it('keeps error-log entries without their query strings, referrers or hosts', () => {
    const [line] = sanitizeLogLines(
      [
        '2026/09/18 06:00:00 [error] 29#29: *1 connect() failed (111: Connection refused) while connecting to upstream, client: 203.0.113.9, server: labs.example.org, request: "GET /auth/callback?code=AUTHCODESENTINEL&state=abc HTTP/2.0", upstream: "http://172.18.0.4:4000/auth/callback?code=AUTHCODESENTINEL&state=abc", host: "labs.example.org", referrer: "https://idp.example/authorize?client_id=x"',
      ],
      { source: 'nginx', maxLines: 10 },
    ).lines;
    expect(line).toContain('connect() failed (111: Connection refused)');
    expect(line).toContain('"GET /auth/callback?[query removed] HTTP/2.0"');
    expect(line).not.toMatch(/AUTHCODESENTINEL|client_id|referrer|host:/);
  });

  it('keeps only 5xx access lines, reduced to address, time, method, path and status', () => {
    const result = sanitizeLogLines(
      [
        '203.0.113.9 [18/Sep/2026:06:00:00 +0000] "GET /api/labs HTTP/2.0" 200 1234 0.010 "Mozilla/5.0"',
        '203.0.113.9 [18/Sep/2026:06:00:01 +0000] "POST /api/labs/K8S-001/start HTTP/2.0" 502 157 5.001 "Mozilla/5.0"',
        '203.0.113.9 - - [18/Sep/2026:06:00:02 +0000] "GET /auth/callback?code=AUTHCODESENTINEL HTTP/1.1" 504 0 "https://idp.example/?x=REFERERSENTINEL" "Mozilla/5.0" "-"',
      ],
      { source: 'nginx', maxLines: 10 },
    );
    expect(result.lines).toEqual([
      '203.0.113.9 [18/Sep/2026:06:00:01 +0000] "POST /api/labs/K8S-001/start" 502',
      '203.0.113.9 [18/Sep/2026:06:00:02 +0000] "GET /auth/callback" 504',
    ]);
  });

  it("keeps the certificate gate's own lines and drops the entrypoint chatter", () => {
    const result = sanitizeLogLines(
      [
        'jtt-tls-preflight: certificate for labs.example.org expires in 12 days',
        '/docker-entrypoint.sh: Configuration complete; ready for start up',
        'some unrecognised line with a token=abc',
      ],
      { source: 'nginx', maxLines: 10 },
    );
    expect(result.lines).toEqual(['jtt-tls-preflight: certificate for labs.example.org expires in 12 days']);
    expect(result.unrecognised).toBe(1);
  });
});

describe('stripQueryStrings', () => {
  it('removes the query from every URL-shaped path in a line', () => {
    expect(stripQueryStrings('a /x?y=1 b "/z?q=2" https://h/p?k=v')).toBe(
      'a /x?[query removed] b "/z?[query removed]" https://h/p?[query removed]',
    );
    expect(stripQueryStrings('is this a question? yes')).toBe('is this a question? yes');
  });
});

describe('findSecretLeaks — the gate before a bundle is packaged', () => {
  it('finds a configured secret literally, and says which kind, never the value', () => {
    expect(findSecretLeaks('db said: s3cr3t-value-from-env ok', ['s3cr3t-value-from-env'])).toEqual(['configured-secret']);
    expect(findSecretLeaks('nothing here', ['s3cr3t-value-from-env'])).toEqual([]);
  });

  it('finds shapes that are never innocent', () => {
    expect(findSecretLeaks('-----BEGIN PRIVATE KEY-----', [])).toEqual(['pem']);
    expect(findSecretLeaks('postgresql://jumptotech:pw@postgres:5432/db', [])).toEqual(['dsn']);
    expect(findSecretLeaks('Authorization: Bearer abcdefghijklmnopqrstu', [])).toEqual(['authorization']);
    expect(findSecretLeaks('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', [])).toEqual(['jwt']);
    expect(findSecretLeaks('cookie jtt_session=abcdefghijkl', [])).toEqual(['cookie']);
  });

  it('does not cry wolf on what a bundle legitimately holds', () => {
    const innocent = [
      'jtt-lab-3f9a2c1b77e04d1e  Up 12 minutes',
      'sha256:4b825dc642cb6eb9a060e54bf8d69288fbee4904a0c8a5c1f5c5b2f0b0e6b8a1',
      '[REDACTED:dsn]jumptotech_labs',
      '"GET /auth/callback?[query removed] HTTP/2.0"',
      'client_secret=[REDACTED:oauth]',
      'short min 3 ab',
    ].join('\n');
    expect(findSecretLeaks(innocent, ['ab'])).toEqual([]);
  });
});
