import {
  authenticate,
  createSessionGuard,
  type AuthAuditLogger,
} from './auth/middleware.js';
import type { IdentityResolver } from './auth/identity.js';
import { DevelopmentIdentityResolver } from './auth/resolvers.js';
import { InMemoryUserRepository } from './auth/users.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type {
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
import type { ApiConfig } from './config.js';
import { asyncRoute, sendError, sendOk } from './http.js';
import { createLabRoutes } from './routes/labs.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createInternalRoutes } from './routes/internal.js';
import { createTrackRoutes } from './routes/tracks.js';
import { createMeRoutes } from './routes/me.js';

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

export function createApp(deps: CreateAppDeps): Express {
  const app = express();
  const learning = deps.progress ?? inMemoryProgress(deps.config);

  // No `x-powered-by`, and small request bodies only — nothing here needs more.
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  // CORS covers the browser-facing surface only. `/internal` is deliberately
  // registered outside it: no browser should be able to reach that router at
  // all, and it additionally requires the shared service secret.
  const browserCors = cors({
    origin: deps.config.allowedOrigins,
    methods: ['GET', 'POST', 'DELETE'],
    credentials: false,
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
  const identity =
    deps.identityResolver ?? new DevelopmentIdentityResolver(new InMemoryUserRepository());
  const authenticated = authenticate(identity, audit);
  const sessionGuard = createSessionGuard(deps.sessions, audit);

  const routes = { ...deps, ...learning, sessionGuard, identity: learning.identity };
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
    // eslint-disable-next-line no-console
    console.error('[api] unhandled error:', error);
    sendError(res, 500, {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred while handling the request.',
    });
  });

  return app;
}
