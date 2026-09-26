/**
 * Switches are read strictly, as the api reads its own.
 *
 * These services took anything outside the true-words as `false`, so
 * `TERMINAL_SANDBOX_BROKER_ENABLED=ture` silently fell back to running
 * `docker exec` in the terminal process — the privilege the broker exists to
 * remove — and `TERMINAL_CONTAINER_EXEC_ENABLED=flase` left that path *on*.
 */
import { describe, expect, it } from 'vitest';
import { loadObservabilityConfig } from '../src/config.js';

const load = (env: NodeJS.ProcessEnv) => loadObservabilityConfig({ service: 'api', defaultPort: 9400, env });

describe('observability switches', () => {
  it('refuses a misspelt OBSERVABILITY_ALLOW_ANONYMOUS_METRICS instead of guessing', () => {
    expect(() => load({ OBSERVABILITY_ALLOW_ANONYMOUS_METRICS: 'ture' })).toThrow(
      /OBSERVABILITY_ALLOW_ANONYMOUS_METRICS must be true or false/,
    );
  });
});
