/**
 * The student dashboard — the front door after sign-in.
 *
 * Everything on it is read from the platform, and each panel has its own
 * loading, empty and error state, so one slow or unavailable source never
 * blanks the page:
 *
 *   - the running lab        GET /api/sessions      (ActiveSessionContext)
 *   - progress per track     GET /api/me/progress   (CatalogContext)
 *   - recent attempts        GET /api/me/attempts
 *   - tracks                 GET /api/labs          (CatalogContext) + the above
 *   - learning path + next   GET /api/learning-paths/:id + GET /api/me/learning-paths/:id
 *
 * No percentage is shown that the API did not compute, and the next lab is the
 * API's deterministic learning-path rule, with its reason printed beside it.
 */
import { useEffect, useState } from 'react';
import { useActiveSession } from '../lib/ActiveSessionContext';
import { useAuth } from '../lib/AuthContext';
import { displayNameFor } from '../lib/auth';
import { useCatalog } from '../lib/CatalogContext';
import { api } from '../lib/api';
import { accessRefusal, describeError, toApiError } from '../lib/errors';
import { ATTEMPT_LABEL, formatMoment, plural, sessionStatusText } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';
import { FLAGSHIP_PATH_ID, useLearningPath } from '../lib/learningPath';
import type { ApiError, AttemptSummary, LabAccess } from '../lib/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { PathProgressSummary, Recommendation } from '../components/LearningPath';
import { Badge, LoadingState, PageHeader, ProgressBar } from '../components/ui';

/**
 * Why this signed-in account cannot use labs, before they press Start.
 *
 * Advisory: Start, Verify and the terminal each explain a refusal themselves,
 * so a read that fails here shows nothing rather than a second error panel.
 * Nothing is shown when access is active or the deployment does not require it.
 */
function AccessNotice() {
  const [access, setAccess] = useState<LabAccess | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(api.getAccess())
      .then((data) => {
        if (!cancelled && data?.access) setAccess(data.access);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (!access || access.active) return null;
  return (
    <section className="panel" aria-labelledby="access-heading">
      <h2 id="access-heading" className="visually-hidden">
        Lab access
      </h2>
      <ErrorNotice
        error={{ ...accessRefusal(access.state), reference: `ACCESS_NOT_ACTIVE · ${access.state}` }}
        headingLevel={3}
        live={false}
      />
    </section>
  );
}

function minutesLeft(expiresAt: string): number | null {
  const ms = Date.parse(expiresAt) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : null;
}

function ActiveLabPanel() {
  const { entries, launching, status, error, refresh } = useActiveSession();

  if (launching) {
    return (
      <section className="panel panel--accent" aria-labelledby="active-lab-heading">
        <h2 id="active-lab-heading" className="panel__title">
          Your lab is starting
        </h2>
        <p className="panel__text">Preparing your lab environment for {launching.labId}…</p>
        <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId: launching.labId })}>
          Open workspace
        </a>
      </section>
    );
  }

  // Only when nothing is known. A later re-read that fails (the tab came back
  // during an API blip) must not hide a running lab the student already saw —
  // the top bar keeps showing it, and Continue re-reads it anyway.
  if (status === 'error' && error && entries.length === 0) {
    return (
      <section className="panel" aria-labelledby="active-lab-heading">
        <h2 id="active-lab-heading" className="visually-hidden">
          Running lab
        </h2>
        <ErrorNotice
          error={{
            ...describeError(error, 'load'),
            title: 'We could not check whether you have a lab running',
          }}
          headingLevel={3}
          live={false}
          actions={
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void refresh()}>
              Try again
            </button>
          }
        />
      </section>
    );
  }

  const entry = entries[0];
  if (!entry) return null;

  const { session } = entry;
  const left = session.status === 'ACTIVE' ? minutesLeft(session.expiresAt) : null;
  return (
    <section className="panel panel--accent" aria-labelledby="active-lab-heading">
      <div className="panel__head">
        <h2 id="active-lab-heading" className="panel__title">
          You have a lab running
        </h2>
        <Badge tone={session.status === 'ACTIVE' ? 'success' : 'warning'}>
          {sessionStatusText(session.status).label}
        </Badge>
      </div>
      <p className="panel__lead">
        <span className="mono-id">{session.labId}</span> {entry.labTitle}
      </p>
      <p className="panel__text">
        {sessionStatusText(session.status).description}
        {left !== null ? ` About ${plural(left, 'minute')} left before it is removed.` : ''}
      </p>
      <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId: session.labId })}>
        Continue lab
      </a>
    </section>
  );
}

