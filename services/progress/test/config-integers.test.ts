/**
 * Integer settings are read strictly.
 *
 * `Number.parseInt` stops at the first non-digit, so a value written with a
 * unit — `1h`, `10s`, `16x` — or in another notation — `1e3`, `1.5` — was
 * accepted as its leading digits, while the error message promised "a positive
 * integer". `TERMINAL_MAX_SESSION_SECONDS=2h` was a two-second shell.
 */
import { describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '../src/postgres/config.js';

const BASE = { DATABASE_URL: 'postgres://jtt:synthetic@127.0.0.1:5432/jtt' } as NodeJS.ProcessEnv;

describe('database integer settings', () => {
  it.each(['10s', '1e4', '5000ms'])('refuses DATABASE_STATEMENT_TIMEOUT_MS=%j', (value) => {
    expect(() => loadDatabaseConfig({ ...BASE, DATABASE_STATEMENT_TIMEOUT_MS: value })).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS must be a positive integer/,
    );
  });

  it('accepts a plain integer', () => {
    expect(loadDatabaseConfig({ ...BASE, DATABASE_STATEMENT_TIMEOUT_MS: '2500' })?.statementTimeoutMs).toBe(2500);
  });
});
