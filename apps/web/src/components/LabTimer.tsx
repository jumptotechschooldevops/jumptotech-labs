/**
 * Countdown to the session's absolute deadline.
 *
 * PLATFORM-002 made this real. It is no longer a frontend-only pacing aid: the
 * caller seeds it from `session.secondsRemaining`, which the API derives from
 * the session's server-side `expires_at`, and the reaper deletes the namespace
 * when that deadline passes whatever the browser believes. Reloading the page
 * re-reads the deadline from the server; closing the tab does not stop it.
 *
 * The component itself stays a dumb countdown so it can be tested without a
 * clock, a session, or a network.
 */
import { useEffect, useState } from 'react';

interface LabTimerProps {
  /** Epoch ms when the countdown started, or null before Start Lab. */
  startedAt: number | null;
  durationSeconds: number;
  onExpire: () => void;
}

function format(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function LabTimer({ startedAt, durationSeconds, onExpire }: LabTimerProps) {
  const [remaining, setRemaining] = useState(durationSeconds);

  useEffect(() => {
    if (startedAt === null) {
      setRemaining(durationSeconds);
      return;
    }

    let expired = false;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const left = durationSeconds - elapsed;
      setRemaining(left);
      if (left <= 0 && !expired) {
        expired = true;
        onExpire();
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startedAt, durationSeconds, onExpire]);

  const running = startedAt !== null;
  const warning = running && remaining <= 300 && remaining > 0;
  const expired = running && remaining <= 0;

  return (
    <div
      className={`timer ${expired ? 'timer--expired' : warning ? 'timer--warning' : ''}`}
      role="timer"
      aria-live="off"
      title={running ? 'Time remaining in this lab session' : 'Lab duration'}
    >
      <span className="timer__icon" aria-hidden="true" />
      <span className="timer__value">{format(remaining)}</span>
    </div>
  );
}
