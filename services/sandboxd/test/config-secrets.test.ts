/**
 * BETA-P0-010 — sandboxd validates the capabilities it serves.
 *
 * `scopes.test.ts` already proves two scope secrets may not share a value. This
 * adds what production needs on top: every capability the deployment serves is
 * configured with a real secret, the derivation key is not also a credential,
 * and the broker refuses secrets that belong to other services.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SANDBOXD_FORBIDDEN_SECRETS, loadSandboxdConfig } from '../src/config.js';

const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

const PRODUCTION = {
  NODE_ENV: 'production',
  SANDBOXD_ATTACH_SECRET: hex('attach').slice(0, 48),
  SANDBOXD_RUNTIME_SECRET: hex('runtime').slice(0, 48),
  SANDBOXD_DOCKER_SECRET: hex('docker').slice(0, 48),
  NAMESPACE_DERIVATION_SECRET: hex('namespace'),
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape'),
  DOCKER_TRACK_ENABLED: 'true',
  // Required under production since BETA-P0-008; not a secret.
  RUNTIME_OWNER_ID: 'labs-prod',
} as NodeJS.ProcessEnv;

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadSandboxdConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadSandboxdConfig to refuse');
}

describe('sandboxd under NODE_ENV=production', () => {
  it('accepts a complete, distinct set', () => {
    const config = loadSandboxdConfig(PRODUCTION);
    expect(config.scopeSecrets.attach).toBe(PRODUCTION.SANDBOXD_ATTACH_SECRET);
    expect(config.docker).not.toBeNull();
  });

  it('requires attach and runtime', () => {
    expect(refusal({ ...PRODUCTION, SANDBOXD_ATTACH_SECRET: '' })).toMatch(/SANDBOXD_ATTACH_SECRET is not set/);
    expect(refusal({ ...PRODUCTION, SANDBOXD_RUNTIME_SECRET: '' })).toMatch(/SANDBOXD_RUNTIME_SECRET is not set/);
  });

  it('requires the docker capability only when the Docker track is on', () => {
    expect(refusal({ ...PRODUCTION, SANDBOXD_DOCKER_SECRET: '' })).toMatch(/SANDBOXD_DOCKER_SECRET is not set/);
    expect(() =>
      loadSandboxdConfig({ ...PRODUCTION, SANDBOXD_DOCKER_SECRET: '', DOCKER_TRACK_ENABLED: 'false' }),
    ).not.toThrow();
  });

  it('refuses scope secrets that are long enough for development but not for production', () => {
    expect(refusal({ ...PRODUCTION, SANDBOXD_RUNTIME_SECRET: 'api-runtime-cred-1' })).toMatch(
      /SANDBOXD_RUNTIME_SECRET is too short/,
    );
  });

  it('refuses a placeholder derivation key', () => {
    expect(
      refusal({ ...PRODUCTION, NAMESPACE_DERIVATION_SECRET: 'dev-only-insecure-secret-change-me' }),
    ).toMatch(/NAMESPACE_DERIVATION_SECRET is a placeholder/);
  });

  for (const name of SANDBOXD_FORBIDDEN_SECRETS) {
    it(`refuses to hold ${name}`, () => {
      expect(refusal({ ...PRODUCTION, [name]: hex(name) })).toContain(`${name} is set, but sandboxd`);
    });
  }

  it('still refuses to start without a runtime owner when every secret is valid', () => {
    expect(refusal({ ...PRODUCTION, RUNTIME_OWNER_ID: undefined })).toMatch(/RUNTIME_OWNER_ID must be set/);
    expect(loadSandboxdConfig(PRODUCTION).runtimeOwner).toBe('labs-prod');
  });

  it('never echoes a value in the refusal', () => {
    const message = refusal({ ...PRODUCTION, SANDBOXD_RUNTIME_SECRET: 'short', INTERNAL_SERVICE_SECRET: hex('x') });
    expect(message).not.toContain(hex('x'));
  });
});

describe('sandboxd in every environment', () => {
  it('refuses a derivation key equal to a scope secret', () => {
    const shared = 'shared-value-used-twice-000000';
    expect(() =>
      loadSandboxdConfig({
        SANDBOXD_ATTACH_SECRET: shared,
        NAMESPACE_DERIVATION_SECRET: shared,
      } as NodeJS.ProcessEnv),
    ).toThrow(/NAMESPACE_DERIVATION_SECRET and SANDBOXD_ATTACH_SECRET are the same value/);
  });

  it('refuses a padded secret: the api trims the derivation key and the terminal does not trim the attach secret', () => {
    for (const name of ['NAMESPACE_DERIVATION_SECRET', 'SANDBOXD_ATTACH_SECRET', 'SANDBOXD_RUNTIME_SECRET'] as const) {
      expect(refusal({ ...PRODUCTION, [name]: `${PRODUCTION[name]} ` })).toMatch(
        new RegExp(`${name} has leading or trailing whitespace`),
      );
    }
  });

  it('derives sandbox references from the same trimmed key as the api', () => {
    const config = loadSandboxdConfig({
      SANDBOXD_ATTACH_SECRET: 'terminal-attach-credential',
      NAMESPACE_DERIVATION_SECRET: ' dev-derivation-key ',
    } as NodeJS.ProcessEnv);
    expect(config.derivationSecret).toBe('dev-derivation-key');
  });

  it('still accepts short development credentials outside production', () => {
    expect(() =>
      loadSandboxdConfig({
        SANDBOXD_ATTACH_SECRET: 'terminal-attach-credential',
        NAMESPACE_DERIVATION_SECRET: 'dev-derivation-key',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
