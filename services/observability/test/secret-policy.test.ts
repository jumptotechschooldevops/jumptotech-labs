/**
 * BETA-P0-010 — what a production secret is, decided in one place.
 *
 * The three services call `assertProductionSecrets` with their own lists; this
 * pins the rules those lists are judged by. The values `.env.example` ships
 * are tested by name, because "a placeholder that happens to be long enough"
 * is exactly how `dev-only-insecure-secret-change-me` passed every earlier check.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_MARKERS,
  SecretPolicyError,
  assertProductionSecrets,
  secretWeakness,
} from '../src/secret-policy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const HEX_32 = '9f2b4c6d8e0a1b3c5d7e9f0a1b2c3d4e';
const HEX_48 = '3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f';
const HEX_64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('a production secret', () => {
  it('accepts what `make secrets` generates', () => {
    for (const value of [HEX_32, HEX_48, HEX_64]) expect(secretWeakness(value)).toBeNull();
  });

  it('refuses every placeholder .env.example ships', () => {
    const example = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    for (const name of ['TERMINAL_SESSION_SECRET', 'POSTGRES_PASSWORD']) {
      const value = new RegExp(`^${name}=(.*)$`, 'm').exec(example)?.[1];
      expect(value, `.env.example assigns ${name}`).toBeTruthy();
      expect(secretWeakness(value), `${name} from .env.example`).not.toBeNull();
    }
  });

  it('refuses a placeholder however long it is', () => {
    expect(secretWeakness('dev-only-insecure-secret-change-me-and-then-some-more')).toBe('placeholder');
    expect(secretWeakness('REPLACEME-0123456789abcdef0123456789abcdef')).toBe('placeholder');
  });

  it('refuses empty, short and repetitive values', () => {
    expect(secretWeakness(undefined)).toBe('missing');
    expect(secretWeakness('   ')).toBe('missing');
    expect(secretWeakness('0123456789abcdef')).toBe('too-short');
    expect(secretWeakness('ab'.repeat(32))).toBe('low-entropy');
  });

  it('lets a caller set a lower floor for provider-issued credentials', () => {
    expect(secretWeakness('GOCSPX-abcdefghijklmnop', 16)).toBeNull();
    expect(secretWeakness('GOCSPX-abcdefghijklmnop')).toBe('too-short');
  });

  it('keeps the setup script on the same placeholder list', () => {
    const script = readFileSync(path.join(REPO_ROOT, 'scripts/ensure-dev-secrets.sh'), 'utf8');
    const pattern = /^PLACEHOLDER_PATTERN='([^']+)'$/m.exec(script)?.[1];
    expect(pattern?.split('|').sort()).toEqual([...PLACEHOLDER_MARKERS].sort());
  });
});

describe('assertProductionSecrets', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('passes a complete, distinct configuration', () => {
    expect(() =>
      assertProductionSecrets({
        service: 'api',
        env,
        secrets: [
          { name: 'A', value: HEX_32, required: true },
          { name: 'B', value: HEX_48, required: true },
          { name: 'OPTIONAL', value: '', required: false },
        ],
        forbidden: ['NOT_MINE'],
      }),
    ).not.toThrow();
  });

  it('refuses a required secret that is missing, and names it', () => {
    expect(() =>
      assertProductionSecrets({
        service: 'api',
        env,
        secrets: [{ name: 'INTERNAL_SERVICE_SECRET', value: undefined, required: true }],
        forbidden: [],
      }),
    ).toThrow(/INTERNAL_SERVICE_SECRET is not set/);
  });

  it('checks an optional secret only when it is set', () => {
    expect(() =>
      assertProductionSecrets({
        service: 'api',
        env,
        secrets: [{ name: 'OIDC_CLIENT_SECRET', value: 'change-me', required: false }],
        forbidden: [],
      }),
    ).toThrow(/OIDC_CLIENT_SECRET is a placeholder/);
  });

  it('refuses two secrets with one value', () => {
    expect(() =>
      assertProductionSecrets({
        service: 'api',
        env,
        secrets: [
          { name: 'TERMINAL_SESSION_SECRET', value: HEX_64, required: true },
          { name: 'INTERNAL_SERVICE_SECRET', value: HEX_64, required: true },
        ],
        forbidden: [],
      }),
    ).toThrow(/INTERNAL_SERVICE_SECRET and TERMINAL_SESSION_SECRET are the same value/);
  });

  it('refuses a secret the service must not hold', () => {
    expect(() =>
      assertProductionSecrets({
        service: 'terminal',
        env: { SANDBOXD_RUNTIME_SECRET: HEX_48 } as NodeJS.ProcessEnv,
        secrets: [],
        forbidden: ['SANDBOXD_RUNTIME_SECRET'],
      }),
    ).toThrow(/SANDBOXD_RUNTIME_SECRET is set, but terminal has no use for it/);
  });

  it('reports every problem at once, and never a value', () => {
    const leaked = 'dev-only-insecure-secret-change-me';
    try {
      assertProductionSecrets({
        service: 'api',
        env: { SANDBOXD_ATTACH_SECRET: HEX_48 } as NodeJS.ProcessEnv,
        secrets: [
          { name: 'TERMINAL_SESSION_SECRET', value: leaked, required: true },
          { name: 'INTERNAL_SERVICE_SECRET', value: HEX_32, required: true },
          { name: 'NAMESPACE_DERIVATION_SECRET', value: HEX_32, required: true },
        ],
        forbidden: ['SANDBOXD_ATTACH_SECRET'],
      });
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretPolicyError);
      const message = (error as Error).message;
      expect((error as SecretPolicyError).problems).toHaveLength(3);
      for (const value of [leaked, HEX_32, HEX_48]) expect(message).not.toContain(value);
      expect(message).toContain('TERMINAL_SESSION_SECRET');
      expect(message).toContain('SANDBOXD_ATTACH_SECRET');
    }
  });
});
