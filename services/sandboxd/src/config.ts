/**
 * `sandboxd` configuration.
 *
 * Everything here is deployment configuration. Nothing in this file can be
 * influenced by a request: the container binary, the runtime owner and the
 * derivation secret are read once at startup, and the attach path takes only a
 * session id from the network.
 */

import type { OutputFlowOptions } from '@jumptotech/lab-orchestrator';
import {
  assertTlsVerificationEnabled,
  resolveBrokerServerTransport,
  resolveRuntimeOwner,
  type BrokerTransportMode,
  type DockerSandboxPolicy,
  type RuntimeOwnerSource,
} from '@jumptotech/lab-orchestrator';
import { SANDBOXD_SCOPES, type SandboxdScope, type ScopeSecrets } from './scopes.js';

/** The environment variable carrying each scope's secret. */
export const SCOPE_ENV: Readonly<Record<SandboxdScope, string>> = {
  attach: 'SANDBOXD_ATTACH_SECRET',
  runtime: 'SANDBOXD_RUNTIME_SECRET',
  docker: 'SANDBOXD_DOCKER_SECRET',
};

/**
 * Read the per-scope secrets, and refuse the two ways they can be wrong.
 *
 * **Too short** is the ordinary check. **Equal to one another** is the
 * interesting one: two scopes sharing a value silently collapses the boundary
 * back to a single shared secret, which is precisely the arrangement this
 * exists to remove — and it would do so with every test still passing, because
 * every request would still be authorized. It is refused at startup, where an
 * operator sees it, rather than becoming a property nobody can observe.
 *
 * A scope may be left unset. That switches the capability off — the endpoint
 * then refuses everything — which is the right answer for a deployment that
 * does not run the Docker track.
 */
export function loadScopeSecrets(env: NodeJS.ProcessEnv): ScopeSecrets {
  const secrets = {} as Record<SandboxdScope, string>;

  for (const scope of SANDBOXD_SCOPES) {
    const raw = env[SCOPE_ENV[scope]]?.trim() ?? '';
    if (raw && raw.length < 16) {
      throw new Error(
        `${SCOPE_ENV[scope]} must be at least 16 characters; \`make setup\` generates one.`,
      );
    }
    secrets[scope] = raw;
  }

  if (SANDBOXD_SCOPES.every((s) => !secrets[s])) {
    throw new Error(
      `No sandboxd capability is configured. Set at least ${SCOPE_ENV.attach}; ` +
        '`make setup` generates the whole set.',
    );
  }

  const seen = new Map<string, SandboxdScope>();
  for (const scope of SANDBOXD_SCOPES) {
    const value = secrets[scope];
    if (!value) continue;
    const owner = seen.get(value);
    if (owner) {
      throw new Error(
        `${SCOPE_ENV[scope]} and ${SCOPE_ENV[owner]} are the same value. Each capability ` +
          'needs its own secret: sharing one lets a caller that holds either exercise both, ' +
          'which is the boundary this separation exists to create.',
      );
    }
    seen.set(value, scope);
  }

  return secrets;
}

import {
  loadObservabilityConfig,
  assertProductionSecrets,
  assertScrapeTokenIsDistinct,
  isProductionEnv,
  type ObservabilityConfig,
} from '@jumptotech/observability';

/**
 * Secrets `sandboxd` must never be given — BETA-P0-010.
 *
 * The broker holds its three scope secrets and the derivation key and nothing
 * else. It never verifies a browser token, never calls the API, and never
 * touches the database or the identity provider; a production broker that
 * finds any of those credentials in its environment refuses to start.
 */
export const SANDBOXD_FORBIDDEN_SECRETS: readonly string[] = [
  'TERMINAL_SESSION_SECRET',
  'INTERNAL_SERVICE_SECRET',
  'OIDC_CLIENT_SECRET',
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
  'GRAFANA_ADMIN_PASSWORD',
];

