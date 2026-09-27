import type { OutputFlowOptions } from '@jumptotech/lab-orchestrator/output-flow';
import {
  assertTlsVerificationEnabled,
  resolveBrokerClientTransport,
  type BrokerClientTransport,
} from '@jumptotech/lab-orchestrator';
import {
  boolFromEnv,
  loadObservabilityConfig,
  assertProductionSecrets,
  assertScrapeTokenIsDistinct,
  isProductionEnv,
  type ObservabilityConfig,
} from '@jumptotech/observability';

/**
 * Secrets the terminal must never be given — BETA-P0-010.
 *
 * This is the process a student types into. It verifies browser tokens, calls
 * the API's `/internal` routes and opens broker shells, and it needs exactly
 * the three secrets for that. The namespace derivation key, the broker's
 * runtime and Docker capabilities, the identity provider's client secret and
 * the database credential all belong to other services; a production terminal
 * that finds one in its environment refuses to start.
 */
export const TERMINAL_FORBIDDEN_SECRETS: readonly string[] = [
  'NAMESPACE_DERIVATION_SECRET',
  'SANDBOXD_RUNTIME_SECRET',
  'SANDBOXD_DOCKER_SECRET',
  'OIDC_CLIENT_SECRET',
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
  'GRAFANA_ADMIN_PASSWORD',
];

