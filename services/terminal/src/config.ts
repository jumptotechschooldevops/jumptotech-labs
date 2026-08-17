export interface TerminalConfig {
  port: number;
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
  /** Where per-session kubeconfigs are written (0600, deleted on disconnect). */
  credentialsDir: string;
  /** Working directory + HOME for the student shell. */
  workDir: string;
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

  return {
    port: intFromEnv(env, 'TERMINAL_PORT', 4001),
    sessionSecret,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    apiInternalUrl: env.API_INTERNAL_URL ?? 'http://localhost:4000',
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET || sessionSecret,
    sandboxBrokerUrl: env.SANDBOX_BROKER_URL ?? 'http://127.0.0.1:4002',
    credentialsDir: env.TERMINAL_CREDENTIALS_DIR ?? '/tmp/jumptotech-credentials',
    workDir: env.TERMINAL_WORKDIR ?? '/home/student',
    maxSessions: intFromEnv(env, 'TERMINAL_MAX_SESSIONS', 16),
    idleTimeoutMs: intFromEnv(env, 'TERMINAL_IDLE_TIMEOUT_SECONDS', 1800) * 1000,
    maxSessionMs: intFromEnv(env, 'TERMINAL_MAX_SESSION_SECONDS', 7200) * 1000,
    shell: env.TERMINAL_SHELL ?? '/bin/bash',
    promptUser: env.TERMINAL_PROMPT_USER ?? 'student',
    promptHost: env.TERMINAL_PROMPT_HOST ?? 'lab',
    containerBinary: env.SANDBOX_CONTAINER_BINARY ?? 'docker',
    containerExecEnabled: boolFromEnv(env, 'TERMINAL_CONTAINER_EXEC_ENABLED', true),
  };
}
