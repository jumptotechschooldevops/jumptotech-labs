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

/**
 * The minimum sandboxd needs to start, with no owner. Values are test-only, and
 * long and distinct enough for the BETA-P0-010 production secret gate, so the
 * production cases below vary the owner and nothing else.
 */
const BASE = {
  NAMESPACE_DERIVATION_SECRET: '7b3e9d1f5a8c2e6b0d4f9a3c7e1b5d8f2a6c0e4b9d3f7a1c5e8b2d6f0a4c9e3b',
  SANDBOXD_ATTACH_SECRET: 'c5a1e7b3d9f2a6c0e4b8d1f5a9c3e7b0d6f2a8c4e1b5d9f3',
  SANDBOXD_RUNTIME_SECRET: '4d8b2f6a0c5e9b3d7f1a6c0e4b8d2f5a9c3e7b1d6f0a4c8e',
  SANDBOXD_DOCKER_SECRET: 'a9f3c7e1b5d0f4a8c2e6b9d3f7a1c5e0b4d8f2a6c9e3b7d1',
  OBSERVABILITY_SCRAPE_TOKEN: '8e2c6a0f4b7d1e5c9a3f6b0d4e8c2a7f1b5d9e3c6a0f4b8d2e7c1a5f9b3d6e0c',
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
