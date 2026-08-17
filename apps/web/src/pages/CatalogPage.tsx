/**
 * The JumpToTech Labs catalog.
 *
 * Entirely driven by the API: tracks, topics, difficulties, and cards are all
 * derived from lab definitions on disk. There is no hardcoded lab, no
 * hardcoded track, and no switch on a lab id anywhere in this file — dropping
 * a new `lab.yaml` into `labs/` makes it appear here after an API restart.
 */
import { useEffect, useMemo, useState } from 'react';
import { ApiRequestError, api } from '../lib/api';
import type { ApiError, LabSummary, TrackSummary } from '../lib/types';

/** Sorted low → high so the filter row reads as a progression. */
const DIFFICULTY_RANK: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };

function toApiError(error: unknown): ApiError {
  return error instanceof ApiRequestError
    ? error.error
    : { code: 'UNEXPECTED_ERROR', message: String(error) };
}

export function CatalogPage({ onOpenLab }: { onOpenLab: (labId: string) => void }) {
  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const [activeTrack, setActiveTrack] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listLabs()
      .then((data) => {
        if (cancelled) return;
        setLabs(data.labs);
        setTracks(data.tracks);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Filtering happens client-side over the already-loaded catalog.
   *
   * The API supports the same filters as query parameters (and the track
   * endpoints exist for consumers that want them), but the whole catalog is a
   * few kilobytes of metadata that never touches a cluster — so re-fetching on
   * every chip click would add latency and gain nothing.
   */
  const visible = useMemo(() => {
    return (labs ?? []).filter((lab) => {
      if (activeTrack && lab.track !== activeTrack) return false;
      if (difficulty && lab.difficulty !== difficulty) return false;
      return true;
    });
  }, [labs, activeTrack, difficulty]);

  const difficulties = useMemo(
    () =>
      [...new Set((labs ?? []).map((lab) => lab.difficulty))].sort(
        (a, b) => (DIFFICULTY_RANK[a] ?? 99) - (DIFFICULTY_RANK[b] ?? 99),
      ),
    [labs],
  );

  /** Group the visible labs by track, preserving catalog order within each. */
  const grouped = useMemo(() => {
    const byTrack = new Map<string, LabSummary[]>();
    for (const lab of visible) {
      const bucket = byTrack.get(lab.track);
      if (bucket) bucket.push(lab);
      else byTrack.set(lab.track, [lab]);
    }
    return [...byTrack.entries()];
  }, [visible]);

  const trackTitle = (track: string) =>
    tracks.find((t) => t.track === track)?.title ?? track;

  return (
    <div className="page">
      <header className="topbar">
        <span className="topbar__brand">
          <span className="topbar__logo" aria-hidden="true">◆</span>
          JumpToTech <span className="topbar__brand-light">Labs</span>
        </span>
        <div className="topbar__center" />
        <div className="topbar__right">
          <span className="topbar__track">catalog</span>
        </div>
      </header>

      <main className="catalog">
        <div className="catalog__intro">
          <h1>Practice environments, not slideshows</h1>
          <p>
            Launch a disposable environment in your browser, run real commands, and have your work
            verified against what you actually built.
          </p>
        </div>

        {error && (
          <div className="message-card" role="alert">
            <h2>{error.code}</h2>
            <p>{error.message}</p>
            {error.remediation && <p className="message-card__hint">{error.remediation}</p>}
          </div>
        )}

        {!labs && !error && <p className="catalog__loading">Loading labs…</p>}

        {labs && labs.length === 0 && (
          <div className="message-card">
            <h2>No labs found</h2>
            <p>The API loaded zero lab definitions. Check the labs/ directory and LABS_DIR.</p>
          </div>
        )}

        {labs && labs.length > 0 && (
          <nav className="catalog__filters" aria-label="Filter labs">
            <div className="filterrow" role="group" aria-label="Track">
              <span className="filterrow__label">Track</span>
              <button
                type="button"
                className="filterchip"
                aria-pressed={activeTrack === null}
                onClick={() => setActiveTrack(null)}
              >
                All
                <span className="filterchip__count">{labs.length}</span>
              </button>
              {tracks.map((track) => (
                <button
                  key={track.track}
                  type="button"
                  className="filterchip"
                  aria-pressed={activeTrack === track.track}
                  onClick={() => setActiveTrack(track.track)}
                >
                  {track.title}
                  <span className="filterchip__count">{track.labCount}</span>
                </button>
              ))}
            </div>

            {difficulties.length > 1 && (
              <div className="filterrow" role="group" aria-label="Difficulty">
                <span className="filterrow__label">Level</span>
                <button
                  type="button"
                  className="filterchip"
                  aria-pressed={difficulty === null}
                  onClick={() => setDifficulty(null)}
                >
                  Any
                </button>
                {difficulties.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="filterchip"
                    aria-pressed={difficulty === value}
                    onClick={() => setDifficulty(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            )}
          </nav>
        )}

        {labs && labs.length > 0 && visible.length === 0 && (
          <div className="message-card">
            <h2>No labs match these filters</h2>
            <p>Try clearing the difficulty filter or choosing a different track.</p>
          </div>
        )}

        {grouped.map(([track, trackLabs]) => (
          <section key={track} className="catalog__track">
            <div className="catalog__track-head">
              <h2 className="catalog__track-title">{trackTitle(track)}</h2>
              <span className="catalog__track-count">
                {trackLabs.length} lab{trackLabs.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="catalog__grid">
              {trackLabs.map((lab) => (
                <article key={lab.id} className="labcard">
                  <div className="labcard__top">
                    <span className="labcard__id">{lab.id}</span>
                    <div className="labcard__badges">
                      {lab.certifications.map((cert) => (
                        <span key={cert} className="chip chip--cert">
                          {cert}
                        </span>
                      ))}
                      <span className={`chip chip--${lab.difficulty}`}>{lab.difficulty}</span>
                    </div>
                  </div>

                  <h3 className="labcard__title">{lab.title}</h3>
                  <p className="labcard__summary">{lab.summary}</p>

                  <dl className="labcard__facts">
                    <div>
                      <dt>Duration</dt>
                      <dd>{lab.durationMinutes} min</dd>
                    </div>
                    <div>
                      <dt>Topic</dt>
                      <dd>{lab.topicTitle}</dd>
                    </div>
                    {lab.prerequisites.length > 0 && (
                      <div>
                        <dt>Prerequisites</dt>
                        <dd>{lab.prerequisites.map((p) => p.id).join(', ')}</dd>
                      </div>
                    )}
                  </dl>

                  {lab.skills.length > 0 && (
                    <div className="labcard__skills">
                      {/* Skill ids are dotted (`kubernetes.pods.create`); the
                          track prefix is dropped because the card is already
                          inside its track section. */}
                      {lab.skills.slice(0, 4).map((skill) => (
                        <span key={skill} className="skills__tag">
                          {skill.split('.').slice(1).join(' · ') || skill}
                        </span>
                      ))}
                      {lab.skills.length > 4 && (
                        <span className="skills__tag skills__tag--more">
                          +{lab.skills.length - 4}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="labcard__footer">
                    {lab.hasSetup && (
                      <span className="labcard__note" title="This lab starts from a prepared environment">
                        prepared environment
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn btn--primary labcard__cta"
                      onClick={() => onOpenLab(lab.id)}
                    >
                      Open lab
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
