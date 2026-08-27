/**
 * Composition root.
 *
 * Assembles the object graph — registry, Kubernetes client, provider, session
 * manager, reaper — and starts the HTTP server. Everything that varies between
 * environments is decided here and nowhere else.
 */
import {
  InMemorySessionStore,
  PostgresSessionStore,
  LabRegistry,
  SessionManager,
  SessionReaper,
} from '@jumptotech/lab-orchestrator';
import { buildIdentityResolver } from './auth/resolvers.js';
import { buildSandboxComposition } from './composition.js';
import { OidcTokenVerifier } from './auth/oidc.js';
import { InMemoryUserRepository, PostgresUserRepository } from './auth/users.js';
import { OidcBrowserClient } from './auth/oidc-client.js';
import {
  InMemoryAuthSessionStore,
  PostgresAuthSessionStore,
  type AuthSessionStore,
} from './auth/browser-session.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import {
  AbandonedAttemptSweeper,
  AttemptClosingListener,
  buildProgressRuntime,
} from './progress.js';
import { HttpTerminalControl, noopTerminalControl } from './terminal-control.js';
import { buildApiObservability } from './observability.js';
import { installRuntimeCollectors } from './observability-collectors.js';

async function main(): Promise<void> {
  const config = loadConfig();

  /*
   * Observability is built first, before anything that could want to log.
   *
   * It also runs the redaction self-test, so a deployment whose secrets the
   * scanner cannot recognise stops here — before a single line is written.
   */
  const observability = buildApiObservability(config);
  const { logger, metrics } = observability;

  if (process.getuid?.() === 0) {
    logger.warn(
      'config.loaded',
      { reason: 'running_as_root' },
      'running as root — the provided container images run as the non-root `node` user; see README → Security',
    );
  }

  const registry = new LabRegistry(config.labsDir);
  await registry.load();
  metrics.sessions.labsLoaded.set(registry.size);
  metrics.sessions.labLoadErrors.set(registry.loadErrors.length);
  if (registry.loadErrors.length > 0) {
    logger.warn(
      'config.loaded',
      { count: registry.loadErrors.length, reason: 'lab_definition_problems' },
      `lab definition problems: ${registry.loadErrors.join('; ')}`,
    );
  }
  if (registry.size === 0) {
    logger.error(
      'config.loaded',
      { reason: 'no_labs_loaded' },
      `no labs loaded from ${config.labsDir} — check LABS_DIR`,
    );
  }

  const { k8s, engines, workspace, kubernetes, providers, ansible } = buildSandboxComposition({ config });

  const terminal = config.terminalControlUrl
    ? new HttpTerminalControl({
        baseUrl: config.terminalControlUrl,
        secret: config.internalServiceSecret,
      })
    : noopTerminalControl;

  /*
   * Learning history (PLATFORM-005).
   *
   * Built before the session manager, because it is the layer above it: the
   * manager is given a listener that closes a student's *attempt* when their
   * sandbox goes away, and knows nothing else about persistence.
   *
   * A configured-but-unreachable database stops the API here rather than
   * silently falling back to memory — telling students their progress is saved
   * when it is not would be worse than not starting.
   */
  const learning = await buildProgressRuntime(config, logger.legacy('migration.applied'));

  /*
   * Session bookkeeping is durable when a database is configured.
   *
   * It used to be memory on the reasoning that sandboxes are disposable and the
   * reaper reconciles. That holds for one process; it does not survive a
   * restart or a second instance. A restart lost every session record while the
   * sandboxes kept running, so the student's lab became unreachable and the
   * sandbox became an orphan — and two instances could not see each other's
   * sessions at all.
   *
   * Memory remains the fallback when no database is configured, so local
   * development and the hermetic test suite are unchanged. The warning says so
   * plainly rather than implying sessions are safe.
   */
  const sessionStore = learning.database
    ? new PostgresSessionStore(learning.database)
    : new InMemorySessionStore();
  metrics.database.storeInfo.set({ store: learning.store }, 1);
  if (learning.database) {
    logger.info('config.loaded', { store: 'postgres', durable: true }, 'durable session store');
  } else {
    logger.warn(
      'config.loaded',
      { store: 'memory', durable: false },
      'no DATABASE_URL configured — sessions are IN MEMORY and are lost on restart',
    );
  }

  /*
   * Identity, decided once at startup.
   *
   * `buildIdentityResolver` refuses to return a development resolver when
   * NODE_ENV=production, so a stale AUTH_MODE in a production environment file
   * stops the process instead of silently disabling authentication.
   */
  const users = learning.database
    ? new PostgresUserRepository(learning.database, config.auth.mode === 'oidc' ? 'oidc' : 'development')
    : new InMemoryUserRepository(config.auth.mode === 'oidc' ? 'oidc' : 'development');

  const identityResolver = buildIdentityResolver({
    config: { mode: config.auth.mode, nodeEnv: config.auth.nodeEnv },
    users,
    ...(config.auth.oidc
      ? { verifier: new OidcTokenVerifier(config.auth.oidc) }
      : {}),
  });
  if (identityResolver.mode === 'oidc') {
    logger.info('config.loaded', { authMode: 'oidc' }, `OIDC identity (issuer ${config.auth.oidc?.issuer})`);
  } else {
    metrics.common.securityEvents.inc({ service: 'api', event: 'dev_identity_in_use' });
    logger.warn(
      'config.loaded',
      { authMode: 'development', securityEvent: 'dev_identity_in_use' },
      'DEVELOPMENT identity — every caller is whoever they claim to be. Never for production.',
    );
  }

  /*
   * The browser half — PLATFORM-010.
   *
   * Durable when a database is configured, so a signed-in browser survives an
   * API restart and any instance can resolve a session it did not create —
   * exactly the argument that made lab sessions durable in PLATFORM-008. In
   * memory otherwise, and it says so, rather than quietly signing everyone out
   * on every deploy without explanation.
   */
  const authSessions: AuthSessionStore = learning.database
    ? new PostgresAuthSessionStore(learning.database)
    : new InMemoryAuthSessionStore();
  logger[learning.database ? 'info' : 'warn'](
    'config.loaded',
    { store: learning.database ? 'postgres' : 'memory' },
    learning.database
      ? 'durable browser sessions'
      : 'no DATABASE_URL configured — browser sign-ins are IN MEMORY and are lost on restart',
  );

  /*
   * The confidential OIDC client, when one is configured.
   *
   * Null without `OIDC_CLIENT_SECRET`, and `/auth/config` then tells the
   * frontend that signing in is not available here — which is better than a
   * button that leads to a 503. The secret is read here and never leaves the
   * process except in the token-endpoint POST body.
   */
  const browserClient =
    config.auth.oidc && config.auth.browserFlow
      ? new OidcBrowserClient({
          issuer: config.auth.oidc.issuer,
          clientId: config.auth.oidc.clientId,
          clientSecret: config.auth.browserFlow.clientSecret,
          redirectUri: config.auth.browserFlow.redirectUri,
          scopes: config.auth.browserFlow.scopes,
        })
      : null;

  /*
   * A second verifier, for the ID token.
   *
   * An ID token's audience is always the *client id*; an API access token's is
   * `OIDC_AUDIENCE`. Verifying one with the other's expectation fails, so the
   * two are separate instances of the same class rather than one loosened to
   * accept both.
   */
  const idTokenVerifier =
    config.auth.oidc && browserClient
      ? new OidcTokenVerifier({
          issuer: config.auth.oidc.issuer,
          audience: config.auth.oidc.clientId,
          ...(config.auth.oidc.jwksUri ? { jwksUri: config.auth.oidc.jwksUri } : {}),
        })
      : null;

  if (browserClient) {
    logger.info(
      'config.loaded',
      { authMode: config.auth.mode },
      `browser sign-in enabled — redirect ${config.auth.browserFlow!.redirectUri}`,
    );
  } else if (config.auth.mode === 'oidc') {
    logger.info(
      'config.loaded',
      { authMode: 'oidc' },
      'browser sign-in NOT configured (no OIDC_CLIENT_SECRET) — the API accepts bearer tokens only',
    );
  }

  /*
   * Expired browser sessions are swept on the same timer budget as sandboxes.
   *
   * `resolve` already refuses an expired row, so this is housekeeping rather
   * than a security control — but a table that only grows is an operational
   * problem, and the sweep is one indexed DELETE.
   */
  const authSessionSweeper = setInterval(() => {
    void authSessions
      .purgeExpired()
      .then((purged) => {
        if (typeof purged === 'number' && purged > 0) {
          metrics.database.authSessionsPurged.inc(purged);
          logger.info('auth.sessions.purged', { count: purged });
        }
      })
      .catch((error: unknown) => {
        logger.error('auth.sessions.purged', { outcome: 'failed', err: error });
      });
  }, config.reaperIntervalSeconds * 1000);
  authSessionSweeper.unref();

  const sessions = new SessionManager({
    registry,
    providers,
    store: sessionStore,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    terminal,
    listener: new AttemptClosingListener(
      learning.progress,
      logger.legacy('progress.write_failed', 'warn'),
    ),
    logger: logger.legacy('session.transition'),
    metrics: {
      onProvision: (event) => {
        metrics.sessions.provisionDuration.observe(
          { provider: event.provider, sandbox_kind: event.sandboxKind, outcome: event.outcome },
          event.durationMs / 1000,
        );
        for (const step of event.steps) {
          metrics.sessions.provisionStepDuration.observe(
            { provider: event.provider, step: step.name, outcome: step.outcome },
            step.durationMs / 1000,
          );
        }
      },
      onTransition: (from, to) => {
        metrics.sessions.stateTransitions.inc({ from, to });
      },
      onCapacityRejected: (track) => {
        metrics.sessions.capacityRejections.inc({ track });
      },
      onSessionEnded: (event) => {
        metrics.sessions.labEnds.inc({ provider: event.provider, reason: event.reason });
        metrics.sessions.sessionLifetime.observe(
          { provider: event.provider, end_reason: event.reason },
          event.lifetimeSeconds,
        );
      },
    },
  });

  // Students are never responsible for cleanup. The reaper reclaims expired,
  // idle, and orphaned sandboxes across *every* substrate; see
  // services/lab-orchestrator/src/session/reaper.ts.
  const reaper = new SessionReaper({
    sessions,
    providers,
    intervalMs: config.reaperIntervalSeconds * 1000,
    retentionMs: config.sessionRetentionMinutes * 60_000,
    log: logger.legacy('reaper.sweep.completed'),
    metrics: {
      onSweep: (event) => {
        metrics.reaper.sweeps.inc({ outcome: event.outcome });
        metrics.reaper.sweepDuration.observe(event.durationMs / 1000);
        if (event.outcome === 'ok') {
          // A timestamp, not a counter: a counter that stops rising looks
          // exactly like a quiet period, and "cleanup stopped" has to be
          // detectable without anyone noticing an absence.
          metrics.reaper.lastSuccess.set(Date.now() / 1000);
          for (const [provider, count] of Object.entries(event.orphansByProvider)) {
            metrics.reaper.orphansFound.set({ provider }, count);
          }
        }
      },
      onReclaimed: (reason, provider) => {
        metrics.reaper.reclaimed.inc({ reason, provider });
      },
      onSkipped: (reason) => {
        metrics.reaper.skipped.inc({ reason });
      },
      onDeleteFailed: (provider, reason) => {
        metrics.reaper.deleteFailures.inc({ provider, reason });
      },
    },
  });
  reaper.start();

  // The reaper's counterpart on the persistent side: it closes attempts whose
  // sandbox is gone in a way nothing could report — an API restart, most of
  // all. It only ever touches attempts older than the absolute session
  // lifetime, so it cannot close one a student is still working on.
  const attemptSweeper = new AbandonedAttemptSweeper({
    progress: learning.progress,
    maxSessionSeconds: config.lifetimes.maxSessionSeconds,
    intervalMs: config.reaperIntervalSeconds * 1000,
    log: logger.legacy('progress.write_failed', 'warn'),
  });
  attemptSweeper.start();

  const app = createApp({
    registry,
    sessions,
    k8s,
    engines,
    ansible,
    workspace,
    config,
    identityResolver,
    browserAuth: { users, authSessions, client: browserClient, idTokenVerifier },
    observability: {
      logger,
      metrics: {
        common: metrics.common,
        sessions: metrics.sessions,
        verification: metrics.verification,
        auth: metrics.auth,
      },
    },
    /*
     * One line per authorization decision, and one counter increment.
     *
     * `authorizationResult` on the metric is exactly the value on the audit
     * line, so the two can never disagree about what happened — which matters
     * because a rising `denied-not-owner` rate is the signal that distinguishes
     * somebody probing session ids from an ordinary bug.
     */
    authAudit: (event) => {
      metrics.auth.authzDecisions.inc({
        action: event.action,
        result: event.authorizationResult,
      });
      logger.info('authz.decision', {
        requestId: event.requestId,
        ...(event.authenticatedUserId ? { userId: event.authenticatedUserId } : {}),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        action: event.action,
        authorizationResult: event.authorizationResult,
      });
      if (event.authorizationResult === 'denied-not-owner') {
        metrics.common.securityEvents.inc({
          service: 'api',
          event: 'unowned_session_access',
        });
      }
    },
    progress: {
      progress: learning.progress,
      identity: learning.identity,
      store: learning.store,
      durable: learning.durable,
    },
  });

  /*
   * Scrape-time collectors, and the database probe that backs `/readyz`.
   *
   * Registered before the listener starts so the first scrape is already
   * truthful rather than reporting zeroes for a cycle.
   */
  installRuntimeCollectors({
    metrics,
    sessions,
    registry,
    progress: learning.progress,
    database: learning.database,
    authSessions,
    config,
    logger,
    recordDatabaseProbe: observability.recordDatabaseProbe,
  });

  const observabilityServer = observability.start({
    databaseConfigured: learning.database !== null,
    labsLoaded: () => registry.size,
  });

  metrics.common.configInfo.set(
    {
      service: 'api',
      auth_mode: config.auth.mode,
      lab_provider: config.provider,
      store: learning.store,
    },
    1,
  );
  metrics.sessions.capacityLimit.set(config.lifetimes.maxActiveSessions);

  const server = app.listen(config.port, '0.0.0.0', () => {
    observability.markStarted();

    logger.info(
      'process.started',
      {
        port: config.port,
        labsLoaded: registry.size,
        store: learning.store,
        durable: learning.durable,
        authMode: config.auth.mode,
        version: config.observability.version,
        commit: config.observability.commit,
      },
      `api listening on :${config.port} — ${registry.size} labs, kubernetes substrate=${kubernetes.name} ` +
        `cluster=${config.clusterName} endpoint=${k8s.clusterEndpoint().server}`,
    );

    logger.info(
      'config.loaded',
      { reason: 'session_lifetimes' },
      `sessions: max=${config.lifetimes.maxActiveSessions} lifetime=${config.lifetimes.maxSessionSeconds / 60}m ` +
        `idle=${config.lifetimes.idleTimeoutSeconds / 60}m warn=${config.lifetimes.warningSeconds / 60}m`,
    );

    logger.info(
      'config.loaded',
      { reason: 'docker_track' },
      config.dockerEnabled
        ? `docker sandboxes: image=${config.policy.docker.image} network=${config.policy.docker.network} ` +
            `memory=${config.policy.docker.memory} cpus=${config.policy.docker.cpus} pids=${config.policy.docker.pidsLimit}`
        : 'docker track disabled (DOCKER_TRACK_ENABLED=false)',
    );

    void sessions.providers.statuses().then((statuses) => {
      for (const status of statuses) {
        logger[status.available ? 'info' : 'warn'](
          'provider.registered',
          {
            provider: status.providerId,
            implementation: status.implementation,
            sandboxKind: status.sandboxKind,
            outcome: status.available ? 'available' : 'unavailable',
            ...(status.reason ? { reason: status.reason } : {}),
          },
          `provider ${status.providerId}: ${status.available ? 'available' : `unavailable — ${status.reason ?? 'unknown'}`}`,
        );
      }
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('process.stopping', {}, `${signal} received`);
      reaper.stop();
      attemptSweeper.stop();
      clearInterval(authSessionSweeper);
      observabilityServer.close();
      server.close(() => {
        // Release the connection pool so a restart does not leave connections
        // hanging on the database side.
        const closed = learning.database?.close() ?? Promise.resolve();
        void closed.catch(() => undefined).finally(() => process.exit(0));
      });
    });
  }
}

main().catch((error: unknown) => {
  /*
   * Deliberately `console.error` and not the structured logger.
   *
   * This is the one path where the logger may not exist yet — the redaction
   * self-test and the label policy both run inside `buildApiObservability`, and
   * a failure there has to be reportable. Those messages name a variable or a
   * metric, never a value.
   */
  // eslint-disable-next-line no-console
  console.error('[api] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
