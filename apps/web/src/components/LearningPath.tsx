/**
 * The learning-path vocabulary shared by the path page, the stage page, the
 * dashboard and the progress page: stage status, skill status, and the
 * server's next-lab recommendation.
 *
 * Every status is shown as words with a mark beside it — never a colour alone —
 * and every mark is hidden from screen readers because the words already say it.
 */
import { formatMinutes, plural } from '../lib/format';
import { hrefFor } from '../lib/router';
import type {
  LearningPathDetail,
  LearningPathProgress,
  LearningRecommendation,
  SkillStatus,
  StageStatus,
} from '../lib/types';
import { Badge, ProgressBar, type Tone } from './ui';

const STAGE_STATUS: Record<StageStatus, { label: string; tone: Tone; mark: string }> = {
  COMPLETED: { label: 'Completed', tone: 'success', mark: '✓' },
  IN_PROGRESS: { label: 'In progress', tone: 'warning', mark: '◐' },
  NOT_STARTED: { label: 'Not started', tone: 'neutral', mark: '○' },
  LOCKED: { label: 'Earlier stage first', tone: 'info', mark: '◇' },
  COMING_SOON: { label: 'Coming soon', tone: 'neutral', mark: '…' },
};

/**
 * A stage whose labs are all verified but which still has curriculum gaps is
 * not called "Completed": the student finished what exists, not the stage.
 */
export function stageStatusLabel(status: StageStatus, gapCount = 0): string {
  if (status === 'COMPLETED' && gapCount > 0) return 'Available labs completed';
  return STAGE_STATUS[status].label;
}

export function StageStatusBadge({ status, gapCount = 0 }: { status: StageStatus; gapCount?: number }) {
  const { tone, mark } = STAGE_STATUS[status];
  return (
    <Badge tone={tone}>
      <span aria-hidden="true">{mark} </span>
      {stageStatusLabel(status, gapCount)}
    </Badge>
  );
}

export const SKILL_STATUS_LABEL: Record<SkillStatus, string> = {
  COMPLETED: 'All labs completed',
  IN_PROGRESS: 'In progress',
  NOT_STARTED: 'Not started',
  COMING_SOON: 'Coming soon',
};

const SKILL_MARK: Record<SkillStatus, string> = { COMPLETED: '✓', IN_PROGRESS: '◐', NOT_STARTED: '○', COMING_SOON: '…' };

export function SkillStatusText({ status }: { status: SkillStatus }) {
  return (
    <span className={`skill-status skill-status--${status.toLowerCase()}`}>
      <span aria-hidden="true">{SKILL_MARK[status]} </span>
      {SKILL_STATUS_LABEL[status]}
    </span>
  );
}

const LAB_KINDS = new Set(['CONTINUE_ATTEMPT', 'PREREQUISITE_FIRST', 'START_STAGE', 'NEXT_IN_STAGE', 'EXTRA_PRACTICE']);

/** Whether a recommendation points at a lab to open next (not a running lab, not "nothing left"). */
export function recommendsLab(recommendation: LearningRecommendation): boolean {
  return Boolean(recommendation.labId) && LAB_KINDS.has(recommendation.kind);
}

/**
 * "What should I do next?" — the API's answer and its reason.
 *
 * `showResumeAction` is off on the dashboard, where the running-lab panel above
 * already offers Continue lab.
 */
export function Recommendation({
  recommendation,
  firstTime = false,
  showResumeAction = true,
}: {
  recommendation: LearningRecommendation;
  firstTime?: boolean;
  showResumeAction?: boolean;
}) {
  const { kind, labId, labTitle, reason } = recommendation;
  const heading =
    kind === 'RESUME_ACTIVE' ? 'Your running lab' : LAB_KINDS.has(kind) ? 'Next recommended lab' : 'What next';

  return (
    <div className="recommendation">
      <h3 className="recommendation__heading">{heading}</h3>
      {labId ? (
        <p className="panel__lead">
          <span className="mono-id">{labId}</span> {labTitle ?? ''}
        </p>
      ) : null}
      <p className="recommendation__reason">{reason}</p>
      {labId && LAB_KINDS.has(kind) ? (
        <a className="btn btn--primary" href={hrefFor({ name: 'lab', labId })}>
          {firstTime ? 'Start learning' : 'Continue learning'}
          <span className="visually-hidden">: {labId}</span>
        </a>
      ) : null}
      {labId && kind === 'RESUME_ACTIVE' && showResumeAction ? (
        <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId })}>
          Continue lab
          <span className="visually-hidden">: {labId}</span>
        </a>
      ) : null}
    </div>
  );
}

/** Overall verified progress through a path, and what is — and is not — counted. */
export function PathProgressSummary({
  path,
  progress,
}: {
  path: LearningPathDetail;
  progress: LearningPathProgress;
}) {
  const { labs, core } = progress.overall;
  const current = path.stages.find((stage) => stage.id === progress.currentStageId);
  return (
    <>
      <p className="stat">
        <span className="stat__value">{labs.completed}</span>
        <span className="stat__label">of {plural(labs.total, 'lab')} in this path completed</span>
      </p>
      <ProgressBar
        value={labs.completed}
        max={labs.total}
        label={`${path.title} path: ${labs.completed} of ${labs.total} labs completed`}
        size="lg"
      />
      <p className="panel__meta">
        Core labs: {core.completed} of {core.total}
        {current ? (
          <>
            {' · '}Current stage:{' '}
            <a className="text-link" href={hrefFor({ name: 'stage', pathId: path.id, stageId: current.id })}>
              {current.title}
            </a>{' '}
            ({current.position} of {path.stages.length})
          </>
        ) : null}
      </p>
    </>
  );
}

/** One sentence on how the numbers are made, shown wherever they are. */
export function ProgressRule({ path }: { path: LearningPathDetail }) {
  return (
    <p className="panel__meta">
      A lab counts only when Verify passed it. {plural(path.totals.comingSoonStages, 'stage')} and{' '}
      {plural(path.totals.gapSkills, 'skill')} with no labs yet are shown as Coming soon and never counted. Core lab
      time is about {formatMinutes(path.totals.estimatedMinutes.core)}.
    </p>
  );
}
