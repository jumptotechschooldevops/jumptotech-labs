/**
 * Composition root.
 *
 * Assembles the object graph — registry, Kubernetes client, provider, session
 * manager, reaper — and starts the HTTP server. Everything that varies between
 * environments is decided here and nowhere else.
 */
import {
  InMemorySessionStore,
  KubernetesClient,
  LabRegistry,
  SessionManager,
  SessionReaper,
  createLabProvider,
} from '@jumptotech/lab-orchestrator';
import { waitForRequirements } from '@jumptotech/verifier';
import { createApp } from './app.js';
import { buildProviderRegistry } from './providers.js';
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

  const k8s = new KubernetesClient(
    config.kubeconfigPath ? { kubeconfigPath: config.kubeconfigPath } : {},
  );
  const kubernetes = createLabProvider({
    provider: config.provider,
    clusterName: config.clusterName,
    ...(config.kubeconfigPath ? { kubeconfigPath: config.kubeconfigPath } : {}),
    k8s,
    waitForRequirements: (input) => waitForRequirements({ k8s, ...input }),
  });

  // One registry, every sandbox backend. Which one a lab uses is decided by the
  // lab's own `environment.provider`, not by anything in the application.
  const providers = buildProviderRegistry({ config, kubernetes });

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

  const sessions = new SessionManager({
    registry,
    providers,
    // Sandbox bookkeeping stays in memory: it is disposable state about
    // disposable environments, and the reaper reconciles it against reality on
    // every sweep. What must survive a restart lives in `learning`.
    store: new InMemorySessionStore(),
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
  // idle, and orphaned sandboxes; see services/lab-orchestrator/src/session/reaper.ts.
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
    config,
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
    console.log(`[api] kubernetes=${k8s.serverUrl}`);
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
