/**
 * The student dashboard.
 *
 * Two questions, answered from two different places and joined by the API:
 * "how far through each track am I?" (stored progress ÷ the live catalog) and
 * "what have I actually done?" (the attempt history). Nothing on this page is
 * derived from a running sandbox — that is the point. Every environment the
 * student ever had may be long deleted and this page reads exactly the same.
 *
 * It is also honest about what it is: the identity is a development identity,
 * and when the deployment has no database the page says the history will not
 * survive a restart rather than quietly implying it will.
 */
import { useEffect, useState } from 'react';
import { UserMenu } from '../components/UserMenu';
import { ApiRequestError, api } from '../lib/api';
import type {
  ApiError,
  AttemptStatus,
  AttemptSummary,
  ProgressSnapshot,
  TrackProgress,
} from '../lib/types';

/** Human labels for the attempt lifecycle. The status itself is never a boolean. */
const ATTEMPT_LABEL: Record<AttemptStatus, string> = {
  IN_PROGRESS: 'In progress',
  PASSED: 'Passed',
  FAILED: 'Failed to start',
  ENDED: 'Ended',
  EXPIRED: 'Expired',
};

function toApiError(error: unknown): ApiError {
  return error instanceof ApiRequestError
    ? error.error
    : { code: 'UNEXPECTED_ERROR', message: String(error) };
}

/** `2026-08-17T10:04:00Z` → `17 Aug, 10:04`. Locale-aware, never a raw ISO string. */
function formatMoment(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TrackCard({ track }: { track: TrackProgress }) {
  return (
    <article className="trackcard">
      <header className="trackcard__head">
        <h3 className="trackcard__title">{track.title}</h3>
        <span className="trackcard__count">
          <strong>{track.completed}</strong>/{track.total} completed
        </span>
      </header>

      <div
        className="meter"
        role="progressbar"
        aria-valuenow={track.completed}
        aria-valuemin={0}
        aria-valuemax={track.total}
        aria-label={`${track.title}: ${track.completed} of ${track.total} labs completed`}
      >
        <span className="meter__fill" style={{ width: `${track.percent}%` }} />
      </div>

      <p className="trackcard__meta">
        {track.inProgress > 0 ? `${track.inProgress} in progress · ` : ''}
        {track.notStarted} not started
      </p>

      <ul className="tracklabs">
        {track.labs.map((lab) => (
          <li key={lab.labId} className={`tracklabs__item tracklabs__item--${lab.status.toLowerCase()}`}>
            <span className="tracklabs__mark" aria-hidden="true">
              {lab.status === 'COMPLETED' ? '✓' : lab.status === 'IN_PROGRESS' ? '◐' : '○'}
            </span>
            <span className="tracklabs__id">{lab.labId}</span>
            <span className="tracklabs__title">{lab.title}</span>
            {lab.completionCount > 1 && (
              <span className="tracklabs__repeat" title="Completed more than once">
                ×{lab.completionCount}
              </span>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

export function ProgressPage({
  onBack,
  onOpenLab,
}: {
  onBack: () => void;
  onOpenLab: (labId: string) => void;
}) {
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [attempts, setAttempts] = useState<AttemptSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getProgress(), api.listAttempts(15)])
      .then(([snapshot, history]) => {
        if (cancelled) return;
        setProgress(snapshot);
        setAttempts(history.attempts);
      })
      .catch((err: unknown) => {
        // A dashboard that cannot read its own history says so. Showing an
        // empty one would be indistinguishable from "you have done nothing".
        if (!cancelled) setError(toApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <button type="button" className="topbar__brand" onClick={onBack}>
          <span className="topbar__logo" aria-hidden="true">◆</span>
          JumpToTech <span className="topbar__brand-light">Labs</span>
        </button>
        <div className="topbar__center" />
        <div className="topbar__right">
          <button type="button" className="btn btn--ghost topbar__link" onClick={onBack}>
            Catalog
          </button>
          <span className="topbar__track">progress</span>
          <UserMenu />
        </div>
      </header>

      <main className="catalog">
        <div className="catalog__intro">
          <h1>Your progress</h1>
          <p>
            Lab environments are disposable. What you completed in them is not — this page is
            read from your saved history, not from any running environment.
          </p>
        </div>

        {error && (
          <div className="message-card" role="alert">
            <h2>{error.code}</h2>
            <p>{error.message}</p>
            {error.remediation && <p className="message-card__hint">{error.remediation}</p>}
          </div>
        )}

        {!progress && !error && <p className="catalog__loading">Loading your progress…</p>}

        {progress && (
          <section className="progress">
            {/* Said out loud, not buried: this is not a signed-in account. */}
            <div className="progress__identity">
              <span className="progress__student">{progress.student.studentId}</span>
              <span className="chip chip--muted">development identity — no sign-in yet</span>
              {!progress.student.durable && (
                <span className="chip chip--unavailable" title="No database is configured">
                  not saved to a database
                </span>
              )}
            </div>

            <div className="progress__overall">
              <div className="progress__headline">
                <span className="progress__big">{progress.overall.completed}</span>
                <span className="progress__of">of {progress.overall.total} labs completed</span>
              </div>
              <div
                className="meter meter--lg"
                role="progressbar"
                aria-valuenow={progress.overall.completed}
                aria-valuemin={0}
                aria-valuemax={progress.overall.total}
                aria-label={`Overall: ${progress.overall.completed} of ${progress.overall.total} labs completed`}
              >
                <span className="meter__fill" style={{ width: `${progress.overall.percent}%` }} />
              </div>
              <p className="progress__meta">
                {progress.overall.percent}% complete · {progress.overall.inProgress} in progress ·{' '}
                {progress.overall.notStarted} not started
              </p>
            </div>

            <div className="progress__tracks">
              {progress.tracks.map((track) => (
                <TrackCard key={track.track} track={track} />
              ))}
            </div>

            <section className="progress__history">
              <h2 className="progress__heading">Recent lab attempts</h2>

              {attempts && attempts.length === 0 && (
                <p className="progress__empty">
                  No attempts yet. Open a lab from the catalog and your history starts here.
                </p>
              )}

              {attempts && attempts.length > 0 && (
                <ul className="attempts">
                  {attempts.map((attempt) => (
                    <li key={attempt.attemptId} className="attempts__item">
                      <button
                        type="button"
                        className="attempts__lab"
                        onClick={() => onOpenLab(attempt.labId)}
                        title={`Open ${attempt.labId}`}
                      >
                        <span className="attempts__id">{attempt.labId}</span>
                        <span className="attempts__title">{attempt.labTitle}</span>
                      </button>
                      <span
                        className={`attempts__status attempts__status--${attempt.status.toLowerCase()}`}
                      >
                        {ATTEMPT_LABEL[attempt.status]}
                      </span>
                      <span className="attempts__when">{formatMoment(attempt.startedAt)}</span>
                      <span className="attempts__counts">
                        {attempt.checkCount} check{attempt.checkCount === 1 ? '' : 's'}
                        {attempt.resetCount > 0 ? ` · ${attempt.resetCount} reset` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </section>
        )}
      </main>
    </div>
  );
}
