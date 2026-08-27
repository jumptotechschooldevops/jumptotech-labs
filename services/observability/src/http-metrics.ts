/**
 * HTTP instrumentation — PLATFORM-003.
 *
 * ## The route label is the whole problem
 *
 * `req.path` on this platform is routinely `/api/sessions/8f3c…/check`. Using
 * it as a metric label would create one series per session, forever, and would
 * publish session identifiers into a store that many people can read and that
 * never forgets. That is both halves of the label policy violated by one
 * careless line.
 *
 * Express knows the *template* — `/api/sessions/:sessionId/check` — but only
 * after routing has happened, which is why the label is read in the `finish`
 * handler rather than on the way in. Where no route matched (a 404), the label
 * is the literal string `unmatched`: not the path, because an unmatched path is
 * attacker-chosen and therefore the most unbounded input there is.
 */
import type { NextFunction, Request, Response } from 'express';

import { enrichContext, normaliseRequestId, withContext } from './context.js';
import type { CommonMetrics } from './metrics.js';
import type { Logger } from './logger.js';

/** `2xx`, `4xx`, `5xx` — a bounded companion to the exact status. */
export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}

/**
 * The Express route template for a finished request.
 *
 * `req.route` is set by the router once a handler matched, but it is relative
 * to the mount point, so `req.baseUrl` has to be prepended — otherwise every
 * router's `/` collapses into one series and `/api/labs` becomes
 * indistinguishable from `/api/tracks`.
 */
export function routeTemplate(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route;
  if (!route?.path) return 'unmatched';
  const base = req.baseUrl || '';
  const path = route.path === '/' ? '' : route.path;
  const combined = `${base}${path}`;
  return combined.length > 0 ? combined : '/';
}

export interface HttpObservabilityOptions {
  service: string;
  metrics: CommonMetrics;
  logger: Logger;
  /** 2xx sampling. 4xx and 5xx are never sampled — see below. */
  sampleRate?: number;
  now?: () => number;
}

/**
 * Correlation + HTTP metrics + one access line per request.
 *
 * Registered once, before every router, so nothing downstream has to remember
 * to participate.
 */
export function httpObservability(options: HttpObservabilityOptions) {
  const now = options.now ?? (() => Date.now());
  const sampleRate = options.sampleRate ?? 1;

  return function middleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = normaliseRequestId(req.get('x-request-id'));
    const startedAt = now();

    /*
     * Echoed back so a student reporting a problem can quote it, and so a
     * proxy in front of this can log the same id. It is not a credential and
     * grants nothing — it is an index into log lines an operator can already
     * read.
     */
    res.setHeader('x-request-id', requestId);

    withContext({ requestId, method: req.method }, () => {
      options.metrics.httpInFlight.inc({ service: options.service });

      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;

        const route = routeTemplate(req);
        const status = res.statusCode;
        const klass = statusClass(status);
        const durationMs = now() - startedAt;

        enrichContext({ route });

        options.metrics.httpInFlight.dec({ service: options.service });
        options.metrics.httpRequests.inc({
          service: options.service,
          method: req.method,
          route,
          status: String(status),
          status_class: klass,
        });
        options.metrics.httpDuration.observe(
          { service: options.service, method: req.method, route, status_class: klass },
          durationMs / 1000,
        );

        /*
         * Errors are never sampled.
         *
         * Sampling exists to keep a busy 2xx path from drowning the log. A 4xx
         * or 5xx is by definition rare and by definition the thing someone will
         * come looking for, so dropping one to save volume is exactly backwards.
         */
        const isError = status >= 400;
        if (!isError && sampleRate < 1 && Math.random() >= sampleRate) return;

        options.logger[isError ? 'warn' : 'info'](
          'http.request.completed',
          { route, method: req.method, status, durationMs },
        );
      };

      // `finish` covers a normal response; `close` covers a client that hung
      // up mid-response, which otherwise leaks the in-flight gauge upward until
      // it looks like a load problem that is not happening.
      res.on('finish', settle);
      res.on('close', settle);

      next();
    });
  };
}
