/**
 * `sandboxd` entrypoint.
 *
 * Refuses to start rather than starting weakly: `loadSandboxdConfig` throws
 * when the internal secret or the derivation secret is missing, and the runtime
 * is probed once here so an operator learns at boot that the daemon address is
 * wrong, instead of learning it from a student whose lab would not open.
 */
import {
  DockerCliFactory,
  DockerCliRuntime,
  MANAGED_CONTAINER_SELECTOR,
  RUNTIME_OWNER_LABEL,
} from '@jumptotech/lab-orchestrator';
import {
  assertLabelPolicy,
  assertSecretsAreRedactable,
  cachedCheck,
  createCommonMetrics,
  createLogger,
  createObservabilityListener,
  createRegistry,
  createSandboxdMetrics,
  setCollector,
  simpleCheck,
} from '@jumptotech/observability';
import { DockerOps } from './docker-ops.js';
import { loadSandboxdConfig } from './config.js';
import { DockerSandboxInspector } from './inspector.js';
import { createSandboxd } from './server.js';

const config = loadSandboxdConfig();

const logger = createLogger({
  service: 'sandboxd',
  level: config.observability.logLevel,
  maxLineBytes: config.observability.maxLineBytes,
});

/*
 * This service holds the most dangerous credentials in the platform — the three
 * scope secrets and the derivation key that names every sandbox. Proving they
 * are redactable before a single line is written is worth the four lines.
 */
assertSecretsAreRedactable({
  SANDBOXD_ATTACH_SECRET: config.scopeSecrets.attach,
  SANDBOXD_RUNTIME_SECRET: config.scopeSecrets.runtime,
  SANDBOXD_DOCKER_SECRET: config.scopeSecrets.docker,
  NAMESPACE_DERIVATION_SECRET: config.derivationSecret,
  OBSERVABILITY_SCRAPE_TOKEN: config.observability.scrapeToken,
});

const registry = createRegistry({ service: 'sandboxd' });
const common = createCommonMetrics(registry, 'sandboxd');
const metrics = createSandboxdMetrics(registry);
assertLabelPolicy(registry);

common.buildInfo.set(
  {
    service: 'sandboxd',
    version: config.observability.version,
    commit: config.observability.commit,
    node_version: process.versions.node,
  },
  1,
);
common.configInfo.set(
  {
    service: 'sandboxd',
    auth_mode: 'scoped-secret',
    lab_provider: 'container',
    store: 'none',
  },
  1,
);

const inspector = new DockerSandboxInspector({ binary: config.containerBinary });

/*
 * The same `DockerCliRuntime` the API used to hold, moved to the process that
 * should have held it all along. Every name, image, capability and environment
 * name a caller sends is validated by *this* copy, on the privileged side of
 * the boundary — see `runtime-routes.ts`.
 */
const runtime = new DockerCliRuntime({ binary: config.containerBinary });

/*
 * The Docker track, when this deployment runs it.
 *
 * `DockerCliFactory` is the real socket-backed engine — the one the API used to
 * hold. It lives here now, behind fourteen named operations that take a session
 * id and never a container name, an image or a privilege flag.
 */
const docker = config.docker
  ? new DockerOps({
      engines: new DockerCliFactory(),
      derivationSecret: config.derivationSecret,
      runtimeOwner: config.runtimeOwner,
      policy: config.docker,
    })
  : undefined;

const server = createSandboxd({
  config,
  inspector,
  runtime,
  logger,
  metrics,
  common,
  ...(docker ? { docker } : {}),
});

/**
 * The last runtime probe, shared by `/readyz` and `jtt_sandboxd_runtime_up`.
 *
 * `jtt_sandboxd_runtime_up` is deliberately a different question from
 * `up{job="sandboxd"}`: the broker being reachable and the container runtime
 * beneath it being usable are two separate failures with two separate fixes,
 * and incident exercise 2 turns entirely on being able to tell them apart.
 */
let lastRuntimeProbe: { ok: boolean; at: number; reason?: string } | null = null;
let started = false;

async function probeRuntime(): Promise<void> {
  try {
    const version = await inspector.ping();
    lastRuntimeProbe = { ok: true, at: Date.now() };
    metrics.runtimeUp.set(1);
    if (!started) {
      logger.info('sandbox.runtime.ready', {}, `container runtime ready (server ${version})`);
    }
  } catch (error) {
    lastRuntimeProbe = { ok: false, at: Date.now(), reason: 'unreachable' };
    metrics.runtimeUp.set(0);
    logger.warn('sandbox.runtime.unreachable', { err: error });
  }
}

/*
 * Containers this broker currently holds, read at scrape time.
 *
 * Compared against `jtt_sessions_active` on the Sandbox/Runtime dashboard —
 * the difference is the number of sandboxes nobody is accounting for. Both
 * sides are read from their own source of truth for that reason: two
 * independently maintained counters would drift into a permanent false
 * difference and the leak alert would be silenced within a week.
 */
setCollector(metrics.containersManaged, async (gauge) => {
  try {
    const all = await runtime.list(MANAGED_CONTAINER_SELECTOR);
    /*
     * Scoped to this runtime owner, exactly as `/v1/runtime` `list` already
     * scopes it. Counting another deployment's sandboxes on a shared daemon
     * would make this instance's leak panel permanently non-zero and the alert
     * useless — the same reasoning that made the broker scope the verb itself.
     */
    const mine = all.filter(
      (container) => container.labels?.[RUNTIME_OWNER_LABEL] === config.runtimeOwner,
    );
    gauge.reset();
    gauge.set({ provider: 'container' }, mine.length);
  } catch {
    // A runtime that cannot be listed is already reported by
    // `jtt_sandboxd_runtime_up`; leaving the gauge at its last value would be
    // a lie, so it is cleared instead.
    gauge.reset();
  }
});

const observabilityServer = createObservabilityListener({
  service: 'sandboxd',
  port: config.observability.port,
  host: config.observability.host,
  registry,
  scrapeToken: config.observability.scrapeToken,
  allowUnauthenticatedMetrics: config.observability.allowAnonymousMetrics,
  /*
   * Here the runtime *is* the service, so it is a correct readiness gate —
   * unlike the API, where a provider outage must not make the instance unready.
   * A broker that cannot reach a container runtime genuinely cannot serve any
   * request it exists to serve.
   */
  checks: [
    simpleCheck('scope_secrets', () => ({ ok: true, detail: 'three distinct scopes' })),
    cachedCheck({
      name: 'container_runtime',
      staleAfterMs: 90_000,
      read: () => lastRuntimeProbe,
    }),
  ],
  isStarted: () => started,
  logger,
  readyzGauge: common.readyzOk,
  onScrapeDenied: () => common.scrapeDenied.inc({ service: 'sandboxd' }),
});

server.listen(config.port, config.bindAddress, () => {
  started = true;
  logger.info(
    'process.started',
    { port: config.port, version: config.observability.version, commit: config.observability.commit },
    `runtime broker listening on ${config.bindAddress}:${config.port} (owner=${config.runtimeOwner})`,
  );
});

/*
 * A failed probe is a warning, not an exit. The runtime may come up after this
 * process does, and refusing to serve `/health` would then make an ordinary
 * start-order race look like a deployment failure. `/readyz` reports it
 * honestly in the meantime.
 */
void probeRuntime();
const runtimeProbeTimer = setInterval(() => void probeRuntime(), 30_000);
runtimeProbeTimer.unref?.();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('process.stopping', {}, `${signal} — closing shells`);
    clearInterval(runtimeProbeTimer);
    observabilityServer.close();
    server.close(() => process.exit(0));
  });
}
