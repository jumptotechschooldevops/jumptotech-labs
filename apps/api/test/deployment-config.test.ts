/**
 * Deployment configuration that must fail closed.
 *
 * Two settings decide whether a deployment is a deployment or a laptop with the
 * wrong `NODE_ENV`, and both used to have permissive defaults:
 *
 *   · `AUTH_MODE` — already gated; covered here so the two live together.
 *   · the public origin — defaulted to `http://localhost:3000`, which a
 *     production stack would then use for its OIDC callback, its logout
 *     redirect and its terminal WebSocket URL. Nothing failed; students just
 *     got sign-in links pointing at their own machine.
 *
 * The rule both follow: in production, a missing value is a refusal to start,
 * not a default.
 */
import { describe, expect, it } from 'vitest';
import { assertPublicOriginConfigured, loadConfig } from '../src/config.js';
import { assertAuthModeAllowed } from '../src/auth/resolvers.js';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://issuer.example.com',
  OIDC_CLIENT_ID: 'jumptotech-labs',
  OIDC_AUDIENCE: 'jumptotech-labs',
  // BETA-P0-010: production requires each secret, separately generated.
  TERMINAL_SESSION_SECRET: '6c1f0a9e3b7d4c2a8e5f1b9d3a7c6e0f2b8d4a1c9e7f3b5d0a2c8e6f4b1d9a3c',
  INTERNAL_SERVICE_SECRET: '1e8b3d6f0a4c9e2b7d5f1a8c3e6b0d4f9a2c7e5b1d8f3a6c0e4b9d2f7a5c1e8b',
  NAMESPACE_DERIVATION_SECRET: 'b4d9f2a7c1e6b3d8f5a0c4e9b2d7f1a6c3e8b5d0f4a9c2e7b1d6f3a8c5e0b4d9',
  OBSERVABILITY_SCRAPE_TOKEN: '7a2c5e8b1d4f9a3c6e0b5d8f2a7c4e1b9d6f3a0c8e5b2d7f4a1c6e9b3d0f5a8c',
  PUBLIC_ORIGIN: 'https://labs.example.com',
  ALLOWED_ORIGINS: 'https://labs.example.com',
  RUNTIME_OWNER_ID: 'labs-prod',
} as NodeJS.ProcessEnv;

describe('a production deployment cannot serve itself from localhost', () => {
  it('refuses to start when nothing named a public origin', () => {
    expect(() =>
      assertPublicOriginConfigured({
        nodeEnv: 'production',
        appUrl: 'http://localhost:3000',
        looksLocal: true,
      }),
    ).toThrow(/PUBLIC_ORIGIN/);
  });

  it('refuses every localhost spelling, not just the obvious one', () => {
    for (const appUrl of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      const looksLocal = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(appUrl);
      expect(looksLocal).toBe(true);
      expect(() => assertPublicOriginConfigured({ nodeEnv: 'production', appUrl, looksLocal })).toThrow();
    }
  });

  it('accepts a real public origin', () => {
    expect(() =>
      assertPublicOriginConfigured({
        nodeEnv: 'production',
        appUrl: 'https://labs.example.com',
        looksLocal: false,
      }),
    ).not.toThrow();
  });

  it('leaves development alone', () => {
    expect(() =>
      assertPublicOriginConfigured({
        nodeEnv: 'development',
        appUrl: 'http://localhost:3000',
        looksLocal: true,
      }),
    ).not.toThrow();
  });

  it('fires from loadConfig, not only from the helper', () => {
    const { PUBLIC_ORIGIN, ALLOWED_ORIGINS, ...withoutOrigin } = PRODUCTION_ENV;
    expect(() => loadConfig(withoutOrigin as NodeJS.ProcessEnv)).toThrow(/public origin/i);
    expect(() => loadConfig(PRODUCTION_ENV)).not.toThrow();
  });
});

describe('a production deployment cannot fall back to development identity', () => {
  it('refuses AUTH_MODE=development under NODE_ENV=production', () => {
    expect(() =>
      assertAuthModeAllowed({ mode: 'development', nodeEnv: 'production' } as never),
    ).toThrow(/AUTH_MODE=development/);
  });

  it('defaults to oidc when AUTH_MODE is absent, so a lost line fails closed', () => {
    const config = loadConfig({ ...PRODUCTION_ENV, AUTH_MODE: undefined } as NodeJS.ProcessEnv);
    expect(config.auth.mode).toBe('oidc');
  });
});

describe('the container runtime a deployment drives', () => {
  it('prefers the broker over any daemon address when both are configured', () => {
    const config = loadConfig({
      ...PRODUCTION_ENV,
      SANDBOX_BROKER_URL: 'http://sandboxd:4002',
      SANDBOX_RUNTIME_HOST: 'tcp://some-daemon:2376',
      // A brokered production API needs both capabilities it uses (BETA-P0-010).
      SANDBOXD_RUNTIME_SECRET: '3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f',
      SANDBOXD_DOCKER_SECRET: 'c8e1f4a7b0d3e6f9a2c5e8b1d4f7a0c3e6b9d2f5a8c1e4b7',
    } as NodeJS.ProcessEnv);

    expect(config.sandbox.runtimeBrokerUrl).toBe('http://sandboxd:4002');
    expect(config.sandbox.runtimeHost).toBe('tcp://some-daemon:2376');
  });

  it('is unset by default, which is the ambient daemon a laptop wants', () => {
    const config = loadConfig(PRODUCTION_ENV);
    expect(config.sandbox.runtimeBrokerUrl).toBe('');
    expect(config.sandbox.runtimeHost).toBe('');
  });
});
