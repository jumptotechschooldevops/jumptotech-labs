/**
 * BETA-P0-008 — one explicit runtime owner per deployment.
 *
 * The API and sandboxd used to resolve `RUNTIME_OWNER_ID` independently, each
 * with its own hardcoded fallback, and the base compose file never passed the
 * variable to the API at all. Setting it — as docs/runtime-ownership.md told
 * operators to — gave sandboxd one owner and the API another: sandboxd stamped
 * its own owner on every sandbox, the API then refused to discover or delete
 * any of them, and every brokered sandbox leaked.
 *
 * `resolveRuntimeOwner` is now the one decision both make. These tests pin its
 * contract and the label rules the providers build on it.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_OWNER,
  MANAGED_LABEL,
  RUNTIME_OWNER_LABEL,
  isValidRuntimeOwner,
  ownedByRuntime,
  ownershipLabels,
  resolveRuntimeOwner,
  runtimeOwnerPermits,
} from '../src/index.js';

describe('resolveRuntimeOwner in production', () => {
  it('refuses to start when the owner is missing', () => {
    expect(() => resolveRuntimeOwner({ NODE_ENV: 'production' })).toThrow(
      /RUNTIME_OWNER_ID must be set when NODE_ENV=production/,
    );
  });

  it('treats an empty value as missing, not as an owner', () => {
    // `${RUNTIME_OWNER_ID:-}` in a compose file produces exactly this.
    expect(() => resolveRuntimeOwner({ NODE_ENV: 'production', RUNTIME_OWNER_ID: '' })).toThrow(
      /must be set/,
    );
  });

  it('never falls back to the development owner', () => {
    let resolved: unknown;
    try {
      resolved = resolveRuntimeOwner({ NODE_ENV: 'production' });
    } catch {
      resolved = undefined;
    }
    expect(resolved).toBeUndefined();
  });

  it('accepts an explicit, valid owner', () => {
    expect(resolveRuntimeOwner({ NODE_ENV: 'production', RUNTIME_OWNER_ID: 'labs-prod-eu1' })).toEqual({
      owner: 'labs-prod-eu1',
      source: 'configured',
    });
  });

  it('refuses an unsafe owner rather than normalising it', () => {
    for (const unsafe of [' labs-prod', 'labs-prod ', 'labs prod', 'labs/prod', '-labs', 'labs-']) {
      expect(() => resolveRuntimeOwner({ NODE_ENV: 'production', RUNTIME_OWNER_ID: unsafe }), unsafe).toThrow(
        /not a valid runtime owner/,
      );
    }
  });
});

describe('resolveRuntimeOwner outside production', () => {
  it('uses the one development owner, and says so', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      expect(resolveRuntimeOwner({ NODE_ENV })).toEqual({
        owner: DEFAULT_RUNTIME_OWNER,
        source: 'development-default',
      });
    }
  });

  it('still honours, and still validates, an explicit owner', () => {
    expect(resolveRuntimeOwner({ RUNTIME_OWNER_ID: 'wt-docker' })).toEqual({
      owner: 'wt-docker',
      source: 'configured',
    });
    expect(() => resolveRuntimeOwner({ RUNTIME_OWNER_ID: 'wt docker' })).toThrow(/not a valid/);
  });

  it('resolves the same env to the same owner every time', () => {
    const env = { NODE_ENV: 'production', RUNTIME_OWNER_ID: 'ci-123-sandboxd' };
    expect(resolveRuntimeOwner(env)).toEqual(resolveRuntimeOwner({ ...env }));
  });
});

describe('a rejected owner is never echoed', () => {
  it('reports the length and the rule, not the value', () => {
    // Somebody pasted a credential into the wrong variable.
    const pasted = 'sk_live_9f8e7d6c5b4a 3210';
    let message = '';
    try {
      resolveRuntimeOwner({ NODE_ENV: 'production', RUNTIME_OWNER_ID: pasted });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not a valid runtime owner \(25 characters\)/);
    expect(message).not.toContain(pasted);
    expect(message).not.toContain('sk_live');
  });
});

describe('what a runtime owner may look like', () => {
  it('accepts values valid as both a Kubernetes label value and a Docker label', () => {
    for (const ok of ['a', 'jumptotech', 'ci-9876543210-gates', 'wt.docker_1', 'x'.repeat(63)]) {
      expect(isValidRuntimeOwner(ok), ok).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const bad of ['', 'x'.repeat(64), '_x', 'x.', 'ÿ', 'a,b', 'a=b', 'a\nb']) {
      expect(isValidRuntimeOwner(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('ownership labels are deterministic', () => {
  it('produces identical labels for identical input, owner included', () => {
    const input = { sessionId: 'sess-0000000000000001', labId: 'K8S-001', expiresAtMs: 1, runtimeOwner: 'wt-a' };
    expect(ownershipLabels(input)).toEqual(ownershipLabels({ ...input }));
    expect(ownershipLabels(input)[RUNTIME_OWNER_LABEL]).toBe('wt-a');
    expect(ownershipLabels(input)[MANAGED_LABEL]).toBe('true');
  });
});

describe('the two ownership predicates', () => {
  const mine = { [RUNTIME_OWNER_LABEL]: 'wt-a' };
  const theirs = { [RUNTIME_OWNER_LABEL]: 'wt-b' };
  const unowned = {};

  it('discovery (ownedByRuntime) accepts only an exact match', () => {
    expect(ownedByRuntime(mine, 'wt-a')).toBe(true);
    expect(ownedByRuntime(theirs, 'wt-a')).toBe(false);
    expect(ownedByRuntime(unowned, 'wt-a')).toBe(false);
    expect(ownedByRuntime({ [RUNTIME_OWNER_LABEL]: '' }, 'wt-a')).toBe(false);
  });

  it('a delete (runtimeOwnerPermits) accepts an unowned resource only when a session vouches for it', () => {
    expect(runtimeOwnerPermits(mine, 'wt-a', undefined)).toBe(true);
    expect(runtimeOwnerPermits(mine, 'wt-a', 'sess-0000000000000001')).toBe(true);
    expect(runtimeOwnerPermits(theirs, 'wt-a', undefined)).toBe(false);
    expect(runtimeOwnerPermits(theirs, 'wt-a', 'sess-0000000000000001')).toBe(false);
    expect(runtimeOwnerPermits(unowned, 'wt-a', undefined)).toBe(false);
    expect(runtimeOwnerPermits(unowned, 'wt-a', 'sess-0000000000000001')).toBe(true);
  });
});
