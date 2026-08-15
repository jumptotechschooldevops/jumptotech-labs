export interface TerminalConfig {
  port: number;
  sessionSecret: string;
  allowedOrigins: string[];
  kubeconfigPath: string | undefined;
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
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
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
    port: intFromEnv('TERMINAL_PORT', 4001),
    sessionSecret,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    kubeconfigPath: env.KUBECONFIG || undefined,
    workDir: env.TERMINAL_WORKDIR ?? '/home/student',
    maxSessions: intFromEnv('TERMINAL_MAX_SESSIONS', 16),
    idleTimeoutMs: intFromEnv('TERMINAL_IDLE_TIMEOUT_SECONDS', 1800) * 1000,
    maxSessionMs: intFromEnv('TERMINAL_MAX_SESSION_SECONDS', 7200) * 1000,
    shell: env.TERMINAL_SHELL ?? '/bin/bash',
    promptUser: env.TERMINAL_PROMPT_USER ?? 'student',
    promptHost: env.TERMINAL_PROMPT_HOST ?? 'controlplane',
  };
}
