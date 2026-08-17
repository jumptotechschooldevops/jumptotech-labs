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

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    terminal,
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

  const app = createApp({ registry, sessions, k8s, config });

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
    console.log(`[api] kubernetes=${k8s.serverUrl}`);
    console.log(
      `[api] sessions: max=${config.lifetimes.maxActiveSessions} lifetime=${config.lifetimes.maxSessionSeconds / 60}m idle=${config.lifetimes.idleTimeoutSeconds / 60}m warn=${config.lifetimes.warningSeconds / 60}m`,
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      reaper.stop();
      server.close(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  console.error('[api] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
