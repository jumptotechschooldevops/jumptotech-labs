/**
 * Saved progress and attempt history.
 *
 * Two questions, answered from two different places and joined by the API:
 * "how far through each track am I?" (stored progress ÷ the live catalog) and
 * "what have I actually done?" (the attempt history). Nothing on this page is
 * derived from a running sandbox — every environment the student ever had may
 * be long deleted and this page reads exactly the same.
 *
 * A lab is Completed only when the verifier passed it. Launching, resetting or
 * ending one never marks it complete; the API computes that, not this page.
 *
 * Between the overall numbers and the per-track lists sit the learning path and
 * its skills (V1 EPIC-02): where the student is on the DevOps Engineer path,
 * the next lab, and each skill as "labs that practise it, and how many passed".
 */
import { useEffect, useState } from 'react';
import { useCatalog } from '../lib/CatalogContext';
import { api } from '../lib/api';
import { describeError, toApiError } from '../lib/errors';
import { ATTEMPT_LABEL, formatMoment, plural } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';
import type { ApiError, AttemptSummary, TrackProgress } from '../lib/types';
import { ErrorNotice } from '../components/ErrorNotice';
import {
  PathProgressSummary,
  ProgressRule,
  Recommendation,
  SkillStatusText,
  StageStatusBadge,
} from '../components/LearningPath';
import { Badge, LoadingState, PageHeader, ProgressBar } from '../components/ui';
import { FLAGSHIP_PATH_ID, gapSkills, useLearningPath, useProgressLookup } from '../lib/learningPath';

