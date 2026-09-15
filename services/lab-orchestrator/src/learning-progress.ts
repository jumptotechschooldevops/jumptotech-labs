/**
 * Where a student stands on a learning path, and what they should do next.
 *
 * Pure functions of four inputs, so every rule is testable without a server:
 *
 *   - the path (`learning-paths.ts`);
 *   - each lab's verified status — `COMPLETED` only when Verify passed;
 *   - whether each lab can be started on this deployment right now;
 *   - the lab ids of the student's own running sessions (or `null` when they
 *     could not be read).
 *
 * Nothing here invents progress. A stage with no labs is COMING_SOON and is
 * never counted as done; a skill no lab covers is COMING_SOON and never
 * completed; totals include only labs that exist.
 *
 * ## Stage status
 *
 * ```text
 *   no labs in the stage                           COMING_SOON
 *   every core lab verified                        COMPLETED
 *   any lab attempted or verified                  IN_PROGRESS
 *   a required prerequisite stage not satisfied    LOCKED   (advice — labs still open)
 *   otherwise                                      NOT_STARTED
 * ```
 *
 * A prerequisite stage is satisfied when it is COMPLETED or COMING_SOON — a gap
 * in the curriculum can never hold a student back.
 *
 * ## Next lab (deterministic)
 *
 *   1. A running lab comes first: one lab at a time.
 *   2. Stages whose core labs are not all verified are considered in this order:
 *      a. stages the student has already started, in path order;
 *      b. stages whose required prerequisites are satisfied and that come after
 *         the last stage with a verified lab;
 *      c. every other stage whose required prerequisites are satisfied.
 *      In the first of those with something startable: an attempted core lab,
 *      else the first unverified core lab — or, if that lab's own prerequisite
 *      is not verified yet, that prerequisite.
 *   3. With every core lab verified: extra-practice labs, in path order.
 *   4. Otherwise: the path is complete, or nothing left can be started now.
 */
import type { PrerequisiteKind, ResolvedLearningPath, ResolvedPathLab, ResolvedStage } from './learning-paths.js';

export type PathLabStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export type StageStatus = 'COMING_SOON' | 'LOCKED' | 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export type SkillStatus = 'COMING_SOON' | 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

export type RecommendationKind =
  | 'RESUME_ACTIVE'
  | 'ACTIVE_SESSION_UNKNOWN'
  | 'CONTINUE_ATTEMPT'
  | 'PREREQUISITE_FIRST'
  | 'START_STAGE'
  | 'NEXT_IN_STAGE'
  | 'EXTRA_PRACTICE'
  | 'PATH_COMPLETE'
  | 'NONE_AVAILABLE';

export interface Recommendation {
  kind: RecommendationKind;
  labId?: string;
  stageId?: string;
  /** Why, in words a student reads. */
  reason: string;
}

export interface LearningProgressInput {
  path: ResolvedLearningPath;
  statusOf: (labId: string) => PathLabStatus;
  canStart: (labId: string) => boolean;
  /** The student's occupying sessions, newest first; `null` when unknown. */
  activeLabIds: readonly string[] | null;
}

export interface StageProgress {
  stageId: string;
  status: StageStatus;
  /** Every required prerequisite stage is satisfied. */
  prerequisitesMet: boolean;
  prerequisites: Array<{ stageId: string; kind: PrerequisiteKind; met: boolean }>;
  labs: { total: number; completed: number; inProgress: number };
  core: { total: number; completed: number };
  /** The lab this stage would continue with, ignoring platform availability. */
  nextLabId: string | null;
}

export interface SkillProgress {
  skillId: string;
  status: SkillStatus;
  labs: { total: number; completed: number };
}

export interface LearningPathProgress {
  overall: {
    /** Labs placed in the path. Curriculum gaps are not labs and are not counted. */
    labs: { total: number; completed: number; inProgress: number; notStarted: number };
    core: { total: number; completed: number };
    stages: { total: number; completed: number; comingSoon: number };
    skills: { total: number; completed: number; comingSoon: number };
  };
  /** The stage the next core lab comes from; null once every core lab is verified. */
  currentStageId: string | null;
  stages: StageProgress[];
  skills: SkillProgress[];
  labs: Array<{ labId: string; status: PathLabStatus }>;
  recommendation: Recommendation;
}

interface Pick {
  lab: ResolvedPathLab;
  attempted: boolean;
  /** Set when `lab` was chosen because this lab needs it first. */
  target?: ResolvedPathLab;
}

const satisfies = (status: StageStatus) => status === 'COMPLETED' || status === 'COMING_SOON';

