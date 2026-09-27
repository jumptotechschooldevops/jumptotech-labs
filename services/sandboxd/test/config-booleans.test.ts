/**
 * Switches are read strictly, as the api reads its own.
 *
 * These services took anything outside the true-words as `false`, so
 * `TERMINAL_SANDBOX_BROKER_ENABLED=ture` silently fell back to running
 * `docker exec` in the terminal process — the privilege the broker exists to
 * remove — and `TERMINAL_CONTAINER_EXEC_ENABLED=flase` left that path *on*.
 */
import { describe, expect, it } from 'vitest';
import { loadSandboxdConfig } from '../src/config.js';

const BASE = {
  NAMESPACE_DERIVATION_SECRET: '7b3e9d1f5a8c2e6b0d4f9a3c7e1b5d8f2a6c0e4b9d3f7a1c5e8b2d6f0a4c9e3b',
  SANDBOXD_ATTACH_SECRET: 'c5a1e7b3d9f2a6c0e4b8d1f5a9c3e7b0d6f2a8c4e1b5d9f3',
} as NodeJS.ProcessEnv;

describe('sandboxd switches', () => {
  it('refuses a misspelt DOCKER_TRACK_ENABLED instead of reading it as off', () => {
    expect(() => loadSandboxdConfig({ ...BASE, DOCKER_TRACK_ENABLED: 'ture' })).toThrow(
      /DOCKER_TRACK_ENABLED must be true or false/,
    );
  });
});
