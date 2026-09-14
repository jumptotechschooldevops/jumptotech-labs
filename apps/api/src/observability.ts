/**
 * The API's observability composition — PLATFORM-003.
 *
 * One place that builds the logger, the metric registry, the readiness checks
 * and the second listener, so `index.ts` stays a composition root rather than
 * becoming an instrumentation root.
 *
 * ## What readiness means for *this* service
 *
 * Ready = this instance can serve requests. That is:
 *
 *   · the lab catalogue loaded — an API with no labs can answer nothing useful;
 *   · the database is reachable, *when one is configured* — sessions,
 *     ownership and progress all live there, so a start or a check would fail.
 *
 * And deliberately not:
 *
 *   · **any provider's availability.** If the container runtime dies, this
 *     instance still serves the catalogue, progress, authentication and all
 *     nineteen Kubernetes labs. Going unready would turn a partial outage into
 *     a total one and pull the instance out of the load balancer — which is
 *     where its metrics were being scraped from, so the outage would also
 *     become invisible. Provider health is an alert, and there is one.
 *   · **sandboxd or the terminal service.** Same argument, one hop further out.
 *
 * The general rule: readiness answers "will requests to me succeed", never "is
 * the platform fully functional". The second question is what the dashboards
 * are for.
 */
import type { Server } from 'node:http';

import {
  assertLabelPolicy,
  assertSecretsAreRedactable,
  registerSecretValues,
  cachedCheck,
  createAuthMetrics,
  createCommonMetrics,
  createDatabaseMetrics,
  createLogger,
  createObservabilityListener,
  createProviderMetrics,
  createRegistry,
  createReaperMetrics,
  createSessionMetrics,
  createVerificationMetrics,
  simpleCheck,
  type AuthMetrics,
  type CommonMetrics,
  type DatabaseMetrics,
  type HealthCheck,
  type Logger,
  type ProviderMetrics,
  type ReaperMetrics,
  type Registry,
  type SessionMetrics,
  type VerificationMetrics,
} from '@jumptotech/observability';

import type { SessionMetricsHooks } from '@jumptotech/lab-orchestrator';

import { databasePasswordOf, type ApiConfig } from './config.js';

export interface ApiMetrics {
  common: CommonMetrics;
  sessions: SessionMetrics;
  providers: ProviderMetrics;
  verification: VerificationMetrics;
  database: DatabaseMetrics;
  auth: AuthMetrics;
  reaper: ReaperMetrics;
}

export interface ApiObservability {
  logger: Logger;
  registry: Registry;
  metrics: ApiMetrics;
  /** Records the last database probe, for `/readyz` and `jtt_db_up`. */
  recordDatabaseProbe(result: { ok: boolean; reason?: string; detail?: string }): void;
  /** Flipped once startup work is finished; until then `/readyz` is 503. */
  markStarted(): void;
  start(options: {
    /** Null when no database is configured — readiness then ignores it. */
    databaseConfigured: boolean;
    labsLoaded: () => number;
  }): Server;
}

