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
 */
import { useEffect, useState } from 'react';
import { useCatalog } from '../lib/CatalogContext';
import { api } from '../lib/api';
import { describeError, toApiError } from '../lib/errors';
import { ATTEMPT_LABEL, formatMoment, plural } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';
import type { ApiError, AttemptSummary, TrackProgress } from '../lib/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { Badge, LoadingState, PageHeader, ProgressBar } from '../components/ui';

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
