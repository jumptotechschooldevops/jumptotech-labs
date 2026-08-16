/**
 * Track navigation.
 *
 * A track is a learning path — `kubernetes` today, others later. These
 * endpoints are pure reads over the in-memory registry: browsing the catalog
 * touches no cluster and creates nothing, which is what keeps the catalog free
 * to serve at any scale.
 *
 * Everything served here is the catalog-safe projection. Requirements, setup
 * manifests, and reset policy are not reachable from any track endpoint.
 */
import { Router } from 'express';
import type { LabRegistry } from '@jumptotech/lab-orchestrator';
import { sendError, sendOk } from '../http.js';
import { readFilter } from './labs.js';

/** Track ids are kebab-case slugs; validated before use, like every other id. */
const TRACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function createTrackRoutes(deps: { registry: LabRegistry }): Router {
  const { registry } = deps;
  const router = Router();

  // GET /api/tracks --------------------------------------------------------
  router.get('/', (_req, res) => {
    const tracks = registry.tracks();
    sendOk(res, { tracks, count: tracks.length });
  });

  // GET /api/tracks/:trackId -----------------------------------------------
  router.get('/:trackId', (req, res) => {
    const trackId = String(req.params.trackId ?? '');
    if (!TRACK_ID_PATTERN.test(trackId)) {
      sendError(res, 400, {
        code: 'INVALID_TRACK_ID',
        message: `'${trackId}' is not a valid track id`,
        remediation: 'Track ids are lowercase slugs, e.g. kubernetes.',
      });
      return;
    }

    const track = registry.track(trackId);
    if (!track) {
      sendError(res, 404, {
        code: 'TRACK_NOT_FOUND',
        message: `Track ${trackId} not found`,
        remediation: 'List the available tracks with GET /api/tracks.',
      });
      return;
    }

    sendOk(res, { track, labs: registry.labsForTrack(trackId) });
  });

  // GET /api/tracks/:trackId/labs ------------------------------------------
  router.get('/:trackId/labs', (req, res) => {
    const trackId = String(req.params.trackId ?? '');
    if (!TRACK_ID_PATTERN.test(trackId)) {
      sendError(res, 400, {
        code: 'INVALID_TRACK_ID',
        message: `'${trackId}' is not a valid track id`,
        remediation: 'Track ids are lowercase slugs, e.g. kubernetes.',
      });
      return;
    }

    if (!registry.track(trackId)) {
      sendError(res, 404, {
        code: 'TRACK_NOT_FOUND',
        message: `Track ${trackId} not found`,
        remediation: 'List the available tracks with GET /api/tracks.',
      });
      return;
    }

    // The track is pinned from the path; any `track` query parameter is
    // ignored rather than allowed to widen the result beyond this track.
    const labs = registry.list({ ...readFilter(req), track: trackId });
    sendOk(res, { track: trackId, labs, count: labs.length, prerequisitesEnforced: false });
  });

  return router;
}