export function buildApiObservability(config: ApiConfig): ApiObservability {
  const logger = createLogger({
    service: 'api',
    level: config.observability.logLevel,
    maxLineBytes: config.observability.maxLineBytes,
  });

  /*
   * Gate three of the redaction contract, run before anything is logged.
   *
   * If this deployment generated a secret in a shape the scanner does not
   * recognise, the process stops here rather than discovering it in a log file
   * weeks later. Values are passed but never echoed — the failure names the
   * variable only.
   */
  /*
   * The two credentials this service is *issued* rather than generates.
   *
   * An identity provider decides the client secret's shape and an operator the
   * database password's, so no pattern can promise to recognise them. They are
   * registered for exact-value redaction first, which is what lets the
   * self-test below cover them without refusing a legitimate provider secret.
   */
  const databasePassword = databasePasswordOf(config.progress.database).value;
  registerSecretValues([config.auth.browserFlow?.clientSecret, databasePassword]);

  assertSecretsAreRedactable({
    TERMINAL_SESSION_SECRET: config.terminalSessionSecret,
    INTERNAL_SERVICE_SECRET: config.internalServiceSecret,
    NAMESPACE_DERIVATION_SECRET: config.namespaceSecret,
    SANDBOXD_RUNTIME_SECRET: config.sandbox.runtimeBrokerCredential,
    SANDBOXD_DOCKER_SECRET: config.sandbox.dockerBrokerCredential,
    OBSERVABILITY_SCRAPE_TOKEN: config.observability.scrapeToken,
    OIDC_CLIENT_SECRET: config.auth.browserFlow?.clientSecret,
    POSTGRES_PASSWORD: databasePassword,
  });

  for (const name of config.developmentSecretFallbacks) {
    logger.warn(
      'config.loaded',
      { reason: 'development_secret_fallback' },
      `${name} is not set and falls back to TERMINAL_SESSION_SECRET — DEVELOPMENT ONLY; ` +
        'production refuses to start this way (`make secrets` generates a separate value)',
    );
  }

  const registry = createRegistry({ service: 'api' });
  const metrics: ApiMetrics = {
    common: createCommonMetrics(registry, 'api'),
    sessions: createSessionMetrics(registry),
    providers: createProviderMetrics(registry),
    verification: createVerificationMetrics(registry),
    database: createDatabaseMetrics(registry),
    auth: createAuthMetrics(registry),
    reaper: createReaperMetrics(registry),
  };

  /*
   * Checked against the registry this process actually built, immediately after
   * building it. A metric that violates the label policy therefore fails at
   * startup rather than at scrape time — an operator gets a refusal to start
   * with an explanation, not a Prometheus that quietly grows a million series.
   */
  assertLabelPolicy(registry);

  metrics.common.buildInfo.set(
    {
      service: 'api',
      version: config.observability.version,
      commit: config.observability.commit,
      node_version: process.versions.node,
    },
    1,
  );

  let lastDatabaseProbe: { ok: boolean; at: number; reason?: string; detail?: string } | null =
    null;
  let started = false;

  return {
    logger,
    registry,
    metrics,

    recordDatabaseProbe(result) {
      lastDatabaseProbe = {
        ok: result.ok,
        at: Date.now(),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
      metrics.database.up.set(result.ok ? 1 : 0);
    },

    markStarted() {
      started = true;
    },

    start({ databaseConfigured, labsLoaded }) {
      const checks: HealthCheck[] = [
        simpleCheck('lab_registry', () => {
          const count = labsLoaded();
          return count > 0
            ? { ok: true, detail: `${count} labs` }
            : { ok: false, reason: 'empty' };
        }),
      ];

      if (databaseConfigured) {
        checks.push(
          cachedCheck({
            name: 'database',
            /*
             * Three reaper intervals. Long enough that a single slow probe does
             * not flap readiness, short enough that a genuinely dead database
             * is reported well before anybody notices through a failed lab
             * start.
             */
            staleAfterMs: config.reaperIntervalSeconds * 3_000,
            read: () => lastDatabaseProbe,
          }),
        );
      }

      return createObservabilityListener({
        service: 'api',
        port: config.observability.port,
        host: config.observability.host,
        registry,
        scrapeToken: config.observability.scrapeToken,
        allowUnauthenticatedMetrics: config.observability.allowAnonymousMetrics,
        checks,
        isStarted: () => started,
        logger,
        readyzGauge: metrics.common.readyzOk,
        onScrapeDenied: () => metrics.common.scrapeDenied.inc({ service: 'api' }),
      });
    },
  };
}

/**
 * The session manager's observability hooks, mapped onto this service's metrics.
 *
 * A function rather than an object literal inside `index.ts`, so the mapping a
 * test exercises is the one production runs. It decides which counter each
 * refusal lands on, and `CapacityExhausted` pages on one of them: a student at
 * their own session limit must never be counted as the platform being full.
 */
export function sessionMetricsHooks(sessions: SessionMetrics): SessionMetricsHooks {
  return {
    onProvision: (event) => {
      sessions.provisionDuration.observe(
        { provider: event.provider, sandbox_kind: event.sandboxKind, outcome: event.outcome },
        event.durationMs / 1000,
      );
      for (const step of event.steps) {
        sessions.provisionStepDuration.observe(
          { provider: event.provider, step: step.name, outcome: step.outcome },
          step.durationMs / 1000,
        );
      }
    },
    onTransition: (from, to) => {
      sessions.stateTransitions.inc({ from, to });
    },
    onCapacityRejected: (track) => {
      sessions.capacityRejections.inc({ track });
    },
    onStudentLimitRejected: (track) => {
      sessions.studentLimitRejections.inc({ track });
    },
    onSessionEnded: (event) => {
      sessions.labEnds.inc({ provider: event.provider, reason: event.reason });
      sessions.sessionLifetime.observe(
        { provider: event.provider, end_reason: event.reason },
        event.lifetimeSeconds,
      );
    },
  };
}
