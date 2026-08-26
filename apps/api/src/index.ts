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
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import {
  AbandonedAttemptSweeper,
  AttemptClosingListener,
  buildProgressRuntime,
} from './progress.js';
import { HttpTerminalControl, noopTerminalControl } from './terminal-control.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (process.getuid?.() === 0) {
    console.warn(
      '[api] WARNING: running as root. The provided container images run as the non-root `node` user; see README → Security.',
    );
  }

  const registry = new LabRegistry(config.labsDir);
  await registry.load();
  if (registry.loadErrors.length > 0) {
    console.warn('[api] lab definition problems:');
    for (const err of registry.loadErrors) console.warn(`  - ${err}`);
  }
  if (registry.size === 0) {
    console.error(`[api] No labs loaded from ${config.labsDir}. Check LABS_DIR.`);
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
  const learning = await buildProgressRuntime(config, (message) =>
    console.log(`[progress] ${message}`),
  );

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
  console.log(
    learning.database
      ? '[sessions] durable session store (postgres)'
      : '[sessions] no DATABASE_URL configured — sessions are IN MEMORY and are lost on restart',
  );

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
  console.log(
    identityResolver.mode === 'oidc'
      ? `[auth] OIDC (issuer ${config.auth.oidc?.issuer})`
      : '[auth] DEVELOPMENT identity — every caller is whoever they claim to be. Never for production.',
  );

  const sessions = new SessionManager({
    registry,
    providers,
    store: sessionStore,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    terminal,
    listener: new AttemptClosingListener(learning.progress, (message) =>
      console.log(`[progress] ${message}`),
    ),
    logger: (message) => console.log(`[sessions] ${message}`),
  });

  // Students are never responsible for cleanup. The reaper reclaims expired,
  // idle, and orphaned sandboxes across *every* substrate; see
  // services/lab-orchestrator/src/session/reaper.ts.
  const reaper = new SessionReaper({
    sessions,
    providers,
    intervalMs: config.reaperIntervalSeconds * 1000,
    retentionMs: config.sessionRetentionMinutes * 60_000,
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
    log: (message) => console.log(`[progress] ${message}`),
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
    // One structured line per authorization decision. Carries the user id and
    // the outcome, never a token or a claim beyond the identifier.
    authAudit: (event) => console.log(`[authz] ${JSON.stringify(event)}`),
    progress: {
      progress: learning.progress,
      identity: learning.identity,
      store: learning.store,
      durable: learning.durable,
    },
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[api] listening on :${config.port}`);
    console.log(`[api] kubernetes substrate=${kubernetes.name} cluster=${config.clusterName}`);
    void sessions.providers.statuses().then((statuses) => {
      for (const status of statuses) {
        console.log(
          `[api] provider ${status.providerId}: ${status.available ? 'available' : `unavailable — ${status.reason ?? 'unknown'}`}`,
        );
      }
    });
    console.log(`[api] labs=${registry.size} from ${config.labsDir}`);
    console.log(
      `[api] progress store=${learning.store} durable=${learning.durable} student=${config.progress.devStudentId} (development identity — not authentication)`,
    );
    console.log(`[api] kubernetes=${k8s.clusterEndpoint().server}`);
    console.log(
      config.dockerEnabled
        ? `[api] docker sandboxes: image=${config.policy.docker.image} network=${config.policy.docker.network} memory=${config.policy.docker.memory} cpus=${config.policy.docker.cpus} pids=${config.policy.docker.pidsLimit}`
        : '[api] docker track disabled (DOCKER_TRACK_ENABLED=false)',
    );
    console.log(
      `[api] sessions: max=${config.lifetimes.maxActiveSessions} lifetime=${config.lifetimes.maxSessionSeconds / 60}m idle=${config.lifetimes.idleTimeoutSeconds / 60}m warn=${config.lifetimes.warningSeconds / 60}m`,
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      reaper.stop();
      attemptSweeper.stop();
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
  console.error('[api] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