export function computeLearningPathProgress(input: LearningProgressInput): LearningPathProgress {
  const { path, canStart } = input;
  const status = (labId: string): PathLabStatus => input.statusOf(labId);

  /** The first unverified lab on the way to `labId`, following lab.yaml prerequisites. */
  const firstReady = (labId: string, seen = new Set<string>()): string => {
    if (seen.has(labId)) return labId;
    seen.add(labId);
    const lab = path.labs.get(labId);
    for (const prerequisite of lab?.info.prerequisites ?? []) {
      if (!path.labs.has(prerequisite) || status(prerequisite) === 'COMPLETED') continue;
      return firstReady(prerequisite, seen);
    }
    return labId;
  };

  const pickInStage = (stage: ResolvedStage, optional: boolean, requireStartable: boolean): Pick | null => {
    const pool = stage.labs.filter((lab) => lab.optional === optional);
    const startable = (lab: ResolvedPathLab) => !requireStartable || canStart(lab.labId);
    const attempted = pool.find((lab) => status(lab.labId) === 'IN_PROGRESS' && startable(lab));
    if (attempted) return { lab: attempted, attempted: true };
    for (const lab of pool) {
      if (status(lab.labId) !== 'NOT_STARTED') continue;
      const ready = path.labs.get(firstReady(lab.labId));
      if (!ready || !startable(ready)) continue;
      return ready.labId === lab.labId
        ? { lab, attempted: false }
        : { lab: ready, attempted: status(ready.labId) === 'IN_PROGRESS', target: lab };
    }
    return null;
  };

  // --- stages --------------------------------------------------------------
  const byStage = new Map<string, StageProgress>();
  const stages: StageProgress[] = path.stages.map((stage) => {
    const completed = stage.labs.filter((lab) => status(lab.labId) === 'COMPLETED').length;
    const inProgress = stage.labs.filter((lab) => status(lab.labId) === 'IN_PROGRESS').length;
    const core = stage.labs.filter((lab) => !lab.optional);
    const coreCompleted = core.filter((lab) => status(lab.labId) === 'COMPLETED').length;
    const prerequisites = stage.prerequisites.map((prerequisite) => {
      const prior = byStage.get(prerequisite.stageId);
      return { stageId: prerequisite.stageId, kind: prerequisite.kind, met: prior ? satisfies(prior.status) : true };
    });
    const prerequisitesMet = prerequisites.every((p) => p.kind !== 'required' || p.met);

    let stageStatus: StageStatus;
    if (stage.labs.length === 0) stageStatus = 'COMING_SOON';
    else if (coreCompleted === core.length) stageStatus = 'COMPLETED';
    else if (completed + inProgress > 0) stageStatus = 'IN_PROGRESS';
    else if (!prerequisitesMet) stageStatus = 'LOCKED';
    else stageStatus = 'NOT_STARTED';

    const next = pickInStage(stage, false, false) ?? pickInStage(stage, true, false);
    const progress: StageProgress = {
      stageId: stage.id,
      status: stageStatus,
      prerequisitesMet,
      prerequisites,
      labs: { total: stage.labs.length, completed, inProgress },
      core: { total: core.length, completed: coreCompleted },
      nextLabId: next?.lab.labId ?? null,
    };
    byStage.set(stage.id, progress);
    return progress;
  });
  const stageOf = (stage: ResolvedStage) => byStage.get(stage.id)!;

  // --- skills --------------------------------------------------------------
  const skills: SkillProgress[] = [...path.skills.keys()].map((skillId) => {
    const covering = path.labsForSkill(skillId);
    const completed = covering.filter((lab) => status(lab.labId) === 'COMPLETED').length;
    const touched = covering.some((lab) => status(lab.labId) !== 'NOT_STARTED');
    const skillStatus: SkillStatus =
      covering.length === 0
        ? 'COMING_SOON'
        : completed === covering.length
          ? 'COMPLETED'
          : touched
            ? 'IN_PROGRESS'
            : 'NOT_STARTED';
    return { skillId, status: skillStatus, labs: { total: covering.length, completed } };
  });

  // --- next lab ------------------------------------------------------------
  const withLabs = path.stages.filter((stage) => stage.labs.length > 0);
  const incomplete = withLabs.filter((stage) => stageOf(stage).status !== 'COMPLETED');
  const started = (stage: ResolvedStage) => {
    const counts = stageOf(stage).labs;
    return counts.completed + counts.inProgress > 0;
  };
  const lastVerified = path.stages.reduce(
    (last, stage, index) => (stageOf(stage).labs.completed > 0 ? index : last),
    -1,
  );
  const eligible = incomplete.filter((stage) => stageOf(stage).prerequisitesMet);
  const order = [
    ...new Set([
      ...incomplete.filter(started),
      ...eligible.filter((stage) => path.stages.indexOf(stage) > lastVerified),
      ...eligible,
    ]),
  ];

  const nextStageAfter = (stage: ResolvedStage) =>
    withLabs.find((candidate) => candidate.position > stage.position);
  const anyActivity = path.stages.some(started);

  let currentStageId: string | null = order[0]?.id ?? null;
  let recommendation: Recommendation | null = null;

  for (const stage of order) {
    const pick = pickInStage(stage, false, true);
    if (!pick) continue;
    currentStageId = stage.id;
    const base = { labId: pick.lab.labId, stageId: pick.lab.stageId };
    if (pick.target) {
      recommendation = {
        kind: 'PREREQUISITE_FIRST',
        ...base,
        reason: `${pick.lab.labId} comes before ${pick.target.labId} (${pick.target.info.title}), the next lab in ${stage.title}.`,
      };
    } else if (pick.attempted) {
      recommendation = {
        kind: 'CONTINUE_ATTEMPT',
        ...base,
        reason: 'You started this lab and have not passed Verify yet.',
      };
    } else if (started(stage)) {
      const following = nextStageAfter(stage);
      recommendation = {
        kind: 'NEXT_IN_STAGE',
        ...base,
        reason: following
          ? `Next in ${stage.title}. Finish the ${stage.title} stage before starting ${following.title}.`
          : `Next in ${stage.title}.`,
      };
    } else {
      recommendation = {
        kind: 'START_STAGE',
        ...base,
        reason:
          !anyActivity && stage === withLabs[0]
            ? `Start here. ${stage.title} is the first stage of the ${path.title} path.`
            : `${stage.title} is the next stage of the ${path.title} path.`,
      };
    }
    break;
  }

  if (!recommendation) {
    const coreDone = incomplete.length === 0;
    if (coreDone) {
      currentStageId = null;
      for (const stage of withLabs) {
        const pick = pickInStage(stage, true, true);
        if (!pick) continue;
        recommendation = {
          kind: 'EXTRA_PRACTICE',
          labId: pick.lab.labId,
          stageId: pick.lab.stageId,
          reason: `You have verified the core labs of every available stage. This extra-practice lab goes further in ${stage.title}.`,
        };
        break;
      }
    }
    if (!recommendation) {
      const everything = [...path.labs.keys()].every((labId) => status(labId) === 'COMPLETED');
      recommendation =
        everything && path.labs.size > 0
          ? {
              kind: 'PATH_COMPLETE',
              reason: `You have completed every lab currently available in the ${path.title} path. Stages marked Coming soon will open as labs are added.`,
            }
          : {
              kind: 'NONE_AVAILABLE',
              reason: 'None of the next labs in this path can be started on this platform right now.',
            };
    }
  }

  if (input.activeLabIds === null) {
    recommendation = {
      kind: 'ACTIVE_SESSION_UNKNOWN',
      reason: 'We could not check whether you already have a lab running, so no next lab is suggested right now.',
    };
  } else if (input.activeLabIds.length > 0) {
    const labId = input.activeLabIds[0]!;
    const placed = path.labs.get(labId);
    recommendation = {
      kind: 'RESUME_ACTIVE',
      labId,
      ...(placed ? { stageId: placed.stageId } : {}),
      reason: 'You have a lab running. Continue it, or end it, before starting another — you can run one lab at a time.',
    };
  }

  // --- totals --------------------------------------------------------------
  const allLabs = [...path.labs.values()];
  const completedLabs = allLabs.filter((lab) => status(lab.labId) === 'COMPLETED').length;
  const inProgressLabs = allLabs.filter((lab) => status(lab.labId) === 'IN_PROGRESS').length;
  const coreLabs = allLabs.filter((lab) => !lab.optional);

  return {
    overall: {
      labs: {
        total: allLabs.length,
        completed: completedLabs,
        inProgress: inProgressLabs,
        notStarted: allLabs.length - completedLabs - inProgressLabs,
      },
      core: {
        total: coreLabs.length,
        completed: coreLabs.filter((lab) => status(lab.labId) === 'COMPLETED').length,
      },
      stages: {
        total: stages.length,
        completed: stages.filter((stage) => stage.status === 'COMPLETED').length,
        comingSoon: stages.filter((stage) => stage.status === 'COMING_SOON').length,
      },
      skills: {
        total: skills.length,
        completed: skills.filter((skill) => skill.status === 'COMPLETED').length,
        comingSoon: skills.filter((skill) => skill.status === 'COMING_SOON').length,
      },
    },
    currentStageId,
    stages,
    skills,
    labs: allLabs.map((lab) => ({ labId: lab.labId, status: status(lab.labId) })),
    recommendation,
  };
}
