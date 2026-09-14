/**
 * BETA-P0-008 — sandboxd takes its runtime owner from the shared resolver.
 *
 * sandboxd used to read `env.RUNTIME_OWNER_ID ?? 'jumptotech'` on its own. It
 * runs `NODE_ENV=production` in compose, so a deployment that forgot the
 * variable came up guarding an owner nobody chose — and one that set it for
 * sandboxd but not the API split the deployment into two owners that could not
 * clean up after each other. It now resolves exactly as the API does.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_OWNER, resolveRuntimeOwner } from '@jumptotech/lab-orchestrator';
import { loadSandboxdConfig } from '../src/config.js';

/** The minimum sandboxd needs to start, with no owner. Values are test-only. */
const BASE = {
  NAMESPACE_DERIVATION_SECRET: 'a-derivation-secret-for-tests',
  SANDBOXD_ATTACH_SECRET: 'attach-secret-for-tests-0001',
  SANDBOXD_RUNTIME_SECRET: 'runtime-secret-for-tests-0002',
  SANDBOXD_DOCKER_SECRET: 'docker-secret-for-tests-00003',
  OBSERVABILITY_SCRAPE_TOKEN: 'scrape-token-for-tests-000004',
} as NodeJS.ProcessEnv;

describe('sandboxd runtime owner', () => {
  it('refuses to start in production without an owner', () => {
    expect(() => loadSandboxdConfig({ ...BASE, NODE_ENV: 'production' })).toThrow(
      /RUNTIME_OWNER_ID must be set/,
    );
  });

  it('refuses an unsafe owner in production', () => {
    expect(() =>
      loadSandboxdConfig({ ...BASE, NODE_ENV: 'production', RUNTIME_OWNER_ID: 'two words' }),
    ).toThrow(/not a valid runtime owner/);
  });

  it('uses the configured owner', () => {
    const config = loadSandboxdConfig({ ...BASE, NODE_ENV: 'production', RUNTIME_OWNER_ID: 'labs-prod' });
    expect(config.runtimeOwner).toBe('labs-prod');
    expect(config.runtimeOwnerSource).toBe('configured');
  });

  it('uses the shared development owner, and reports it as a default, outside production', () => {
    const config = loadSandboxdConfig({ ...BASE });
    expect(config.runtimeOwner).toBe(DEFAULT_RUNTIME_OWNER);
    expect(config.runtimeOwnerSource).toBe('development-default');
  });

  it('agrees with the resolver the API uses, for every shape of environment', () => {
    for (const env of [
      { ...BASE },
      { ...BASE, RUNTIME_OWNER_ID: 'wt-docker' },
      { ...BASE, NODE_ENV: 'production', RUNTIME_OWNER_ID: 'ci-42-sandboxd' },
    ]) {
      expect(loadSandboxdConfig(env).runtimeOwner).toBe(resolveRuntimeOwner(env).owner);
    }
  });
});
