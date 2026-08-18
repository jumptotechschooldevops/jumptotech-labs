/**
 * The JumpToTech Labs catalog.
 *
 * Entirely driven by the API: tracks, topics, difficulties, and cards are all
 * derived from lab definitions on disk. There is no hardcoded lab, no
 * hardcoded track, and no switch on a lab id or a track name anywhere in this
 * file — dropping a new `lab.yaml` into `labs/` makes it appear here after an
 * API restart, and a second track appears as a second card without a line of
 * frontend work.
 *
 * The page has two modes, and which one you see is data, not configuration:
 *
 * ```text
 *   more than one track, none chosen ──► track cards, then every lab by track
 *   a track chosen                   ──► that track's topics, then its labs
 * ```
 */
import { useEffect, useMemo, useState } from 'react';
import { ApiRequestError, api } from '../lib/api';
import type {
  ApiError,
  LabProgressStatus,
  LabSummary,
  ProgressSnapshot,
  ProviderReadiness,
  TopicSummary,
  TrackSummary,
} from '../lib/types';

/**
 * Display names for providers that have no labs yet.
 *
 * Only used for the "coming soon" strip: a track with labs takes its title from
 * the API, which derives it from the lab definitions.
 */
const PROVIDER_TITLES: Record<string, string> = {
  kubernetes: 'Kubernetes',
  linux: 'Linux',
  docker: 'Docker',
  terraform: 'Terraform',
  aws: 'AWS',
};

/** Sorted low → high so the filter row reads as a progression. */
const DIFFICULTY_RANK: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };

function toApiError(error: unknown): ApiError {
  return error instanceof ApiRequestError
    ? error.error
    : { code: 'UNEXPECTED_ERROR', message: String(error) };
}

/** How a card announces where the student stands. */
const PROGRESS_LABEL: Record<Exclude<LabProgressStatus, 'NOT_STARTED'>, string> = {
  COMPLETED: '✓ Completed',
  IN_PROGRESS: 'In progress',
};

