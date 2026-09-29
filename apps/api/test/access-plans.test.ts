/**
 * Plans and trial terms — `access/plans.ts`, without HTTP.
 *
 * A plan file is configuration an operator writes by hand, so everything it
 * does not say explicitly is refused rather than guessed: an absent `tracks`
 * never means "every track", an unknown field is not ignored, and a trial with
 * no configured length does not exist. The enforcement over HTTP is
 * `access-plans-enforcement.test.ts`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  PlanCatalog,
  PlanConfigError,
  effectiveSessionLimit,
  parsePlans,
  planIncludesTrack,
  plansFromEnv,
  trialFromEnv,
} from '../src/access/plans.js';

const FIXTURE = {
  plans: [
    { id: 'fixture-all', name: 'Everything', tracks: 'all' },
    { id: 'fixture-linux', name: 'Linux only', tracks: ['linux'], maxConcurrentSessions: 1 },
    { id: 'fixture-two', name: 'Two tracks', description: 'Linux and Docker', tracks: ['linux', 'docker'], maxConcurrentSessions: 3 },
  ],
};

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PlanConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a PlanConfigError');
}

describe('parsePlans', () => {
  it('reads a valid document', () => {
    const catalog = parsePlans(FIXTURE);
    expect(catalog.size).toBe(3);
    expect(catalog.get('fixture-linux')).toEqual({
      id: 'fixture-linux',
      name: 'Linux only',
      description: null,
      tracks: ['linux'],
      maxConcurrentSessions: 1,
    });
    expect(catalog.get('fixture-all')!.tracks).toBe('all');
    expect(catalog.get('fixture-two')!.description).toBe('Linux and Docker');
  });

  it('refuses a plan without an explicit track list — absent must not mean everything', () => {
    expect(refusal(() => parsePlans({ plans: [{ id: 'p', name: 'P' }] }))).toMatch(/tracks must be "all"/);
    expect(refusal(() => parsePlans({ plans: [{ id: 'p', name: 'P', tracks: [] }] }))).toMatch(/tracks/);
    expect(refusal(() => parsePlans({ plans: [{ id: 'p', name: 'P', tracks: ['Linux!'] }] }))).toMatch(/tracks/);
  });

  it('refuses unknown fields, including anything that looks like a price', () => {
    expect(refusal(() => parsePlans({ plans: [{ id: 'p', name: 'P', tracks: 'all', price: 10 }] }))).toMatch(
      /unknown field\(s\) price/,
    );
    expect(refusal(() => parsePlans({ plans: [], currency: 'usd' }))).toMatch(/unknown top-level/);
  });

  it('refuses bad ids, duplicate ids, names and limits', () => {
    expect(refusal(() => parsePlans({ plans: [{ id: 'Beta', name: 'B', tracks: 'all' }] }))).toMatch(/\.id/);
    expect(refusal(() => parsePlans({ plans: [{ id: '-x', name: 'B', tracks: 'all' }] }))).toMatch(/\.id/);
    expect(
      refusal(() =>
        parsePlans({ plans: [{ id: 'x', name: 'A', tracks: 'all' }, { id: 'x', name: 'B', tracks: 'all' }] }),
      ),
    ).toMatch(/defined twice/);
    expect(refusal(() => parsePlans({ plans: [{ id: 'x', name: ' ', tracks: 'all' }] }))).toMatch(/\.name/);
    for (const bad of [0, -1, 1.5, 101, '2']) {
      expect(refusal(() => parsePlans({ plans: [{ id: 'x', name: 'X', tracks: 'all', maxConcurrentSessions: bad }] }))).toMatch(
        /maxConcurrentSessions/,
      );
    }
    expect(refusal(() => parsePlans([]))).toMatch(/JSON object/);
    expect(refusal(() => parsePlans({}))).toMatch(/"plans" array/);
  });

  it('checks every named track against the lab catalog', () => {
    const catalog = parsePlans(FIXTURE);
    expect(() => catalog.assertTracksExist(new Set(['linux', 'docker']))).not.toThrow();
    expect(refusal(() => catalog.assertTracksExist(new Set(['linux'])))).toMatch(/fixture-two names track\(s\).*docker/);
  });
});

describe('what a plan allows', () => {
  const catalog = parsePlans(FIXTURE);

  it('no plan and an "all" plan include every track; a list includes only its tracks', () => {
    expect(planIncludesTrack(null, 'kubernetes')).toBe(true);
    expect(planIncludesTrack(catalog.get('fixture-all')!, 'kubernetes')).toBe(true);
    expect(planIncludesTrack(catalog.get('fixture-linux')!, 'linux')).toBe(true);
    expect(planIncludesTrack(catalog.get('fixture-linux')!, 'kubernetes')).toBe(false);
    expect(planIncludesTrack(catalog.get('fixture-linux')!, undefined)).toBe(false);
  });

  it('a plan lowers the per-student limit and never raises it', () => {
    expect(effectiveSessionLimit(1, null)).toBe(1);
    expect(effectiveSessionLimit(1, catalog.get('fixture-two')!)).toBe(1); // plan says 3; deployment says 1
    expect(effectiveSessionLimit(5, catalog.get('fixture-two')!)).toBe(3);
    expect(effectiveSessionLimit(5, catalog.get('fixture-all')!)).toBe(5); // no plan limit
    expect(effectiveSessionLimit(undefined, catalog.get('fixture-linux')!)).toBe(1);
    expect(effectiveSessionLimit(undefined, null)).toBeUndefined();
  });
});

describe('ACCESS_PLANS_FILE and the trial terms', () => {
  it('no file: no plans', () => {
    expect(plansFromEnv({}).size).toBe(0);
  });

  it('reads the document inline from ACCESS_PLANS_JSON, and refuses both at once', () => {
    expect(plansFromEnv({ ACCESS_PLANS_JSON: JSON.stringify(FIXTURE) }).size).toBe(3);
    expect(refusal(() => plansFromEnv({ ACCESS_PLANS_JSON: '{' }))).toMatch(/ACCESS_PLANS_JSON is not valid JSON/);
    expect(refusal(() => plansFromEnv({ ACCESS_PLANS_JSON: '{"plans":[]}', ACCESS_PLANS_FILE: '/x' }))).toMatch(/not both/);
  });

  it('refuses a file it cannot read or parse, naming the variable', () => {
    expect(refusal(() => plansFromEnv({ ACCESS_PLANS_FILE: '/nope/plans.json' }))).toMatch(
      /ACCESS_PLANS_FILE=\/nope\/plans.json cannot be read/,
    );
    expect(refusal(() => plansFromEnv({ ACCESS_PLANS_FILE: 'x' }, () => '{not json'))).toMatch(/not valid JSON/);
  });

  it('trials are off unless TRIAL_DURATION_DAYS is set — there is no default length', () => {
    const plans = parsePlans(FIXTURE);
    expect(trialFromEnv({}, plans)).toEqual({ durationDays: null, planId: null });
    expect(trialFromEnv({ TRIAL_DURATION_DAYS: '14' }, plans)).toEqual({ durationDays: 14, planId: null });
    expect(trialFromEnv({ TRIAL_DURATION_DAYS: '7', TRIAL_PLAN: 'fixture-linux' }, plans)).toEqual({
      durationDays: 7,
      planId: 'fixture-linux',
    });
    for (const bad of ['0', '366', '7d', '-1', '1.5']) {
      expect(refusal(() => trialFromEnv({ TRIAL_DURATION_DAYS: bad }, plans))).toMatch(/TRIAL_DURATION_DAYS/);
    }
    expect(refusal(() => trialFromEnv({ TRIAL_DURATION_DAYS: '7', TRIAL_PLAN: 'missing' }, plans))).toMatch(
      /TRIAL_PLAN=missing is not a plan/,
    );
    expect(refusal(() => trialFromEnv({ TRIAL_PLAN: 'fixture-linux' }, plans))).toMatch(/TRIAL_DURATION_DAYS is not/);
  });

  it('loadConfig reads both, and refuses to start on a bad plan file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jtt-plans-'));
    const file = path.join(dir, 'plans.json');
    await writeFile(file, JSON.stringify(FIXTURE));
    const base = { TERMINAL_SESSION_SECRET: 'plans-test-secret', AUTH_MODE: 'development' };
    const config = loadConfig({ ...base, ACCESS_PLANS_FILE: file, TRIAL_DURATION_DAYS: '10' } as NodeJS.ProcessEnv);
    expect(config.accessPlans).toBeInstanceOf(PlanCatalog);
    expect(config.accessPlans!.list().map((p) => p.id)).toEqual(['fixture-all', 'fixture-linux', 'fixture-two']);
    expect(config.trial).toEqual({ durationDays: 10, planId: null });

    const unset = loadConfig(base as NodeJS.ProcessEnv);
    expect(unset.accessPlans!.size).toBe(0);
    expect(unset.trial).toEqual({ durationDays: null, planId: null });

    await writeFile(file, JSON.stringify({ plans: [{ id: 'p', name: 'P' }] }));
    expect(() => loadConfig({ ...base, ACCESS_PLANS_FILE: file } as NodeJS.ProcessEnv)).toThrow(PlanConfigError);
  });
});
