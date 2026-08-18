/**
 * Pre-lab overlay over the terminal pane: the Start Lab button, live
 * provisioning progress, and — critically — the real failure when the
 * environment cannot be created.
 */
import type { ApiError, ProvisionStep, ProviderAvailability } from '../lib/types';

export type StartPhase = 'idle' | 'starting' | 'ready' | 'active' | 'failed';

interface StartOverlayProps {
  phase: StartPhase;
  /** Steps reported by the backend (environment, daemon/API, CLI). */
  steps: ProvisionStep[];
  /** Status of the browser terminal, rendered as the final step. */
  terminalStep: ProvisionStep;
  error: ApiError | null;
  /**
   * Whether this lab's provider can create an environment here.
   *
   * When it cannot, the overlay says so and offers no button. Showing a Start
   * Lab that was always going to fail would be the one thing the catalog's
   * readiness model exists to prevent.
   */
  availability?: ProviderAvailability | undefined;
  /**
   * What the environment is called, e.g. `Kubernetes`, `Docker`, `Linux`.
   *
   * Supplied by the caller rather than mapped from a provider id here: a new
   * track names itself and nothing in this component changes. Defaults to the
   * neutral wording rather than naming the wrong technology.
   */
  environmentName?: string;
  onStart: () => void;
}

export function StartOverlay({
  phase,
  steps,
  terminalStep,
  error,
  availability,
  environmentName = 'lab',
  onStart,
}: StartOverlayProps) {
  // Once the lab is running the overlay gets out of the way entirely.
  if (phase === 'active') return null;

  if (phase === 'idle' && availability && !availability.available) {
    return (
      <div className="overlay">
        <div className="overlay__card overlay__card--wide">
          <h2 className="overlay__title">Not available here</h2>
          <p className="overlay__text">{availability.reason}</p>
          {availability.remediation && (
            <p className="overlay__text overlay__text--hint">{availability.remediation}</p>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'idle') {
    return (
      <div className="overlay">
        <div className="overlay__card">
          <h2 className="overlay__title">Start Lab</h2>
          <p className="overlay__text">
            A temporary {environmentName} environment will be prepared for you. Nothing is
            installed on your computer.
          </p>
          <button type="button" className="btn btn--primary btn--lg" onClick={onStart}>
            Start Lab
          </button>
        </div>
      </div>
    );
  }

  // The terminal step is always last, and only shown once the backend steps
  // have all succeeded — there is no terminal to connect before then.
  const backendSucceeded = steps.length > 0 && steps.every((s) => s.status === 'ok');
  const allSteps: ProvisionStep[] = backendSucceeded ? [...steps, terminalStep] : steps;

  const title =
    phase === 'failed'
      ? 'Could not start the lab'
      : phase === 'ready'
        ? 'Lab Ready'
        : `Preparing ${environmentName} environment…`;

  return (
    <div className="overlay">
      <div className="overlay__card overlay__card--wide">
        <h2 className={`overlay__title ${phase === 'ready' ? 'overlay__title--ready' : ''}`}>
          {title}
        </h2>

        <ul className="steps">
          {allSteps.map((step) => (
            <li key={step.id} className={`steps__item steps__item--${step.status}`}>
              <span
                className={`steps__mark ${step.status === 'pending' ? 'steps__mark--spin' : ''}`}
                aria-hidden="true"
              >
                {step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '·'}
              </span>
              <span className="steps__label">{step.label}</span>
              {step.detail && <span className="steps__detail">{step.detail}</span>}
            </li>
          ))}
        </ul>

        {phase === 'failed' && error && (
          <div className="overlay__error" role="alert">
            <div className="overlay__error-code">{error.code}</div>
            <p className="overlay__error-message">{error.message}</p>
            {error.remediation && <p className="overlay__error-hint">{error.remediation}</p>}
            <button type="button" className="btn btn--ghost" onClick={onStart}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
