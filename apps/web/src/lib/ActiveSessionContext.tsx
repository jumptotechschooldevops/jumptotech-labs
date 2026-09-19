/**
 * The student's running lab, held above every page.
 *
 * Before this existed, a session lived in the one page that pressed Start. Back,
 * a navigation, a reload or a second tab orphaned it: the sandbox kept running,
 * the student could not reach it, and Start refused them because they already
 * had one. Now the app asks the API which sessions this caller owns
 * (`GET /api/sessions`) and every page reads the same answer.
 *
 * ## What is kept, and where
 *
 * - **Sessions** — the server's payloads, refreshed on load, when the tab
 *   becomes visible, and after anything that changes them. Never invented: a
 *   session appears here only because the API returned it.
 * - **Terminal grants** — in memory, per session, for as long as the tab lives.
 *   Never written to storage. After a reload the page has none, and asks the
 *   owner-guarded `POST /api/sessions/:id/terminal` for a fresh one.
 * - **Launch** — single-flight. A second Launch while one is in flight returns
 *   the same promise, so a double click, an impatient second click or two
 *   buttons for the same action cannot send two start requests.
 *
 * The launch request is owned here rather than by a page so that leaving the
 * page mid-provisioning does not lose the response: the environment, its
 * grant and its steps land here whichever page is showing when it arrives.
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
import { isLiveStatus } from './format';
import { parseRoute } from './router';
import { resolveTerminalWsBase } from './urls';
import type {
  ActiveSessionEntry,
  ApiError,
  AttemptSummary,
  EnvironmentInfo,
  ProvisionStep,
  SessionInfo,
  StartLabResponse,
  TerminalGrant,
} from './types';

export interface LaunchState {
  labId: string;
  startedAt: number;
}

/** What the most recent successful start reported, for the workspace to show. */
export interface StartReport {
  labId: string;
  sessionId: string;
  steps: ProvisionStep[];
  environment: EnvironmentInfo;
}

export interface ActiveSessionState {
  status: 'loading' | 'ready' | 'error';
  error: ApiError | null;
  /** The caller's own live sessions, newest first. */
  entries: ActiveSessionEntry[];
  /** The caller's own quota, when the deployment reports one. */
  limit: number | null;
  refresh: () => Promise<void>;
  sessionForLab: (labId: string) => ActiveSessionEntry | undefined;

  launching: LaunchState | null;
  launchError: { labId: string; error: ApiError } | null;
  lastStart: StartReport | null;
  launch: (labId: string, labTitle?: string) => Promise<StartLabResponse | null>;
  /** Forget a refused launch — for one lab, or whichever it was. */
  clearLaunchError: (labId?: string) => void;

  grantFor: (sessionId: string) => TerminalGrant | null;
  /** Mint a fresh grant from the API, replacing any held one. */
  obtainGrant: (sessionId: string) => Promise<TerminalGrant>;

  /** Record a newer copy of a session — from a poll, a check, a reset, an end. */
  adoptSession: (session: SessionInfo, attempt?: AttemptSummary | null) => void;
}

const ActiveSessionContext = createContext<ActiveSessionState | null>(null);

/**
 * Where this browser should open the terminal socket.
 *
 * The API's `terminal.url` is only a fallback: without PUBLIC_ORIGIN or a
 * forwarded origin it is the configured default (`ws://localhost:4001`), which
 * behind the web proxy — or on a laptop running more than one stack — is not
 * this deployment's terminal at all, and the token would be presented to the
 * wrong service. `resolveTerminalWsBase` prefers VITE_TERMINAL_WS_URL, then this
 * page's own origin (proxied `/terminal`), exactly as the lab page always did.
 */
function browserGrant(grant: TerminalGrant): TerminalGrant {
  return { url: resolveTerminalWsBase(grant.url), token: grant.token };
}

