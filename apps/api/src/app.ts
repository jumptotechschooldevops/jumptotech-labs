import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { KubernetesPort, LabRegistry, SessionManager } from '@jumptotech/lab-orchestrator';
import type { ApiConfig } from './config.js';
import { sendError, sendOk } from './http.js';
import { createLabRoutes } from './routes/labs.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createInternalRoutes } from './routes/internal.js';

export interface CreateAppDeps {
  registry: LabRegistry;
  sessions: SessionManager;
  k8s: KubernetesPort;
  config: ApiConfig;
}

export function createApp(deps: CreateAppDeps): Express {
  const app = express();

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

  app.get('/health', (_req, res) => {
    sendOk(res, {
      service: 'api',
      status: 'ok',
      labsLoaded: deps.registry.size,
      labLoadErrors: deps.registry.loadErrors,
      sessions: {
        active: deps.sessions.activeCount,
        maxActive: deps.sessions.lifetimes.maxActiveSessions,
      },
    });
  });

  app.use('/api/labs', browserCors, createLabRoutes(deps));
  app.use('/api/sessions', browserCors, createSessionRoutes(deps));
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
