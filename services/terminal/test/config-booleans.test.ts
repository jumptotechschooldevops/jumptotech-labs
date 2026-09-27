/**
 * Switches are read strictly, as the api reads its own.
 *
 * These services took anything outside the true-words as `false`, so
 * `TERMINAL_SANDBOX_BROKER_ENABLED=ture` silently fell back to running
 * `docker exec` in the terminal process — the privilege the broker exists to
 * remove — and `TERMINAL_CONTAINER_EXEC_ENABLED=flase` left that path *on*.
 */
import { describe, expect, it } from 'vitest';
import { loadTerminalConfig } from '../src/config.js';

const DEVELOPMENT = { TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret' } as NodeJS.ProcessEnv;

describe('terminal switches', () => {
  it.each(['TERMINAL_SANDBOX_BROKER_ENABLED', 'TERMINAL_CONTAINER_EXEC_ENABLED'])(
    'refuses a misspelt %s instead of guessing',
    (name) => {
      expect(() => loadTerminalConfig({ ...DEVELOPMENT, [name]: 'ture' })).toThrow(
        new RegExp(`${name} must be true or false`),
      );
    },
  );

  it('reads the recognised words', () => {
    expect(loadTerminalConfig({ ...DEVELOPMENT, TERMINAL_CONTAINER_EXEC_ENABLED: ' OFF ' }).containerExecEnabled).toBe(false);
    expect(loadTerminalConfig({ ...DEVELOPMENT, TERMINAL_CONTAINER_EXEC_ENABLED: 'yes' }).containerExecEnabled).toBe(true);
    expect(loadTerminalConfig({ ...DEVELOPMENT, TERMINAL_CONTAINER_EXEC_ENABLED: '' }).containerExecEnabled).toBe(true);
  });
});
