/**
 * Learning paths (V1 EPIC-02).
 *
 * ```text
 *   GET /api/learning-paths                  every path, summarised
 *   GET /api/learning-paths/:pathId          one path: stages, skills, labs in order, curriculum gaps
 *   GET /api/me/learning-paths/:pathId       the caller's verified progress through it, and the next lab
 * ```
 *
 * The first two are catalog reads — the same for every student, and built only
 * from `labs/learning-paths/*.yaml` and the lab catalog. The third is mounted
 * under `/api/me` (see `me.ts`) because its subject is the authenticated caller:
 * there is no student parameter anywhere, so nobody can ask for someone else's
 * progress by editing a URL.
 *
 * What is deliberately absent from every payload here: session ids, sandbox
 * names, provider failure reasons, lab requirements and setup. A path points at
 * labs by id and title; everything that runs or grades a lab stays where it was.
 */
import { Router, type Request, type Response } from 'express';
import {
  LEARNING_PATH_ID_PATTERN,
  computeLearningPathProgress,
  type LabRegistry,
  type LearningPathCatalog,
  type PathLabStatus,
  type ResolvedLearningPath,
  type SessionManager,
} from '@jumptotech/lab-orchestrator';
import { asyncRoute, sendError, sendOk } from '../http.js';

export interface LearningPathRoutesDeps {
  learningPaths: LearningPathCatalog;
  registry: LabRegistry;
  sessions: SessionManager;
}

/** Resolve `:pathId`, replying 400/404 itself when it cannot. */
export function findLearningPath(
  catalog: LearningPathCatalog,
  req: Request,
  res: Response,
): ResolvedLearningPath | null {
  const id = String(req.params.pathId ?? '');
  if (!LEARNING_PATH_ID_PATTERN.test(id)) {
    // The id is not echoed back: it is caller-chosen and has already failed validation.
    sendError(res, 400, {
      code: 'INVALID_LEARNING_PATH_ID',
      message: 'That is not a valid learning path id.',
      remediation: 'Learning path ids are lowercase slugs, e.g. devops-engineer.',
    });
    return null;
  }
  const found = catalog.get(id);
  if (!found && catalog.isRefused(id)) {
    // Defined, but refused at startup (see /health learningPathLoadErrors).
    sendError(res, 503, {
      code: 'LEARNING_PATH_UNAVAILABLE',
      message: 'This learning path is unavailable right now.',
      remediation: 'Try again later. Every lab is still available from the lab catalog.',
    });
    return null;
  }
  if (!found) {
    sendError(res, 404, {
      code: 'LEARNING_PATH_NOT_FOUND',
      message: 'No learning path has that id.',
      remediation: 'List the available learning paths with GET /api/learning-paths.',
    });
    return null;
  }
  return found;
}

/** Which labs can be started on this deployment, by provider readiness. */
export async function labStartability(sessions: SessionManager): Promise<(provider: string) => boolean> {
  const statuses = await sessions.providers.statuses();
  const available = new Set(statuses.filter((status) => status.available).map((status) => status.providerId as string));
  return (provider) => available.has(provider);
}

const sumMinutes = (labs: ResolvedLearningPath['stages'][number]['labs']) =>
  labs.reduce((sum, lab) => sum + lab.info.durationMinutes, 0);

function totalsOf(path: ResolvedLearningPath) {
  const labs = [...path.labs.values()];
  const core = labs.filter((lab) => !lab.optional);
  const gapSkills = [...path.skills.keys()].filter((skill) => path.labsForSkill(skill).length === 0);
  return {
    stages: path.stages.length,
    comingSoonStages: path.stages.filter((stage) => stage.labs.length === 0).length,
    labs: labs.length,
    coreLabs: core.length,
    skills: path.skills.size,
    gapSkills: gapSkills.length,
    /** Sum of the labs' own estimated durations — nothing else is added. */
    estimatedMinutes: { core: sumMinutes(core), all: sumMinutes(labs) },
  };
}

export function toLearningPathSummary(path: ResolvedLearningPath) {
  return {
    id: path.id,
    title: path.title,
    summary: path.summary,
    audience: path.audience,
    totals: totalsOf(path),
  };
}

