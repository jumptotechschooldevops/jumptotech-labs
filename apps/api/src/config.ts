import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export interface ApiConfig {
  port: number;
  labsDir: string;
  provider: string;
  clusterName: string;
  kubeconfigPath: string | undefined;
  allowedOrigins: string[];
  terminalSessionSecret: string;
  terminalSessionTtlSeconds: number;
  terminalWsUrl: string;
  nodeEnv: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const secret = env.TERMINAL_SESSION_SECRET ?? '';
  if (secret.length < 8) {
    throw new Error(
      'TERMINAL_SESSION_SECRET must be set to at least 8 characters. Copy .env.example to .env and generate one with: openssl rand -hex 32',
    );
  }

  return {
    port: intFromEnv('API_PORT', 4000),
    labsDir: env.LABS_DIR ?? path.join(repoRoot, 'labs'),
    provider: env.LAB_PROVIDER ?? 'kind',
    clusterName: env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
    kubeconfigPath: env.KUBECONFIG || undefined,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    terminalSessionSecret: secret,
    terminalSessionTtlSeconds: intFromEnv('TERMINAL_SESSION_TTL_SECONDS', 3600),
    terminalWsUrl: env.VITE_TERMINAL_WS_URL ?? 'ws://localhost:4001',
    nodeEnv: env.NODE_ENV ?? 'development',
  };
}
