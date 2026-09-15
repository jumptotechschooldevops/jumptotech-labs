/**
 * A lab, before it runs.
 *
 * The student reads what they will do, what environment they will get and what
 * is worth knowing about it — and only then presses Launch. Launch is the one
 * primary action on the page, and the page never offers it when it cannot
 * work:
 *
 *   - this lab is already running for them       → Continue lab
 *   - another lab of theirs uses their quota      → Continue that lab
 *   - a launch is already in flight               → shown as in progress
 *   - the platform cannot run this kind of lab    → the reason, no button
 *
 * Global capacity cannot be known in advance without telling students how busy
 * everyone else is, so it is handled when the API answers — with a message that
 * says what it means and when to retry.
 */
import { useEffect, useState } from 'react';
import { useActiveSession } from '../lib/ActiveSessionContext';
import { useCatalog } from '../lib/CatalogContext';
import { api } from '../lib/api';
import { describeError, toApiError } from '../lib/errors';
import { describeProvider, trackNote } from '../lib/environmentInfo';
import { SESSION_STATUS_TEXT, formatMinutes, plural } from '../lib/format';
import { hrefFor, navigate, usePageTitle } from '../lib/router';
import type { ApiError, LabDetail } from '../lib/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { LabBrief } from '../components/LabBrief';
import { Badge, DifficultyBadge, LoadingState, PageHeader, ProgressBadge } from '../components/ui';

function LaunchPanel({ lab }: { lab: LabDetail }) {
  const sessions = useActiveSession();
  const { sessionForLab, entries, launching, launchError, limit, launch } = sessions;

  const running = sessionForLab(lab.id);
  const other = entries.find((entry) => entry.session.labId !== lab.id);
  const atLimit = !running && limit !== null && entries.length >= limit && other !== undefined;
  const unavailable = lab.availability?.available === false;
  const error = launchError?.labId === lab.id ? launchError.error : null;

  const onLaunch = () => {
    if (sessions.launching) return;
    void launch(lab.id, lab.title);
    navigate({ name: 'workspace', labId: lab.id });
  };

  let body;
  if (running) {
    body = (
      <>
        <p className="launch__status">
          <Badge tone={running.session.status === 'ACTIVE' ? 'success' : 'warning'}>
            {SESSION_STATUS_TEXT[running.session.status].label}
          </Badge>{' '}
          This lab is running for you.
        </p>
        <a className="btn btn--primary btn--lg btn--block" href={hrefFor({ name: 'workspace', labId: lab.id })}>
          Continue lab
        </a>
      </>
    );
  } else if (launching) {
    body =
      launching.labId === lab.id ? (
        <>
          <p className="launch__status" role="status">
            Preparing your lab environment…
          </p>
          <a className="btn btn--primary btn--lg btn--block" href={hrefFor({ name: 'workspace', labId: lab.id })}>
            Open workspace
          </a>
        </>
      ) : (
        <>
          <p className="launch__status" role="status">
            Another lab ({launching.labId}) is starting. Wait for it to finish before launching this one.
          </p>
          <button type="button" className="btn btn--primary btn--lg btn--block" disabled>
            Launch lab
          </button>
        </>
      );
  } else if (atLimit && other) {
    body = (
      <div className="notice notice--info">
        <h3 className="notice__title">You already have a lab running</h3>
        <p className="notice__message">
          <span className="mono-id">{other.session.labId}</span> {other.labTitle} is still running.{' '}
          {limit === 1 ? 'You can run one lab at a time.' : `You can run ${limit} labs at a time.`}
        </p>
        <p className="notice__guidance">Continue it, or end it from its workspace before launching this lab.</p>
        <div className="notice__actions">
          <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId: other.session.labId })}>
            Continue {other.session.labId}
          </a>
        </div>
      </div>
    );
  } else if (unavailable) {
    body = (
      <div className="notice notice--warning">
        <h3 className="notice__title">This lab cannot be started right now</h3>
        <p className="notice__message">
          The platform cannot create this kind of environment at the moment. You can still read the lab.
        </p>
        {lab.availability?.reason ? (
          <p className="notice__reference">Details: {lab.availability.reason}</p>
        ) : null}
      </div>
    );
  } else {
    body = (
      <>
        {error ? (
          <ErrorNotice
            error={describeError(error, 'launch')}
            headingLevel={3}
            actions={
              error.code === 'STUDENT_SESSION_LIMIT_REACHED' && entries[0] ? (
                <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId: entries[0].session.labId })}>
                  Continue {entries[0].session.labId}
                </a>
              ) : undefined
            }
          />
        ) : null}
        <button type="button" className="btn btn--primary btn--lg btn--block" onClick={onLaunch}>
          {error ? 'Try launching again' : 'Launch lab'}
        </button>
      </>
    );
  }

  return (
    <section className="panel launch" aria-labelledby="launch-heading">
      <h2 id="launch-heading" className="panel__title">
        {running ? 'Your lab' : 'Launch'}
      </h2>
      {body}
      {!running ? (
        <ul className="launch__what">
          <li>A private environment is created just for you. This can take a little while.</li>
          <li>You work in a terminal in your browser — nothing is installed on your computer.</li>
          <li>Press Verify whenever you like to check your work.</li>
          <li>End the lab when you are finished. Your progress is saved either way.</li>
        </ul>
      ) : null}
    </section>
  );
}

