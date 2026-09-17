import {
  authenticate,
  createSessionGuard,
  type AuthAuditLogger,
} from './auth/middleware.js';
import type { IdentityResolver } from './auth/identity.js';
import { DevelopmentIdentityResolver } from './auth/resolvers.js';
import { InMemoryUserRepository, type UserRepository } from './auth/users.js';
import { BrowserSessionAuthenticator } from './auth/browser-authenticator.js';
import { InMemoryAuthSessionStore, type AuthSessionStore } from './auth/browser-session.js';
import { deriveTransactionKey } from './auth/cookies.js';
import { requireTrustedOrigin } from './auth/origin-guard.js';
import type { OidcBrowserClient } from './auth/oidc-client.js';
import type { TokenVerifier } from './auth/oidc.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { LearningPathCatalog } from '@jumptotech/lab-orchestrator';
import type {
  AnsibleSandboxPort,
  DockerEngineFactory,
  KubernetesPort,
  LabRegistry,
  SessionManager,
  WorkspacePort,
} from '@jumptotech/lab-orchestrator';
import {
  DevStudentIdentity,
  InMemoryProgressRepository,
  ProgressService,
  type StudentIdentityResolver,
} from '@jumptotech/progress';
import {
  httpObservability,
  silentLogger,
  createRegistry,
  createCommonMetrics,
  createSessionMetrics,
  createVerificationMetrics,
  createAuthMetrics,
  type CommonMetrics,
  type SessionMetrics,
  type VerificationMetrics,
  type AuthMetrics,
  type Logger,
} from '@jumptotech/observability';
import type { ApiConfig } from './config.js';
import { asyncRoute, sendError, sendOk } from './http.js';
import { createLabRoutes } from './routes/labs.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createInternalRoutes } from './routes/internal.js';
import { createTrackRoutes } from './routes/tracks.js';
import { createLearningPathRoutes } from './routes/learning-paths.js';
import {
  LEARNING_PATH_RATE_LIMIT,
  SANDBOX_WRITE_RATE_LIMIT,
  byAuthenticatedUser,
  createRateLimiter,
  type RateLimitPolicy,
} from './rate-limit.js';
import { createMeRoutes } from './routes/me.js';
import { createAuthRoutes } from './routes/auth.js';

/**
 * The learning-history half of the graph.
 *
 * Optional: a caller that supplies nothing gets an in-memory store, which is
 * what the unit suites and a laptop with no database use. The composition root
 * passes the PostgreSQL-backed one (see `progress.ts`).
 */
export interface ProgressDeps {
  progress: ProgressService;
  identity: StudentIdentityResolver;
  store: string;
  /** False when history does not outlive the process. */
  durable: boolean;
}

export interface CreateAppDeps {
  registry: LabRegistry;
  sessions: SessionManager;
  k8s: KubernetesPort;
  /** Session-scoped Docker access, for verifying Docker labs. Optional in tests. */
  engines?: DockerEngineFactory;
  /** Reads an Ansible session's topology, for verification. */
  ansible?: AnsibleSandboxPort;
  /** Reads student-authored files, for Docker workspace checks. */
  workspace?: WorkspacePort;
  config: ApiConfig;
  progress?: ProgressDeps;
  /**
   * Learning paths (V1 EPIC-02), loaded from `labs/learning-paths` at startup.
   *
   * Optional so existing tests keep composing an app without one; absent means
   * a deployment with no paths, which lists none and 404s every path id.
   */
  learningPaths?: LearningPathCatalog;
  /** Per-client request budget for the learning-path routes. Defaults to `LEARNING_PATH_RATE_LIMIT`. */
  learningPathRateLimit?: RateLimitPolicy;
  /** Per-student budget for Start and Reset, the routes that create a sandbox. Defaults to `SANDBOX_WRITE_RATE_LIMIT`. */
  sandboxWriteRateLimit?: RateLimitPolicy;
  /**
   * How a request's caller is identified (PLATFORM-009).
   *
   * Optional so existing tests keep composing an app without one; when absent a
   * development resolver over an in-memory user store is used, which is exactly
   * what the pre-authentication behaviour was. Production always supplies one,
   * and `buildIdentityResolver` refuses to hand back a development resolver
   * when NODE_ENV=production.
   */
  identityResolver?: IdentityResolver;
  /** One line per authorization decision. Never carries a credential. */
  authAudit?: AuthAuditLogger;
  /**
   * Structured logging and metrics — PLATFORM-003.
   *
   * Optional so every existing test keeps composing an app without one. When
   * absent the logger is silent and the metrics go to a throwaway registry, so
   * instrumented handlers behave identically without a suite having to know
   * they are instrumented.
   */
  observability?: {
    logger: Logger;
    metrics: {
      common: CommonMetrics;
      sessions: SessionMetrics;
      verification: VerificationMetrics;
      auth: AuthMetrics;
    };
  };
  /**
   * The browser sign-in half (PLATFORM-010).
   *
   * Optional so every existing test keeps composing an app without it. When
   * absent, an in-memory auth-session store and an in-memory user store are
   * used and `/auth/login` reports that no identity provider is configured —
   * which is the truth for a deployment that supplied none, rather than a
   * sign-in button that leads nowhere.
   */
  browserAuth?: {
    users: UserRepository;
    authSessions?: AuthSessionStore;
    /** Null on a deployment with no OIDC client secret. */
    client?: OidcBrowserClient | null;
    /** Verifies the ID token; its audience is the client id. */
    idTokenVerifier?: TokenVerifier | null;
  };
}

