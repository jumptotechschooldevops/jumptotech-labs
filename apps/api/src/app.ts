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
import type { OidcBrowserClient } from './auth/oidc-client.js';
import type { TokenVerifier } from './auth/oidc.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
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

  // No `x-powered-by`, and small request bodies only — nothing here needs more.
  app.disable('x-powered-by');

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

  app.get('/health', asyncRoute(async (_req, res) => {
    // Provider readiness belongs on /health because an operator's first
    // question after "are the labs loaded?" is "which tracks can actually run
    // here?" — and the answer is a live probe, not configuration.
    const providers = await deps.sessions.providers.statuses();
    // Where learning history is going, and whether it is really going there.
    // An operator must be able to see "memory" at a glance rather than
    // discovering it when a restart loses a cohort's progress.
    const store = await learning.progress.health();
    sendOk(res, {
      service: 'api',
      status: 'ok',
      labsLoaded: deps.registry.size,
      labLoadErrors: deps.registry.loadErrors,
      providers: providers.map((provider) => ({
        provider: provider.providerId,
        implementation: provider.implementation,
        sandboxKind: provider.sandboxKind,
        registered: provider.registered,
        available: provider.available,
        ...(provider.reason ? { reason: provider.reason } : {}),
      })),
      sessions: {
        active: await deps.sessions.activeCount(),
        maxActive: deps.sessions.lifetimes.maxActiveSessions,
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
    createAuthRoutes({
      client: deps.browserAuth?.client ?? null,
      idTokenVerifier: deps.browserAuth?.idTokenVerifier ?? null,
      users,
      authSessions,
      browser,
      cookie: deps.config.auth.cookie,
      appUrl: deps.config.auth.browserFlow?.appUrl ?? deps.config.allowedOrigins[0] ?? '',
      transactionSecret: deps.config.terminalSessionSecret,
      mode: deps.config.auth.mode,
    }),
  );

  const routes = {
    ...deps,
    ...learning,
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
  };
  app.use('/api/labs', browserCors, authenticated, createLabRoutes(routes));
  app.use('/api/tracks', browserCors, authenticated, createTrackRoutes(routes));
  app.use('/api/sessions', browserCors, authenticated, createSessionRoutes(routes));
  app.use('/api/me', browserCors, authenticated, createMeRoutes(routes));
  app.use('/internal', createInternalRoutes(deps));

  app.use((_req, res) => {
    sendError(res, 404, { code: 'NOT_FOUND', message: 'No such endpoint' });
  });

  // Central error handler — never leak a stack trace to the client.
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
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
