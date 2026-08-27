/**
 * Observability configuration — PLATFORM-003.
 *
 * Shared by all three services so a variable means the same thing everywhere.
 * Each service's own config module composes this rather than re-parsing the
 * environment, which is what stops `LOG_LEVEL` meaning one thing in the API and
 * another in the terminal.
 */
import { isLogLevel, type LogLevel } from './logger.js';

export interface ObservabilityConfig {
  service: string;
  port: number;
  host: string;
  scrapeToken: string;
  allowAnonymousMetrics: boolean;
  logLevel: LogLevel;
  maxLineBytes: number;
  version: string;
  commit: string;
}

export interface LoadObservabilityOptions {
  service: string;
  /** Per-service default, so three services do not fight over one port. */
  defaultPort: number;
  env?: NodeJS.ProcessEnv;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function loadObservabilityConfig(options: LoadObservabilityOptions): ObservabilityConfig {
  const env = options.env ?? process.env;
  const isProduction = (env.NODE_ENV ?? '').trim() === 'production';

  const level = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!isLogLevel(level)) {
    throw new Error(`LOG_LEVEL must be one of debug, info, warn, error — got '${env.LOG_LEVEL}'`);
  }

  /*
   * Anonymous metrics are a local-development affordance and must never survive
   * into production. The gate is the same shape as the one that refuses
   * AUTH_MODE=development under NODE_ENV=production: a stale environment file
   * stops the process rather than silently opening something.
   */
  const allowAnonymousMetrics = boolFromEnv(env, 'OBSERVABILITY_ALLOW_ANONYMOUS_METRICS', false);
  if (allowAnonymousMetrics && isProduction) {
    throw new Error(
      'OBSERVABILITY_ALLOW_ANONYMOUS_METRICS=true with NODE_ENV=production. ' +
        'Unauthenticated metrics publish capacity and failure rates to anything that can ' +
        'reach the port. Set OBSERVABILITY_SCRAPE_TOKEN instead.',
    );
  }

  return {
    service: options.service,
    port: intFromEnv(env, 'OBSERVABILITY_PORT', options.defaultPort),
    host: (env.OBSERVABILITY_HOST ?? '0.0.0.0').trim(),
    scrapeToken: (env.OBSERVABILITY_SCRAPE_TOKEN ?? '').trim(),
    allowAnonymousMetrics,
    logLevel: level,
    maxLineBytes: intFromEnv(env, 'LOG_MAX_LINE_BYTES', 8192),
    version: (env.JTT_VERSION ?? '0.1.0').trim(),
    commit: (env.JTT_COMMIT ?? 'unknown').trim(),
  };
}

/**
 * Refuse a scrape token that collides with another secret.
 *
 * `sandboxd` already refuses to start when two of its three scope secrets are
 * equal, for the reason that equal secrets silently collapse a boundary back to
 * where it started. The same argument applies across services: a scrape token
 * equal to `INTERNAL_SERVICE_SECRET` would mean anything holding the (widely
 * distributed, read-only) metrics credential could also drive the internal
 * control endpoints.
 *
 * Comparison is on the values, and no value is ever echoed.
 */
export function assertScrapeTokenIsDistinct(
  scrapeToken: string,
  others: Readonly<Record<string, string | undefined>>,
): void {
  if (!scrapeToken) return;
  const collisions = Object.entries(others)
    .filter(([, value]) => typeof value === 'string' && value.length > 0 && value === scrapeToken)
    .map(([name]) => name);

  if (collisions.length > 0) {
    throw new Error(
      [
        `OBSERVABILITY_SCRAPE_TOKEN is the same value as: ${collisions.join(', ')}.`,
        '',
        'The scrape token is read-only and is handed to a monitoring system; those',
        'other secrets authorise privileged internal operations. Sharing one value',
        'collapses that boundary.',
        '',
        'Generate a distinct token: openssl rand -hex 32',
      ].join('\n'),
    );
  }
}