export function ActiveSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [entries, setEntries] = useState<ActiveSessionEntry[]>([]);
  const [limit, setLimit] = useState<number | null>(null);

  const [launching, setLaunching] = useState<LaunchState | null>(null);
  const [launchError, setLaunchError] = useState<{ labId: string; error: ApiError } | null>(null);
  const [lastStart, setLastStart] = useState<StartReport | null>(null);

  const grants = useRef(new Map<string, TerminalGrant>());
  /** Grants live in a ref; this version is what tells consumers one arrived. */
  const [grantVersion, setGrantVersion] = useState(0);
  const inFlightLaunch = useRef<Promise<StartLabResponse | null> | null>(null);
  const inFlightGrant = useRef(new Map<string, Promise<TerminalGrant>>());
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const result = await Promise.resolve().then(() => api.listMySessions());
      if (generation.current !== mine) return;
      setEntries(result.sessions);
      setLimit(result.limits?.maxActiveSessionsPerStudent ?? null);
      setError(null);
      setStatus('ready');
      // A grant for a session that is no longer ours is worth nothing; drop it.
      const live = new Set(result.sessions.map((entry) => entry.session.sessionId));
      for (const sessionId of [...grants.current.keys()]) {
        if (!live.has(sessionId)) grants.current.delete(sessionId);
      }
    } catch (cause) {
      if (generation.current !== mine) return;
      setError(toApiError(cause));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const adoptSession = useCallback((session: SessionInfo, attempt?: AttemptSummary | null) => {
    setEntries((current) => {
      const index = current.findIndex((entry) => entry.session.sessionId === session.sessionId);
      if (!isLiveStatus(session.status)) {
        grants.current.delete(session.sessionId);
        return index === -1 ? current : current.filter((_, i) => i !== index);
      }
      if (index === -1) return current;
      const next = [...current];
      const existing = next[index]!;
      next[index] = {
        ...existing,
        session,
        ...(attempt ? { attempt } : {}),
      };
      return next;
    });
  }, []);

  const launch = useCallback(
    (labId: string, labTitle?: string) => {
      if (inFlightLaunch.current) return inFlightLaunch.current;

      setLaunching({ labId, startedAt: Date.now() });
      setLaunchError(null);

      const promise = Promise.resolve()
        .then(() => api.startLab(labId))
        .then((response) => {
          grants.current.set(response.session.sessionId, browserGrant(response.terminal));
          setGrantVersion((v) => v + 1);
          setEntries((current) => [
            {
              session: response.session,
              labTitle: labTitle ?? labId,
              ...(response.attempt ? { attempt: response.attempt } : {}),
            },
            ...current.filter((entry) => entry.session.sessionId !== response.session.sessionId),
          ]);
          setLastStart({
            labId,
            sessionId: response.session.sessionId,
            steps: response.steps,
            environment: response.environment,
          });
          return response;
        })
        .catch((cause: unknown) => {
          const apiError = toApiError(cause);
          setLaunchError({ labId, error: apiError });
          // Re-read the student's sessions after any failed start. A refusal can
          // name a session this page does not know about, and a start that timed
          // out or lost its response (a proxy error, a dropped connection) may
          // still have created one: either way the page can offer Continue
          // instead of a Try again that is refused as a second lab.
          void refresh();
          return null;
        })
        .finally(() => {
          inFlightLaunch.current = null;
          setLaunching(null);
        });

      inFlightLaunch.current = promise;
      return promise;
    },
    [refresh],
  );

  /*
   * A refusal answers the moment it was made. Moving on to anything but that
   * lab's own page or workspace forgets it, so coming back later does not show
   * it again as if it were new: "you already have a lab running" after that lab
   * has ended, or a capacity alert from twenty minutes ago. Navigation rather
   * than a page's unmount decides, because the workspace is loaded lazily and
   * can mount after a fast refusal has already arrived.
   */
  useEffect(() => {
    const onNavigate = () => {
      const route = parseRoute(window.location.hash);
      const labId = route.name === 'lab' || route.name === 'workspace' ? route.labId : null;
      setLaunchError((current) => (current && current.labId !== labId ? null : current));
    };
    window.addEventListener('hashchange', onNavigate);
    return () => window.removeEventListener('hashchange', onNavigate);
  }, []);

  const clearLaunchError = useCallback(
    (labId?: string) => setLaunchError((current) => (!labId || current?.labId === labId ? null : current)),
    [],
  );

  const grantFor = useCallback((sessionId: string) => grants.current.get(sessionId) ?? null, []);

  const obtainGrant = useCallback((sessionId: string) => {
    const pending = inFlightGrant.current.get(sessionId);
    if (pending) return pending;
    const promise = Promise.resolve()
      .then(() => api.issueTerminal(sessionId))
      .then((response) => {
        const grant = browserGrant(response.terminal);
        grants.current.set(sessionId, grant);
        setGrantVersion((v) => v + 1);
        return grant;
      })
      .finally(() => {
        inFlightGrant.current.delete(sessionId);
      });
    inFlightGrant.current.set(sessionId, promise);
    return promise;
  }, []);

  const value = useMemo<ActiveSessionState>(
    () => ({
      status,
      error,
      entries,
      limit,
      refresh,
      sessionForLab: (labId) => entries.find((entry) => entry.session.labId === labId),
      launching,
      launchError,
      lastStart,
      launch,
      clearLaunchError,
      grantFor,
      obtainGrant,
      adoptSession,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grantVersion re-publishes `grantFor`'s answers
    [
      grantVersion,
      status,
      error,
      entries,
      limit,
      refresh,
      launching,
      launchError,
      lastStart,
      launch,
      clearLaunchError,
      grantFor,
      obtainGrant,
      adoptSession,
    ],
  );

  return <ActiveSessionContext.Provider value={value}>{children}</ActiveSessionContext.Provider>;
}

export function useActiveSession(): ActiveSessionState {
  const value = useContext(ActiveSessionContext);
  if (!value) throw new Error('useActiveSession must be used inside an ActiveSessionProvider');
  return value;
}