export function toLearningPathDetail(
  path: ResolvedLearningPath,
  registry: LabRegistry,
  canStartProvider: (provider: string) => boolean,
) {
  const trackTitles = new Map(registry.tracks().map((track) => [track.track, track.title]));
  const stageTitle = (id: string) => path.stage(id)?.title ?? id;

  return {
    ...toLearningPathSummary(path),
    outcomes: path.outcomes,
    stages: path.stages.map((stage) => ({
      id: stage.id,
      position: stage.position,
      title: stage.title,
      summary: stage.summary,
      why: stage.why,
      objectives: stage.objectives,
      ...(stage.comingSoon ? { comingSoon: stage.comingSoon } : {}),
      prerequisites: stage.prerequisites.map((p) => ({ stageId: p.stageId, title: stageTitle(p.stageId), kind: p.kind })),
      estimatedMinutes: { core: sumMinutes(stage.labs.filter((lab) => !lab.optional)), all: sumMinutes(stage.labs) },
      skills: stage.skills.map((skillId) => {
        const skill = path.skills.get(skillId);
        const covering = path.labsForSkill(skillId);
        return {
          id: skillId,
          title: skill?.title ?? skillId,
          description: skill?.description ?? '',
          /** Every lab in the path that practises this skill, in path order. Empty means Coming soon. */
          labIds: covering.map((lab) => lab.labId),
        };
      }),
      labs: stage.labs.map((lab) => ({
        labId: lab.labId,
        title: lab.info.title,
        summary: lab.info.summary,
        track: lab.info.track,
        trackTitle: trackTitles.get(lab.info.track) ?? lab.info.track,
        difficulty: lab.info.difficulty,
        durationMinutes: lab.info.durationMinutes,
        optional: lab.optional,
        why: lab.why,
        skills: lab.skills,
        prerequisites: lab.info.prerequisites.map((id) => ({ id, title: path.labs.get(id)?.info.title ?? id })),
        // Whether it can be started here — never the provider's reason, which is operator detail.
        availability: { available: canStartProvider(lab.info.provider) },
      })),
    })),
  };
}

/**
 * The caller's progress through one path.
 *
 * `rows` are the caller's own stored per-lab statuses: COMPLETED means Verify
 * passed, IN_PROGRESS means a launch was attempted. Nothing else counts.
 */
export function toLearningPathProgressPayload(
  path: ResolvedLearningPath,
  rows: ReadonlyArray<{ labId: string; status: PathLabStatus }>,
  options: {
    canStartProvider: (provider: string) => boolean;
    activeLabIds: readonly string[] | null;
    labTitle: (labId: string) => string;
  },
) {
  const statuses = new Map(rows.map((row) => [row.labId, row.status]));
  const progress = computeLearningPathProgress({
    path,
    statusOf: (labId) => statuses.get(labId) ?? 'NOT_STARTED',
    canStart: (labId) => {
      const lab = path.labs.get(labId);
      return lab !== undefined && options.canStartProvider(lab.info.provider);
    },
    activeLabIds: options.activeLabIds,
  });
  const { recommendation } = progress;
  return {
    pathId: path.id,
    ...progress,
    recommendation: {
      ...recommendation,
      ...(recommendation.labId ? { labTitle: options.labTitle(recommendation.labId) } : {}),
    },
  };
}

/**
 * Lab ids of the caller's own occupying sessions, newest first.
 *
 * The same ownership filter as `GET /api/sessions`. Only lab ids leave this
 * function — never a session id. `null` when the session store could not be
 * read, so the next-lab rule can say it does not know rather than suggest
 * starting a second lab.
 */
export async function activeLabIdsFor(
  sessions: SessionManager,
  userId: string | undefined,
  log: (message: string) => void,
): Promise<string[] | null> {
  if (!userId) return [];
  try {
    return (await sessions.listOccupying())
      .filter((session) => session.ownerUserId !== undefined && session.ownerUserId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => session.labId);
  } catch (error) {
    log(`could not read active sessions for the learning path: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function createLearningPathRoutes(deps: LearningPathRoutesDeps): Router {
  const { learningPaths, registry, sessions } = deps;
  const router = Router();

  // GET /api/learning-paths --------------------------------------------------
  router.get('/', (_req, res) => {
    const paths = learningPaths.list().map(toLearningPathSummary);
    sendOk(res, { learningPaths: paths, count: paths.length });
  });

  // GET /api/learning-paths/:pathId -------------------------------------------
  router.get('/:pathId', asyncRoute(async (req, res) => {
    const path = findLearningPath(learningPaths, req, res);
    if (!path) return;
    sendOk(res, { learningPath: toLearningPathDetail(path, registry, await labStartability(sessions)) });
  }));

  return router;
}