export interface TerminalConfig {
  port: number;
  /** Structured logging, metrics and the health listener (PLATFORM-003). */
  observability: ObservabilityConfig;
  sessionSecret: string;
  allowedOrigins: string[];
  /**
   * Base URL of the API's internal credential endpoint.
   *
   * PLATFORM-002 removed the mounted kubeconfig from this service entirely. The
   * shell no longer inherits *any* ambient cluster credential: it is handed a
   * namespace-scoped ServiceAccount kubeconfig fetched from here, per session.
   */
  apiInternalUrl: string;
  /** Shared secret authenticating API ⇄ terminal calls, in both directions. */
  internalServiceSecret: string;
  /**
   * Secrets filled from `TERMINAL_SESSION_SECRET` because they were not set.
   * Development only — production refuses to start instead. See the API's
   * field of the same name.
   */
  developmentSecretFallbacks?: readonly string[];
  /**
   * The unprivileged account this process drops to at startup — BETA-P0-010.
   *
   * Student shells run as this same account, so the drop has to happen *inside*
   * this process: the kernel marks a process that changed its uid non-dumpable,
   * and a non-dumpable process' `/proc/<pid>/environ` and memory are closed to
   * other processes of that uid. Started directly as the account instead, every
   * student could read this service's secrets. See `process-identity.ts`.
   */
  dropToUid?: number;
  /** Group for `dropToUid`. Defaults to the same number. */
  dropToGid?: number;
  /**
   * Base URL of the sandbox broker, used for Linux sessions.
   *
   * This service still holds no container-runtime access: it opens a WebSocket
   * to the broker, authenticated with the internal secret, and the broker
   * decides what may be attached to.
   */
  sandboxBrokerUrl: string;
  /**
   * This service's credential for the broker's **attach** capability, and only
   * that one.
   *
   * Deliberately not `internalServiceSecret`. That value is this service's
   * credential for the *API*, and while the broker accepted it too, this
   * process — the one a student types into — could authenticate to
   * `/v1/docker` and drive the container runtime. It never did; nothing
   * stopped it. Holding a credential that opens exactly one endpoint is what
   * turns "the terminal does not do that" into "the terminal cannot".
   */
  sandboxBrokerCredential: string;
  /**
   * How `sandboxBrokerUrl` is reached, and why that was allowed — BETA-P0-011.
   *
   * Resolved only when the broker is enabled. Carries the CA bundle trusted for
   * this one connection when the broker is `https://`.
   */
  sandboxBrokerTransport?: BrokerClientTransport | null;
  /**
   * Where per-session credentials are written (0600, deleted on disconnect).
   *
   * Holds both kubeconfigs and Docker client certificate directories. Nothing
   * long-lived lives here: every file in it belongs to exactly one live shell.
   */
  credentialsDir: string;
  /**
   * Working directory + HOME for a Kubernetes student shell.
   *
   * Docker sessions get a per-session workspace under `workspaceRoot` instead,
   * because their labs ask them to author files that the verifier then reads.
   */
  workDir: string;
  /** Parent directory holding per-session Docker workspaces. */
  workspaceRoot: string;
  /** Hard cap on concurrent PTYs, so a stuck browser cannot exhaust the host. */
  maxSessions: number;
  /** Kill an idle PTY after this long with no client traffic. */
  idleTimeoutMs: number;
  /** Kill any PTY after this long, regardless of activity. */
  maxSessionMs: number;
  /**
   * At most one lab-session activity report per socket in this window.
   *
   * Typing is reported to the API so the session is not reaped as idle, but a
   * write per keystroke would be a write per keystroke. The first input is
   * reported at once; after that, sustained typing refreshes the session once
   * per window. 30 seconds against a 20-minute idle budget is invisible.
   */
  activityReportIntervalMs: number;
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
  shell: string;
  promptUser: string;
  promptHost: string;
  /**
   * Container CLI used to attach a PTY to a sandbox container.
   *
   * Configuration only. No value from the network ever reaches this, and the
   * spawn plan re-validates every other field before building an argv.
   */
  containerBinary: string;
  /**
   * May this service attach to sandbox containers at all?
   *
   * Off inside the shipped compose stack, where the terminal container has no
   * access to a container runtime by design. On when the service runs on a
   * developer's host, which is where the Linux and Terraform tracks run today.
   */
  containerExecEnabled: boolean;
  /**
   * Attach container-backed shells through `sandboxd` instead of running
   * `docker exec` in this process.
   *
   * This is the setting that makes the container-backed tracks deployable. The
   * local path needs a container runtime *here*, in the one process a student
   * types into, which no real deployment may grant. With the broker on, this
   * service holds no runtime at all: it opens an authenticated WebSocket to
   * `sandboxBrokerUrl`, sends the session id it has already verified, and
   * bridges bytes. The broker derives the container name itself.
   *
   * Takes precedence over `containerExecEnabled` when both are on, because a
   * deployment that has a broker should never fall back to the local path
   * silently.
   */
  sandboxBrokerEnabled: boolean;
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

function optionalIdFromEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^[0-9]+$/.test(raw) || Number.parseInt(raw, 10) <= 0) {
    throw new Error(`Environment variable ${name} must name an unprivileged numeric id, got '${raw}'`);
  }
  return Number.parseInt(raw, 10);
}