export interface SandboxdConfig {
  port: number;
  /** Structured logging, metrics and the health listener (PLATFORM-003). */
  observability: ObservabilityConfig;
  /** Loopback in development; `0.0.0.0` when the callers are other containers. */
  bindAddress: string;
  /**
   * The certificate and key this broker serves every endpoint with —
   * BETA-P0-011. `null` (or absent) serves plaintext, which production allows
   * only on a loopback bind or a declared single-host bridge.
   */
  tls?: { cert: string; key: string } | null;
  /** Why the transport above was accepted. Logged at startup; never a secret. */
  transportMode?: BrokerTransportMode;
  /**
   * One secret per capability, and never one secret for all of them.
   *
   * This used to be a single `INTERNAL_SERVICE_SECRET`, shared with the value
   * the terminal holds to talk to the API — so the terminal could authenticate
   * to `/v1/docker` and drive the container runtime. See `scopes.ts`.
   *
   * Each caller is now given only what it needs: the terminal gets `attach`,
   * the API gets `runtime` and `docker`, and nothing holds all three.
   */
  scopeSecrets: ScopeSecrets;
  /**
   * The HMAC key a sandbox reference is derived from.
   *
   * Must equal the API's `NAMESPACE_DERIVATION_SECRET`, because that is the
   * whole mechanism: this service re-derives the container name from the
   * session id rather than being told one. A mismatch fails closed — the
   * derived name simply will not exist.
   */
  derivationSecret: string;
  /**
   * Which runtime owner's sandboxes this broker will touch. See
   * `RUNTIME_OWNER_LABEL`. Resolved by the same `resolveRuntimeOwner` the API
   * uses, so the two cannot default to different owners.
   */
  runtimeOwner: string;
  /** Whether `runtimeOwner` was configured or is the development default. */
  runtimeOwnerSource?: RuntimeOwnerSource;
  /** Container CLI. Configuration, never a value from the network. */
  containerBinary: string;
  /** Shell opened inside a sandbox. Configuration, never a value from the network. */
  shell: string;
  /**
   * The account a student's shell runs as — `SANDBOX_USER`, the same policy
   * value the API applies.
   *
   * Deliberately *not* read back from the container. `Config.User` is the
   * account the container's foreground process runs as, and a Linux sandbox
   * runs a real service supervisor there as `root`. Attaching with that gave
   * every Linux, CS, Networking and AWS student a root shell. See attach.ts.
   */
  sandboxUser: string;
  /** The student's working directory — `SANDBOX_HOME`. */
  sandboxHome: string;
  /** Concurrent PTYs this broker will host. */
  maxSessions: number;
  /**
   * Docker-track sandbox shape.
   *
   * Read here rather than sent by the API, and that is the whole point: the
   * image, the `--privileged` flag, the memory, the CPU and the pids limit of a
   * `docker:dind` sandbox are this process' configuration. No caller can name
   * any of them, so no caller can ask for a different image or for privilege on
   * something that is not a sandbox. See `docker-ops.ts`.
   *
   * `null` when the Docker track is off, and then `/v1/docker` answers 503
   * rather than existing half-wired.
   */
  docker: DockerSandboxPolicy | null;
  /** A PTY with no traffic for this long is closed. */
  idleTimeoutMs: number;
  /** Hard ceiling on one PTY, whatever the traffic. */
  maxSessionMs: number;
  /**
   * Overrides for the output flow-control limits (`DEFAULT_OUTPUT_FLOW`).
   *
   * Not read from the environment: the defaults are the policy, and this seam
   * exists so a test can prove the bound without streaming megabytes.
   */
  outputFlow?: Partial<OutputFlowOptions>;
  /**
   * Overrides for the input flow-control limits, the same mechanism facing the
   * other way (see "student input" in `output-flow.ts`). Same defaults, same
   * reason for not being read from the environment.
   */
  inputFlow?: Partial<OutputFlowOptions>;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * The Docker sandbox shape, from this process' own environment.
 *
 * Must match the API's `DOCKER_SANDBOX_*` values, because the API reports the
 * ceilings to the student and this process is what actually applies them. They
 * are set on both services from the same variables in compose.
 */
function loadDockerPolicy(env: NodeJS.ProcessEnv): DockerSandboxPolicy {
  const mirror = env.DOCKER_SANDBOX_REGISTRY_MIRROR?.trim() ?? '';
  return {
    image: env.DOCKER_SANDBOX_IMAGE?.trim() || 'docker:27-dind',
    // Exposed so an operator can switch it *off* on a host with a rootless
    // alternative — and so the requirement is visible in configuration rather
    // than buried in provider code.
    privileged: boolFromEnv(env, 'DOCKER_SANDBOX_PRIVILEGED', true),
    memory: env.DOCKER_SANDBOX_MEMORY?.trim() || '2g',
    cpus: env.DOCKER_SANDBOX_CPUS?.trim() || '2',
    pidsLimit: intFromEnv(env, 'DOCKER_SANDBOX_PIDS_LIMIT', 512),
    maxContainers: intFromEnv(env, 'DOCKER_SANDBOX_MAX_CONTAINERS', 10),
    network: env.DOCKER_SANDBOX_NETWORK?.trim() || 'jumptotech-sandboxes',
    daemonPort: intFromEnv(env, 'DOCKER_SANDBOX_DAEMON_PORT', 2376),
    readyTimeoutSeconds: intFromEnv(env, 'DOCKER_SANDBOX_READY_TIMEOUT_SECONDS', 180),
    restartAttempts: intFromEnv(env, 'DOCKER_SANDBOX_RESTART_ATTEMPTS', 5),
    ...(mirror ? { registryMirror: mirror } : {}),
  };
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw || raw.trim() === '') return fallback;
  // Digits only: `parseInt` alone read `2h` as 2 and `1e3` as 1.
  const parsed = /^\s*[0-9]+\s*$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

/**
 * Observability defaults for a config built by hand.
 *
 * Exists so the suites that construct a `SandboxdConfig` literal do not each
 * hand-roll the same block — and so adding a field to `ObservabilityConfig`
 * later is one edit rather than four.
 */
export function defaultObservabilityConfig(service: string, port: number): ObservabilityConfig {
  return {
    service,
    port,
    host: '127.0.0.1',
    scrapeToken: '',
    allowAnonymousMetrics: true,
    logLevel: 'error',
    maxLineBytes: 8192,
    httpSampleRate: 1,
    version: '0.0.0-test',
    commit: 'test',
  };
}

export function loadSandboxdConfig(env: NodeJS.ProcessEnv = process.env): SandboxdConfig {
  const scopeSecrets = loadScopeSecrets(env);

  /*
   * Fails closed rather than defaulting. A broker that derived references from
   * a different key than the API would refuse every attach — confusing but
   * safe — and one that silently fell back to the *internal* secret would make
   * two unrelated secrets load-bearing for each other. Say so at startup.
   */
  // Trimmed, as the api trims it (apps/api/src/config.ts): the two must derive
  // the same sandbox reference from one .env line.
  const derivationSecret = env.NAMESPACE_DERIVATION_SECRET?.trim() ?? '';
  if (derivationSecret.length < 8) {
    throw new Error(
      'NAMESPACE_DERIVATION_SECRET must be set to at least 8 characters and must match the API exactly; sandbox references are derived from it.',
    );
  }

  /*
   * The derivation key names every sandbox; a scope secret authorizes a call.
   * One value doing both would let any caller holding that scope compute the
   * sandbox reference of any session id — refused in every environment, the
   * same way two equal scope secrets are.
   */
  for (const scope of SANDBOXD_SCOPES) {
    if (scopeSecrets[scope] && scopeSecrets[scope] === derivationSecret.trim()) {
      throw new Error(
        `NAMESPACE_DERIVATION_SECRET and ${SCOPE_ENV[scope]} are the same value. The key that ` +
          'derives sandbox references must not also be a credential a caller presents.',
      );
    }
  }

  // sandboxd is always NODE_ENV=production in compose, so a missing owner stops
  // it here rather than letting it guard a different owner than the API stamps.
  const runtimeOwner = resolveRuntimeOwner(env);

  const observability = loadObservabilityConfig({
    service: 'sandboxd',
    defaultPort: 9402,
    env,
  });

  /*
   * The scrape token must differ from all three scope secrets.
   *
   * `loadScopeSecrets` already refuses two equal scope secrets, because equal
   * secrets collapse the attach/runtime/docker boundary back to where it
   * started. The scrape credential is handed to a monitoring system and is the
   * most widely distributed of the four, so it is held to the same rule.
   */
  assertScrapeTokenIsDistinct(observability.scrapeToken, {
    SANDBOXD_ATTACH_SECRET: scopeSecrets.attach,
    SANDBOXD_RUNTIME_SECRET: scopeSecrets.runtime,
    SANDBOXD_DOCKER_SECRET: scopeSecrets.docker,
    NAMESPACE_DERIVATION_SECRET: derivationSecret,
  });

  const dockerEnabled = boolFromEnv(env, 'DOCKER_TRACK_ENABLED', false);

  /*
   * BETA-P0-010 — the broker validates its own capabilities.
   *
   * Development may leave a scope unset (the endpoint then refuses everything)
   * and may use short test credentials. Production may not: `attach` and
   * `runtime` serve every container-backed track, `docker` is required whenever
   * the Docker track is on, and each must be a real, distinct secret.
   */
  if (isProductionEnv(env)) {
    assertProductionSecrets({
      service: 'sandboxd',
      env,
      secrets: [
        { name: SCOPE_ENV.attach, value: scopeSecrets.attach, required: true },
        { name: SCOPE_ENV.runtime, value: scopeSecrets.runtime, required: true },
        { name: SCOPE_ENV.docker, value: scopeSecrets.docker, required: dockerEnabled },
        { name: 'NAMESPACE_DERIVATION_SECRET', value: derivationSecret, required: true },
        { name: 'OBSERVABILITY_SCRAPE_TOKEN', value: observability.scrapeToken, required: true },
      ],
      forbidden: SANDBOXD_FORBIDDEN_SECRETS,
    });
  }

  /*
   * BETA-P0-011 — the scope secrets arrive over this listener. Production serves
   * them over TLS, on loopback behind a TLS proxy, or on a declared single-host
   * bridge, and refuses anything else. After the owner and secret gates, so
   * their refusals keep their precedence. See `broker-transport.ts`.
   */
  assertTlsVerificationEnabled(env, 'sandboxd');
  const bindAddress = env.SANDBOXD_BIND ?? '127.0.0.1';
  const transport = resolveBrokerServerTransport(env, { bindAddress });

  return {
    port: intFromEnv(env, 'SANDBOXD_PORT', 4002),
    observability,
    bindAddress,
    tls: transport.tls,
    transportMode: transport.mode,
    scopeSecrets,
    derivationSecret,
    runtimeOwner: runtimeOwner.owner,
    runtimeOwnerSource: runtimeOwner.source,
    containerBinary: env.SANDBOX_CONTAINER_BINARY ?? 'docker',
    shell: env.SANDBOXD_SHELL ?? '/bin/bash',
    // Must match the API's SANDBOX_USER / SANDBOX_HOME: the API tells the
    // student's browser which sandbox they have, and this service decides who
    // they are inside it. Disagreement is a shell with the wrong identity.
    docker: dockerEnabled ? loadDockerPolicy(env) : null,
    sandboxUser: env.SANDBOX_USER?.trim() || 'student',
    sandboxHome: env.SANDBOX_HOME?.trim() || '/home/student',
    maxSessions: intFromEnv(env, 'SANDBOXD_MAX_SESSIONS', 32),
    idleTimeoutMs: intFromEnv(env, 'SANDBOXD_IDLE_TIMEOUT_SECONDS', 1800) * 1000,
    maxSessionMs: intFromEnv(env, 'SANDBOXD_MAX_SESSION_SECONDS', 7200) * 1000,
  };
}
