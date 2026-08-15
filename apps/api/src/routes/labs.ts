/**
 * Lab REST routes.
 *
 * Security note: none of these endpoints execute student-supplied commands.
 * `POST /start` mints a short-lived terminal session token; the actual shell
 * lives behind the separate terminal WebSocket service, which verifies that
 * token before spawning a PTY.
 */
import { Router, type Request, type Response } from 'express';
import {
  InvalidLabIdError,
  LabNotFoundError,
  assertValidLabId,
  issueSessionToken,
  labContextFor,
  type LabDefinition,
  type LabProvider,
  type LabRegistry,
} from '@jumptotech/lab-orchestrator';
import { verifyLab, type VerificationResult } from '@jumptotech/verifier';
import type { KubernetesPort } from '@jumptotech/lab-orchestrator';
import type { ApiConfig } from '../config.js';
import { sendError, sendOk } from '../http.js';
import type { LabSession, LabSessionStore } from '../session-store.js';

export interface LabRoutesDeps {
  registry: LabRegistry;
  provider: LabProvider;
  k8s: KubernetesPort;
  sessions: LabSessionStore;
  config: ApiConfig;
}

/** Public shape of a lab — everything the UI renders comes from lab.yaml. */
function toLabDetail(def: LabDefinition) {
  return {
    id: def.id,
    slug: def.slug,
    title: def.title,
    track: def.track,
    difficulty: def.difficulty,
    durationMinutes: def.duration_minutes,
    environment: { provider: def.environment.provider, namespace: def.environment.namespace },
    task: { summary: def.task.summary, description: def.task.description },
    requirements: def.requirement_labels,
    // The literal expectations, so the UI can show them without duplicating them.
    target: {
      podName: def.requirements.pod_name,
      namespace: def.requirements.namespace,
      image: def.requirements.image,
      status: def.requirements.status,
    },
    hint: def.hint,
    documentation: def.documentation,
  };
}

/** Translate domain errors into HTTP responses. */
function handleDomainError(res: Response, error: unknown): boolean {
  if (error instanceof InvalidLabIdError) {
    sendError(res, 400, {
      code: 'INVALID_LAB_ID',
      message: error.message,
      remediation: 'Lab ids look like K8S-001.',
    });
    return true;
  }
  if (error instanceof LabNotFoundError) {
    sendError(res, 404, { code: 'LAB_NOT_FOUND', message: error.message });
    return true;
  }
  return false;
}

export function createLabRoutes(deps: LabRoutesDeps): Router {
  const { registry, provider, k8s, sessions, config } = deps;
  const router = Router();

  /** Resolve `:id` → definition, replying with the right error if it fails. */
  function resolveLab(req: Request, res: Response): LabDefinition | null {
    try {
      const labId = assertValidLabId(req.params.id);
      return registry.get(labId);
    } catch (error) {
      if (handleDomainError(res, error)) return null;
      throw error;
    }
  }

  // GET /api/labs ----------------------------------------------------------
  router.get('/', (_req, res) => {
    const labs = registry.list();
    const tracks = [...new Set(labs.map((l) => l.track))].sort();
    sendOk(res, { labs, tracks, count: labs.length });
  });

  // GET /api/labs/:id ------------------------------------------------------
  router.get('/:id', (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;
    sendOk(res, toLabDetail(def));
  });

  // POST /api/labs/:id/start ----------------------------------------------
  router.post('/:id/start', async (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;

    const context = labContextFor(def);
    const result = await provider.create(context);

    if (!result.ok) {
      // Report the real failure. Never claim the lab is ready.
      sendError(res, 503, {
        code: result.error?.code ?? 'PROVISION_FAILED',
        message: result.error?.message ?? 'Failed to create the lab environment',
        ...(result.error?.remediation ? { remediation: result.error.remediation } : {}),
        details: { steps: result.steps, environment: result.environment },
      });
      return;
    }

    const { token, claims } = issueSessionToken({
      labId: def.id,
      namespace: def.environment.namespace,
      secret: config.terminalSessionSecret,
      ttlSeconds: config.terminalSessionTtlSeconds,
    });

    const session: LabSession = {
      sessionId: claims.sid,
      labId: def.id,
      namespace: def.environment.namespace,
      environmentId: result.environment.environmentId,
      startedAt: new Date(claims.iat * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      durationSeconds: def.duration_minutes * 60,
    };
    await sessions.put(session);

    sendOk(res, {
      session: {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        durationSeconds: session.durationSeconds,
      },
      environment: result.environment,
      steps: result.steps,
      terminal: {
        url: config.terminalWsUrl,
        // Presented to the terminal service over the WebSocket handshake.
        token,
      },
    });
  });

  // GET /api/labs/:id/status ----------------------------------------------
  router.get('/:id/status', async (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;

    const environment = await provider.status(labContextFor(def));
    const session = await sessions.getByLabId(def.id);
    sendOk(res, {
      environment,
      session: session
        ? {
            sessionId: session.sessionId,
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            durationSeconds: session.durationSeconds,
          }
        : null,
    });
  });

  // POST /api/labs/:id/check ----------------------------------------------
  router.post('/:id/check', async (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;

    const result: VerificationResult = await verifyLab({ k8s, lab: def });
    if (result.error) {
      sendError(res, 503, {
        code: result.error.code,
        message: result.error.message,
        remediation: 'Start the lab environment before checking your solution.',
        details: { checks: result.checks },
      });
      return;
    }
    // A failing lab is a successful *check*: HTTP 200 with passed:false.
    sendOk(res, result);
  });

  // POST /api/labs/:id/reset ----------------------------------------------
  router.post('/:id/reset', async (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;

    const result = await provider.reset(labContextFor(def));
    if (!result.ok) {
      sendError(res, 503, {
        code: result.error?.code ?? 'RESET_FAILED',
        message: result.error?.message ?? 'Failed to reset the lab environment',
        details: { steps: result.steps, removed: result.removed },
      });
      return;
    }

    sendOk(res, {
      message: 'Lab reset successfully.',
      removed: result.removed,
      steps: result.steps,
      environment: result.environment,
      /** Tells the UI it is safe to clear the terminal scrollback. */
      clearTerminal: true,
    });
  });

  // DELETE /api/labs/:id/environment --------------------------------------
  router.delete('/:id/environment', async (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;

    const result = await provider.destroy(labContextFor(def));
    if (!result.ok) {
      sendError(res, 503, {
        code: result.error?.code ?? 'DESTROY_FAILED',
        message: result.error?.message ?? 'Failed to destroy the lab environment',
      });
      return;
    }
    await sessions.delete(def.id);
    sendOk(res, { message: 'Lab environment released.', labId: def.id });
  });

  return router;
}
