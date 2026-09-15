/**
 * The lab catalog — every lab, searchable.
 *
 * Entirely driven by the API: tracks, difficulties and cards are derived from
 * lab definitions on disk. There is no hardcoded lab, no hardcoded track and no
 * switch on a lab id or a track name — a new `lab.yaml` appears here after an
 * API restart, and a new track appears as a new section and a new option.
 *
 * With ~114 labs a wall of chips stops working, so the page is a search box and
 * three filters, and the filters live in the URL: Back returns to the same
 * results, and a link can point at "the beginner Linux labs".
 *
 * Filtering is client-side over the already-loaded catalog. It is a few
 * kilobytes of metadata that never touches a cluster; a request per keystroke
 * would add latency and gain nothing.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useActiveSession } from '../lib/ActiveSessionContext';
import { useCatalog } from '../lib/CatalogContext';
import { describeError } from '../lib/errors';
import { PROGRESS_LABEL, byDifficulty, difficultyLabel, plural } from '../lib/format';
import { hrefFor, replaceRoute, usePageTitle, type CatalogFilters } from '../lib/router';
import { trackNote } from '../lib/environmentInfo';
import type { LabProgressStatus, LabSummary } from '../lib/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { LabCard } from '../components/LabCard';
import { EmptyState, LoadingState, PageHeader } from '../components/ui';

const STATUSES: LabProgressStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'];

/** Every word must appear somewhere in what the card shows. */
export function matchesQuery(lab: LabSummary, query: string, trackTitle: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    lab.id,
    lab.title,
    lab.summary,
    lab.topicTitle,
    lab.topic,
    trackTitle,
    lab.difficulty,
    ...lab.skills,
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function CatalogPage({ initialFilters = {} }: { initialFilters?: CatalogFilters }) {
  const catalog = useCatalog();
  const { sessionForLab } = useActiveSession();

  const [query, setQuery] = useState(initialFilters.q ?? '');
  const [track, setTrack] = useState(initialFilters.track ?? '');
  const [level, setLevel] = useState(initialFilters.level ?? '');
  const [status, setStatus] = useState(initialFilters.status ?? '');

  const searchId = useId();
  const trackId = useId();
  const levelId = useId();
  const statusId = useId();

  usePageTitle('Lab catalog');

  // Keep the URL describing what is on screen, without a history entry per keystroke.
  useEffect(() => {
    replaceRoute({
      name: 'labs',
      ...(track ? { track } : {}),
      ...(query.trim() ? { q: query.trim() } : {}),
      ...(level ? { level } : {}),
      ...(status ? { status } : {}),
    });
  }, [track, query, level, status]);

  const trackTitle = (id: string) => catalog.trackById(id)?.title ?? id;
  const progressReady = catalog.progressStatus === 'ready';

  const difficulties = useMemo(
    () => [...new Set(catalog.labs.map((lab) => lab.difficulty))].sort(byDifficulty),
    [catalog.labs],
  );

  const visible = useMemo(
    () =>
      catalog.labs.filter((lab) => {
        if (track && lab.track !== track) return false;
        if (level && lab.difficulty !== level) return false;
        if (status && progressReady && (catalog.progressFor(lab.id)?.status ?? 'NOT_STARTED') !== status) {
          return false;
        }
        return matchesQuery(lab, query, catalog.trackById(lab.track)?.title ?? lab.track);
      }),
    // `catalog` carries the lookups; the filters are the rest.
    [catalog, track, level, status, query, progressReady],
  );

  const grouped = useMemo(() => {
    const byTrack = new Map<string, LabSummary[]>();
    for (const lab of visible) {
      const bucket = byTrack.get(lab.track);
      if (bucket) bucket.push(lab);
      else byTrack.set(lab.track, [lab]);
    }
    // `catalog.labs` is already in track order, so insertion order is track order.
    return [...byTrack.entries()];
  }, [visible]);

  const filtered = Boolean(track || level || status || query.trim());
  const clearFilters = () => {
    setQuery('');
    setTrack('');
    setLevel('');
    setStatus('');
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Labs"
        title="Lab catalog"
        description={
          catalog.status === 'ready'
            ? `${plural(catalog.labs.length, 'hands-on lab')} across ${plural(catalog.tracks.length, 'track')}. Every lab runs in a temporary environment created just for you.`
            : 'Hands-on labs, each in a temporary environment created just for you.'
        }
      />

      {catalog.status === 'loading' ? <LoadingState label="Loading labs…" /> : null}

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

      {catalog.status === 'ready' && catalog.labs.length === 0 ? (
        <EmptyState title="No labs are available yet">
          <p>The platform has not loaded any lab definitions. Please check back later or ask your instructor.</p>
        </EmptyState>
      ) : null}

      {catalog.status === 'ready' && catalog.labs.length > 0 ? (
        <>
          <form className="filters" role="search" aria-label="Filter labs" onSubmit={(event) => event.preventDefault()}>
            <div className="field field--grow">
              <label htmlFor={searchId} className="field__label">
                Search
              </label>
              <input
                id={searchId}
                type="search"
                className="input"
                placeholder="Title, id, topic or skill — e.g. pods, permissions, LINUX-003"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor={trackId} className="field__label">
                Track
              </label>
              <select id={trackId} className="input" value={track} onChange={(event) => setTrack(event.target.value)}>
                <option value="">All tracks</option>
                {catalog.tracks.map((option) => (
                  <option key={option.track} value={option.track}>
                    {option.title} ({option.labCount})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={levelId} className="field__label">
                Difficulty
              </label>
              <select id={levelId} className="input" value={level} onChange={(event) => setLevel(event.target.value)}>
                <option value="">Any difficulty</option>
                {difficulties.map((value) => (
                  <option key={value} value={value}>
                    {difficultyLabel(value)}
                  </option>
                ))}
              </select>
            </div>
            {progressReady ? (
              <div className="field">
                <label htmlFor={statusId} className="field__label">
                  Status
                </label>
                <select id={statusId} className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">Any status</option>
                  {STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {PROGRESS_LABEL[value]}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {filtered ? (
              <button type="button" className="btn btn--ghost filters__clear" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
          </form>

          <p className="results-count" role="status" aria-live="polite">
            {filtered
              ? `Showing ${visible.length} of ${plural(catalog.labs.length, 'lab')}`
              : `Showing all ${plural(catalog.labs.length, 'lab')}`}
          </p>

          {visible.length === 0 ? (
            <EmptyState
              title="No labs match"
              action={
                <button type="button" className="btn btn--secondary" onClick={clearFilters}>
                  Clear filters
                </button>
              }
            >
              <p>Try fewer words, a different track, or clearing the difficulty and status filters.</p>
            </EmptyState>
          ) : null}

          {grouped.map(([groupTrack, labs]) => {
            const summary = catalog.trackById(groupTrack);
            const note = trackNote(groupTrack);
            return (
              <section key={groupTrack} className="catalog-section" aria-labelledby={`track-${groupTrack}`}>
                <div className="catalog-section__head">
                  <h2 id={`track-${groupTrack}`} className="catalog-section__title">
                    {trackTitle(groupTrack)}
                  </h2>
                  <span className="catalog-section__count">{plural(labs.length, 'lab')}</span>
                  <a className="text-link catalog-section__link" href={hrefFor({ name: 'track', trackId: groupTrack })}>
                    Track overview<span className="visually-hidden">: {trackTitle(groupTrack)}</span>
                  </a>
                </div>
                {summary?.tagline ? <p className="catalog-section__tagline">{summary.tagline}</p> : null}
                {note ? <p className="catalog-section__note">{note}</p> : null}
                {summary?.availability?.available === false ? (
                  <p className="catalog-section__note catalog-section__note--warning">
                    Labs in this track cannot be started on this platform right now.
                  </p>
                ) : null}
                <div className="card-grid">
                  {labs.map((lab) => (
                    <LabCard
                      key={lab.id}
                      lab={lab}
                      progress={catalog.progressFor(lab.id)?.status}
                      running={sessionForLab(lab.id) !== undefined}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
