/**
 * Integer settings are read strictly.
 *
 * `Number.parseInt` stops at the first non-digit, so a value written with a
 * unit — `1h`, `10s`, `16x` — or in another notation — `1e3`, `1.5` — was
 * accepted as its leading digits, while the error message promised "a positive
 * integer". `TERMINAL_MAX_SESSION_SECONDS=2h` was a two-second shell.
 */
import { describe, expect, it } from 'vitest';
import { loadTerminalConfig } from '../src/config.js';

const DEVELOPMENT = { TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret' } as NodeJS.ProcessEnv;

describe('terminal integer settings', () => {
  it.each(['2h', '1e3', '1.5', '16x'])('refuses TERMINAL_MAX_SESSION_SECONDS=%j', (value) => {
    expect(() => loadTerminalConfig({ ...DEVELOPMENT, TERMINAL_MAX_SESSION_SECONDS: value })).toThrow(
      /TERMINAL_MAX_SESSION_SECONDS must be a positive integer/,
    );
  });

  it('accepts a plain integer', () => {
    expect(loadTerminalConfig({ ...DEVELOPMENT, TERMINAL_MAX_SESSIONS: '20' }).maxSessions).toBe(20);
  });
});
