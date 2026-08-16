/**
 * Idle warning banner.
 *
 * Appears once the session's idle countdown enters its warning window.
 * "Continue Lab" records activity server-side, which moves the *idle* deadline
 * only — the absolute session deadline is never extended, so this cannot keep a
 * lab alive forever.
 */
export function IdleWarning({
  secondsUntilIdle,
  busy,
  onContinue,
}: {
  secondsUntilIdle: number;
  busy: boolean;
  onContinue: () => void;
}) {
  const minutes = Math.max(1, Math.ceil(secondsUntilIdle / 60));

  return (
    <div className="banner banner--warning" role="alert">
      <div>
        <strong>Your lab has been inactive.</strong>{' '}
        This environment will automatically stop in {minutes} minute{minutes === 1 ? '' : 's'}.
      </div>
      <button type="button" className="btn btn--small" onClick={onContinue} disabled={busy}>
        {busy ? 'Continuing…' : 'Continue Lab'}
      </button>
    </div>
  );
}