function FirstSteps() {
  return (
    <section className="panel" aria-labelledby="first-steps-heading">
      <h2 id="first-steps-heading" className="panel__title">
        How a lab works
      </h2>
      <ol className="steps-list">
        <li>
          <strong>Choose a lab.</strong> Each lab page says what you will do and what environment you will get.
        </li>
        <li>
          <strong>Launch it.</strong> A temporary environment is created just for you. Nothing is installed on
          your computer.
        </li>
        <li>
          <strong>Work in the terminal, then press Verify.</strong> Verify checks the real state of your
          environment and tells you what is still missing.
        </li>
        <li>
          <strong>End the lab when you are done.</strong> The environment is deleted; your progress is saved.
        </li>
      </ol>
      <a className="text-link" href={hrefFor({ name: 'help' })}>
        More about how labs work
      </a>
    </section>
  );
}

/**
 * The student's place on the flagship learning path, and the next lab.
 *
 * Replaces the old "Next up" rule: one answer to "what should I do next?",
 * computed by the API from verified progress. A running lab is already offered
 * by the panel above, so this panel explains rather than repeating the button.
 */
function LearningPathPanel() {
  const { definition, progress, reloadDefinition, reloadProgress } = useLearningPath(FLAGSHIP_PATH_ID);
  const path = definition.data;
  const firstTime =
    progress.data !== null && progress.data.overall.labs.completed + progress.data.overall.labs.inProgress === 0;

  return (
    <section className="panel" aria-labelledby="path-heading">
      <div className="panel__head">
        <h2 id="path-heading" className="panel__title">
          {path ? `${path.title} path` : 'Your learning path'}
        </h2>
        {path ? (
          <a className="text-link" href={hrefFor({ name: 'path', pathId: path.id })}>
            View path
          </a>
        ) : null}
      </div>
      {definition.status === 'loading' ? (
        <LoadingState label="Loading your learning path…" />
      ) : !path ? (
        <ErrorNotice
          error={{ ...describeError(definition.error!, 'load'), title: 'We could not load your learning path' }}
          headingLevel={3}
          live={false}
          actions={
            <button type="button" className="btn btn--secondary btn--sm" onClick={reloadDefinition}>
              Try again
            </button>
          }
        />
      ) : progress.status === 'loading' ? (
        <LoadingState label="Loading your progress on this path…" />
      ) : !progress.data ? (
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
          <p className="panel__text">
            {firstTime ? 'Start your DevOps journey' : 'Continue your DevOps journey'} — one stage at a time, each
            building on the last.
          </p>
          <PathProgressSummary path={path} progress={progress.data} />
          <Recommendation recommendation={progress.data.recommendation} firstTime={firstTime} showResumeAction={false} />
        </>
      )}
    </section>
  );
}

