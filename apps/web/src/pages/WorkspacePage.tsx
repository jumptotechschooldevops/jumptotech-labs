/**
 * The active lab workspace — instructions, a real terminal, and Verify.
 *
 * ## Source of truth
 *
 * The session's state is always the server's. This page holds a copy of the
 * last payload it received (from the session list, a poll, a check, a reset or
 * an end) and renders *that*; it never advances a status on its own. Buttons
 * exist only in states where the API would accept them:
 *
 * ```text
 *   CREATING   preparing overlay                    no actions
 *   ACTIVE     terminal                             Verify · Reset · End
 *   RESETTING  resetting overlay                    no actions
 *   DEGRADED   "needs a reset" overlay              Reset · End
 *   ENDING / EXPIRING   shutting-down overlay       no actions
 *   ENDED / EXPIRED / FAILED   summary, no terminal no actions
 * ```
 *
 * Transitional states are polled every few seconds, steady ones every fifteen.
 * Polling does not count as activity, so an abandoned tab cannot keep a sandbox
 * alive.
 *
 * ## Finding the session
 *
 * No session id is ever in the URL. The page asks `ActiveSessionContext`, which
 * asks the API which sessions this student owns. A reloaded page therefore
 * reattaches to the lab that is really running, and mints a fresh terminal
 * token through the owner-guarded endpoint — it never needs one from storage.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useActiveSession } from '../lib/ActiveSessionContext';
import { useCatalog } from '../lib/CatalogContext';
import { ApiRequestError, api } from '../lib/api';
import { describeError, toApiError } from '../lib/errors';
import { RESET_KEEPS, describeProvider, describeReset } from '../lib/environmentInfo';
import { SESSION_STATUS_TEXT, formatMinutes, isLiveStatus, isTransitionalStatus, removedForInactivity, sessionStatusText } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';
import type {
  ApiError,
  AttemptSummary,
  CheckResult,
  LabDetail,
  LabHint,
  LearningRecommendation,
  ProvisionStep,
  SessionInfo,
} from '../lib/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorNotice } from '../components/ErrorNotice';
import { IdleWarning } from '../components/IdleWarning';
import { LabBrief } from '../components/LabBrief';
import { LabTerminal, type LabTerminalHandle, type TerminalEvent } from '../components/LabTerminal';
import { FLAGSHIP_PATH_ID } from '../lib/learningPath';
import { LabTimer } from '../components/LabTimer';
import { Recommendation, recommendsLab } from '../components/LearningPath';
import { VerificationPanel, type VerifyState } from '../components/VerificationPanel';
import { Badge, EmptyState, LoadingState } from '../components/ui';

export const STEADY_POLL_MS = 15_000;
export const TRANSITION_POLL_MS = 3_000;
/** How many times a workspace with no session for its lab looks again (≈30 s). */
export const NOT_RUNNING_RECHECKS = 10;
/**
 * Automatic reconnects after an abnormal drop, before asking the student.
 *
 * About a minute in all: long enough to ride out a terminal or sandboxd
 * container restart (`prod restart terminal`, or Docker's own restart policy),
 * which takes longer than the ten seconds the first three steps cover.
 */
export const AUTO_RECONNECTS = [1_000, 3_000, 6_000, 10_000, 15_000, 25_000];

/**
 * Terminal refusals that describe the platform's plumbing rather than the
 * session: a broker or API that is restarting, a shell that could not be
 * spawned this time, an attach slower than the auth grace. The same bounded
 * retry as a dropped connection.
 */
const TRANSIENT_TERMINAL_CODES = new Set([
  'CONNECTION_LOST',
  'BROKER_UNREACHABLE',
  'PTY_SPAWN_FAILED',
  'CREDENTIALS_UNAVAILABLE',
  'SANDBOX_UNAVAILABLE',
  'AUTH_TIMEOUT',
]);

/**
 * Refusals that mean the session is not what this page thinks it is. They are
 * never retried; the session is re-read so the page shows what it really is.
 * SANDBOX_REF_MISMATCH is a security refusal and belongs here, not above.
 */
const SESSION_STATE_TERMINAL_CODES = new Set([
  'SESSION_NOT_ACTIVE',
  'SESSION_NOT_FOUND',
  'SESSION_NOT_OWNED',
  'INVALID_TERMINAL_CONTEXT',
  'SANDBOX_REF_MISMATCH',
]);

const TERMINAL_TEXT: Record<string, string> = {
  // Shown only while the session is still ACTIVE: a lab that really ended moves
  // to the ended summary as soon as the session is re-read.
  SESSION_ENDED: 'Disconnected — this terminal was opened in another tab or window.',
  IDLE_TIMEOUT: 'Disconnected after a period of inactivity.',
  SESSION_EXPIRED: 'Disconnected — the terminal reached its time limit.',
  SHELL_EXITED: 'The shell exited.',
  CAPACITY: 'The terminal service is busy right now.',
  UNAUTHORIZED: 'The terminal’s access expired.',
  CREDENTIALS_UNAVAILABLE: 'The terminal could not attach to your environment.',
  CONNECTION_LOST: 'Connection to the terminal was lost.',
};

