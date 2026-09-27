/**
 * Integer settings are read strictly.
 *
 * `Number.parseInt` stops at the first non-digit, so a value written with a
 * unit — `1h`, `10s`, `16x` — or in another notation — `1e3`, `1.5` — was
 * accepted as its leading digits, while the error message promised "a positive
 * integer". `TERMINAL_MAX_SESSION_SECONDS=2h` was a two-second shell.
 */
import { describe, expect, it } from 'vitest';
import { loadSandboxdConfig } from '../src/config.js';

const BASE = {
  NAMESPACE_DERIVATION_SECRET: '7b3e9d1f5a8c2e6b0d4f9a3c7e1b5d8f2a6c0e4b9d3f7a1c5e8b2d6f0a4c9e3b',
  SANDBOXD_ATTACH_SECRET: 'c5a1e7b3d9f2a6c0e4b8d1f5a9c3e7b0d6f2a8c4e1b5d9f3',
} as NodeJS.ProcessEnv;

describe('sandboxd integer settings', () => {
  it.each(['1e3', '32 shells', '2h'])('refuses SANDBOXD_MAX_SESSIONS=%j', (value) => {
    expect(() => loadSandboxdConfig({ ...BASE, SANDBOXD_MAX_SESSIONS: value })).toThrow(
      /SANDBOXD_MAX_SESSIONS must be a positive integer/,
    );
  });

  it('accepts a plain integer', () => {
    expect(loadSandboxdConfig({ ...BASE, SANDBOXD_MAX_SESSIONS: '8' }).maxSessions).toBe(8);
  });

  // Past 2^31 - 1 ms a Node timer fires after 1 ms: a limit meant as "never"
  // would close every broker shell as it opened.
  it.each(['SANDBOXD_MAX_SESSION_SECONDS', 'SANDBOXD_IDLE_TIMEOUT_SECONDS'])(
    'refuses a %s a timer cannot wait for',
    (name) => {
      expect(() => loadSandboxdConfig({ ...BASE, [name]: '2592000' })).toThrow(
        new RegExp(`${name} must be at most 2147483`),
      );
      expect(loadSandboxdConfig({ ...BASE, [name]: '2147483' })).toBeTruthy();
    },
  );
});
