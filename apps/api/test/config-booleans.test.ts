/**
 * The operator's switches are read strictly. A misspelt value used to read as
 * `false`, so `LAB_LAUNCHES_PAUSED=ture` — the stop-launches switch of
 * private-beta-operations.md §3 — left Start Lab open during an incident.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DEVELOPMENT = { TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret' } as NodeJS.ProcessEnv;

describe('operator switches', () => {
  it.each(['true', 'TRUE', ' yes ', '1', 'on'])('reads %j as on', (value) => {
    expect(loadConfig({ ...DEVELOPMENT, LAB_LAUNCHES_PAUSED: value }).launchesPaused).toBe(true);
  });

  it.each(['false', 'No', '0', 'off'])('reads %j as off', (value) => {
    expect(loadConfig({ ...DEVELOPMENT, LAB_LAUNCHES_PAUSED: value }).launchesPaused).toBe(false);
  });

  it('keeps the default when unset or empty', () => {
    expect(loadConfig(DEVELOPMENT).launchesPaused).toBe(false);
    expect(loadConfig({ ...DEVELOPMENT, LAB_LAUNCHES_PAUSED: ' ' }).launchesPaused).toBe(false);
  });

  it.each(['ture', 'y', 'enabled', 'paused'])('refuses %j, naming the variable, instead of reading it as off', (value) => {
    expect(() => loadConfig({ ...DEVELOPMENT, LAB_LAUNCHES_PAUSED: value })).toThrow(/LAB_LAUNCHES_PAUSED must be true or false/);
  });

  it('applies to every switch, not only the pause', () => {
    expect(() => loadConfig({ ...DEVELOPMENT, DOCKER_TRACK_ENABLED: 'flase' })).toThrow(/DOCKER_TRACK_ENABLED must be true or false/);
  });
});