export function LabDetailPage({ labId }: { labId: string }) {
  const catalog = useCatalog();
  const { limit } = useActiveSession();
  const [lab, setLab] = useState<LabDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  usePageTitle(lab ? `${lab.id} ${lab.title}` : labId);

  useEffect(() => {
    let cancelled = false;
    setLab(null);
    setError(null);
    Promise.resolve()
      .then(() => api.getLab(labId))
      .then((detail) => {
        if (!cancelled) setLab(detail);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(toApiError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [labId, nonce]);

  if (error) {
    const described = describeError(error, 'load');
    return (
      <div className="page">
        <ErrorNotice
          error={described}
          live={false}
          actions={
            <>
              {described.retryable ? (
                <button type="button" className="btn btn--secondary" onClick={() => setNonce((n) => n + 1)}>
                  Try again
                </button>
              ) : null}
              <a className="btn btn--secondary" href={hrefFor({ name: 'labs' })}>
                Browse labs
              </a>
            </>
          }
        />
      </div>
    );
  }

  if (!lab) return <LoadingState label={`Loading ${labId}…`} />;

  const track = catalog.trackById(lab.track);
  const environment = describeProvider(lab.environment.provider);
  const note = trackNote(lab.track);
  const progress = catalog.progressFor(lab.id);

  return (
    <div className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <a href={hrefFor({ name: 'labs' })}>Labs</a>
          </li>
          <li>
            <a href={hrefFor({ name: 'track', trackId: lab.track })}>{track?.title ?? lab.track}</a>
          </li>
          <li aria-current="page">{lab.id}</li>
        </ol>
      </nav>

      <PageHeader eyebrow={`${lab.id} · ${track?.title ?? lab.track}`} title={lab.title} description={lab.task.summary}>
        <div className="page-header__badges">
          <DifficultyBadge difficulty={lab.difficulty} />
          <Badge>{formatMinutes(lab.durationMinutes)}</Badge>
          <Badge>{lab.topicTitle}</Badge>
          <ProgressBadge status={progress?.status} showNotStarted={catalog.progressStatus === 'ready'} />
        </div>
      </PageHeader>

      <div className="detail-layout">
        <div className="detail-layout__main">
          <LabBrief lab={lab} showHeader={false} showHints={false} />
        </div>

        <aside className="detail-layout__side" aria-label="Launch and environment">
          <LaunchPanel lab={lab} />

          <section className="panel" aria-labelledby="environment-heading">
            <h2 id="environment-heading" className="panel__title">
              Your environment
            </h2>
            <p className="panel__lead">{environment.name}</p>
            <p className="panel__text">{environment.summary}</p>
            {note ? <p className="callout callout--info">{note}</p> : null}
            {lab.hasSetup ? (
              <p className="panel__text">This lab starts with something already set up for you to investigate or build on.</p>
            ) : null}
          </section>

          <section className="panel" aria-labelledby="good-to-know-heading">
            <h2 id="good-to-know-heading" className="panel__title">
              Good to know
            </h2>
            <ul className="plain-list">
              <li>
                The environment is temporary. It is deleted when you end the lab, after a period of inactivity, or when
                its time limit is reached.
              </li>
              <li>Reset puts the environment back to its starting state. Your progress is kept.</li>
              <li>The estimated time of {formatMinutes(lab.durationMinutes)} is a guide, not a deadline.</li>
              {limit === 1 ? <li>You can run one lab at a time.</li> : null}
              {lab.hints.length > 0 ? (
                <li>{plural(lab.hints.length, 'hint is', 'hints are')} available once the lab is running.</li>
              ) : null}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
