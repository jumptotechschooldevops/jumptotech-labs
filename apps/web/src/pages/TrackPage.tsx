/**
 * One track: what it covers, its labs in order, and where the student stands.
 *
 * Built only from repository metadata. Topics are the ones the lab definitions
 * declare, in the order their first lab appears; labs are in their declared
 * `order`; prerequisites are the ones each lab names. Progress is the API's own
 * completed-of-total for this track. Nothing here is a certification claim.
 */
import { useEffect, useMemo } from 'react';
import { useActiveSession } from '../lib/ActiveSessionContext';
import { useCatalog } from '../lib/CatalogContext';
import { describeError } from '../lib/errors';
import { describeProvider, trackNote } from '../lib/environmentInfo';
import { formatMinutes, plural } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';
import { nextInTrack } from '../lib/suggest';
import type { LabSummary } from '../lib/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { LabCard } from '../components/LabCard';
import { EmptyState, LoadingState, PageHeader, ProgressBar } from '../components/ui';

export function TrackPage({ trackId }: { trackId: string }) {
  const catalog = useCatalog();
  const { sessionForLab } = useActiveSession();
  const track = catalog.trackById(trackId);

  usePageTitle(track?.title ?? 'Track');

  const { reloadProgress } = catalog;
  useEffect(() => {
    reloadProgress();
  }, [reloadProgress]);

  const labs = useMemo(() => catalog.labsInTrack(trackId), [catalog, trackId]);

  const topics = useMemo(() => {
    const groups = new Map<string, { title: string; labs: LabSummary[] }>();
    for (const lab of labs) {
      const group = groups.get(lab.topic);
      if (group) group.labs.push(lab);
      else groups.set(lab.topic, { title: lab.topicTitle, labs: [lab] });
    }
    return [...groups.entries()];
  }, [labs]);

  if (catalog.status === 'loading') return <LoadingState label="Loading track…" />;
  if (catalog.status === 'error' && catalog.error) {
    return (
      <div className="page">
        <ErrorNotice
          headingLevel={1}
          error={describeError(catalog.error, 'load')}
          actions={
            <button type="button" className="btn btn--secondary" onClick={catalog.reload}>
              Try again
            </button>
          }
        />
      </div>
    );
  }
  if (!track) {
    return (
      <div className="page">
        <EmptyState
          headingLevel={1}
          title="Track not found"
          action={
            <a className="btn btn--secondary" href={hrefFor({ name: 'tracks' })}>
              See all tracks
            </a>
          }
        >
          <p>There is no track called “{trackId}”.</p>
        </EmptyState>
      </div>
    );
  }

  const progress = catalog.progress?.tracks.find((t) => t.track === trackId);
  const next = progress ? nextInTrack(labs, catalog.progressFor) : undefined;
  const totalMinutes = labs.reduce((sum, lab) => sum + (lab.durationMinutes || 0), 0);
  const providers = [...new Set(track.providers ?? labs.map((lab) => lab.provider))];
  const note = trackNote(trackId);

  return (
    <div className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <a href={hrefFor({ name: 'tracks' })}>Tracks</a>
          </li>
          <li aria-current="page">{track.title}</li>
        </ol>
      </nav>

      <PageHeader
        eyebrow="Track"
        title={track.title}
        description={track.tagline}
        actions={
          <a className="btn btn--secondary" href={hrefFor({ name: 'labs', track: trackId })}>
            Search this track
          </a>
        }
      >
        <p className="page-header__facts">
          {plural(labs.length, 'lab')} · {plural(topics.length, 'topic')} · about {formatMinutes(totalMinutes)} of
          estimated lab time
        </p>
      </PageHeader>

      {note ? <p className="callout callout--info">{note}</p> : null}
      {track.availability?.available === false ? (
        <p className="callout callout--warning">Labs in this track cannot be started on this platform right now.</p>
      ) : null}

      <div className="track-layout">
        <div className="track-layout__main">
          {topics.map(([topic, group], index) => (
            <section key={topic} className="topic" aria-labelledby={`topic-${topic}`}>
              <h2 id={`topic-${topic}`} className="topic__title">
                <span className="topic__index" aria-hidden="true">
                  {index + 1}
                </span>
                {group.title}
              </h2>
              <div className="card-grid card-grid--list">
                {group.labs.map((lab) => (
                  <LabCard
                    key={lab.id}
                    lab={lab}
                    progress={catalog.progressFor(lab.id)?.status}
                    running={sessionForLab(lab.id) !== undefined}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <aside className="track-layout__side" aria-label="Track summary">
          <section className="panel" aria-labelledby="track-progress-heading">
            <h2 id="track-progress-heading" className="panel__title">
              Your progress
            </h2>
            {progress ? (
              <>
                <p className="stat">
                  <span className="stat__value">{progress.completed}</span>
                  <span className="stat__label">of {plural(progress.total, 'lab')} completed</span>
                </p>
                <ProgressBar
                  value={progress.completed}
                  max={progress.total}
                  label={`${track.title}: ${progress.completed} of ${progress.total} labs completed`}
                />
                {progress.inProgress > 0 ? (
                  <p className="panel__meta">{plural(progress.inProgress, 'lab')} in progress</p>
                ) : null}
                {next ? (
                  <p className="panel__text">
                    {progress.completed === 0 && progress.inProgress === 0 ? 'Start here: ' : 'Next: '}
                    <a className="text-link" href={hrefFor({ name: 'lab', labId: next.id })}>
                      {next.id} {next.title}
                    </a>
                  </p>
                ) : progress.total > 0 && progress.completed === progress.total ? (
                  <p className="panel__text">You have completed every lab in this track.</p>
                ) : null}
              </>
            ) : catalog.progressStatus === 'loading' ? (
              <LoadingState label="Loading your progress…" />
            ) : (
              <p className="panel__text">Your progress for this track could not be loaded right now.</p>
            )}
          </section>

          <section className="panel" aria-labelledby="track-env-heading">
            <h2 id="track-env-heading" className="panel__title">
              Lab environment
            </h2>
            {providers.map((provider) => (
              <p key={provider} className="panel__text">
                <strong>{describeProvider(provider).name}.</strong> {describeProvider(provider).summary}
              </p>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
