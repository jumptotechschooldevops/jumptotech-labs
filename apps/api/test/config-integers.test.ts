/**
 * Integer settings are read strictly.
 *
 * `Number.parseInt` stops at the first non-digit, so a value written with a
 * unit — `1h`, `10s`, `16x` — or in another notation — `1e3`, `1.5` — was
 * accepted as its leading digits, while the error message promised "a positive
 * integer". `TERMINAL_MAX_SESSION_SECONDS=2h` was a two-second shell.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DEVELOPMENT = { TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret' } as NodeJS.ProcessEnv;

describe('api integer settings', () => {
  it.each(['2h', '90m', '1e3', '1.5', '60 minutes', '0x10'])('refuses MAX_SESSION_MINUTES=%j', (value) => {
    expect(() => loadConfig({ ...DEVELOPMENT, MAX_SESSION_MINUTES: value })).toThrow(
      /MAX_SESSION_MINUTES must be a positive integer/,
    );
  });

  it('accepts a plain integer, surrounding whitespace included', () => {
    expect(loadConfig({ ...DEVELOPMENT, MAX_SESSION_MINUTES: ' 90 ' }).lifetimes.maxSessionSeconds).toBe(5400);
  });

  it('keeps the default when unset or empty', () => {
    expect(loadConfig({ ...DEVELOPMENT, MAX_SESSION_MINUTES: '' }).lifetimes.maxSessionSeconds).toBe(3600);
  });
});