function TrackProgressCard({ track }: { track: TrackProgress }) {
  return (
    <article className="progress-track" aria-labelledby={`progress-${track.track}`}>
      <header className="progress-track__head">
        <h3 className="progress-track__title" id={`progress-${track.track}`}>
          <a href={hrefFor({ name: 'track', trackId: track.track })}>{track.title}</a>
        </h3>
        <span className="progress-track__count">
          <strong>{track.completed}</strong>/{track.total} completed
        </span>
      </header>

      <ProgressBar
        value={track.completed}
        max={track.total}
        label={`${track.title}: ${track.completed} of ${track.total} labs completed`}
      />

      <p className="progress-track__meta">
        {track.inProgress > 0 ? `${track.inProgress} in progress · ` : ''}
        {track.notStarted} not started
      </p>

      <ul className="tracklabs">
        {track.labs.map((lab) => (
          <li key={lab.labId} className={`tracklabs__item tracklabs__item--${lab.status.toLowerCase()}`}>
            <span className="tracklabs__mark" aria-hidden="true">
              {lab.status === 'COMPLETED' ? '✓' : lab.status === 'IN_PROGRESS' ? '◐' : '○'}
            </span>
            <a className="tracklabs__link" href={hrefFor({ name: 'lab', labId: lab.labId })}>
              <span className="tracklabs__id">{lab.labId}</span>
              <span className="tracklabs__title">{lab.title}</span>
            </a>
            <span className="visually-hidden">
              {lab.status === 'COMPLETED' ? 'completed' : lab.status === 'IN_PROGRESS' ? 'in progress' : 'not started'}
            </span>
            {lab.completionCount > 1 ? (
              <span className="tracklabs__repeat" title="Completed more than once">
                ×{lab.completionCount}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}

function LearningPathSections() {
  const { definition, progress, reloadDefinition, reloadProgress } = useLearningPath(FLAGSHIP_PATH_ID);
  const lookup = useProgressLookup(progress.data);
  const path = definition.data;

  if (definition.status === 'loading') return <LoadingState label="Loading your learning path…" />;
  if (!path) {
    return (
      <section className="progress__path" aria-labelledby="path-section-heading">
        <h2 id="path-section-heading" className="section-title">
          Learning path
        </h2>
        <ErrorNotice
          error={{ ...describeError(definition.error!, 'load'), title: 'The learning path could not be loaded' }}
          headingLevel={3}
          live={false}
          actions={
            <button type="button" className="btn btn--secondary btn--sm" onClick={reloadDefinition}>
              Try again
            </button>
          }
        />
      </section>
    );
  }

  const data = progress.data;
  return (
    <>
      <section className="progress__path" aria-labelledby="path-section-heading">
        <div className="section-head">
          <h2 id="path-section-heading" className="section-title">
            {path.title} path
          </h2>
          <a className="text-link" href={hrefFor({ name: 'path', pathId: path.id })}>
            View path
          </a>
        </div>
        {progress.status === 'loading' ? (
          <LoadingState label="Loading your progress on this path…" />
        ) : !data ? (
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
            <div className="panel">
              <PathProgressSummary path={path} progress={data} />
              <Recommendation recommendation={data.recommendation} />
              <ProgressRule path={path} />
            </div>
            <ol className="path-progress" aria-label={`${path.title} path stages`}>
              {path.stages.map((stage) => {
                const stageProgress = lookup.stage(stage.id);
                return (
                  <li key={stage.id} className="path-progress__item">
                    <a className="path-progress__link" href={hrefFor({ name: 'stage', pathId: path.id, stageId: stage.id })}>
                      <span className="path-progress__position" aria-hidden="true">
                        {stage.position}
                      </span>
                      {stage.title}
                    </a>
                    {stageProgress ? (
                      <StageStatusBadge status={stageProgress.status} gapCount={gapSkills(stage).length} />
                    ) : null}
                    <span className="path-progress__count">
                      {stage.labs.length === 0 || !stageProgress
                        ? 'No labs yet'
                        : `${stageProgress.core.completed}/${stageProgress.core.total} core labs`}
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>

      {data ? (
        <section className="progress__skills" aria-labelledby="skills-heading">
          <h2 id="skills-heading" className="section-title">
            Skills
          </h2>
          <p className="panel__text">
            Each skill is practised in one or more labs. A skill is complete when every lab that practises it has
            passed Verify. Skills with no lab yet are shown as Coming soon.
          </p>
          <div className="skill-groups">
            {path.stages.map((stage) => (
              <section key={stage.id} className="skill-group" aria-labelledby={`skills-${stage.id}`}>
                <h3 id={`skills-${stage.id}`} className="skill-group__title">
                  <a href={hrefFor({ name: 'stage', pathId: path.id, stageId: stage.id })}>{stage.title}</a>
                </h3>
                <ul className="skill-list">
                  {stage.skills.map((skill) => {
                    const skillProgress = lookup.skill(skill.id);
                    return (
                      <li key={skill.id} className="skill-list__item">
                        <span className="skill-list__title">{skill.title}</span>
                        {skillProgress ? <SkillStatusText status={skillProgress.status} /> : null}
                        {skillProgress && skillProgress.labs.total > 0 ? (
                          <span className="skill-list__count">
                            {skillProgress.labs.completed} of {plural(skillProgress.labs.total, 'lab')}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

export function ProgressPage() {
  const catalog = useCatalog();
  const [attempts, setAttempts] = useState<AttemptSummary[] | null>(null);
  const [attemptsError, setAttemptsError] = useState<ApiError | null>(null);

  usePageTitle('Progress');

  const { reloadProgress } = catalog;
  useEffect(() => {
    reloadProgress();
  }, [reloadProgress]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.listAttempts(20))
      .then((history) => {
        if (!cancelled) setAttempts(history.attempts);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setAttemptsError(toApiError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const progress = catalog.progress;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Progress"
        title="Your progress"
        description="Lab environments are temporary. What you completed in them is not — this page is read from your saved history, not from any running environment. A lab counts as completed when Verify passes it."
      />

      {catalog.progressStatus === 'loading' ? <LoadingState label="Loading your progress…" /> : null}

      {/* A dashboard that cannot read its own history says so. Showing an empty
          one would be indistinguishable from "you have done nothing". */}
      {catalog.progressStatus === 'error' && catalog.progressError ? (
        <ErrorNotice
          error={describeError(catalog.progressError, 'progress')}
          actions={
            <button type="button" className="btn btn--secondary" onClick={catalog.reloadProgress}>
              Try again
            </button>
          }
        />
      ) : null}

      {progress ? (
        <div className="progress">
          {!progress.student.authenticated || !progress.student.durable ? (
            <div className="progress__identity">
              {!progress.student.authenticated ? (
                <Badge tone="warning" title="Nobody proved this identity">
                  Development identity — not a real sign-in
                </Badge>
              ) : null}
              {!progress.student.durable ? (
                <Badge tone="warning" title="No database is configured">
                  Not saved to a database — history is lost when the platform restarts
                </Badge>
              ) : null}
            </div>
          ) : null}

          <section className="panel" aria-labelledby="overall-progress-heading">
            <h2 id="overall-progress-heading" className="panel__title">
              Overall
            </h2>
            <p className="stat">
              <span className="stat__value">{progress.overall.completed}</span>
              <span className="stat__label">of {plural(progress.overall.total, 'lab')} completed</span>
            </p>
            <ProgressBar
              value={progress.overall.completed}
              max={progress.overall.total}
              label={`Overall: ${progress.overall.completed} of ${progress.overall.total} labs completed`}
              size="lg"
            />
            <p className="panel__meta">
              {progress.overall.percent}% complete · {progress.overall.inProgress} in progress ·{' '}
              {progress.overall.notStarted} not started
            </p>
          </section>
        </div>
      ) : null}

      <LearningPathSections />

      {progress ? (
        <div className="progress">
          <section aria-labelledby="by-track-heading">
            <h2 id="by-track-heading" className="section-title">
              By track
            </h2>
            <div className="progress__tracks">
              {progress.tracks.map((track) => (
                <TrackProgressCard key={track.track} track={track} />
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <section className="progress__history" aria-labelledby="history-heading">
        <h2 id="history-heading" className="section-title">
          Recent lab attempts
        </h2>

        {attemptsError ? (
          <ErrorNotice error={describeError(attemptsError, 'progress')} headingLevel={3} live={false} />
        ) : attempts === null ? (
          <LoadingState label="Loading your attempts…" />
        ) : attempts.length === 0 ? (
          <p className="panel__text">No attempts yet. Launch a lab from the catalog and your history starts here.</p>
        ) : (
          <ul className="attempts">
            {attempts.map((attempt) => (
              <li key={attempt.attemptId} className="attempts__item">
                <a className="attempts__lab" href={hrefFor({ name: 'lab', labId: attempt.labId })}>
                  <span className="mono-id">{attempt.labId}</span>
                  <span className="attempts__title">{attempt.labTitle}</span>
                </a>
                <Badge
                  tone={
                    attempt.status === 'PASSED'
                      ? 'success'
                      : attempt.status === 'IN_PROGRESS'
                        ? 'warning'
                        : attempt.status === 'FAILED'
                          ? 'danger'
                          : 'neutral'
                  }
                >
                  {ATTEMPT_LABEL[attempt.status]}
                </Badge>
                <span className="attempts__when">{formatMoment(attempt.startedAt)}</span>
                <span className="attempts__counts">
                  {plural(attempt.checkCount, 'check')}
                  {attempt.resetCount > 0 ? ` · ${plural(attempt.resetCount, 'reset')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
