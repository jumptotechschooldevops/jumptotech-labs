/**
 * The observability listener — PLATFORM-003.
 *
 * ## Why a second HTTP server instead of three more routes
 *
 * `/metrics` publishes internal topology, capacity, failure rates, and the
 * catalogue's shape. On the API it would sit beside routes that nginx proxies
 * to the public internet, one `location` block away from being served to
 * anybody.
 *
 * A separate listener on a port nginx has no `proxy_pass` for makes that
 * exposure *structurally* impossible rather than a routing convention that
 * holds until somebody edits `web.conf`. It is the same argument that moved the
 * container runtime out of the API and into `sandboxd`: the strong version of
 * "this service cannot do that" is that it has no way to, not that it declines.
 *
 * Two further properties fall out of the separation:
 *
 *   · **It keeps answering while the main listener is saturated** — which is
 *     precisely when an operator needs it, and precisely when a route on the
 *     busy server would be queued behind the incident.
 *   · **It cannot be reached through the student CORS surface at all**, so no
 *     browser preflight, no origin allow-list, nothing to get wrong.
 *
 * ## Three gates on /metrics
 *
 *   1. a port nginx cannot route to
 *   2. bound to 127.0.0.1 in the shipped compose files
 *   3. `Authorization: Bearer <token>`, compared in constant time
 *
 * Any one would do. All three is this repository's established idiom — the same
 * belt-and-braces the verifier uses for sandbox path safety and `sandboxd` uses
 * for scope authorization.
 *
 * `Bearer` specifically, rather than the `x-internal-secret` header used
 * elsewhere, because Prometheus can supply it from `authorization.credentials_file`
 * and cannot supply an arbitrary custom header. The token therefore never has
 * to appear as a literal in a scrape config.
 *
 * ## /livez and /readyz are unauthenticated, on purpose
 *
 * A container orchestrator holds no credential. Both endpoints return a status
 * code and a bounded enum, and nothing else — see `HealthCheckResult.reason`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { evaluateReadiness, type HealthCheck } from './health.js';
import type { Logger } from './logger.js';
import type { Gauge, Registry } from './metrics.js';

export interface ObservabilityListenerOptions {
  service: string;
  port: number;
  /**
   * Interface to bind.
   *
   * Defaults to loopback. A deployment that must scrape from another host sets
   * this explicitly and is warned, exactly as `sandboxd` warns when told to
   * bind wider than loopback.
   */
  host?: string;
  registry: Registry;
  /**
   * Bearer token required for `/metrics`.
   *
   * Empty is refused unless `allowUnauthenticatedMetrics` is set, so a
   * deployment that forgets it loses metrics loudly rather than publishing
   * them.
   */
  scrapeToken: string;
  /** Local development only. Never true in a shipped compose file. */
  allowUnauthenticatedMetrics?: boolean;
  checks: readonly HealthCheck[];
  isStarted?: () => boolean;
  logger: Logger;
  /** Kept in step with `/readyz` so an alert can fire on sustained unreadiness. */
  readyzGauge?: Gauge;
  /** Counts refused scrapes. */
  onScrapeDenied?: () => void;
}

export class ObservabilityConfigError extends Error {
  readonly code = 'OBSERVABILITY_CONFIG_INVALID';
}

/**
 * Constant-time bearer comparison.
 *
 * Length is checked first because `timingSafeEqual` throws on a length
 * mismatch — the same shape as `sandboxd/src/scopes.ts`, kept deliberately
 * identical so the two cannot drift into different opinions about how a secret
 * is compared.
 */
function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header || expected.length === 0) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const presented = Buffer.from(match[1]);
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // Nothing here is cacheable and a cached readiness answer is a dangerous
    // one — an intermediary replaying a stale 200 defeats the whole probe.
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function createObservabilityListener(options: ObservabilityListenerOptions): Server {
  const host = options.host ?? '127.0.0.1';

  if (!options.scrapeToken && !options.allowUnauthenticatedMetrics) {
    throw new ObservabilityConfigError(
      [
        'No metrics scrape token is configured.',
        '',
        '/metrics publishes capacity, failure rates and catalogue shape. Serving it',
        'unauthenticated is a decision, not a default, so this refuses to start.',
        '',
        'Set OBSERVABILITY_SCRAPE_TOKEN (generated by `make setup`), or set',
        'OBSERVABILITY_ALLOW_ANONYMOUS_METRICS=true for a local stack only.',
      ].join('\n'),
    );
  }

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    options.logger.warn(
      'observability.listener.started',
      { service: options.service, reason: 'non_loopback_bind' },
      `observability listener bound to ${host}, which is wider than loopback — ` +
        'anything able to reach this port can read platform metrics if it holds the scrape token',
    );
  }

  const server = createServer((req, res) => {
    void (async () => {
      // A path-only comparison: no prefix matching, so `/metricsX` and
      // `/metrics/../livez` are simply not endpoints. Same discipline as
      // `scopeForEndpoint` in sandboxd.
      const url = req.url ?? '';

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
        return;
      }

      if (url === '/livez') {
        /*
         * Checks nothing. Reaching this line *is* the check: the process is
         * up, the event loop is turning, and the HTTP stack is serving. Adding
         * a dependency here is how a database blip becomes a restart storm.
         */
        sendJson(res, 200, { ok: true, data: { service: options.service, status: 'alive' } });
        return;
      }

      if (url === '/readyz') {
        const report = await evaluateReadiness({
          service: options.service,
          checks: options.checks,
          ...(options.isStarted ? { isStarted: options.isStarted } : {}),
        });
        options.readyzGauge?.set({ service: options.service }, report.ready ? 1 : 0);
        sendJson(res, report.ready ? 200 : 503, { ok: report.ready, data: report });
        return;
      }

      if (url === '/metrics') {
        if (!options.allowUnauthenticatedMetrics) {
          const authorised = bearerMatches(req.headers.authorization, options.scrapeToken);
          if (!authorised) {
            options.onScrapeDenied?.();
            options.logger.warn(
              'observability.scrape.denied',
              { service: options.service, securityEvent: 'scrape_unauthorized' },
              'metrics scrape refused: missing or invalid bearer token',
            );
            // A bare 401 with no body. An error message describing what was
            // wrong with the credential is an oracle.
            res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-length': '0' });
            res.end();
            return;
          }
        }

        try {
          const body = await options.registry.metrics();
          res.writeHead(200, {
            'content-type': options.registry.contentType,
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          });
          res.end(body);
        } catch (error) {
          // A failing collector must not take down the endpoint that would
          // tell an operator why.
          options.logger.error('http.request.failed', { route: '/metrics', err: error });
          sendJson(res, 500, { ok: false, error: { code: 'METRICS_COLLECTION_FAILED' } });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    })();
  });

  server.listen(options.port, host, () => {
    options.logger.info(
      'observability.listener.started',
      { service: options.service, port: options.port },
      `observability listener on ${host}:${options.port} (/metrics /livez /readyz)`,
    );
  });

  return server;
}
