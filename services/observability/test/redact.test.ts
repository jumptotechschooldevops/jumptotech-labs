/**
 * PLATFORM-003 — the redaction contract.
 *
 * This is the security test of the story. Everything else observability adds is
 * a convenience; this is the thing standing between a structured logger and a
 * credential in a log file.
 *
 * The corpus is built from the shapes this deployment actually produces —
 * `openssl rand -hex 32` from `make setup`, a real-shaped JWT, a kubeconfig
 * fragment, a Postgres DSN — rather than from generic examples, because the
 * question worth answering is not "does it catch a secret" but "does it catch
 * *ours*".
 */
import { describe, expect, it } from 'vitest';

import {
  assertSecretsAreRedactable,
  containsSecret,
  redactString,
  redactValue,
} from '../src/redact.js';

/** [description, value, expected kind] */
const CORPUS: Array<[string, string, string]> = [
  [
    'an OIDC ID token',
    'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImFiYyJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaXNzIjoiaHR0cHM6Ly9pZHAiLCJhdWQiOiJqdHQifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'jwt',
  ],
  ['a bearer header value', 'Bearer abc123def456ghi789jkl012', 'authorization'],
  ['a basic header value', 'Basic dXNlcjpwYXNzd29yZA==', 'authorization'],
  [
    'an RSA private key',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----',
    'pem',
  ],
  [
    'a certificate',
    '-----BEGIN CERTIFICATE-----\nMIIDazCCAlOgAwIBAgI\n-----END CERTIFICATE-----',
    'pem',
  ],
  [
    'a Postgres DSN with a password',
    'postgres://jumptotech:s3cr3tp4ss@postgres:5432/jumptotech',
    'dsn',
  ],
  ['a redis DSN with a password', 'redis://default:hunter2hunter2@cache:6379', 'dsn'],
  ['the platform session cookie', 'jtt_session=9f2b4c6d8e0a1b3c5d7e9f0a', 'cookie'],
  ['an express session cookie', 'connect.sid=s%3AabcdefghijklmnopQRSTUV', 'cookie'],
  ['an OIDC client secret parameter', 'client_secret=abcdefgh12345678', 'oauth'],
  ['an authorization code parameter', 'code=4/0AeanS0abcdefghijkl', 'oauth'],
  ['a refresh token parameter', 'refresh_token=1//0gabcdefghijklmno', 'oauth'],
  ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE', 'aws-key'],
  ['an STS access key id', 'ASIAIOSFODNN7EXAMPLE', 'aws-key'],
  // `openssl rand -hex 16` — POSTGRES_PASSWORD from `make setup`.
  ['a 32-char hex secret', '9f2b4c6d8e0a1b3c5d7e9f0a1b2c3d4e', 'hex-secret'],
  // `openssl rand -hex 24` — the three SANDBOXD_* scope secrets.
  ['a 48-char hex secret', '3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f', 'hex-secret'],
  // `openssl rand -hex 32` — TERMINAL_SESSION_SECRET.
  [
    'a 64-char hex secret',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'hex-secret',
  ],
  [
    'a long base64 secret',
    'aGVsbG93b3JsZHRoaXNpc2Fsb25nc2VjcmV0dmFsdWVpbmRlZWQxMjM0NTY3ODkw',
    'base64-secret',
  ],
  ['a kubeconfig client key', 'client-key-data: LS0tLS1CRUdJTiBS', 'kubeconfig'],
  ['a kubeconfig CA', 'certificate-authority-data: LS0tLS1CRUdJTiBD', 'kubeconfig'],
  ['a kubeconfig token field', 'token: abcdef.0123456789abcdef', 'kubeconfig'],
  ['a student email address', 'student@example.edu', 'email'],
];

describe('the redactor catches every secret shape this platform produces', () => {
  for (const [description, value, kind] of CORPUS) {
    it(`redacts ${description}`, () => {
      const out = redactString(value);
      expect(out, `the raw value survived: ${description}`).not.toContain(value);
      expect(out).toContain(`[REDACTED:${kind}]`);
      expect(containsSecret(value)).toBe(true);
    });
  }
});

