import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, api } from '../lib/api';
import type {
  ApiError,
  LabDetail,
  ProvisionStep,
  SessionInfo,
  VerificationResult,
} from '../lib/types';
import { LabBrief } from '../components/LabBrief';
import { LabTimer } from '../components/LabTimer';
import { CheckPanel } from '../components/CheckPanel';
import { StartOverlay, type StartPhase } from '../components/StartOverlay';
import { EndLabDialog } from '../components/EndLabDialog';
import { IdleWarning } from '../components/IdleWarning';
import { LabTerminal, type LabTerminalHandle, type TerminalStatus } from '../components/LabTerminal';

const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Disconnected',
  error: 'Connection error',
};

/** How often the browser asks the server for session state. */
const POLL_INTERVAL_MS = 15_000;

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiRequestError) return error.error;
  return { code: 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : String(error) };
}

export function LabPage({
  labId,
  onBack,
  onOpenLab,
}: {
  labId: string;
  onBack: () => void;
  /** Lets the brief link to a prerequisite lab. */
  onOpenLab?: (labId: string) => void;
}) {
  const [lab, setLab] = useState<LabDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [startPhase, setStartPhase] = useState<StartPhase>('idle');
  const [steps, setSteps] = useState<ProvisionStep[]>([]);
  const [startError, setStartError] = useState<ApiError | null>(null);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [terminalToken, setTerminalToken] = useState<string | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>('idle');
  const [terminalDetail, setTerminalDetail] = useState<string | undefined>();

  const [timerSeededAt, setTimerSeededAt] = useState<number | null>(null);
  const [timeExpired, setTimeExpired] = useState(false);

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<VerificationResult | null>(null);
  const [checkError, setCheckError] = useState<ApiError | null>(null);

  const [resetting, setResetting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [endDialogOpen, setEndDialogOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [envSummary, setEnvSummary] = useState<string | null>(null);

  const terminalRef = useRef<LabTerminalHandle | null>(null);

  /** Adopt a session payload and re-seed the countdown from the server. */
  const adoptSession = useCallback((next: SessionInfo) => {
    setSession(next);
    setTimerSeededAt(Date.now());
    setTimeExpired(next.secondsRemaining <= 0);
  }, []);

  // --- load the lab definition -------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLab(null);
    setLoadError(null);
    api
      .getLab(labId)
      .then((detail) => {
        if (!cancelled) setLab(detail);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(toApiError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [labId]);

  // --- poll session state -------------------------------------------------
  // Polling does NOT count as activity server-side, by design: leaving this tab
  // open must not keep an abandoned environment alive.
  useEffect(() => {
    if (!session) return;
    if (session.status !== 'ACTIVE' && session.status !== 'RESETTING') return;

    let cancelled = false;
    const poll = () => {
      api
        .getSession(session.sessionId)
        .then((response) => {
          if (cancelled) return;
          setSession(response.session);
          if (response.session.secondsRemaining <= 0) setTimeExpired(true);
        })
        .catch(() => {
          /* a transient poll failure is not worth showing the student */
        });
    };

    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [session]);

  // --- terminal status ----------------------------------------------------
  const handleTerminalStatus = useCallback((status: TerminalStatus, detail?: string) => {
    setTerminalStatus(status);
    setTerminalDetail(detail);
  }, []);

  // Only flip to "ready" once the terminal has actually connected, so the UI
  // never claims the lab is ready before it is. The confirmation is held
  // briefly, then the overlay clears to reveal the live terminal.
  useEffect(() => {
    if (startPhase !== 'starting' || terminalStatus !== 'connected') return;
    setStartPhase('ready');
    const timeout = setTimeout(() => setStartPhase('active'), 1200);
    return () => clearTimeout(timeout);
  }, [startPhase, terminalStatus]);

  // If the terminal fails while we are still starting, surface the real error.
  useEffect(() => {
    if (startPhase === 'starting' && (terminalStatus === 'error' || terminalStatus === 'closed')) {
      setStartPhase('failed');
      setStartError({
        code: 'TERMINAL_UNAVAILABLE',
        message: terminalDetail ?? 'The browser terminal could not connect.',
        remediation: 'Check the terminal service: docker compose logs terminal',
      });
    }
  }, [startPhase, terminalStatus, terminalDetail]);

  /** The terminal's own provisioning step, derived from the live connection. */
  const terminalStep = useMemo<ProvisionStep>(() => {
    if (terminalStatus === 'connected') return { id: 'terminal', label: 'Terminal connected', status: 'ok' };
    if (terminalStatus === 'error' || terminalStatus === 'closed') {
      return {
        id: 'terminal',
        label: 'Terminal connected',
        status: 'failed',
        detail: terminalDetail ?? 'connection failed',
      };
    }
    return { id: 'terminal', label: 'Terminal connected', status: 'pending', detail: 'connecting…' };
  }, [terminalStatus, terminalDetail]);

  // --- actions ------------------------------------------------------------
  const handleStart = useCallback(async () => {
    setStartPhase('starting');
    setStartError(null);
    setSteps([]);
    setCheckResult(null);
    setCheckError(null);
    setNotice(null);
    setTimeExpired(false);

    try {
      const response = await api.startLab(labId);
      setSteps(response.steps);
      setTerminalUrl(response.terminal.url);
      setTerminalToken(response.terminal.token);
      adoptSession(response.session);
      const nodeCount = response.environment.nodes?.length ?? 0;
      setEnvSummary(
        `${response.environment.provider} · ${response.environment.kubernetesVersion ?? 'k8s'} · ${nodeCount} node${nodeCount === 1 ? '' : 's'}`,
      );
    } catch (error) {
      const apiError = toApiError(error);
      setStartPhase('failed');
      setStartError(apiError);
      const details = (apiError.details ?? {}) as { steps?: ProvisionStep[] };
      if (Array.isArray(details.steps)) setSteps(details.steps);
    }
  }, [labId, adoptSession]);

  const handleCheck = useCallback(async () => {
    if (!session) return;
    setChecking(true);
    setCheckResult(null);
    setCheckError(null);
    setNotice(null);
    try {
      const result = await api.checkSolution(session.sessionId);
      setCheckResult(result);
      if (result.session) setSession(result.session);
    } catch (error) {
      setCheckError(toApiError(error));
    } finally {
      setChecking(false);
    }
  }, [session]);

  const handleReset = useCallback(async () => {
    if (!session) return;
    setResetting(true);
    setCheckResult(null);
    setCheckError(null);
    setNotice(null);
    try {
      const response = await api.resetLab(session.sessionId);
      if (response.clearTerminal) {
        terminalRef.current?.clear();
        terminalRef.current?.writeNotice('Lab reset. Press Enter for a fresh prompt.');
      }
      const removedNote =
        response.removed.length > 0
          ? ` Removed: ${response.removed.join(', ')}.`
          : ' Nothing needed removing.';
      setNotice(`${response.message}${removedNote}`);
      // Reset keeps the session: the absolute deadline deliberately does NOT
      // move, so the countdown is re-seeded from the server, not restarted.
      adoptSession(response.session);
    } catch (error) {
      setCheckError(toApiError(error));
    } finally {
      setResetting(false);
    }
  }, [session, adoptSession]);

  const handleContinue = useCallback(async () => {
    if (!session) return;
    setContinuing(true);
    try {
      const response = await api.recordActivity(session.sessionId);
      setSession(response.session);
    } catch (error) {
      setCheckError(toApiError(error));
    } finally {
      setContinuing(false);
    }
  }, [session]);

  const handleEnd = useCallback(async () => {
    if (!session) return;
    setEnding(true);
    try {
      const response = await api.endLab(session.sessionId);
      setSession(response.session);
      setEndDialogOpen(false);
      setStartPhase('idle');
      setTerminalUrl(null);
      setTerminalToken(null);
      setTimerSeededAt(null);
      setNotice(response.message);
    } catch (error) {
      setEndDialogOpen(false);
      setCheckError(toApiError(error));
    } finally {
      setEnding(false);
    }
  }, [session]);

  const handleExpire = useCallback(() => setTimeExpired(true), []);

  const labReady = startPhase === 'ready' || startPhase === 'active';
  const sessionLive = session?.status === 'ACTIVE' || session?.status === 'RESETTING';
  const busy = checking || resetting || ending;

  // --- render -------------------------------------------------------------
  if (loadError) {
    return (
      <div className="page page--message">
        <div className="message-card" role="alert">
          <h2>{loadError.code}</h2>
          <p>{loadError.message}</p>
          {loadError.remediation && <p className="message-card__hint">{loadError.remediation}</p>}
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            Back to catalog
          </button>
        </div>
      </div>
    );
  }

  if (!lab) {
    return (
      <div className="page page--message">
        <div className="message-card">
          <div className="checkpanel__spinner" aria-hidden="true" />
          <p>Loading lab {labId}…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <button type="button" className="topbar__brand" onClick={onBack}>
          <span className="topbar__logo" aria-hidden="true">◆</span>
          JumpToTech <span className="topbar__brand-light">Labs</span>
        </button>

        <div className="topbar__center">
          {envSummary && <span className="topbar__env" title="Live environment">{envSummary}</span>}
          {session && (
            <span className={`statuspill statuspill--session-${session.status.toLowerCase()}`}>
              {session.status}
            </span>
          )}
          <span className={`statuspill statuspill--${terminalStatus}`}>
            {TERMINAL_STATUS_LABEL[terminalStatus]}
          </span>
        </div>

        <div className="topbar__right">
          <LabTimer
            startedAt={timerSeededAt}
            durationSeconds={session?.secondsRemaining ?? lab.durationMinutes * 60}
            onExpire={handleExpire}
          />
          <span className="topbar__track">{lab.track}</span>
        </div>
      </header>

      {session?.idleWarning && sessionLive && (
        <IdleWarning
          secondsUntilIdle={session.secondsUntilIdle}
          busy={continuing}
          onContinue={handleContinue}
        />
      )}

      {timeExpired && (
        <div className="banner banner--warning" role="alert">
          <strong>Time expired.</strong> This environment has reached its maximum lifetime and is
          being released. Start the lab again for a fresh one.
        </div>
      )}

      {session && !sessionLive && session.status !== 'CREATING' && (
        <div className="banner banner--info" role="status">
          <strong>Session {session.status}.</strong>{' '}
          {session.statusReason ?? 'This environment has been released.'}
        </div>
      )}

      {notice && (
        <div className="banner banner--info" role="status">
          {notice}
          <button type="button" className="banner__close" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <main className="workspace">
        <LabBrief lab={lab} {...(onOpenLab ? { onOpenLab } : {})} />

        <section className="terminal-pane" aria-label="Lab terminal">
          <div className="terminal-pane__header">
            <span className="terminal-pane__title">Terminal</span>
            {/* Developer detail. The namespace is not a student-facing concept
                and possessing it grants nothing — every API call is addressed
                by session id. */}
            <span className="terminal-pane__meta">
              {labReady && session ? `namespace: ${session.namespace}` : 'not started'}
            </span>
          </div>

          <div className="terminal-pane__body">
            <LabTerminal
              ref={terminalRef}
              url={terminalUrl}
              token={terminalToken}
              onStatusChange={handleTerminalStatus}
            />
            <StartOverlay
              phase={startPhase}
              steps={steps}
              terminalStep={terminalStep}
              error={startError}
              onStart={handleStart}
            />
          </div>

          <CheckPanel
            running={checking}
            result={checkResult}
            error={checkError}
            onDismiss={() => {
              setCheckResult(null);
              setCheckError(null);
            }}
          />
        </section>
      </main>

      <footer className="actionbar">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={handleReset}
          disabled={!labReady || !sessionLive || busy}
          title="Remove your resources and start this lab over. Keeps your environment."
        >
          {resetting ? 'Resetting…' : 'Reset Lab'}
        </button>

        <button
          type="button"
          className="btn btn--danger-ghost"
          onClick={() => setEndDialogOpen(true)}
          disabled={!labReady || !sessionLive || busy}
          title="Delete this environment and release it. Cannot be undone."
        >
          End Lab
        </button>

        <div className="actionbar__spacer" />

        <button
          type="button"
          className="btn btn--primary"
          onClick={handleCheck}
          disabled={!labReady || !sessionLive || busy}
        >
          {checking ? 'Checking…' : 'Check Solution'}
        </button>
      </footer>

      <EndLabDialog
        open={endDialogOpen}
        busy={ending}
        onCancel={() => setEndDialogOpen(false)}
        onConfirm={handleEnd}
      />
    </div>
  );
}
