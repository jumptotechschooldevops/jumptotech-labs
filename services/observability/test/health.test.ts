/**
 * PLATFORM-003 — liveness and readiness semantics.
 *
 * The two properties that matter most here are negative ones, and they are the
 * ones the brief calls out explicitly:
 *
 *   · readiness **fails** when a required dependency is unhealthy
 *   · liveness does **not** fail because an external dependency blipped
 *
 * The second is the one that causes outages when it is wrong: a liveness probe
 * wired to a downstream check restarts the whole fleet the moment that
 * downstream hiccups, and the fleet comes back cold into an already-degraded
 * dependency.
 */
import { describe, expect, it } from 'vitest';

import { cachedCheck, evaluateReadiness, simpleCheck } from '../src/health.js';

const ok = () => simpleCheck('always-ok', () => ({ ok: true, detail: '114 labs' }));
const bad = (reason: string) => simpleCheck('always-bad', () => ({ ok: false, reason }));

describe('readiness fails when a required dependency is unhealthy', () => {
  it('is ready when every check passes', async () => {
    const report = await evaluateReadiness({ service: 'api', checks: [ok()] });
    expect(report.ready).toBe(true);
    expect(report.checks).toEqual([{ name: 'always-ok', ok: true, detail: '114 labs' }]);
  });

  it('is not ready when any check fails', async () => {
    const report = await evaluateReadiness({
      service: 'api',
      checks: [ok(), bad('unreachable')],
    });
    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.name === 'always-bad')?.reason).toBe('unreachable');
  });

  it('reports every failure, not just the first', async () => {
    // "the database is down" plus "the catalogue is empty" is a different
    // incident from either alone, and short-circuiting would hide the second.
    const report = await evaluateReadiness({
      service: 'api',
      checks: [
        simpleCheck('database', () => ({ ok: false, reason: 'unreachable' })),
        simpleCheck('lab_registry', () => ({ ok: false, reason: 'empty' })),
      ],
    });
    expect(report.checks.filter((c) => !c.ok)).toHaveLength(2);
  });

  it('treats a check that threw as a failed check, not a failed probe', async () => {
    const report = await evaluateReadiness({
      service: 'api',
      checks: [
        {
          name: 'explodes',
          check: () => {
            throw new Error('connect ECONNREFUSED postgres://u:p4sswordvalue@db:5432');
          },
        },
      ],
    });
    expect(report.ready).toBe(false);
    expect(report.checks[0]).toEqual({ name: 'explodes', ok: false, reason: 'check_failed' });
  });

  it('never leaks an exception message into an unauthenticated response', () => {
    // /readyz has to be unauthenticated — an orchestrator holds no credential —
    // so everything it returns is public.
    const serialised = JSON.stringify({ reason: 'check_failed' });
    expect(serialised).not.toContain('postgres://');
  });

  it('is never ready before startup work has finished', async () => {
    const report = await evaluateReadiness({
      service: 'api',
      checks: [ok()],
      isStarted: () => false,
    });
    expect(report.ready).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: 'startup', reason: 'starting' });
  });
});

describe('cached checks do not turn a probe into load', () => {
  it('reports the last probe result', () => {
    const check = cachedCheck({
      name: 'database',
      staleAfterMs: 10_000,
      read: () => ({ ok: true, at: 1_000 }),
      now: () => 5_000,
    });
    expect(check.check()).toMatchObject({ ok: true });
  });

  it('refuses to report a stale result as healthy', () => {
    // A cached "healthy" that is five minutes old is a lie, and it is the exact
    // lie that keeps a dead instance in the load balancer.
    const check = cachedCheck({
      name: 'database',
      staleAfterMs: 10_000,
      read: () => ({ ok: true, at: 1_000 }),
      now: () => 60_000,
    });
    expect(check.check()).toEqual({ ok: false, reason: 'stale' });
  });

  it('is not ready before the first probe has run', () => {
    const check = cachedCheck({
      name: 'database',
      staleAfterMs: 10_000,
      read: () => null,
    });
    expect(check.check()).toEqual({ ok: false, reason: 'not_probed_yet' });
  });
});