export function loadTerminalConfig(env: NodeJS.ProcessEnv = process.env): TerminalConfig {
  const sessionSecret = env.TERMINAL_SESSION_SECRET ?? '';
  if (sessionSecret.length < 8) {
    throw new Error(
      'TERMINAL_SESSION_SECRET must be set to at least 8 characters and must match the API.',
    );
  }

  const observability = loadObservabilityConfig({
    service: 'terminal',
    defaultPort: 9401,
    env,
  });

  /*
   * The scrape token must not be any of the credentials this service holds.
   *
   * It matters more here than anywhere: the terminal is the one process a
   * student types into, and it deliberately holds only the `attach` scope. A
   * scrape token equal to that credential would hand the read-only monitoring
   * path the ability to open a shell.
   */
  assertScrapeTokenIsDistinct(observability.scrapeToken, {
    TERMINAL_SESSION_SECRET: sessionSecret,
    INTERNAL_SERVICE_SECRET: env.INTERNAL_SERVICE_SECRET,
    SANDBOXD_ATTACH_SECRET: env.SANDBOXD_ATTACH_SECRET,
  });

  const explicitInternalSecret = env.INTERNAL_SERVICE_SECRET?.trim() ?? '';
  // Trimmed, as sandboxd trims the value it compares against (scope secrets).
  const sandboxBrokerCredential = env.SANDBOXD_ATTACH_SECRET?.trim() ?? '';
  const sandboxBrokerEnabled = boolFromEnv(env, 'TERMINAL_SANDBOX_BROKER_ENABLED', false);

  if (isProductionEnv(env)) {
    assertProductionSecrets({
      service: 'terminal',
      env,
      secrets: [
        { name: 'TERMINAL_SESSION_SECRET', value: sessionSecret, required: true },
        // Its own value, never the session secret: a terminal session key is
        // not a licence to call `/internal`.
        { name: 'INTERNAL_SERVICE_SECRET', value: explicitInternalSecret, required: true },
        // `attach` is needed only when shells are brokered.
        { name: 'SANDBOXD_ATTACH_SECRET', value: sandboxBrokerCredential, required: sandboxBrokerEnabled },
        { name: 'OBSERVABILITY_SCRAPE_TOKEN', value: observability.scrapeToken, required: true },
      ],
      forbidden: TERMINAL_FORBIDDEN_SECRETS,
    });
  }

  /*
   * BETA-P0-011 — the attach secret travels to sandboxd, which may be on another
   * host. After the secret gate, so a missing secret is still reported as one.
   * An empty URL means the local development broker, as it always has.
   */
  assertTlsVerificationEnabled(env, 'terminal');
  const sandboxBrokerUrl = env.SANDBOX_BROKER_URL?.trim() || 'http://127.0.0.1:4002';
  const sandboxBrokerTransport = sandboxBrokerEnabled
    ? resolveBrokerClientTransport(env, { service: 'terminal', url: sandboxBrokerUrl })
    : null;

  const dropToUid = optionalIdFromEnv(env, 'TERMINAL_DROP_TO_UID');
  const dropToGid = optionalIdFromEnv(env, 'TERMINAL_DROP_TO_GID');

  return {
    port: intFromEnv(env, 'TERMINAL_PORT', 4001),
    observability,
    sessionSecret,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    apiInternalUrl: env.API_INTERNAL_URL ?? 'http://localhost:4000',
    // The fallback is development-only: production refused above.
    internalServiceSecret: explicitInternalSecret || sessionSecret,
    developmentSecretFallbacks: explicitInternalSecret ? [] : ['INTERNAL_SERVICE_SECRET'],
    ...(dropToUid !== undefined ? { dropToUid } : {}),
    ...(dropToGid !== undefined ? { dropToGid } : {}),
    sandboxBrokerUrl,
    sandboxBrokerCredential,
    sandboxBrokerTransport,
    credentialsDir: env.TERMINAL_CREDENTIALS_DIR ?? '/tmp/jumptotech-credentials',
    workDir: env.TERMINAL_WORKDIR ?? '/home/student',
    workspaceRoot: env.TERMINAL_WORKSPACE_ROOT ?? '/home/student/workspaces',
    maxSessions: intFromEnv(env, 'TERMINAL_MAX_SESSIONS', 16),
    idleTimeoutMs: intFromEnv(env, 'TERMINAL_IDLE_TIMEOUT_SECONDS', 1800) * 1000,
    maxSessionMs: intFromEnv(env, 'TERMINAL_MAX_SESSION_SECONDS', 7200) * 1000,
    activityReportIntervalMs: 30_000,
    shell: env.TERMINAL_SHELL ?? '/bin/bash',
    promptUser: env.TERMINAL_PROMPT_USER ?? 'student',
    promptHost: env.TERMINAL_PROMPT_HOST ?? 'lab',
    containerBinary: env.SANDBOX_CONTAINER_BINARY ?? 'docker',
    containerExecEnabled: boolFromEnv(env, 'TERMINAL_CONTAINER_EXEC_ENABLED', true),
    sandboxBrokerEnabled,
  };
}
