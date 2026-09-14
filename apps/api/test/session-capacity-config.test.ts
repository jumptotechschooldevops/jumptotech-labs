/**
 * BETA-P0-009 — the per-student limit as configured and as wired.
 *
 * Two things a route test cannot see:
 *
 *   1. The private-beta policy (one live lab per student) is one value in three
 *      places an operator meets it: the config default, the compose file and
 *      `.env.example`. If they drift, a deployment that "set nothing" gets a
 *      different policy depending on how it was started.
 *   2. The composition root maps the manager's refusal hooks onto counters. The
 *      mapping lives in `sessionMetricsHooks`, which `index.ts` calls — so this
 *      exercises the production mapping rather than a copy of it, and pins that
 *      `index.ts` still uses it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLabelPolicy,
  createRegistry,
  createSessionMetrics,
} from '@jumptotech/observability';
import { loadConfig } from '../src/config.js';
import { sessionMetricsHooks } from '../src/observability.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const BASE_ENV = {
  TERMINAL_SESSION_SECRET: 'session-capacity-config-test-secret',
  LABS_DIR: path.join(REPO_ROOT, 'labs'),
  ALLOWED_ORIGINS: 'http://localhost:3000',
};

/**
 * One service's `environment:` block as `KEY -> raw value`.
 *
 * The same small reader `runtime-owner.test.ts` uses: the assertion is about
 * the literal line an operator runs.
 */
function environmentFor(composeFile: string, service: string): Map<string, string> {
  const lines = readFileSync(path.join(REPO_ROOT, composeFile), 'utf8').split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  expect(start, `${composeFile} defines '${service}'`).toBeGreaterThanOrEqual(0);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  const envStart = block.findIndex((line) => line === '    environment:');
  const env = new Map<string, string>();
  if (envStart < 0) return env;
  for (let i = envStart + 1; i < block.length; i += 1) {
    const line = block[i] ?? '';
    if (/^ {4}\S/.test(line)) break;
    const match = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (match?.[1]) env.set(match[1], match[2] ?? '');
  }
  return env;
}

/** Uncommented `KEY=value` assignments in `.env.example`. */
function envExample(): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1]) env.set(match[1], match[2] ?? '');
  }
  return env;
}

describe('the private-beta session policy is the same wherever an operator meets it', () => {
  it('defaults to one live lab per student in config, compose and .env.example', () => {
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).lifetimes.maxActiveSessionsPerStudent).toBe(1);
    expect(environmentFor('docker-compose.yml', 'api').get('MAX_ACTIVE_SESSIONS_PER_STUDENT')).toBe(
      '${MAX_ACTIVE_SESSIONS_PER_STUDENT:-1}',
    );
    expect(envExample().get('MAX_ACTIVE_SESSIONS_PER_STUDENT')).toBe('1');

    // What compose hands the api when the operator's .env sets nothing.
    const composeUnset = { ...BASE_ENV, MAX_ACTIVE_SESSIONS_PER_STUDENT: '' } as NodeJS.ProcessEnv;
    expect(loadConfig(composeUnset).lifetimes.maxActiveSessionsPerStudent).toBe(1);
  });

  it('leaves the global ceiling’s general default where it was, in all three places', () => {
    // The beta host runs MAX_ACTIVE_SESSIONS=5 from its own .env; this story
    // does not change the platform-wide default.
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).lifetimes.maxActiveSessions).toBe(20);
    expect(environmentFor('docker-compose.yml', 'api').get('MAX_ACTIVE_SESSIONS')).toBe(
      '${MAX_ACTIVE_SESSIONS:-20}',
    );
    expect(envExample().get('MAX_ACTIVE_SESSIONS')).toBe('20');

    const beta = loadConfig({
      ...BASE_ENV,
      MAX_ACTIVE_SESSIONS: '5',
      MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
    } as NodeJS.ProcessEnv).lifetimes;
    expect(beta).toMatchObject({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });
  });
});

describe('the composition root puts each refusal on its own counter', () => {
  const counter = async (
    registry: ReturnType<typeof createRegistry>,
    name: string,
    labels: Record<string, string>,
  ): Promise<number> => {
    const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
    expect(metric, `${name} is registered`).toBeDefined();
    return (metric!.values as Array<{ value: number; labels: Record<string, string | number> }>)
      .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
      .reduce((sum, v) => sum + v.value, 0);
  };

  it('counts a per-student refusal only as a per-student refusal, and a full platform only as capacity', async () => {
    const registry = createRegistry({ service: 'api', defaultMetrics: false });
    const hooks = sessionMetricsHooks(createSessionMetrics(registry));

    hooks.onStudentLimitRejected?.('linux');
    hooks.onStudentLimitRejected?.('linux');
    hooks.onCapacityRejected?.('kubernetes');

    expect(await counter(registry, 'jtt_session_student_limit_rejections_total', { track: 'linux' })).toBe(2);
    expect(await counter(registry, 'jtt_session_capacity_rejections_total', { track: 'linux' })).toBe(0);
    expect(await counter(registry, 'jtt_session_capacity_rejections_total', { track: 'kubernetes' })).toBe(1);
    expect(await counter(registry, 'jtt_session_student_limit_rejections_total', { track: 'kubernetes' })).toBe(0);
    // Every series the hooks produced is inside the label policy the API
    // enforces at startup.
    expect(() => assertLabelPolicy(registry)).not.toThrow();
  });

  it('maps every hook the session manager emits', () => {
    const hooks = sessionMetricsHooks(createSessionMetrics(createRegistry({ service: 'api', defaultMetrics: false })));
    expect(Object.keys(hooks).sort()).toEqual([
      'onCapacityRejected',
      'onProvision',
      'onSessionEnded',
      'onStudentLimitRejected',
      'onTransition',
    ]);
  });

  it('is the mapping the composition root actually installs', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'apps/api/src/index.ts'), 'utf8');
    expect(source).toContain('metrics: sessionMetricsHooks(metrics.sessions)');
    // No second, inline mapping that could drift from the tested one.
    expect(source).not.toMatch(/onCapacityRejected|onStudentLimitRejected/);
  });
});
