/**
 * `NODE_ENV=production` means the same thing to every gate.
 *
 * The secret, TLS and observability gates compare the value trimmed
 * (`isProductionEnv`); the runtime-owner gate compared it exactly, so
 * `NODE_ENV="production "` — a trailing space in an env file — passed every
 * other production gate while the owner fell back to the development default
 * instead of refusing to start.
 */
import { describe, expect, it } from 'vitest';
import { resolveRuntimeOwner } from '../src/index.js';

describe('the runtime-owner gate', () => {
  it.each(['production', 'production ', ' production\n'])('refuses a missing owner under NODE_ENV=%j', (value) => {
    expect(() => resolveRuntimeOwner({ NODE_ENV: value })).toThrow(/RUNTIME_OWNER_ID must be set/);
  });

  it('keeps the development default outside production', () => {
    expect(resolveRuntimeOwner({ NODE_ENV: 'development' }).source).toBe('development-default');
  });
});
