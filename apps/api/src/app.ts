import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { KubernetesPort, LabProvider, LabRegistry } from '@jumptotech/lab-orchestrator';
import type { ApiConfig } from './config.js';
import { sendError, sendOk } from './http.js';
import { createLabRoutes } from './routes/labs.js';
import type { LabSessionStore } from './session-store.js';

export interface CreateAppDeps {
  registry: LabRegistry;
  provider: LabProvider;
  k8s: KubernetesPort;
  sessions: LabSessionStore;
  config: ApiConfig;
}

export function createApp(deps: CreateAppDeps): Express {
  const app = express();

  // No `x-powered-by`, and small request bodies only — nothing here needs more.
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(
    cors({
      origin: deps.config.allowedOrigins,
      methods: ['GET', 'POST', 'DELETE'],
      credentials: false,
    }),
  );

  app.get('/health', async (_req, res) => {
    sendOk(res, {
      service: 'api',
      status: 'ok',
      provider: deps.provider.name,
      labsLoaded: deps.registry.size,
      labLoadErrors: deps.registry.loadErrors,
    });
  });

  app.use('/api/labs', createLabRoutes(deps));

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
