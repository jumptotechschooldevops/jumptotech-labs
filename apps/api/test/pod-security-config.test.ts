/**
 * BETA-P0-016 — the Pod Security configuration an API process starts with.
 *
 * Every Kubernetes session namespace is labelled from `policy.podSecurity`, so
 * this is the value that decides whether a student can run a privileged Pod.
 * The rule these tests hold it to: it can be made stricter from the
 * environment, never weaker than `baseline`, and production must pin a version.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POD_SECURITY } from '@jumptotech/lab-orchestrator';
import { loadConfig, loadPodSecurityConfig, loadSessionPolicy } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const DEV_ENV = {
  TERMINAL_SESSION_SECRET: 'pod-security-config-test-secret',
  LABS_DIR: path.join(REPO_ROOT, 'labs'),
  ALLOWED_ORIGINS: 'http://localhost:3000',
} as NodeJS.ProcessEnv;

describe('pod security configuration', () => {
  it('defaults to baseline enforcement, restricted audit, pinned version', () => {
    expect(loadSessionPolicy({}).podSecurity).toEqual(DEFAULT_POD_SECURITY);
    expect(loadConfig(DEV_ENV).policy.podSecurity).toEqual(DEFAULT_POD_SECURITY);
  });

  it('can be made stricter, and warnings follow the enforce level unless set', () => {
    expect(loadPodSecurityConfig({ POD_SECURITY_ENFORCE: 'restricted' })).toEqual({
      enforce: 'restricted',
      warn: 'restricted',
      audit: 'restricted',
      version: 'v1.34',
    });
  });

  it('refuses privileged from every variable, and refuses to start with it', () => {
    for (const name of ['POD_SECURITY_ENFORCE', 'POD_SECURITY_WARN', 'POD_SECURITY_AUDIT']) {
      expect(() => loadPodSecurityConfig({ [name]: 'privileged' }), name).toThrow(/never permitted/);
    }
    expect(() => loadConfig({ ...DEV_ENV, POD_SECURITY_ENFORCE: 'privileged' })).toThrow(/never permitted/);
  });

  it('refuses a warning level weaker than what is enforced', () => {
    expect(() =>
      loadPodSecurityConfig({ POD_SECURITY_ENFORCE: 'restricted', POD_SECURITY_WARN: 'baseline' }),
    ).toThrow(/weaker/);
  });

  it('refuses a malformed version', () => {
    expect(() => loadPodSecurityConfig({ POD_SECURITY_VERSION: '1.34' })).toThrow(/v1\.<minor>/);
  });

  it('allows latest in development and refuses it in production', () => {
    expect(loadPodSecurityConfig({ POD_SECURITY_VERSION: 'latest' }).version).toBe('latest');
    expect(() =>
      loadPodSecurityConfig({ NODE_ENV: 'production', POD_SECURITY_VERSION: 'latest' }),
    ).toThrow(/production/);
    expect(loadPodSecurityConfig({ NODE_ENV: 'production' }).version).toBe('v1.34');
  });
});
