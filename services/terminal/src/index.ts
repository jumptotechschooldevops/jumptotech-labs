import {
  assertLabelPolicy,
  assertSecretsAreRedactable,
  createCommonMetrics,
  createLogger,
  createObservabilityListener,
  createRegistry,
  createTerminalMetrics,
} from '@jumptotech/observability';

import { loadTerminalConfig } from './config.js';
import { createTerminalServer } from './server.js';

function main(): void {
  const config = loadTerminalConfig();

  const logger = createLogger({
    service: 'terminal',
    level: config.observability.logLevel,
    maxLineBytes: config.observability.maxLineBytes,
  });

  /*
   * Prove this deployment's secrets are redactable before anything is logged.
   *
   * The terminal holds the fewest credentials of any service by design — the
   * session secret and the `attach` scope — which is exactly why an unexpected
   * shape here would be easy to miss.
   */
  assertSecretsAreRedactable({
    TERMINAL_SESSION_SECRET: config.sessionSecret,
    INTERNAL_SERVICE_SECRET: config.internalServiceSecret,
    SANDBOXD_ATTACH_SECRET: config.sandboxBrokerCredential,
    OBSERVABILITY_SCRAPE_TOKEN: config.observability.scrapeToken,
  });

  const registry = createRegistry({ service: 'terminal' });
  const common = createCommonMetrics(registry, 'terminal');
  const terminal = createTerminalMetrics(registry);
  assertLabelPolicy(registry);

  common.buildInfo.set(
    {
      service: 'terminal',
      version: config.observability.version,
      commit: config.observability.commit,
      node_version: process.versions.node,
    },
    1,
  );
  common.configInfo.set(
    { service: 'terminal', auth_mode: 'session-token', lab_provider: 'n/a', store: 'n/a' },
    1,
  );

  if (process.getuid?.() === 0) {
    logger.warn(
      'config.loaded',
      { reason: 'running_as_root' },
      'running as root — student shells inherit this process’ user; the provided image runs as the non-root `student` user',
    );
  }

  const server = createTerminalServer(config, { logger, terminal, common });

  let started = false;

  /*
   * Readiness here checks the listener and nothing else.
   *
   * Deliberately **not** sandboxd: a student mid-lab must not lose their shell
   * because the broker blipped for one probe interval, and an unready terminal
   * would be pulled out of the proxy while its existing PTYs are still perfectly
   * alive. Broker health is sandboxd's own `/readyz` and its own alert.
   */
  const observabilityServer = createObservabilityListener({
    service: 'terminal',
    port: config.observability.port,
    host: config.observability.host,
    registry,
    scrapeToken: config.observability.scrapeToken,
    allowUnauthenticatedMetrics: config.observability.allowAnonymousMetrics,
    checks: [],
    isStarted: () => started,
    logger,
    readyzGauge: common.readyzOk,
    onScrapeDenied: () => common.scrapeDenied.inc({ service: 'terminal' }),
  });

  server.listen(config.port, '0.0.0.0', () => {
    started = true;
    logger.info(
      'process.started',
      {
        port: config.port,
        version: config.observability.version,
        commit: config.observability.commit,
      },
      `terminal websocket on :${config.port}/terminal — shell=${config.shell} cwd=${config.workDir}, ` +
        // Deliberately no cluster credential to report: each PTY gets a
        // namespace-scoped kubeconfig fetched per session from the API.
        `credentials per-session from ${config.apiInternalUrl}, ` +
        `allowed origins: ${config.allowedOrigins.join(', ')}`,
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('process.stopping', {}, `${signal} received, shutting down`);
      observabilityServer.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

try {
  main();
} catch (error) {
  /*
   * `console.error` deliberately: the redaction self-test and the label policy
   * both run inside `main`, so a failure in either has to be reportable before
   * a logger exists. Neither message contains a secret value — they name a
   * variable or a metric.
   */
  // eslint-disable-next-line no-console
  console.error('[terminal] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
}
