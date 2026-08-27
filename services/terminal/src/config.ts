import {
  loadObservabilityConfig,
  assertScrapeTokenIsDistinct,
  type ObservabilityConfig,
} from '@jumptotech/observability';

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
  /** Shared secret authenticating this service to the API and the broker. */
  internalServiceSecret: string;
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

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got '${raw}'`);
  }
  return parsed;
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

  return {
    port: intFromEnv(env, 'TERMINAL_PORT', 4001),
    observability,
    sessionSecret,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    apiInternalUrl: env.API_INTERNAL_URL ?? 'http://localhost:4000',
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET || sessionSecret,
    sandboxBrokerUrl: env.SANDBOX_BROKER_URL ?? 'http://127.0.0.1:4002',
    sandboxBrokerCredential: env.SANDBOXD_ATTACH_SECRET ?? '',
    credentialsDir: env.TERMINAL_CREDENTIALS_DIR ?? '/tmp/jumptotech-credentials',
    workDir: env.TERMINAL_WORKDIR ?? '/home/student',
    workspaceRoot: env.TERMINAL_WORKSPACE_ROOT ?? '/home/student/workspaces',
    maxSessions: intFromEnv(env, 'TERMINAL_MAX_SESSIONS', 16),
    idleTimeoutMs: intFromEnv(env, 'TERMINAL_IDLE_TIMEOUT_SECONDS', 1800) * 1000,
    maxSessionMs: intFromEnv(env, 'TERMINAL_MAX_SESSION_SECONDS', 7200) * 1000,
    shell: env.TERMINAL_SHELL ?? '/bin/bash',
    promptUser: env.TERMINAL_PROMPT_USER ?? 'student',
    promptHost: env.TERMINAL_PROMPT_HOST ?? 'lab',
    containerBinary: env.SANDBOX_CONTAINER_BINARY ?? 'docker',
    containerExecEnabled: boolFromEnv(env, 'TERMINAL_CONTAINER_EXEC_ENABLED', true),
    sandboxBrokerEnabled: boolFromEnv(env, 'TERMINAL_SANDBOX_BROKER_ENABLED', false),
  };
}
