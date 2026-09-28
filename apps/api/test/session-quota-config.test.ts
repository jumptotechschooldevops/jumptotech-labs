/**
 * The ResourceQuota an API process stamps on each Kubernetes session namespace.
 *
 * `loadSessionPolicy` rebuilds the quota key by key from the environment, so a
 * ceiling added only to `DEFAULT_SESSION_POLICY` never reaches a running API.
 * The object-count ceilings are what stop one student filling etcd for the
 * whole cluster; they must survive every environment.
 */
import { describe, expect, it } from 'vitest';
import { SESSION_OBJECT_COUNT_QUOTA } from '@jumptotech/lab-orchestrator';
import { loadSessionPolicy } from '../src/config.js';

describe('session quota configuration', () => {
  it('carries every object-count ceiling from the environment-built policy', () => {
    const quota = loadSessionPolicy({ NODE_ENV: 'production', QUOTA_PODS: '30' }).quota;

    expect(quota).toMatchObject(SESSION_OBJECT_COUNT_QUOTA);
    expect(quota['count/configmaps']).toBe('50');
    expect(quota['count/secrets']).toBe('50');
    expect(quota.pods).toBe('30');
  });

  it('bounds node-local disk per container and per namespace (red-team O4)', () => {
    const policy = loadSessionPolicy({ NODE_ENV: 'production' });
    expect(policy.quota['requests.ephemeral-storage']).toBe('2Gi');
    expect(policy.quota['limits.ephemeral-storage']).toBe('4Gi');
    expect(policy.limitRange.defaultRequest['ephemeral-storage']).toBe('64Mi');
    expect(policy.limitRange.default['ephemeral-storage']).toBe('256Mi');
    expect(policy.limitRange.max?.['ephemeral-storage']).toBe('1Gi');

    const tuned = loadSessionPolicy({ QUOTA_LIMITS_EPHEMERAL_STORAGE: '8Gi', LIMITS_MAX_EPHEMERAL_STORAGE: '2Gi' });
    expect(tuned.quota['limits.ephemeral-storage']).toBe('8Gi');
    expect(tuned.limitRange.max?.['ephemeral-storage']).toBe('2Gi');
  });
});
