/**
 * Learning paths in the browser: loading, and small lookups the pages share.
 *
 * The path and the student's progress through it are two requests with two
 * states — the same split as the catalog and progress in `CatalogContext`. If
 * progress cannot be read, the path is still shown and nothing is shown as
 * zero. Every status and every "next lab" is computed by the API
 * (`GET /api/me/learning-paths/:pathId`); nothing here decides one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { toApiError } from './errors';
import type {
  ApiError,
  LabProgressStatus,
  LearningPathDetail,
  LearningPathLab,
  LearningPathProgress,
  LearningStage,
  SkillProgressEntry,
  StageProgressEntry,
} from './types';

/** The flagship path: the Learning Path link and the dashboard panel open it. */
export const FLAGSHIP_PATH_ID = 'devops-engineer';

export interface Loadable<T> {
  status: 'loading' | 'ready' | 'error';
  data: T | null;
  error: ApiError | null;
}

const LOADING = { status: 'loading', data: null, error: null } as const;

export function useLearningPath(pathId: string) {
  const [definition, setDefinition] = useState<Loadable<LearningPathDetail>>(LOADING);
  const [progress, setProgress] = useState<Loadable<LearningPathProgress>>(LOADING);
  const [definitionRequest, setDefinitionRequest] = useState(0);
  const [progressRequest, setProgressRequest] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDefinition(LOADING);
    Promise.resolve()
      .then(() => api.getLearningPath(pathId))
      .then((result) => {
        if (!cancelled) setDefinition({ status: 'ready', data: result.learningPath, error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setDefinition({ status: 'error', data: null, error: toApiError(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [pathId, definitionRequest]);

  useEffect(() => {
    let cancelled = false;
    setProgress(LOADING);
    Promise.resolve()
      .then(() => api.getLearningPathProgress(pathId))
      .then((result) => {
        if (!cancelled) setProgress({ status: 'ready', data: result, error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setProgress({ status: 'error', data: null, error: toApiError(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [pathId, progressRequest]);

  const reloadDefinition = useCallback(() => setDefinitionRequest((n) => n + 1), []);
  const reloadProgress = useCallback(() => setProgressRequest((n) => n + 1), []);
  return { definition, progress, reloadDefinition, reloadProgress };
}

/** A 400 or 404 for the path id: the address is wrong, not the platform. */
export function isUnknownPath(error: ApiError | null): boolean {
  return error?.code === 'LEARNING_PATH_NOT_FOUND' || error?.code === 'INVALID_LEARNING_PATH_ID';
}

export interface ProgressLookup {
  stage: (stageId: string) => StageProgressEntry | undefined;
  lab: (labId: string) => LabProgressStatus | undefined;
  skill: (skillId: string) => SkillProgressEntry | undefined;
}

export function useProgressLookup(progress: LearningPathProgress | null): ProgressLookup {
  return useMemo(() => {
    const stages = new Map(progress?.stages.map((entry) => [entry.stageId, entry]));
    const labs = new Map(progress?.labs.map((entry) => [entry.labId, entry.status]));
    const skills = new Map(progress?.skills.map((entry) => [entry.skillId, entry]));
    return {
      stage: (stageId) => stages.get(stageId),
      lab: (labId) => labs.get(labId),
      skill: (skillId) => skills.get(skillId),
    };
  }, [progress]);
}

/** Skills in a stage that no lab in the path covers yet. */
export function gapSkills(stage: LearningStage) {
  return stage.skills.filter((skill) => skill.labIds.length === 0);
}

export function findPathLab(
  path: LearningPathDetail,
  labId: string,
): { lab: LearningPathLab; stage: LearningStage } | undefined {
  for (const stage of path.stages) {
    const lab = stage.labs.find((candidate) => candidate.labId === labId);
    if (lab) return { lab, stage };
  }
  return undefined;
}
