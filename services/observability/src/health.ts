/**
 * Liveness and readiness — PLATFORM-003.
 *
 * ## The distinction, and why getting it wrong is worse than having neither
 *
 * ```text
 *   /livez   is this process alive?              → restart it if not
 *   /readyz  can this instance serve traffic?    → route away from it if not
 * ```
 *
 * The failure mode this design exists to avoid: a readiness probe that checks a
 * *downstream* dependency, wired to a liveness probe, restarting every instance
 * when that dependency blips. The dependency comes back to a cold fleet, the
 * restart storm looks like a second incident, and the telemetry that would have
 * explained the first one restarted with the process.
 *
 * So:
 *
 *   · `/livez` checks **nothing**. It returns 200 if the event loop can serve a
 *     request. That is the only question a restart should ever be based on.
 *   · `/readyz` checks only what makes *this instance* unable to do its job.
 *
 * ## What readiness deliberately does not check
 *
 * **Provider availability.** If Docker dies, the API can still serve the
 * catalogue, progress, authentication, and all nineteen Kubernetes labs. Going
 * unready there would convert a partial outage into a total one — and take the
 * instance out of the load balancer, which is where its metrics were being
 * scraped from. A provider outage is an *alert*, and there is one.
 *
 * **Downstream services.** The terminal does not check sandboxd: a student
 * mid-lab must not lose their shell because the broker blipped for one probe
 * interval.
 *
 * The general rule: readiness answers "will requests to me succeed", not "is
 * the platform fully functional". The second question is what dashboards and
 * alerts are for.
 */

/** One thing a readiness check looks at. */
export interface HealthCheck {
  name: string;
  /**
   * Must be cheap and must not throw — a probe that hangs is worse than one
   * that fails, because a hung probe usually reads as a timeout somewhere else.
   * Implementations wrap their own errors into `{ ok: false }`.
   */
  check(): Promise<HealthCheckResult> | HealthCheckResult;
}

export interface HealthCheckResult {
  ok: boolean;
  /**
   * A bounded enum, never free text and never a connection string.
   *
   * `/readyz` is unauthenticated — it has to be, because a container
   * orchestrator holds no credential — so everything it returns is public. A
   * DSN or an exception message in this field would publish deployment
   * internals to anyone who can reach the port.
   */
  reason?: string;
  /** Human-readable and safe: counts and states only. */
  detail?: string;
}

export interface ReadinessReport {
  service: string;
  ready: boolean;
  checks: Array<{ name: string; ok: boolean; reason?: string; detail?: string }>;
}

export interface ReadinessOptions {
  service: string;
  checks: readonly HealthCheck[];
  /**
   * Until this returns true the instance is never ready, whatever the checks
   * say. Startup work — migrations, loading the lab catalogue — happens before
   * the listener is useful, and a rolling deploy must not route to an instance
   * that is still doing it.
   */
  isStarted?: () => boolean;
}

/**
 * Evaluate readiness.
 *
 * Every check runs even when an earlier one failed. Short-circuiting would
 * report the first problem and hide the second, and "the database is down"
 * plus "the catalogue is empty" are a different incident from either alone.
 */
export async function evaluateReadiness(options: ReadinessOptions): Promise<ReadinessReport> {
  const started = options.isStarted ? options.isStarted() : true;

  const checks: ReadinessReport['checks'] = [];
  if (!started) {
    checks.push({ name: 'startup', ok: false, reason: 'starting' });
  }

  for (const check of options.checks) {
    try {
      const result = await check.check();
      checks.push({
        name: check.name,
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      });
    } catch {
      // A check that threw is a failed check, never a failed probe. The
      // exception is deliberately not surfaced: see HealthCheckResult.reason.
      checks.push({ name: check.name, ok: false, reason: 'check_failed' });
    }
  }

  return {
    service: options.service,
    ready: started && checks.every((entry) => entry.ok),
    checks,
  };
}

/**
 * A check backed by a cached probe result.
 *
 * Readiness is polled continuously — by a load balancer, by compose's
 * healthcheck, by Prometheus. Hitting the database on every one of those turns
 * the probe into load, and a slow database into a slow probe into a false
 * unready. So the underlying probe runs on its own schedule and the check reads
 * the last answer.
 *
 * `staleAfterMs` matters: a cached "healthy" that is five minutes old is a lie.
 * Past the window the check reports `stale` rather than the old answer.
 */
export function cachedCheck(options: {
  name: string;
  staleAfterMs: number;
  read: () => { ok: boolean; at: number; reason?: string; detail?: string } | null;
  now?: () => number;
}): HealthCheck {
  const now = options.now ?? (() => Date.now());
  return {
    name: options.name,
    check(): HealthCheckResult {
      const last = options.read();
      if (!last) return { ok: false, reason: 'not_probed_yet' };
      if (now() - last.at > options.staleAfterMs) {
        return { ok: false, reason: 'stale' };
      }
      return {
        ok: last.ok,
        ...(last.reason ? { reason: last.reason } : {}),
        ...(last.detail ? { detail: last.detail } : {}),
      };
    },
  };
}

/** A check over a value known synchronously — the lab registry, for instance. */
export function simpleCheck(
  name: string,
  evaluate: () => HealthCheckResult,
): HealthCheck {
  return { name, check: evaluate };
}