describe('redaction reaches every place a secret can hide in a log line', () => {
  it('redacts inside a nested object', () => {
    const out = redactValue({
      outer: { inner: { dsn: 'postgres://u:p4ssw0rdp4ssw0rd@db:5432/x' } },
    });
    expect(JSON.stringify(out)).toContain('[REDACTED:dsn]');
    expect(JSON.stringify(out)).not.toContain('p4ssw0rdp4ssw0rd');
  });

  it('redacts inside an array', () => {
    const out = redactValue(['fine', 'Bearer abcdefghijklmnop']);
    expect(JSON.stringify(out)).toContain('[REDACTED:authorization]');
  });

  it('redacts an Error message and never emits a stack', () => {
    const error = new Error('connect failed for postgres://u:sup3rs3cr3tvalue@db:5432/x');
    const out = redactValue(error) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('[REDACTED:dsn]');
    expect(JSON.stringify(out)).not.toContain('sup3rs3cr3tvalue');
    // A stack carries build-host paths and, routinely, the arguments of the
    // frame that threw — which is one of the commonest ways a token leaks.
    expect(out).not.toHaveProperty('stack');
  });

  it('redacts an object key, not only its value', () => {
    const out = redactValue({ 'Bearer abcdefghijklmnop': 'x' }) as Record<string, unknown>;
    expect(Object.keys(out)[0]).toContain('[REDACTED:');
  });

  it('does not recurse forever on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(redactValue(cyclic))).not.toThrow();
  });

  it('bounds a very long string before scanning it', () => {
    const out = redactString('a'.repeat(50_000));
    expect(out.length).toBeLessThan(9_000);
    expect(out).toContain('truncated');
  });
});

describe('redaction leaves ordinary operational text alone', () => {
  const SAFE = [
    'session lab-9f2b4c ACTIVE (lab=K8S-001 provider=kubernetes)',
    'removed jtt-lab-abc (expired, provider=linux, lab=LINUX-001)',
    'provider docker unavailable: cannot reach the container runtime',
    '114 labs loaded from /app/labs',
    'GET /api/sessions/:sessionId 200 in 12ms',
    'migration 004_auth_sessions applied',
  ];

  for (const text of SAFE) {
    it(`leaves "${text.slice(0, 40)}…" unchanged`, () => {
      expect(redactString(text)).toBe(text);
      expect(containsSecret(text)).toBe(false);
    });
  }
});

describe('the startup self-test refuses a secret the scanner cannot see', () => {
  it('accepts the shapes `make setup` generates', () => {
    expect(() =>
      assertSecretsAreRedactable({
        TERMINAL_SESSION_SECRET:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        SANDBOXD_ATTACH_SECRET: '3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f',
        POSTGRES_PASSWORD: '9f2b4c6d8e0a1b3c5d7e9f0a1b2c3d4e',
      }),
    ).not.toThrow();
  });

  it('refuses to start when a configured secret would survive a log line', () => {
    expect(() =>
      assertSecretsAreRedactable({
        SOME_NEW_SECRET: 'correct-horse-battery-staple-and-more-words-here',
      }),
    ).toThrow(/does not recognise the shape of: SOME_NEW_SECRET/);
  });

  it('never echoes the secret in the failure it raises', () => {
    const value = 'correct-horse-battery-staple-and-more-words-here';
    try {
      assertSecretsAreRedactable({ SOME_NEW_SECRET: value });
      expect.unreachable('expected the self-test to refuse');
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
      expect((error as Error).message).toContain('SOME_NEW_SECRET');
    }
  });

  it('skips unset and short development placeholders', () => {
    expect(() =>
      assertSecretsAreRedactable({ UNSET: undefined, EMPTY: '', SHORT: 'dev-secret' }),
    ).not.toThrow();
  });
});

describe('the redactor cannot be turned into a denial of service', () => {
  /*
   * Log values are attacker-influenced in places — an error message quoting a
   * request field, a provider reason echoing a failed command. A pattern that
   * backtracks catastrophically here would wedge the event loop from a log
   * line, which is a far worse outcome than the leak it was added to prevent.
   */
  const ADVERSARIAL = [
    'a'.repeat(5000),
    `${'eyJ'.repeat(1000)}`,
    `${'-----BEGIN '.repeat(500)}`,
    `${'A'.repeat(2000)}=`,
    `postgres://${'u'.repeat(2000)}`,
    `${'0123456789abcdef'.repeat(400)}`,
    `${'x@y.'.repeat(1000)}z`,
  ];

  for (const [index, input] of ADVERSARIAL.entries()) {
    it(`stays linear on adversarial input #${index + 1}`, () => {
      const started = performance.now();
      redactString(input);
      expect(performance.now() - started).toBeLessThan(50);
    });
  }
});
