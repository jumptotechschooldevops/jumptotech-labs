/**
 * Idle warning banner.
 *
 * Appears once the session's idle countdown enters its warning window.
 * "Stay active" records activity server-side, which moves the *idle* deadline
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
      <p className="banner__text">
        <strong>Are you still working?</strong> This lab has been inactive, and its environment will be removed{' '}
        {/* Read once when the warning appears. The count changes every minute,
            and inside an alert each change was announced again, assertively. */}
        <span aria-live="off">
          in about {minutes} minute{minutes === 1 ? '' : 's'}
        </span>
        .
      </p>
      <button type="button" className="btn btn--sm btn--secondary" onClick={onContinue} disabled={busy}>
        {busy ? 'Keeping it…' : 'Stay active'}
      </button>
    </div>
  );
}
