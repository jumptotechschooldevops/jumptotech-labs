/**
 * Integer settings are read strictly.
 *
 * `Number.parseInt` stops at the first non-digit, so a value written with a
 * unit — `1h`, `10s`, `16x` — or in another notation — `1e3`, `1.5` — was
 * accepted as its leading digits, while the error message promised "a positive
 * integer". `TERMINAL_MAX_SESSION_SECONDS=2h` was a two-second shell.
 */
import { describe, expect, it } from 'vitest';
import { loadObservabilityConfig } from '../src/config.js';

const load = (env: NodeJS.ProcessEnv) => loadObservabilityConfig({ service: 'api', defaultPort: 9400, env });

describe('observability integer settings', () => {
  it.each(['8k', '1e4', '9400.5'])('refuses LOG_MAX_LINE_BYTES=%j', (value) => {
    expect(() => load({ LOG_MAX_LINE_BYTES: value })).toThrow(/LOG_MAX_LINE_BYTES must be a positive integer/);
  });

  it('accepts a plain integer', () => {
    expect(load({ LOG_MAX_LINE_BYTES: '4096' }).maxLineBytes).toBe(4096);
  });
});
