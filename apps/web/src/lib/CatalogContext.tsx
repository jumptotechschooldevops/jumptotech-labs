/**
 * The catalog and the student's progress, loaded once for the whole app.
 *
 * Dashboard, Labs, Tracks, a track page and a lab page all read the same two
 * things: what labs exist (`GET /api/labs`) and where this student stands
 * (`GET /api/me/progress`). Loading them per page made every navigation a
 * spinner; loading them here makes navigation instant and keeps every page
 * showing the same numbers.
 *
 * Two independent requests with two independent states, on purpose: an
 * unavailable progress store costs the student their badges and percentages,
 * never the catalog. And an unavailable progress store is *said*, never shown
 * as zero — "0 completed" and "we could not read your progress" are different
 * facts.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import { toApiError } from './errors';
import type {
  ApiError,
  LabProgressEntry,
  LabSummary,
  ProgressSnapshot,
  ProviderReadiness,
  TrackSummary,
} from './types';

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface CatalogState {
  status: LoadStatus;
  error: ApiError | null;
  /** Every lab, grouped by the API's track order, then by each lab's `order`. */
  labs: LabSummary[];
  tracks: TrackSummary[];
  providers: ProviderReadiness[];
  reload: () => void;

  progressStatus: LoadStatus;
  progressError: ApiError | null;
  progress: ProgressSnapshot | null;
  reloadProgress: () => void;

  labById: (labId: string) => LabSummary | undefined;
  trackById: (trackId: string) => TrackSummary | undefined;
  /** This student's standing on a lab, when progress could be read. */
  progressFor: (labId: string) => LabProgressEntry | undefined;
  labsInTrack: (trackId: string) => LabSummary[];
}

const CatalogContext = createContext<CatalogState | null>(null);

/** Track position first (as the API ordered tracks), then the lab's declared order. */
export function sortLabs(labs: LabSummary[], tracks: TrackSummary[]): LabSummary[] {
  const position = new Map(tracks.map((track, index) => [track.track, index]));
  return [...labs].sort(
    (a, b) =>
      (position.get(a.track) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.track) ?? Number.MAX_SAFE_INTEGER) ||
      a.track.localeCompare(b.track) ||
      a.order - b.order ||
      a.id.localeCompare(b.id),
  );
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [data, setData] = useState<{
    labs: LabSummary[];
    tracks: TrackSummary[];
    providers: ProviderReadiness[];
  }>({ labs: [], tracks: [], providers: [] });

  const [progressStatus, setProgressStatus] = useState<LoadStatus>('loading');
  const [progressError, setProgressError] = useState<ApiError | null>(null);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);

  const catalogGeneration = useRef(0);
  const progressGeneration = useRef(0);
  /** A snapshot has been read at least once in this visit. */
  const progressRead = useRef(false);

  const reload = useCallback(() => {
    const mine = ++catalogGeneration.current;
    setStatus('loading');
    setError(null);
    // `Promise.resolve().then` so a missing or throwing client is a rejected
    // promise handled below, not an exception during render.
    Promise.resolve()
      .then(() => api.listLabs())
      .then((result) => {
        if (catalogGeneration.current !== mine) return;
        setData({
          labs: sortLabs(result.labs, result.tracks),
          tracks: result.tracks,
          providers: result.providers ?? [],
        });
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (catalogGeneration.current !== mine) return;
        setError(toApiError(cause));
        setStatus('error');
      });
  }, []);

  const reloadProgress = useCallback(() => {
    const mine = ++progressGeneration.current;
    // Keep showing the last snapshot while a refresh is in flight; only the
    // very first load shows a loading state.
    setProgressStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
    Promise.resolve()
      .then(() => api.getProgress())
      .then((snapshot) => {
        if (progressGeneration.current !== mine) return;
        progressRead.current = true;
        setProgress(snapshot);
        setProgressError(null);
        setProgressStatus('ready');
      })
      .catch((cause: unknown) => {
        if (progressGeneration.current !== mine) return;
        // A refresh that fails keeps the snapshot already read: completions are
        // never taken away, so it is still true as far as it goes, and dropping
        // it made every Completed badge vanish during an API blip. Only a
        // progress that was never read is an error.
        if (progressRead.current) return;
        setProgress(null);
        setProgressError(toApiError(cause));
        setProgressStatus('error');
      });
  }, []);

  useEffect(() => {
    reload();
    reloadProgress();
  }, [reload, reloadProgress]);

  const value = useMemo<CatalogState>(() => {
    const labsById = new Map(data.labs.map((lab) => [lab.id, lab]));
    const tracksById = new Map(data.tracks.map((track) => [track.track, track]));
    const progressByLab = new Map<string, LabProgressEntry>();
    for (const track of progress?.tracks ?? []) {
      for (const lab of track.labs) progressByLab.set(lab.labId, lab);
    }
    return {
      status,
      error,
      labs: data.labs,
      tracks: data.tracks,
      providers: data.providers,
      reload,
      progressStatus,
      progressError,
      progress,
      reloadProgress,
      labById: (labId) => labsById.get(labId),
      trackById: (trackId) => tracksById.get(trackId),
      progressFor: (labId) => progressByLab.get(labId),
      labsInTrack: (trackId) => data.labs.filter((lab) => lab.track === trackId),
    };
  }, [status, error, data, reload, progressStatus, progressError, progress, reloadProgress]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogState {
  const value = useContext(CatalogContext);
  if (!value) throw new Error('useCatalog must be used inside a CatalogProvider');
  return value;
}
