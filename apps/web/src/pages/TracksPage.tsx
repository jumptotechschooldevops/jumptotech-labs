/**
 * Every learning track, in the order the platform declares.
 *
 * Titles, taglines and order come from `labs/<track>/track.yaml` via the API;
 * counts and topics from the lab definitions; completion from saved progress.
 * A track with no progress data shows its size, never a zero it did not measure.
 */
import { useCatalog } from '../lib/CatalogContext';
import { describeError } from '../lib/errors';
import { byDifficulty, difficultyLabel, plural } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';
import { trackNote } from '../lib/environmentInfo';
import { ErrorNotice } from '../components/ErrorNotice';
import { EmptyState, LoadingState, PageHeader, ProgressBar } from '../components/ui';

export function TracksPage() {
  const catalog = useCatalog();
  usePageTitle('Tracks');

  return (
    <div className="page">
      <PageHeader
        eyebrow="Tracks"
        title="Learning tracks"
        description="Each track is an ordered set of labs on one technology. Start at the top of a track and work down, or jump to any lab."
      />

      {catalog.status === 'loading' ? <LoadingState label="Loading tracks…" /> : null}
      {catalog.status === 'error' && catalog.error ? (
        <ErrorNotice
          error={describeError(catalog.error, 'load')}
          actions={
            <button type="button" className="btn btn--secondary" onClick={catalog.reload}>
              Try again
            </button>
          }
        />
      ) : null}
      {catalog.status === 'ready' && catalog.tracks.length === 0 ? (
        <EmptyState title="No tracks are available yet" />
      ) : null}

      {catalog.status === 'ready' && catalog.tracks.length > 0 ? (
        <ul className="track-grid">
          {catalog.tracks.map((track) => {
            const progress = catalog.progress?.tracks.find((t) => t.track === track.track);
            const difficulties = [...track.difficulties].sort(byDifficulty);
            const note = trackNote(track.track);
            return (
              <li key={track.track}>
                <article className="trackcard" aria-labelledby={`trackcard-${track.track}`}>
                  <h2 className="trackcard__title" id={`trackcard-${track.track}`}>
                    <a href={hrefFor({ name: 'track', trackId: track.track })}>{track.title}</a>
                  </h2>
                  {track.tagline ? <p className="trackcard__tagline">{track.tagline}</p> : null}
                  <p className="trackcard__facts">
                    {plural(track.labCount, 'lab')}
                    {track.topics.length > 0 ? ` · ${plural(track.topics.length, 'topic')}` : ''}
                    {difficulties.length > 0
                      ? ` · ${difficulties.map(difficultyLabel).join(', ')}`
                      : ''}
                  </p>
                  {note ? <p className="trackcard__note">{note}</p> : null}
                  {track.availability?.available === false ? (
                    <p className="trackcard__note trackcard__note--warning">
                      Cannot be started on this platform right now.
                    </p>
                  ) : null}
                  {progress ? (
                    <div className="trackcard__progress">
                      <span className="trackcard__progress-label">
                        {progress.completed} of {progress.total} completed
                      </span>
                      <ProgressBar
                        value={progress.completed}
                        max={progress.total}
                        label={`${track.title}: ${progress.completed} of ${progress.total} labs completed`}
                        size="sm"
                      />
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