export function DashboardPage() {
  const auth = useAuth();
  const catalog = useCatalog();

  const [attempts, setAttempts] = useState<AttemptSummary[] | null>(null);
  const [attemptsError, setAttemptsError] = useState<ApiError | null>(null);
  const [attemptsNonce, setAttemptsNonce] = useState(0);

  usePageTitle('Dashboard');

  const { reloadProgress } = catalog;
  useEffect(() => {
    reloadProgress();
  }, [reloadProgress]);

  useEffect(() => {
    let cancelled = false;
    setAttemptsError(null);
    Promise.resolve()
      .then(() => api.listAttempts(5))
      .then((result) => {
        if (!cancelled) setAttempts(result.attempts);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setAttemptsError(toApiError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [attemptsNonce]);

  const name = auth.identity ? displayNameFor(auth.identity) : null;
  const firstTime = attempts !== null && attempts.length === 0;
  // "back" only once the history says so: until it loads, a first-time student
  // was greeted as a returning one.
  const returning = attempts !== null && attempts.length > 0;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Dashboard"
        title={name ? `Welcome${returning ? ' back' : ''}, ${name}` : 'Welcome'}
        description="Hands-on DevOps practice in real, temporary environments — checked against what you actually built."
      />

      <div className="dashboard">
        <div className="dashboard__main">
          <AccessNotice />

          <ActiveLabPanel />

          {firstTime ? <FirstSteps /> : null}

          <LearningPathPanel />

          <section className="panel" aria-labelledby="recent-heading">
            <div className="panel__head">
              <h2 id="recent-heading" className="panel__title">
                Recent activity
              </h2>
              <a className="text-link" href={hrefFor({ name: 'progress' })}>
                All progress
              </a>
            </div>
            {attemptsError ? (
              <ErrorNotice
                error={describeError(attemptsError, 'progress')}
                headingLevel={3}
                live={false}
                actions={
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setAttemptsNonce((n) => n + 1)}>
                    Try again
                  </button>
                }
              />
            ) : attempts === null ? (
              <LoadingState label="Loading your recent labs…" />
            ) : attempts.length === 0 ? (
              <p className="panel__text">No lab attempts yet. Your history starts the first time you launch a lab.</p>
            ) : (
              <ul className="activity">
                {attempts.map((attempt) => (
                  <li key={attempt.attemptId} className="activity__item">
                    <a className="activity__lab" href={hrefFor({ name: 'lab', labId: attempt.labId })}>
                      <span className="mono-id">{attempt.labId}</span>
                      <span className="activity__title">{attempt.labTitle}</span>
                    </a>
                    <Badge tone={attempt.status === 'PASSED' ? 'success' : attempt.status === 'IN_PROGRESS' ? 'warning' : 'neutral'}>
                      {ATTEMPT_LABEL[attempt.status]}
                    </Badge>
                    <span className="activity__when">{formatMoment(attempt.startedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="dashboard__side" aria-label="Progress summary">
          <section className="panel" aria-labelledby="overall-heading">
            <h2 id="overall-heading" className="panel__title">
              Your progress
            </h2>
            {catalog.progressStatus === 'loading' ? (
              <LoadingState label="Loading your progress…" />
            ) : catalog.progressStatus === 'error' && catalog.progressError ? (
              <ErrorNotice
                error={describeError(catalog.progressError, 'progress')}
                headingLevel={3}
                live={false}
                actions={
                  <button type="button" className="btn btn--secondary btn--sm" onClick={catalog.reloadProgress}>
                    Try again
                  </button>
                }
              />
            ) : catalog.progress ? (
              <>
                <p className="stat">
                  <span className="stat__value">{catalog.progress.overall.completed}</span>
                  <span className="stat__label">of {plural(catalog.progress.overall.total, 'lab')} completed</span>
                </p>
                <ProgressBar
                  value={catalog.progress.overall.completed}
                  max={catalog.progress.overall.total}
                  label={`${catalog.progress.overall.completed} of ${catalog.progress.overall.total} labs completed`}
                  size="lg"
                />
                <p className="panel__meta">
                  {catalog.progress.overall.inProgress > 0
                    ? `${plural(catalog.progress.overall.inProgress, 'lab')} in progress`
                    : 'Nothing in progress'}
                </p>
              </>
            ) : null}
          </section>

          <section className="panel" aria-labelledby="tracks-heading">
            <div className="panel__head">
              <h2 id="tracks-heading" className="panel__title">
                Tracks
              </h2>
              <a className="text-link" href={hrefFor({ name: 'tracks' })}>
                All tracks
              </a>
            </div>
            {catalog.status === 'loading' ? (
              <LoadingState label="Loading tracks…" />
            ) : catalog.status === 'error' && catalog.error ? (
              <ErrorNotice
                error={describeError(catalog.error, 'load')}
                headingLevel={3}
                live={false}
                actions={
                  <button type="button" className="btn btn--secondary btn--sm" onClick={catalog.reload}>
                    Try again
                  </button>
                }
              />
            ) : (
              <ul className="track-mini">
                {catalog.tracks.map((track) => {
                  const progress = catalog.progress?.tracks.find((t) => t.track === track.track);
                  return (
                    <li key={track.track} className="track-mini__item">
                      <a className="track-mini__link" href={hrefFor({ name: 'track', trackId: track.track })}>
                        <span className="track-mini__title">{track.title}</span>
                        <span className="track-mini__count">
                          {progress ? `${progress.completed}/${progress.total}` : plural(track.labCount, 'lab')}
                        </span>
                      </a>
                      {progress ? (
                        <ProgressBar
                          value={progress.completed}
                          max={progress.total}
                          label={`${track.title}: ${progress.completed} of ${progress.total} labs completed`}
                          size="sm"
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