export function CatalogPage({
  onOpenLab,
  onOpenProgress,
}: {
  onOpenLab: (labId: string) => void;
  /** Optional so the catalog still renders anywhere routing is not wired up. */
  onOpenProgress?: () => void;
}) {
  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [providers, setProviders] = useState<ProviderReadiness[]>([]);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const [activeTrack, setActiveTrack] = useState<string | null>(null);
  const [activeTopic, setActiveTopic] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<string | null>(null);

  /** Choosing a track clears any topic from the previous one. */
  const chooseTrack = (track: string | null) => {
    setActiveTrack(track);
    setActiveTopic(null);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .listLabs()
      .then((data) => {
        if (cancelled) return;
        setLabs(data.labs);
        setTracks(data.tracks);
        setProviders(data.providers ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Completion state, fetched separately from the catalog.
   *
   * Two requests rather than one enriched endpoint, on purpose: browsing the
   * catalog stays a pure read of in-memory lab metadata, and a progress store
   * that is unavailable costs the student a few badges instead of the whole
   * page. Hence the deliberately silent catch.
   */
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.getProgress())
      .then((snapshot) => {
        if (!cancelled) setProgress(snapshot);
      })
      .catch(() => {
        if (!cancelled) setProgress(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** labId → standing, for the badges on the cards. */
  const progressByLab = useMemo(() => {
    const byLab = new Map<string, LabProgressStatus>();
    for (const track of progress?.tracks ?? []) {
      for (const lab of track.labs) byLab.set(lab.labId, lab.status);
    }
    return byLab;
  }, [progress]);

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
      if (activeTopic && lab.topic !== activeTopic) return false;
      if (difficulty && lab.difficulty !== difficulty) return false;
      return true;
    });
  }, [labs, activeTrack, activeTopic, difficulty]);

  /**
   * The chosen track's topics, from the API's own track summary.
   *
   * Falling back to deriving them from the loaded labs keeps the row correct
   * for a consumer that serves labs without a matching track entry.
   */
  const topics = useMemo<TopicSummary[]>(() => {
    if (!activeTrack) return [];
    const summary = tracks.find((t) => t.track === activeTrack);
    if (summary && summary.topics.length > 0) return summary.topics;

    const counts = new Map<string, TopicSummary>();
    for (const lab of labs ?? []) {
      if (lab.track !== activeTrack) continue;
      const existing = counts.get(lab.topic);
      if (existing) existing.labCount += 1;
      else counts.set(lab.topic, { topic: lab.topic, title: lab.topicTitle, labCount: 1 });
    }
    return [...counts.values()];
  }, [activeTrack, tracks, labs]);

  const difficulties = useMemo(
    () =>
      [...new Set((labs ?? []).map((lab) => lab.difficulty))].sort(
        (a, b) => (DIFFICULTY_RANK[a] ?? 99) - (DIFFICULTY_RANK[b] ?? 99),
      ),
    [labs],
  );

  /**
   * Group the visible labs by track, preserving catalog order within each.
   *
   * Section order follows the API's track ordering rather than the order labs
   * happen to arrive in, so a track's declared position in `track.yaml` is what
   * the student sees.
   */
  const grouped = useMemo(() => {
    const byTrack = new Map<string, LabSummary[]>();
    for (const lab of visible) {
      const bucket = byTrack.get(lab.track);
      if (bucket) bucket.push(lab);
      else byTrack.set(lab.track, [lab]);
    }

    const position = new Map(tracks.map((track, index) => [track.track, index]));
    return [...byTrack.entries()].sort(
      ([a], [b]) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity),
    );
  }, [visible, tracks]);

  const trackOf = (track: string) => tracks.find((t) => t.track === track);
  const trackTitle = (track: string) => trackOf(track)?.title ?? track;

  const trackAvailability = (track: string) =>
    tracks.find((t) => t.track === track)?.availability;

  /*
   * Providers that exist in the platform but have no labs to show yet.
   *
   * These are the honest "Coming soon" entries — Docker and AWS today. They are
   * listed because the architecture is there and the tracks are planned, and
   * they are *not* rendered as cards, because there is nothing to open.
   */
  const comingSoon = useMemo(() => {
    const withLabs = new Set((labs ?? []).map((lab) => lab.provider));
    return providers.filter((provider) => !withLabs.has(provider.provider) && !provider.available);
  }, [providers, labs]);

  return (
    <div className="page">
      <header className="topbar">
        <span className="topbar__brand">
          <span className="topbar__logo" aria-hidden="true">◆</span>
          JumpToTech <span className="topbar__brand-light">Labs</span>
        </span>
        <div className="topbar__center" />
        <div className="topbar__right">
          {onOpenProgress && (
            <button type="button" className="btn btn--ghost topbar__link" onClick={onOpenProgress}>
              My progress
              {progress && (
                <span className="topbar__progress">
                  {progress.overall.completed}/{progress.overall.total}
                </span>
              )}
            </button>
          )}
          <span className="topbar__track">catalog</span>
        </div>
      </header>

      <main className="catalog">
        <div className="catalog__intro">
          <h1>Practice environments, not slideshows</h1>
          <p>
            Launch a disposable environment in your browser — a private Kubernetes
            namespace, your own Linux or Terraform container, or an isolated Docker
            daemon — run real commands, and have your work verified against the state
            you actually left behind.
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

        {/*
          Track cards are the front door once there is more than one track.
          With a single track they would be a row of one, so the page goes
          straight to the labs — the shape follows the data.
        */}
        {labs && labs.length > 0 && tracks.length > 1 && activeTrack === null && (
          <section className="catalog__tracks" aria-label="Tracks">
            <h2 className="catalog__tracks-title">Tracks</h2>
            <div className="catalog__tracks-grid">
              {tracks.map((track) => (
                <button
                  key={track.track}
                  type="button"
                  className="trackcard"
                  onClick={() => chooseTrack(track.track)}
                >
                  <span className="trackcard__title">{track.title}</span>
                  <span className="trackcard__count">
                    {track.labCount} lab{track.labCount === 1 ? '' : 's'}
                  </span>
                  {track.tagline && <span className="trackcard__tagline">{track.tagline}</span>}
                  {track.topics.length > 0 && (
                    <span className="trackcard__topics">
                      {track.topics.map((topic) => topic.title).join(' · ')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}

        {labs && labs.length > 0 && (
          <nav className="catalog__filters" aria-label="Filter labs">
            <div className="filterrow" role="group" aria-label="Track">
              <span className="filterrow__label">Track</span>
              <button
                type="button"
                className="filterchip"
                aria-pressed={activeTrack === null}
                onClick={() => chooseTrack(null)}
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
                  onClick={() => chooseTrack(track.track)}
                >
                  {track.title}
                  <span className="filterchip__count">{track.labCount}</span>
                </button>
              ))}
            </div>

            {/* Topics belong to a track, so the row only exists once one is chosen. */}
            {activeTrack && topics.length > 1 && (
              <div className="filterrow" role="group" aria-label="Topic">
                <span className="filterrow__label">Topic</span>
                <button
                  type="button"
                  className="filterchip"
                  aria-pressed={activeTopic === null}
                  onClick={() => setActiveTopic(null)}
                >
                  All topics
                </button>
                {topics.map((topic) => (
                  <button
                    key={topic.topic}
                    type="button"
                    className="filterchip"
                    aria-pressed={activeTopic === topic.topic}
                    onClick={() => setActiveTopic(topic.topic)}
                  >
                    {topic.title}
                    <span className="filterchip__count">{topic.labCount}</span>
                  </button>
                ))}
              </div>
            )}

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
              {trackAvailability(track)?.available === false && (
                <span className="chip chip--unavailable" title={trackAvailability(track)?.reason}>
                  unavailable here
                </span>
              )}
              {activeTrack === track && tracks.length > 1 && (
                <button type="button" className="catalog__track-back" onClick={() => chooseTrack(null)}>
                  All tracks
                </button>
              )}
            </div>
            {/* Taglines come from labs/<track>/track.yaml; a track without one
                simply renders no subtitle. */}
            {trackOf(track)?.tagline && (activeTrack !== null || tracks.length <= 1) && (
              <p className="catalog__track-tagline">{trackOf(track)?.tagline}</p>
            )}

            {/* The reason is stated once per track rather than on every card:
                it is a property of the backend, not of any individual lab. */}
            {trackAvailability(track)?.available === false && (
              <p className="catalog__track-note" role="status">
                {trackAvailability(track)?.reason}
                {trackAvailability(track)?.remediation
                  ? ` ${trackAvailability(track)?.remediation}`
                  : ''}
              </p>
            )}

            <div className="catalog__grid">
              {trackLabs.map((lab) => (
                <article
                  key={lab.id}
                  className={`labcard${
                    progressByLab.get(lab.id) === 'COMPLETED' ? ' labcard--completed' : ''
                  }`}
                >
                  <div className="labcard__top">
                    <span className="labcard__id">{lab.id}</span>
                    <div className="labcard__badges">
                      {/* Where this student stands. Absent for a lab never
                          opened — an explicit "Not started" badge on every
                          untouched card would be noise, and the plain card
                          already says it. */}
                      {progressByLab.get(lab.id) === 'COMPLETED' && (
                        <span className="chip chip--completed">{PROGRESS_LABEL.COMPLETED}</span>
                      )}
                      {progressByLab.get(lab.id) === 'IN_PROGRESS' && (
                        <span className="chip chip--inprogress">{PROGRESS_LABEL.IN_PROGRESS}</span>
                      )}
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
                    {/* The lab page still opens for an unavailable lab — the
                        brief, the objectives and the documentation are worth
                        reading either way. What it will not do is offer to
                        start an environment that cannot be created. */}
                    <button
                      type="button"
                      className="btn btn--primary labcard__cta"
                      onClick={() => onOpenLab(lab.id)}
                    >
                      {lab.availability?.available === false ? 'View lab' : 'Open lab'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}

        {comingSoon.length > 0 && (
          <section className="catalog__track catalog__track--soon">
            <div className="catalog__track-head">
              <h2 className="catalog__track-title">Coming soon</h2>
              <span className="catalog__track-count">{comingSoon.length} tracks</span>
            </div>
            <div className="catalog__soon">
              {comingSoon.map((provider) => (
                <article key={provider.provider} className="labcard labcard--soon">
                  <h3 className="labcard__title">
                    {PROVIDER_TITLES[provider.provider] ?? provider.provider}
                  </h3>
                  <p className="labcard__summary">{provider.reason}</p>
                  <span className="chip chip--unavailable">not available yet</span>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
