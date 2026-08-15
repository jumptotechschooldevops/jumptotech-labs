import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, api } from '../lib/api';
import type {
  ApiError,
  LabDetail,
  ProvisionStep,
  VerificationResult,
} from '../lib/types';
import { LabBrief } from '../components/LabBrief';
import { LabTimer } from '../components/LabTimer';
import { CheckPanel } from '../components/CheckPanel';
import { StartOverlay, type StartPhase } from '../components/StartOverlay';
import { LabTerminal, type LabTerminalHandle, type TerminalStatus } from '../components/LabTerminal';

const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Disconnected',
  error: 'Connection error',
};

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiRequestError) return error.error;
  return { code: 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : String(error) };
}

export function LabPage({ labId, onBack }: { labId: string; onBack: () => void }) {
  const [lab, setLab] = useState<LabDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [startPhase, setStartPhase] = useState<StartPhase>('idle');
  const [steps, setSteps] = useState<ProvisionStep[]>([]);
  const [startError, setStartError] = useState<ApiError | null>(null);

  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [terminalToken, setTerminalToken] = useState<string | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>('idle');
  const [terminalDetail, setTerminalDetail] = useState<string | undefined>();

  const [timerStartedAt, setTimerStartedAt] = useState<number | null>(null);
  const [timeExpired, setTimeExpired] = useState(false);

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<VerificationResult | null>(null);
  const [checkError, setCheckError] = useState<ApiError | null>(null);

  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [envSummary, setEnvSummary] = useState<string | null>(null);

  const terminalRef = useRef<LabTerminalHandle | null>(null);

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
      setTimerStartedAt(new Date(response.session.startedAt).getTime());
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
  }, [labId]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    setCheckError(null);
    setNotice(null);
    try {
      setCheckResult(await api.checkSolution(labId));
    } catch (error) {
      setCheckError(toApiError(error));
    } finally {
      setChecking(false);
    }
  }, [labId]);

  const handleReset = useCallback(async () => {
    setResetting(true);
    setCheckResult(null);
    setCheckError(null);
    setNotice(null);
    try {
      const response = await api.resetLab(labId);
      if (response.clearTerminal) {
        terminalRef.current?.clear();
        terminalRef.current?.writeNotice('Lab reset. Press Enter for a fresh prompt.');
      }
      const removedNote =
        response.removed.length > 0
          ? ` Removed: ${response.removed.join(', ')}.`
          : ' Nothing needed removing.';
      setNotice(`${response.message}${removedNote}`);
      setTimerStartedAt(Date.now());
      setTimeExpired(false);
    } catch (error) {
      setCheckError(toApiError(error));
    } finally {
      setResetting(false);
    }
  }, [labId]);

  const handleExpire = useCallback(() => setTimeExpired(true), []);

  const labReady = startPhase === 'ready' || startPhase === 'active';
  const durationSeconds = useMemo(() => (lab?.durationMinutes ?? 30) * 60, [lab]);

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
          <span className={`statuspill statuspill--${terminalStatus}`}>
            {TERMINAL_STATUS_LABEL[terminalStatus]}
          </span>
        </div>

        <div className="topbar__right">
          <LabTimer
            startedAt={timerStartedAt}
            durationSeconds={durationSeconds}
            onExpire={handleExpire}
          />
          <span className="topbar__track">{lab.track}</span>
        </div>
      </header>

      {timeExpired && (
        <div className="banner banner--warning" role="alert">
          <strong>Time expired.</strong> You may reset the lab and try again.
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
        <LabBrief lab={lab} />

        <section className="terminal-pane" aria-label="Lab terminal">
          <div className="terminal-pane__header">
            <span className="terminal-pane__title">Terminal</span>
            <span className="terminal-pane__meta">
              {labReady ? `namespace: ${lab.environment.namespace}` : 'not started'}
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
          disabled={!labReady || resetting || checking}
        >
          {resetting ? 'Resetting…' : 'Reset Lab'}
        </button>

        <div className="actionbar__spacer" />

        <button
          type="button"
          className="btn btn--primary"
          onClick={handleCheck}
          disabled={!labReady || checking || resetting}
        >
          {checking ? 'Checking…' : 'Check Solution'}
        </button>
      </footer>
    </div>
  );
}