function inMemoryProgress(config: ApiConfig): ProgressDeps {
  return {
    progress: new ProgressService({ repository: new InMemoryProgressRepository() }),
    identity: new DevStudentIdentity({
      studentId: config.progress.devStudentId,
      allowHeaderOverride: config.progress.allowStudentHeader,
    }),
    store: 'memory',
    durable: false,
  };
}

/**
 * Metrics for a caller that supplied none.
 *
 * A private registry, never served: handlers can increment unconditionally, so
 * there is no `if (metrics)` at any call site, and a test composing `createApp`
 * gets working counters that nobody scrapes.
 */
function detachedObservability(): NonNullable<CreateAppDeps['observability']> {
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  return {
    logger: silentLogger(),
    metrics: {
      common: createCommonMetrics(registry, 'api'),
      sessions: createSessionMetrics(registry),
      verification: createVerificationMetrics(registry),
      auth: createAuthMetrics(registry),
    },
  };
}

export function createApp(deps: CreateAppDeps): Express {
  const app = express();
  const learning = deps.progress ?? inMemoryProgress(deps.config);
  const observability = deps.observability ?? detachedObservability();
  const learningPaths = deps.learningPaths ?? LearningPathCatalog.empty();

  // No `x-powered-by`, and small request bodies only — nothing here needs more.
  app.disable('x-powered-by');

  /*
   * Exactly one trusted proxy hop: the web tier's nginx, which appends the client
   * address to X-Forwarded-For (infrastructure/docker/nginx/locations.conf).
   * Without it `req.ip` is nginx itself, and a per-client rate limit would put
   * every student in one bucket. One hop, never `true`: an address a client
   * prepends to the header is ignored. Nothing else in the API reads
   * proxy-derived request properties, and the API is not published except
   * through that proxy (BETA-P0-012).
   */
  app.set('trust proxy', 1);

  /*
   * Correlation and HTTP metrics, before everything.
   *
   * Registered first so `req` is inside an AsyncLocalStorage context for the
   * whole request — including the body parser and the error handler — and every
   * log line written anywhere below inherits the same `requestId` without any
   * of that code being handed one. `/health` is included deliberately: an
   * operator polling it should show up in the same latency series as anyone
   * else.
   */
  app.use(
    httpObservability({
      service: 'api',
      metrics: observability.metrics.common,
      logger: observability.logger,
      sampleRate: deps.config.observability.httpSampleRate,
    }),
  );

  app.use(express.json({ limit: '16kb' }));

  // CORS covers the browser-facing surface only. `/internal` is deliberately
  // registered outside it: no browser should be able to reach that router at
  // all, and it additionally requires the shared service secret.
  /*
   * `credentials: true` is what lets the browser send its session cookie.
   *
   * It is only safe alongside an explicit origin allow-list — never a
   * wildcard — which `allowedOrigins` already is, and which the CORS
   * specification enforces anyway by refusing to combine `*` with credentials.
   */
  const browserCors = cors({
    origin: deps.config.allowedOrigins,
    methods: ['GET', 'POST', 'DELETE'],
    credentials: true,
  });

  /*
   * BETA-P0-014 — the same allow-list, enforced on state-changing requests.
   *
   * CORS stops a foreign page reading a response, not sending the request, and
   * `SameSite=Lax` still attaches the cookie for a same-site sibling origin.
   * `PUBLIC_ORIGIN` is trusted too: it is this deployment's own origin, and a
   * same-origin POST through the proxy must not depend on ALLOWED_ORIGINS
   * repeating it. See `auth/origin-guard.ts`.
   */
  const originGuard = requireTrustedOrigin(
    [...deps.config.allowedOrigins, ...(deps.config.publicOrigin ? [deps.config.publicOrigin] : [])],
    (reason) => {
      observability.metrics.common.securityEvents.inc({ service: 'api', event: 'origin_rejected' });
      // The origin itself is attacker-chosen and unbounded, so it is not a field.
      observability.logger.warn('security.event', { securityEvent: 'origin_rejected', reason });
    },
  );

  /*
   * Rate limiting for the learning-path routes (CodeQL js/missing-rate-limiting).
   *
   * Placed after CORS, so a browser can read the 429, and before `authenticated`,
   * so a flood is refused before any credential is verified or session row read.
   * One budget per client address, shared by the catalog and progress reads.
   */
  const learningPathLimiter = createRateLimiter(deps.learningPathRateLimit ?? LEARNING_PATH_RATE_LIMIT, () => {
    observability.metrics.common.securityEvents.inc({ service: 'api', event: 'rate_limited' });
    observability.logger.warn('security.event', { securityEvent: 'rate_limited', reason: 'learning_paths' });
  });

  /*
   * Start Lab and Reset Lab share one per-student budget. Mounted inside the
   * routers, after `authenticate`, so the budget belongs to the student rather
   * than to whoever shares their address.
   */
  const sandboxWriteLimiter = createRateLimiter(
    deps.sandboxWriteRateLimit ?? SANDBOX_WRITE_RATE_LIMIT,
    () => {
      observability.metrics.common.securityEvents.inc({ service: 'api', event: 'rate_limited' });
      observability.logger.warn('security.event', { securityEvent: 'rate_limited', reason: 'sandbox_writes' });
    },
    byAuthenticatedUser,
  );

  app.get('/health', asyncRoute(async (_req, res) => {
    /*
     * Every dependency read here is individually guarded — PLATFORM-003.
     *
     * This endpoint used to throw a 500 when the database was unreachable,
     * because `activeCount()` queries it. That is precisely backwards: the
     * operator endpoint went dark at the moment it was most needed, and an
     * operator's first move — curl /health — returned a generic error that said
     * nothing about which dependency had failed.
     *
     * Found by running incident exercise 1 (docs/incident-exercises.md), not by
     * reasoning about it.
     *
     * The success payload is unchanged, so the five suites that assert this
     * shape still pass; a failing dependency now reports itself instead of
     * taking the whole response with it.
     */
    const safely = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await read();
      } catch {
        return fallback;
      }
    };

    // Provider readiness belongs on /health because an operator's first
    // question after "are the labs loaded?" is "which tracks can actually run
    // here?" — and the answer is a live probe, not configuration.
    const providers = await safely(() => deps.sessions.providers.statuses(), []);
    // Where learning history is going, and whether it is really going there.
    // An operator must be able to see "memory" at a glance rather than
    // discovering it when a restart loses a cohort's progress.
    const store = await safely(() => learning.progress.health(), {
      store: 'unknown',
      ok: false,
      detail: 'health check failed',
    });
    sendOk(res, {
      service: 'api',
      status: 'ok',
      labsLoaded: deps.registry.size,
      labLoadErrors: deps.registry.loadErrors,
      learningPathsLoaded: learningPaths.size,
      learningPathLoadErrors: learningPaths.loadErrors,
      providers: providers.map((provider) => ({
        provider: provider.providerId,
        implementation: provider.implementation,
        sandboxKind: provider.sandboxKind,
        registered: provider.registered,
        available: provider.available,
        ...(provider.reason ? { reason: provider.reason } : {}),
      })),
      sessions: {
        // -1 rather than 0: zero is a real, reassuring number and would be a
        // lie. A negative count is unmistakably "not known".
        active: await safely(() => deps.sessions.activeCount(), -1),
        maxActive: deps.sessions.lifetimes.maxActiveSessions,
        launchesPaused: deps.config.launchesPaused === true,
      },
      progress: {
        store: store.store,
        ok: store.ok,
        durable: learning.durable,
        ...(store.detail ? { detail: store.detail } : {}),
      },
    });
  }));

  /*
   * Identity, then authorization.
   *
   * `authenticate` runs before every browser-facing router, so `req.user` is
   * established once rather than per handler. `/health` is deliberately in
   * front of it — an operator's readiness probe must not need a token — and
   * `/internal` behind its own shared secret, unchanged.
   */
  const audit = deps.authAudit ?? (() => undefined);
  const users = deps.browserAuth?.users ?? new InMemoryUserRepository();
  const identity = deps.identityResolver ?? new DevelopmentIdentityResolver(users);
  const authSessions = deps.browserAuth?.authSessions ?? new InMemoryAuthSessionStore();
  const browser = new BrowserSessionAuthenticator({
    sessions: authSessions,
    users,
    cookieName: deps.config.auth.cookie.name,
  });
  const authenticated = authenticate(identity, audit, browser, ({ source, outcome }) => {
    observability.metrics.auth.attempts.inc({
      mode: deps.config.auth.mode,
      source,
      outcome,
    });
  });
  const sessionGuard = createSessionGuard(deps.sessions, audit);

  /*
   * `/auth` is outside `authenticate` on purpose.
   *
   * Three of its routes are how an unauthenticated caller *becomes*
   * authenticated, and `/auth/session` must be able to answer "nobody" without
   * that being a 401 the frontend has to special-case.
   */
  app.use(
    '/auth',
    browserCors,
    originGuard,
    createAuthRoutes({
      client: deps.browserAuth?.client ?? null,
      idTokenVerifier: deps.browserAuth?.idTokenVerifier ?? null,
      users,
      authSessions,
      browser,
      cookie: deps.config.auth.cookie,
      appUrl: deps.config.auth.browserFlow?.appUrl ?? deps.config.allowedOrigins[0] ?? '',
      /*
       * Derived from the client secret, which only this service holds, rather
       * than TERMINAL_SESSION_SECRET, which the terminal holds too
       * (BETA-P0-014). Without a client secret there is no sign-in to protect.
       */
      transactionSecret: deriveTransactionKey(
        deps.config.auth.browserFlow?.clientSecret ?? `no-browser-flow:${deps.config.terminalSessionSecret}`,
      ),
      mode: deps.config.auth.mode,
      onCallback: (outcome) => observability.metrics.auth.callbacks.inc({ outcome }),
    }),
  );

  const routes = {
    ...deps,
    ...learning,
    learningPaths,
    sessionGuard,
    identity: learning.identity,
    /*
     * The existing `(message: string) => void` seam, preserved.
     *
     * `record()` and the routes' own best-effort catch blocks already speak it,
     * and rewriting every one of those call sites to change how a bookkeeping
     * failure is reported would mix a logging change into handlers that also
     * decide what a student sees. The adapter gives those lines structure and
     * redaction for free; `obs` below is what new instrumentation uses.
     */
    logger: observability.logger.legacy('progress.write_failed', 'warn'),
    obs: observability.logger,
    metrics: observability.metrics,
    sandboxWriteLimiter,
  };
  app.use('/api/labs', browserCors, originGuard, authenticated, createLabRoutes(routes));
  app.use('/api/tracks', browserCors, originGuard, authenticated, createTrackRoutes(routes));
  app.use(
    '/api/learning-paths',
    browserCors,
    originGuard,
    learningPathLimiter,
    authenticated,
    createLearningPathRoutes(routes),
  );
  app.use('/api/sessions', browserCors, originGuard, authenticated, createSessionRoutes(routes));
  /*
   * The student's own learning-path progress shares that budget, counted before
   * `/api/me` authenticates. This prefix only: every other `/api/me` route is
   * unchanged.
   */
  app.use('/api/me/learning-paths', browserCors, learningPathLimiter);
  app.use('/api/me', browserCors, originGuard, authenticated, createMeRoutes(routes));
  app.use('/internal', createInternalRoutes(deps));

  app.use((_req, res) => {
    sendError(res, 404, { code: 'NOT_FOUND', message: 'No such endpoint' });
  });

  // Central error handler — never leak a stack trace to the client.
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    // A body `express.json` refused is the client's error, and it is reached
    // before authentication. Answering it as 500 let anyone raise the 5xx rate
    // `ApiErrorRate` pages on, and logging it wrote the parser's message — which
    // quotes the body — at error level. The request is still logged, as a 4xx,
    // by the HTTP middleware; the body is not.
    const refusal = bodyParserRefusal(error);
    if (refusal) {
      sendError(res, refusal.status, { code: refusal.code, message: refusal.message });
      return;
    }
    // The logger serialises the error without its stack and redacts the
    // message; the client still gets a structured code and nothing else.
    observability.logger.error('http.request.failed', { err: error });
    sendError(res, 500, {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred while handling the request.',
    });
  });

  return app;
}

/**
 * The client-side failures `express.json` reports, mapped to a fixed answer.
 *
 * Matched on body-parser's documented `type`, never on the message, and the
 * message sent back is ours, so no part of the refused body is echoed.
 */
function bodyParserRefusal(error: unknown): { status: number; code: string; message: string } | undefined {
  const type = (error as { type?: unknown } | null)?.type;
  switch (type) {
    case 'entity.parse.failed':
      return { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON.' };
    case 'entity.too.large':
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return { status: 415, code: 'UNSUPPORTED_BODY', message: 'The request body encoding is not supported.' };
    case 'request.aborted':
    case 'request.size.invalid':
    case 'stream.encoding.set':
      return { status: 400, code: 'INVALID_BODY', message: 'The request body could not be read.' };
    default:
      return undefined;
  }
}
