/**
 * Countdown for the lab session.
 *
 * Story 1 scope: frontend-only. It is a pacing aid, not an exam control —
 * nothing server-side enforces it, and the README says so. Persistent
 * server-side timers are deferred to a later story.
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
