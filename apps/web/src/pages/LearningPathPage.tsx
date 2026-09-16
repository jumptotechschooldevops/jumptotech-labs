/**
 * One learning path: its stages in order, where the student stands, and the
 * next lab.
 *
 * A compact ordered list rather than a diagram: each stage is one row with its
 * status in words, its core-lab count and, for a stage that is not ready, why.
 * The structure comes from `GET /api/learning-paths/:id`; statuses and the next
 * lab from `GET /api/me/learning-paths/:id`. If progress cannot be read the
 * path is still shown — without statuses, never with zeros.
 */
import { ErrorNotice } from '../components/ErrorNotice';
import {
  PathProgressSummary,
  ProgressRule,
  Recommendation,
  StageStatusBadge,
} from '../components/LearningPath';
import { Badge, EmptyState, LoadingState, PageHeader, ProgressBar } from '../components/ui';
import { describeError } from '../lib/errors';
import { formatMinutes, plural } from '../lib/format';
import { gapSkills, isUnknownPath, useLearningPath, useProgressLookup } from '../lib/learningPath';
import { hrefFor, usePageTitle } from '../lib/router';
import type { LearningPathDetail, LearningStage, StageProgressEntry } from '../lib/types';

export function PathNotFound({ title = 'Learning path not found' }: { title?: string }) {
  return (
    <div className="page page--narrow">
      <EmptyState
        headingLevel={1}
        title={title}
        action={
          <a className="btn btn--secondary" href={hrefFor({ name: 'paths' })}>
            See all learning paths
          </a>
        }
      >
        <p>That address does not match anything in JumpToTech Labs.</p>
      </EmptyState>
    </div>
  );
}

function StageRow({
  path,
  stage,
  progress,
  current,
}: {
  path: LearningPathDetail;
  stage: LearningStage;
  progress: StageProgressEntry | undefined;
  current: boolean;
}) {
  const gaps = gapSkills(stage);
  const waitingOn = progress?.prerequisites
    .filter((p) => p.kind === 'required' && !p.met)
    .map((p) => path.stages.find((s) => s.id === p.stageId)?.title ?? p.stageId);
  const headingId = `stage-${stage.id}`;

  return (
    <li
      className={`stage-row${progress ? ` stage-row--${progress.status.toLowerCase()}` : ''}${current ? ' stage-row--current' : ''}`}
      aria-labelledby={headingId}
    >
      <span className="stage-row__marker" aria-hidden="true">
        {stage.position}
      </span>
      <div className="stage-row__body">
        <div className="stage-row__head">
          <h3 className="stage-row__title" id={headingId}>
            <a href={hrefFor({ name: 'stage', pathId: path.id, stageId: stage.id })}>
              <span className="visually-hidden">Stage {stage.position}: </span>
              {stage.title}
            </a>
          </h3>
          <div className="stage-row__badges">
            {current ? <Badge tone="accent">You are here</Badge> : null}
            {progress ? <StageStatusBadge status={progress.status} gapCount={gaps.length} /> : null}
          </div>
        </div>
        <p className="stage-row__summary">{stage.summary}</p>
        <p className="stage-row__meta">
          {stage.labs.length === 0
            ? 'No labs yet'
            : progress
              ? `${progress.core.completed} of ${plural(progress.core.total, 'core lab')} completed · ${plural(stage.labs.length, 'lab')} in total`
              : `${plural(stage.labs.length, 'lab')} · about ${formatMinutes(stage.estimatedMinutes.core)} of core lab time`}
          {stage.labs.length > 0 && gaps.length > 0 ? ` · ${plural(gaps.length, 'skill')} coming soon` : ''}
          {waitingOn && waitingOn.length > 0 ? ` · Recommended after ${waitingOn.join(' and ')}` : ''}
        </p>
        {progress && stage.labs.length > 0 ? (
          <ProgressBar
            value={progress.core.completed}
            max={progress.core.total}
            label={`${stage.title}: ${progress.core.completed} of ${progress.core.total} core labs completed`}
            size="sm"
          />
        ) : null}
      </div>
    </li>
  );
}

export function LearningPathPage({ pathId }: { pathId: string }) {
  const { definition, progress, reloadDefinition, reloadProgress } = useLearningPath(pathId);
  const lookup = useProgressLookup(progress.data);
  const path = definition.data;

  usePageTitle(path ? `${path.title} path` : 'Learning path');

  if (definition.status === 'loading') return <LoadingState label="Loading the learning path…" />;
  if (!path) {
    if (isUnknownPath(definition.error)) return <PathNotFound />;
    return (
      <div className="page">
        <ErrorNotice
          headingLevel={1}
          error={{ ...describeError(definition.error!, 'load'), title: 'The learning path could not be loaded' }}
          actions={
            <button type="button" className="btn btn--secondary" onClick={reloadDefinition}>
              Try again
            </button>
          }
        />
      </div>
    );
  }

  const firstTime = progress.data !== null && progress.data.overall.labs.completed + progress.data.overall.labs.inProgress === 0;

  return (
    <div className="page">
      <PageHeader eyebrow="Learning path" title={`${path.title} path`} description={path.summary}>
        <p className="page-header__facts">
          {plural(path.totals.stages, 'stage')} · {plural(path.totals.labs, 'lab')} · about{' '}
          {formatMinutes(path.totals.estimatedMinutes.core)} of core lab time
        </p>
      </PageHeader>

      <div className="path-layout">
        <aside className="path-layout__side" aria-label="Your progress and next step">
          <section className="panel panel--accent" aria-labelledby="path-progress-heading">
            <h2 id="path-progress-heading" className="panel__title">
              Your progress
            </h2>
            {progress.status === 'loading' ? (
              <LoadingState label="Loading your progress…" />
            ) : progress.status === 'error' || !progress.data ? (
              <ErrorNotice
                error={describeError(progress.error!, 'progress')}
                headingLevel={3}
                live={false}
                actions={
                  <button type="button" className="btn btn--secondary btn--sm" onClick={reloadProgress}>
                    Try again
                  </button>
                }
              />
            ) : (
              <>
                <PathProgressSummary path={path} progress={progress.data} />
                <Recommendation recommendation={progress.data.recommendation} firstTime={firstTime} />
              </>
            )}
            <ProgressRule path={path} />
          </section>

          <section className="panel" aria-labelledby="path-audience-heading">
            <h2 id="path-audience-heading" className="panel__title">
              Who this path is for
            </h2>
            <p className="panel__text">{path.audience}</p>
            <h3 className="panel__subtitle">By the end you will be able to</h3>
            <ul className="plain-list">
              {path.outcomes.map((outcome) => (
                <li key={outcome}>{outcome}</li>
              ))}
            </ul>
          </section>
        </aside>

        <section className="path-layout__main" aria-labelledby="stages-heading">
          <h2 id="stages-heading" className="section-title">
            Stages, in order
          </h2>
          {progress.status === 'ready' ? null : progress.status === 'loading' ? (
            <LoadingState label="Loading your progress…" />
          ) : (
            <p className="callout callout--warning">
              Your progress could not be loaded, so stage statuses are not shown. The stages and labs below are
              still accurate.
            </p>
          )}
          <ol className="stage-list">
            {path.stages.map((stage) => (
              <StageRow
                key={stage.id}
                path={path}
                stage={stage}
                progress={lookup.stage(stage.id)}
                current={progress.data?.currentStageId === stage.id}
              />
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