/**
 * Whether `secondsRemaining` is a real countdown for this status.
 *
 * The api sends 0 for every status but ACTIVE and RESETTING (SessionManager.view),
 * so reading 0 as "time is up" told a student whose lab was being prepared,
 * needed a reset, or was ending that it had run out of time.
 */
function countsDown(status: SessionInfo['status']): boolean {
  return status === 'ACTIVE' || status === 'RESETTING';
}

function statusTone(status: SessionInfo['status']) {
  if (status === 'ACTIVE') return 'success' as const;
  if (status === 'DEGRADED' || status === 'FAILED') return 'danger' as const;
  if (isLiveStatus(status)) return 'warning' as const;
  return 'neutral' as const;
}

function Overlay({
  title,
  busy = false,
  children,
}: {
  title: string;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="overlay">
      <div className="overlay__card" role="status" aria-live="polite">
        <p className="overlay__title">
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {title}
        </p>
        {children}
      </div>
    </div>
  );
}

function Steps({ steps, pending }: { steps: ProvisionStep[]; pending?: string }) {
  return (
    <ul className="steps">
      {steps.map((step) => (
        <li key={step.id} className={`steps__item steps__item--${step.status}`}>
          <span className="steps__mark" aria-hidden="true">
            {step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '·'}
          </span>
          <span className="steps__label">{step.label}</span>
        </li>
      ))}
      {pending ? (
        <li className="steps__item steps__item--pending">
          <span className="steps__mark steps__mark--pulse" aria-hidden="true">
            ·
          </span>
          <span className="steps__label">{pending}</span>
        </li>
      ) : null}
    </ul>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="overlay__elapsed">{seconds}s</span>;
}

export function WorkspacePage({ labId }: { labId: string }) {
  const catalog = useCatalog();
  const active = useActiveSession();
  const { adoptSession, obtainGrant, grantFor, launch, refresh: refreshSessionList } = active;

  // --- the lab definition -------------------------------------------------
  const [lab, setLab] = useState<LabDetail | null>(null);
  const [labError, setLabError] = useState<ApiError | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.getLab(labId))
      .then((detail) => {
        if (!cancelled) setLab(detail);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLabError(toApiError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [labId]);

  usePageTitle(lab ? `${lab.id} workspace` : `${labId} workspace`);

  // --- the session ----------------------------------------------------------
  const entry = active.sessionForLab(labId);
  const launchingHere = active.launching?.labId === labId;
  const launchError = active.launchError?.labId === labId ? active.launchError.error : null;

  /*
   * Nothing for this lab yet: look again for a while before settling on "not
   * running". A reload while Start Lab is in flight cancels the browser's
   * request but not the server's work, and the lab appears in the list a moment
   * after this page first read it. Without this the page said "not running" for
   * a lab that was being built and held the student's only slot.
   */
  const notFoundYet = !entry && !launchingHere && !launchError && active.status === 'ready';
  useEffect(() => {
    if (!notFoundYet) return;
    let checks = 0;
    const timer = setInterval(() => {
      checks += 1;
      if (checks > NOT_RUNNING_RECHECKS) {
        clearInterval(timer);
        return;
      }
      void refreshSessionList();
    }, TRANSITION_POLL_MS);
    return () => clearInterval(timer);
  }, [notFoundYet, refreshSessionList]);

  const [session, setSession] = useState<SessionInfo | null>(entry?.session ?? null);
  const [attempt, setAttempt] = useState<AttemptSummary | null>(entry?.attempt ?? null);
  const [gone, setGone] = useState(false);
  // Seeded now when the session is already known at mount; otherwise when it arrives.
  const [timerSeed, setTimerSeed] = useState<number | null>(() => (entry ? Date.now() : null));
  const [timeExpired, setTimeExpired] = useState(false);
  /** Five minutes or less are left; shown once per session, until time is up. */
  const [timeLow, setTimeLow] = useState(false);

  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [lastChecks, setLastChecks] = useState<CheckResult[] | undefined>();
  const [resetOpen, setResetOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [actionError, setActionError] = useState<{
    error: ApiError;
    context: 'reset' | 'end' | 'terminal' | 'activity';
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollTrouble, setPollTrouble] = useState(false);

  const [terminal, setTerminal] = useState<TerminalEvent>({ status: 'idle' });
  const [everConnected, setEverConnected] = useState(false);
  const [connectKey, setConnectKey] = useState(0);
  const [grantError, setGrantError] = useState<ApiError | null>(null);
  const terminalRef = useRef<LabTerminalHandle | null>(null);
  const autoReconnects = useRef(0);
  /** The pending automatic reconnect, so it cannot fire into a later session or an unmounted page. */
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshedToken = useRef(false);
  const verifying = useRef(false);

  /** Mirrors `reconnectTimer` for rendering: the page says it is retrying. */
  const [retryPending, setRetryPending] = useState(false);
  /** Why the last attempt failed, until the terminal first connects. */
  const [connectFailure, setConnectFailure] = useState<string | null>(null);
  const cancelAutoReconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    setRetryPending(false);
  }, []);
  useEffect(() => cancelAutoReconnect, [cancelAutoReconnect]);

  /*
   * What the page last showed, for the one rule a late answer must not break: a
   * session that has ended never comes back. A check started before End answers
   * after it with the copy it read before it ran — ACTIVE — and applying that
   * brought the ended lab's controls, timer and "press End lab" back.
   */
  const shown = useRef<{ session: SessionInfo | null; gone: boolean }>({ session: null, gone: false });
  shown.current = { session, gone };

  /** Take a newer copy of the session, and share it with the rest of the app. */
  const updateSession = useCallback(
    (next: SessionInfo, nextAttempt?: AttemptSummary | null) => {
      const current = shown.current;
      if (
        current.session?.sessionId === next.sessionId &&
        (current.gone || !isLiveStatus(current.session.status)) &&
        isLiveStatus(next.status)
      ) {
        if (nextAttempt) setAttempt(nextAttempt);
        return;
      }
      // Before the re-render, so a second answer in the same tick is judged against this one.
      shown.current = { ...current, session: next };
      setSession(next);
      setTimerSeed(Date.now());
      setTimeExpired(
        (next.status === 'EXPIRING' && !removedForInactivity(next)) ||
          (countsDown(next.status) && next.secondsRemaining <= 0),
      );
      if (nextAttempt) setAttempt(nextAttempt);
      adoptSession(next, nextAttempt ?? null);
    },
    [adoptSession],
  );

  // A session appears for this lab (launch finished, or the list loaded): adopt it.
  const entrySessionId = entry?.session.sessionId;
  useEffect(() => {
    if (!entry || entry.session.sessionId === session?.sessionId) return;
    setSession(entry.session);
    setAttempt(entry.attempt ?? null);
    setTimerSeed(Date.now());
    setTimeExpired(false);
    setTimeLow(false);
    setGone(false);
    setVerify({ kind: 'idle' });
    setLastChecks(undefined);
    setActionError(null);
    setNotice(null);
    setEverConnected(false);
    setConnectFailure(null);
    setGrantError(null);
    autoReconnects.current = 0;
    cancelAutoReconnect();
    refreshedToken.current = false;
    // Only a *different* session is adopted here; updates to the same one flow
    // through `updateSession`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entrySessionId]);

  const sessionId = session?.sessionId ?? null;
  const status = session?.status ?? null;

  const refreshSession = useCallback(() => {
    if (!sessionId) return;
    Promise.resolve()
      .then(() => api.getSession(sessionId))
      .then((response) => updateSession(response.session))
      .catch((cause: unknown) => {
        const error = toApiError(cause);
        if (error.code === 'SESSION_NOT_FOUND') {
          shown.current = { ...shown.current, gone: true };
          setGone(true);
          // The app-wide list still names it; left there it keeps an Active lab
          // link alive and blocks Launch on every other lab page.
          void refreshSessionList();
        }
      });
  }, [sessionId, updateSession, refreshSessionList]);

  // The copy this page starts from may be minutes old (the session list is read
  // when the app loads), so read the session once as soon as it is adopted: the
  // countdown and the idle warning must not show stale numbers until the first poll.
  useEffect(() => {
    if (sessionId) refreshSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // --- polling -------------------------------------------------------------
  const [pollNonce, setPollNonce] = useState(0);
  useEffect(() => {
    if (!sessionId || !status || !isLiveStatus(status) || gone) return;
    const delay = isTransitionalStatus(status) || resetting || ending ? TRANSITION_POLL_MS : STEADY_POLL_MS;
    let cancelled = false;
    const timeout = setTimeout(() => {
      Promise.resolve()
        .then(() => api.getSession(sessionId))
        .then((response) => {
          if (cancelled) return;
          setPollTrouble(false);
          updateSession(response.session);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          const error = toApiError(cause);
          if (error.code === 'SESSION_NOT_FOUND') {
            shown.current = { ...shown.current, gone: true };
            setGone(true);
            void refreshSessionList();
            return;
          }
          // One missed poll is noise; a run of them is worth a quiet line.
          setPollTrouble(true);
          setPollNonce((n) => n + 1);
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [sessionId, status, session, gone, resetting, ending, pollNonce, updateSession, refreshSessionList]);

  // --- terminal grant --------------------------------------------------------
  const grant = sessionId ? grantFor(sessionId) : null;
  useEffect(() => {
    if (!sessionId || status !== 'ACTIVE' || grant || grantError) return;
    obtainGrant(sessionId).catch((cause: unknown) => {
      const error = toApiError(cause);
      if (error.code === 'SESSION_NOT_ACTIVE' || error.code === 'SESSION_NOT_FOUND') refreshSession();
      else setGrantError(error);
    });
  }, [sessionId, status, grant, grantError, obtainGrant, refreshSession]);

  const reconnect = useCallback(
    (freshToken: boolean) => {
      if (!sessionId) return;
      // Whatever asked for this connection, an automatic one still pending
      // would replace it — and the shell the student is typing in — later.
      cancelAutoReconnect();
      setActionError(null);
      if (!freshToken) {
        setConnectKey((n) => n + 1);
        return;
      }
      obtainGrant(sessionId)
        .then(() => setConnectKey((n) => n + 1))
        .catch((cause: unknown) => {
          const error = toApiError(cause);
          if (error.code === 'SESSION_NOT_ACTIVE' || error.code === 'SESSION_NOT_FOUND') refreshSession();
          else setActionError({ error, context: 'terminal' });
        });
    },
    [sessionId, obtainGrant, refreshSession, cancelAutoReconnect],
  );

  const handleTerminalEvent = useCallback(
    (event: TerminalEvent) => {
      setTerminal(event);
      if (event.status === 'connected') {
        setEverConnected(true);
        setConnectFailure(null);
        cancelAutoReconnect();
        autoReconnects.current = 0;
        refreshedToken.current = false;
        return;
      }
      if (event.status !== 'disconnected') return;
      setConnectFailure(event.code ?? 'CONNECTION_LOST');

      switch (event.code) {
        case 'SESSION_ENDED':
        case 'SESSION_EXPIRED':
          refreshSession();
          break;
        case 'UNAUTHORIZED':
          // Most likely an expired token on a session that is still running.
          // Mint one new token, once; a second refusal is shown, not looped.
          if (!refreshedToken.current) {
            refreshedToken.current = true;
            reconnect(true);
          } else {
            refreshSession();
          }
          break;
        default: {
          if (event.code && SESSION_STATE_TERMINAL_CODES.has(event.code)) {
            refreshSession();
            break;
          }
          if (!event.code || !TRANSIENT_TERMINAL_CODES.has(event.code)) break;
          const delay = AUTO_RECONNECTS[autoReconnects.current];
          if (delay !== undefined) {
            autoReconnects.current += 1;
            cancelAutoReconnect();
            setRetryPending(true);
            reconnectTimer.current = setTimeout(() => {
              reconnectTimer.current = null;
              setRetryPending(false);
              reconnect(false);
            }, delay);
          }
          refreshSession();
          break;
        }
      }
    },
    [reconnect, refreshSession, cancelAutoReconnect],
  );

  // --- actions ---------------------------------------------------------------
  const handleVerify = useCallback(async () => {
    if (!sessionId || verifying.current) return;
    verifying.current = true;
    setVerify({ kind: 'checking' });
    setNotice(null);
    try {
      const result = await api.checkSolution(sessionId);
      if (!result || !Array.isArray(result.checks) || typeof result.passed !== 'boolean') {
        // A 200 that is not a verification result — an intermediary's body, a
        // half-deployed API — is a platform fault. It is never a verdict, and it
        // must not reach the render path, where it would blank the whole app.
        throw new ApiRequestError(200, {
          code: 'BAD_RESPONSE',
          message: 'The platform returned something that is not a verification result.',
        });
      }
      setVerify({ kind: 'result', result, newlyCompleted: result.newlyCompleted === true });
      setLastChecks(result.checks);
      if (result.attempt) setAttempt(result.attempt);
      // Not `result.session`: it is the copy the API read *before* the check,
      // so it still carries the idle warning the check itself just cleared, and
      // can be older than a poll that answered meanwhile. Read it fresh.
      refreshSession();
      if (result.newlyCompleted) catalog.reloadProgress();
    } catch (cause) {
      const error = toApiError(cause);
      setVerify({ kind: 'error', error });
      if (error.code === 'SESSION_NOT_ACTIVE' || error.code === 'SESSION_NOT_FOUND') refreshSession();
    } finally {
      verifying.current = false;
    }
  }, [sessionId, catalog, refreshSession]);

  const handleReset = useCallback(async () => {
    if (!sessionId || resetting) return;
    setResetting(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await api.resetLab(sessionId);
      setResetOpen(false);
      if (response.clearTerminal) {
        terminalRef.current?.clear();
        terminalRef.current?.writeNotice(
          response.reconnectTerminal
            ? 'Lab reset. Connecting to your fresh environment…'
            : 'Lab reset. Press Enter for a fresh prompt.',
        );
      }
      // A container-backed reset replaces the sandbox, so the shell attached to
      // the old one is gone. Reattach with the same session.
      if (response.reconnectTerminal) setConnectKey((n) => n + 1);
      setVerify({ kind: 'idle' });
      setLastChecks(undefined);
      setNotice('Your environment was reset to its starting state.');
      updateSession(response.session, response.attempt ?? null);
    } catch (cause) {
      setResetOpen(false);
      const error = toApiError(cause);
      setActionError({ error, context: 'reset' });
      const details = (error.details ?? {}) as { session?: SessionInfo };
      // A failed reset leaves the session DEGRADED; show what it is now.
      if (details.session?.sessionId === sessionId) updateSession(details.session);
      else refreshSession();
    } finally {
      setResetting(false);
    }
  }, [sessionId, resetting, updateSession, refreshSession]);

  const handleEnd = useCallback(async () => {
    if (!sessionId || ending) return;
    setEnding(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await api.endLab(sessionId);
      setEndOpen(false);
      updateSession(response.session, response.attempt ?? null);
      catalog.reloadProgress();
    } catch (cause) {
      setEndOpen(false);
      const error = toApiError(cause);
      const details = (error.details ?? {}) as { session?: SessionInfo };
      if (details.session?.sessionId === sessionId) updateSession(details.session);
      else refreshSession();
      setActionError({ error, context: 'end' });
    } finally {
      setEnding(false);
    }
  }, [sessionId, ending, updateSession, refreshSession, catalog]);

  const handleStayActive = useCallback(async () => {
    if (!sessionId) return;
    setContinuing(true);
    try {
      const response = await api.recordActivity(sessionId);
      updateSession(response.session);
    } catch (cause) {
      setActionError({ error: toApiError(cause), context: 'activity' });
    } finally {
      setContinuing(false);
    }
  }, [sessionId, updateSession]);

  const handleHintReveal = useCallback(
    (hint: LabHint) => {
      if (!sessionId) return;
      // Fire-and-forget: losing the record of a hint must not stop the student reading it.
      void Promise.resolve()
        .then(() => api.recordHint(sessionId, hint.level))
        .catch(() => undefined);
    },
    [sessionId],
  );

  /*
   * Hints this attempt already revealed, so a reload or a return to the lab
   * shows them again instead of starting the panel closed. Read from the
   * student's own attempt; hints unlock in the lab's order, so the count is how
   * many of the lab's hints, from the first, were recorded. Best effort:
   * without it the panel simply starts closed, as it always did.
   */
  const attemptId = attempt?.attemptId ?? null;
  // Kept with the attempt they were read for: a relaunch's first render must not
  // open the new attempt's hints from the old one's record.
  const [revealedLevels, setRevealedLevels] = useState<{ attemptId: string; levels: Set<number> } | null>(null);
  useEffect(() => {
    if (!attemptId) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.getAttempt(attemptId))
      .then(({ attempt: detail }) => {
        if (cancelled || !Array.isArray(detail?.hints)) return;
        setRevealedLevels({ attemptId, levels: new Set(detail.hints.map((hint) => hint.level)) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [attemptId]);
  const hintsRevealed = useMemo(() => {
    if (!lab || !revealedLevels || revealedLevels.attemptId !== attemptId) return 0;
    let count = 0;
    while (count < lab.hints.length && revealedLevels.levels.has(lab.hints[count]!.level)) count += 1;
    return count;
  }, [lab, revealedLevels, attemptId]);

  const handleExpire = useCallback(() => setTimeExpired(true), []);
  const handleTimeLow = useCallback(() => setTimeLow(true), []);

  const environment = useMemo(() => (lab ? describeProvider(lab.environment.provider) : null), [lab]);
  const startReport = active.lastStart?.sessionId === sessionId ? active.lastStart : null;

  // --- render: things that are not a workspace yet -----------------------------
  if (labError) {
    return (
      <div className="page">
        <ErrorNotice
          headingLevel={1}
          error={describeError(labError, 'load')}
          live={false}
          actions={
            <a className="btn btn--secondary" href={hrefFor({ name: 'labs' })}>
              Browse labs
            </a>
          }
        />
      </div>
    );
  }
  if (!lab) return <LoadingState label={`Loading ${labId}…`} />;

  // Launching again from the ended summary: show the new environment preparing,
  // not the old one's summary, until the new session arrives.
  const relaunching = launchingHere && (session === null || gone || !isLiveStatus(session.status));
  const final = !relaunching && (gone || (session !== null && !isLiveStatus(session.status)));
  const live = session !== null && !final && !relaunching;

  if (!session && !launchingHere) {
    if (launchError) {
      const described = describeError(launchError, 'launch');
      const other = active.entries[0];
      return (
        <div className="page page--narrow">
          <p className="page-header__eyebrow">
            {lab.id} · {catalog.trackById(lab.track)?.title ?? lab.track}
          </p>
          <h1 className="page-header__title">{lab.title}</h1>
          <ErrorNotice
            error={described}
            actions={
              <>
                {launchError.code === 'STUDENT_SESSION_LIMIT_REACHED' && other ? (
                  <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId: other.session.labId })}>
                    Continue {other.session.labId}
                  </a>
                ) : described.retryable ? (
                  <button type="button" className="btn btn--primary" onClick={() => void launch(lab.id, lab.title)}>
                    Try again
                  </button>
                ) : null}
                <a className="btn btn--secondary" href={hrefFor({ name: 'lab', labId: lab.id })}>
                  Back to lab
                </a>
              </>
            }
          />
        </div>
      );
    }
    if (active.status === 'loading') return <LoadingState label="Looking for your lab environment…" />;
    // "Not running" would be a guess when the list itself could not be read.
    if (active.status === 'error' && active.error) {
      return (
        <div className="page page--narrow">
          <ErrorNotice
            headingLevel={1}
            error={{ ...describeError(active.error, 'load'), title: 'We could not check whether this lab is running' }}
            live={false}
            actions={
              <button type="button" className="btn btn--primary" onClick={() => void active.refresh()}>
                Try again
              </button>
            }
          />
        </div>
      );
    }
    const other = active.entries[0];
    return (
      <div className="page page--narrow">
        <EmptyState
          headingLevel={1}
          title={`${lab.id} is not running`}
          action={
            other ? (
              <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId: other.session.labId })}>
                Continue {other.session.labId}
              </a>
            ) : (
              <a className="btn btn--primary" href={hrefFor({ name: 'lab', labId: lab.id })}>
                Go to the lab page
              </a>
            )
          }
        >
          <p>
            {other
              ? `You have a different lab running: ${other.session.labId} ${other.labTitle}.`
              : 'There is no environment for this lab right now. Launch it from the lab page.'}
          </p>
        </EmptyState>
      </div>
    );
  }

  // --- render: the workspace -----------------------------------------------------
  const canVerify = status === 'ACTIVE' && !resetting && !ending && verify.kind !== 'checking';
  const canReset = (status === 'ACTIVE' || status === 'DEGRADED') && !resetting && !ending && verify.kind !== 'checking';
  const canEnd = (status === 'ACTIVE' || status === 'DEGRADED') && !resetting && !ending;

  // A dialog opened while the action was possible must not outlive that: a
  // poll that finds the lab expired, ending or needing a reset closes it rather
  // than leaving a confirm button that sends a request the API will refuse.
  if (resetOpen && !resetting && !canReset) setResetOpen(false);
  if (endOpen && !ending && !canEnd) setEndOpen(false);

  let overlay: ReactNode = null;
  if (relaunching) {
    overlay = (
      <Overlay title="Preparing your lab environment…" busy>
        <p className="overlay__text">
          Creating your {environment?.name.toLowerCase() ?? 'environment'}. This can take a little while —{' '}
          <Elapsed since={active.launching!.startedAt} /> so far. You can leave this page; the lab keeps starting.
        </p>
      </Overlay>
    );
  } else if (session) {
    if (resetting || status === 'RESETTING') {
      overlay = <Overlay title="Resetting your lab environment…" busy />;
    } else if (status === 'CREATING') {
      // Reached after a reload or from another tab, when this page did not send
      // the start itself: same reassurance as the launch overlay above.
      overlay = (
        <Overlay title="Preparing your lab environment…" busy>
          <p className="overlay__text">
            Creating your {environment?.name.toLowerCase() ?? 'environment'}. This can take a little while, and this page
            updates by itself. You can leave this page; the lab keeps starting.
          </p>
        </Overlay>
      );
    } else if (status === 'DEGRADED') {
      overlay = (
        <Overlay title="Your environment needs a reset">
          <p className="overlay__text">{SESSION_STATUS_TEXT.DEGRADED.description}</p>
        </Overlay>
      );
    } else if (ending || status === 'ENDING' || status === 'EXPIRING') {
      overlay = (
        <Overlay
          title={
            status === 'EXPIRING'
              ? session && removedForInactivity(session)
                ? 'Removing your environment after inactivity…'
                : 'Time is up — removing your environment…'
              : 'Shutting down your lab environment…'
          }
          busy
        >
          <p className="overlay__text">Cleanup continues automatically. You can leave this page.</p>
        </Overlay>
      );
    } else if (status === 'ACTIVE' && !everConnected) {
      if (grantError) {
        overlay = (
          <div className="overlay">
            <div className="overlay__card">
              <ErrorNotice
                error={describeError(grantError, 'terminal')}
                headingLevel={3}
                actions={
                  <button type="button" className="btn btn--primary" onClick={() => setGrantError(null)}>
                    Try again
                  </button>
                }
              />
            </div>
          </div>
        );
      } else if (connectFailure) {
        // Once an attempt has failed this stays up, with Try again, through the
        // automatic retries: flipping back to "Connecting…" for each one made
        // the page flash between two states, and hid the button for a minute.
        const retrying = retryPending || terminal.status === 'connecting';
        overlay = (
          <div className="overlay">
            <div className="overlay__card" role="alert">
              <p className="overlay__title">The terminal could not connect</p>
              <p className="overlay__text">{TERMINAL_TEXT[connectFailure] ?? TERMINAL_TEXT.CONNECTION_LOST}</p>
              {retrying ? (
                <p className="overlay__text" aria-live="off">
                  <span className="spinner spinner--sm" aria-hidden="true" /> Trying again automatically…
                </p>
              ) : null}
              <button type="button" className="btn btn--primary" onClick={() => reconnect(true)}>
                Try again
              </button>
            </div>
          </div>
        );
      } else {
        overlay = (
          <Overlay title="Connecting to your terminal…" busy>
            {startReport ? <Steps steps={startReport.steps} pending="Terminal connecting" /> : null}
          </Overlay>
        );
      }
    }
  }

  // A container Reset removes the sandbox about a second in, and the shell with
  // it: the socket closes as "shell exited" long before the reset answers. That
  // is the reset working, and the page reconnects when it answers.
  const resetInFlight = resetting && terminal.status === 'disconnected';
  const terminalLabel =
    terminal.status === 'connected'
      ? 'Connected'
      : terminal.status === 'connecting'
        ? 'Connecting…'
        : resetInFlight
          ? 'Resetting your environment…'
          : terminal.status === 'disconnected'
            ? `${TERMINAL_TEXT[terminal.code ?? ''] ?? TERMINAL_TEXT.CONNECTION_LOST}${retryPending ? ' Reconnecting…' : ''}`
            : 'Not connected';
  const showReconnect =
    // Including SESSION_ENDED: while the session is still ACTIVE that means another
    // tab took the terminal over, and Reconnect is how this tab takes it back.
    status === 'ACTIVE' && everConnected && terminal.status === 'disconnected' && !resetInFlight;

  return (
    <div className="workspace">
      <div className="workspace__bar">
        <div className="workspace__heading">
          <p className="workspace__eyebrow">
            <a href={hrefFor({ name: 'lab', labId: lab.id })}>{lab.id}</a>
            <span aria-hidden="true"> · </span>
            <a href={hrefFor({ name: 'track', trackId: lab.track })}>{catalog.trackById(lab.track)?.title ?? lab.track}</a>
          </p>
          <h1 className="workspace__title">{lab.title}</h1>
        </div>

        <div className="workspace__status" role="status" aria-live="polite">
          {session && !relaunching ? (
            <Badge tone={gone ? 'neutral' : statusTone(session.status)}>
              {gone ? 'Gone' : sessionStatusText(session.status).label}
            </Badge>
          ) : (
            <Badge tone="warning">Preparing</Badge>
          )}
          {attempt?.status === 'PASSED' ? (
            <Badge tone="success" title="Saved to your progress">
              <span aria-hidden="true">✓ </span>Completed
            </Badge>
          ) : null}
        </div>

        {live && session && countsDown(session.status) ? (
          <div className="workspace__timer">
            <span className="workspace__timer-label">Time left</span>
            <LabTimer startedAt={timerSeed ?? Date.now()} durationSeconds={session.secondsRemaining} onExpire={handleExpire} onWarning={handleTimeLow} />
          </div>
        ) : null}

        {live || relaunching ? (
          <div className="workspace__actions" role="group" aria-label="Lab actions">
            <button type="button" className="btn btn--primary" onClick={() => void handleVerify()} disabled={!canVerify}>
              {verify.kind === 'checking' ? 'Verifying…' : 'Verify'}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setResetOpen(true)} disabled={!canReset}>
              {resetting ? 'Resetting…' : 'Reset'}
            </button>
            <button type="button" className="btn btn--danger-outline" onClick={() => setEndOpen(true)} disabled={!canEnd}>
              {ending ? 'Ending…' : 'End lab'}
            </button>
          </div>
        ) : null}
      </div>

      {session?.idleWarning && status === 'ACTIVE' ? (
        <IdleWarning secondsUntilIdle={session.secondsUntilIdle} busy={continuing} onContinue={() => void handleStayActive()} />
      ) : null}

      {timeLow && !timeExpired && live && status === 'ACTIVE' ? (
        <div className="banner banner--warning" role="status">
          <p className="banner__text">
            <strong>A few minutes left in this lab.</strong> Press Verify now if you have not: when the time is up the
            environment is removed. Anything already verified stays in your progress.
          </p>
        </div>
      ) : null}

      {timeExpired && live ? (
        <div className="banner banner--warning" role="alert">
          <p className="banner__text">
            <strong>Time is up.</strong> This environment has reached its time limit and is being removed. Your progress
            is saved.
          </p>
        </div>
      ) : null}

      {pollTrouble && live ? (
        <div className="banner banner--info" role="status">
          <p className="banner__text">Having trouble reaching the platform. Retrying…</p>
        </div>
      ) : null}

      {notice ? (
        <div className="banner banner--success" role="status">
          <p className="banner__text">{notice}</p>
          <button type="button" className="banner__close" onClick={() => setNotice(null)} aria-label="Dismiss message">
            ✕
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="workspace__notice">
          <ErrorNotice
            error={describeError(actionError.error, actionError.context)}
            headingLevel={2}
            actions={
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setActionError(null)}>
                Dismiss
              </button>
            }
          />
        </div>
      ) : null}

      {final ? (
        <FinalSummary
          lab={lab}
          session={session}
          gone={gone}
          attempt={attempt}
          otherRunning={active.entries.find((e) => e.session.labId !== lab.id)?.session.labId}
          onLaunchAgain={() => {
            // The new environment is judged afresh: the last verdict belongs to
            // the lab that just ended, not to the one being prepared.
            setVerify({ kind: 'idle' });
            setLastChecks(undefined);
            void launch(lab.id, lab.title);
          }}
          launching={active.launching !== null}
          launchError={launchError}
        />
      ) : (
        <div className="workspace__body">
          <aside className="workspace__instructions" aria-label="Instructions">
            <LabBrief
              // Hints belong to an attempt; a relaunch is a new one and starts closed.
              key={attempt?.attemptId ?? 'no-attempt'}
              lab={lab}
              showHeader={false}
              checks={lastChecks}
              onHintReveal={handleHintReveal}
              hintsRevealed={hintsRevealed}
            />
          </aside>

          <section className="workspace__main" aria-label="Terminal and verification">
            <div className="terminal-bar">
              <span className={`terminal-bar__state terminal-bar__state--${terminal.status}`} role="status" aria-live="polite">
                <span className="terminal-bar__dot" aria-hidden="true" />
                Terminal: {terminalLabel}
              </span>
              {environment ? <span className="terminal-bar__env">{environment.name}</span> : null}
              <span className="terminal-bar__spacer" />
              {showReconnect ? (
                <button type="button" className="btn btn--sm btn--secondary" onClick={() => reconnect(true)}>
                  Reconnect
                </button>
              ) : null}
              {terminal.status === 'connected' ? (
                <span className="terminal-bar__hint">Shift+Tab leaves the terminal</span>
              ) : null}
            </div>

            <div className="terminal-body">
              <LabTerminal
                ref={terminalRef}
                grant={status === 'ACTIVE' || status === 'RESETTING' ? grant : null}
                connectKey={connectKey}
                onEvent={handleTerminalEvent}
              />
              {overlay}
            </div>

            <VerificationPanel state={verify} alreadyCompleted={attempt?.status === 'PASSED'} />
          </section>
        </div>
      )}

      <ConfirmDialog
        open={resetOpen}
        title="Reset this lab?"
        confirmLabel="Reset lab"
        busyLabel="Resetting…"
        busy={resetting}
        onConfirm={() => void handleReset()}
        onCancel={() => setResetOpen(false)}
      >
        <p>{describeReset(session?.sandboxKind)}</p>
        <p>{RESET_KEEPS}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={endOpen}
        title="End this lab?"
        confirmLabel="End lab"
        busyLabel="Ending…"
        busy={ending}
        onConfirm={() => void handleEnd()}
        onCancel={() => setEndOpen(false)}
      >
        <p>Your lab environment will be deleted, including everything you created in it. This cannot be undone.</p>
        <p>
          Your progress is saved.{' '}
          {attempt?.status === 'PASSED'
            ? 'This lab stays completed.'
            : 'If you have not passed Verify yet, the lab will not be marked completed.'}
        </p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * After a completed lab: the path's next lab, straight from the API's rule.
 *
 * Read when the summary appears, which is after End, so the lab just finished
 * is already counted and no longer running. Anything but a lab to open next —
 * the student still has a lab running (the end has not finished), the path is
 * complete, progress cannot be read — shows nothing, and the summary keeps its
 * link to the path page.
 */
function useNextLabAfter(labId: string, enabled: boolean): LearningRecommendation | null {
  const [next, setNext] = useState<LearningRecommendation | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.getLearningPathProgress(FLAGSHIP_PATH_ID))
      .then((progress) => {
        const recommendation = progress?.recommendation;
        if (cancelled || !recommendation || !recommendsLab(recommendation) || recommendation.labId === labId) return;
        setNext(recommendation);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [labId, enabled]);
  return enabled ? next : null;
}

function FinalSummary({
  lab,
  session,
  gone,
  attempt,
  otherRunning,
  onLaunchAgain,
  launching,
  launchError,
}: {
  lab: LabDetail;
  session: SessionInfo | null;
  gone: boolean;
  attempt: AttemptSummary | null;
  otherRunning: string | undefined;
  onLaunchAgain: () => void;
  launching: boolean;
  launchError: ApiError | null;
}) {
  const passed = attempt?.status === 'PASSED';
  const next = useNextLabAfter(lab.id, passed && !otherRunning);
  const title = gone
    ? 'This lab environment no longer exists'
    : session && session.status === 'EXPIRED' && removedForInactivity(session)
      ? 'Your lab environment was removed after inactivity'
      : session?.status === 'EXPIRED'
      ? 'Your lab environment expired'
      : session?.status === 'FAILED'
        ? 'Your lab environment failed'
        : 'Lab ended';
  const description = gone
    ? 'It was ended or cleaned up. Your saved progress is not affected.'
    : session && removedForInactivity(session)
      ? 'Nobody used it for a while, so it was removed to free the space for others. Your saved progress is not affected.'
      : session
        ? sessionStatusText(session.status).description
        : '';

  return (
    <div className="workspace__final">
      <section className="panel final" aria-labelledby="final-heading">
        <h2 id="final-heading" className="panel__title">
          {title}
        </h2>
        <p className="panel__text">{description}</p>
        {attempt?.status === 'PASSED' ? (
          <p className="final__outcome final__outcome--passed">
            <span aria-hidden="true">✓ </span>You completed this lab. It is saved to your progress.
          </p>
        ) : (
          <p className="final__outcome">
            This lab is not completed yet. You can launch it again for a fresh environment
            {lab.durationMinutes ? ` (estimated ${formatMinutes(lab.durationMinutes)})` : ''}.
          </p>
        )}
        {launchError ? <ErrorNotice error={describeError(launchError, 'launch')} headingLevel={3} /> : null}
        {next ? <Recommendation recommendation={next} /> : null}
        <div className="final__actions">
          {otherRunning ? (
            <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId: otherRunning })}>
              Continue {otherRunning}
            </a>
          ) : passed ? (
            <>
              {/* A completed lab leads on: to the next lab when the path names
                  one (above), and to the path page either way. */}
              <a
                className={`btn ${next ? 'btn--secondary' : 'btn--primary'}`}
                href={hrefFor({ name: 'path', pathId: FLAGSHIP_PATH_ID })}
              >
                Continue the learning path
              </a>
              <button type="button" className="btn btn--secondary" onClick={onLaunchAgain} disabled={launching}>
                Launch again
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={onLaunchAgain} disabled={launching}>
              Launch a fresh environment
            </button>
          )}
          <a className="btn btn--secondary" href={hrefFor({ name: 'labs' })}>
            Back to labs
          </a>
          <a className="btn btn--ghost" href={hrefFor({ name: 'dashboard' })}>
            Dashboard
          </a>
        </div>
      </section>
    </div>
  );
}
