/**
 * Verification results drawer. Renders exactly what the backend verifier
 * reported after reading live cluster state.
 */
import type { ApiError, VerificationResult } from '../lib/types';

interface CheckPanelProps {
  running: boolean;
  result: VerificationResult | null;
  error: ApiError | null;
  onDismiss: () => void;
}

export function CheckPanel({ running, result, error, onDismiss }: CheckPanelProps) {
  if (!running && !result && !error) return null;

  return (
    <section className="checkpanel" aria-live="polite">
      <header className="checkpanel__header">
        <span className="checkpanel__title">
          {running ? 'Checking your environment…' : 'Verification result'}
        </span>
        {!running && (
          <button type="button" className="checkpanel__close" onClick={onDismiss} aria-label="Dismiss results">
            ✕
          </button>
        )}
      </header>

      {error && (
        <div className="checkpanel__error" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
          {error.remediation && <p className="checkpanel__hint">{error.remediation}</p>}
        </div>
      )}

      {result && (
        <>
          <ul className="checks">
            {result.checks.map((check) => (
              <li key={check.id} className={`checks__item checks__item--${check.status}`}>
                <span className="checks__mark" aria-hidden="true">
                  {check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '–'}
                </span>
                <span className="checks__label">{check.label}</span>
                {check.detail && <span className="checks__detail">{check.detail}</span>}
              </li>
            ))}
          </ul>
          <div className={`verdict ${result.passed ? 'verdict--pass' : 'verdict--fail'}`}>
            {result.summary}
          </div>
        </>
      )}

      {running && !result && <div className="checkpanel__spinner" aria-hidden="true" />}
    </section>
  );
}
