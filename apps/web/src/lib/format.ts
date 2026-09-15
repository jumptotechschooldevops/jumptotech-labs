/**
 * Small, pure presentation helpers shared across pages.
 *
 * Kept free of React so they can be tested as plain functions and reused by
 * any view without dragging a component along.
 */
import type {
  AttemptStatus,
  LabProgressStatus,
  SessionStatus,
} from './types';

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** `45` → `45 min`, `90` → `1 h 30 min`. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** `125` → `02:05`. Clamped at zero. */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** `2026-08-17T10:04:00Z` → `17 Aug, 10:04`. Locale-aware, never a raw ISO string. */
export function formatMoment(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `beginner` → `Beginner`. Unknown values are shown as they are, capitalised. */
export function difficultyLabel(difficulty: string): string {
  return difficulty ? difficulty.charAt(0).toUpperCase() + difficulty.slice(1) : '';
}

/** Sorted low → high so difficulty reads as a progression. */
export const DIFFICULTY_RANK: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };

export function byDifficulty(a: string, b: string): number {
  return (DIFFICULTY_RANK[a] ?? 99) - (DIFFICULTY_RANK[b] ?? 99);
}

/**
 * Skill ids are dotted (`kubernetes.pods.create`). The track prefix is noise
 * wherever the track is already on screen.
 */
export function skillLabel(skill: string): string {
  return skill.split('.').slice(1).join(' · ') || skill;
}

export const PROGRESS_LABEL: Record<LabProgressStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
};

/** Attempt outcomes as a student reads them. `FAILED` is a start that never got an environment. */
export const ATTEMPT_LABEL: Record<AttemptStatus, string> = {
  IN_PROGRESS: 'In progress',
  PASSED: 'Passed',
  FAILED: 'Could not start',
  ENDED: 'Ended',
  EXPIRED: 'Expired',
};

/**
 * Session lifecycle, in words.
 *
 * `label` is the short badge; `description` is the sentence a beginner reads.
 * Every state the orchestrator can report has an entry — the type makes a
 * missing one a compile error rather than a blank badge.
 */
export const SESSION_STATUS_TEXT: Record<SessionStatus, { label: string; description: string }> = {
  CREATING: { label: 'Preparing', description: 'Preparing your lab environment…' },
  ACTIVE: { label: 'Ready', description: 'Your lab environment is running.' },
  RESETTING: { label: 'Resetting', description: 'Resetting your lab environment to its starting state…' },
  DEGRADED: {
    label: 'Needs a reset',
    description: 'Your environment is not usable as it is. Reset the lab to rebuild it, or end it.',
  },
  EXPIRING: { label: 'Time is up', description: 'This environment reached its time limit and is being removed…' },
  EXPIRED: { label: 'Expired', description: 'This environment was removed when its time ran out.' },
  ENDING: { label: 'Shutting down', description: 'Your lab environment is being removed…' },
  ENDED: { label: 'Ended', description: 'This lab environment has been removed.' },
  FAILED: { label: 'Failed', description: 'This lab environment could not be created.' },
};

/** States in which a session still holds an environment the student can come back to. */
export function isLiveStatus(status: SessionStatus): boolean {
  return status !== 'ENDED' && status !== 'EXPIRED' && status !== 'FAILED';
}

/** States the platform is still moving through on its own. */
export function isTransitionalStatus(status: SessionStatus): boolean {
  return status === 'CREATING' || status === 'RESETTING' || status === 'ENDING' || status === 'EXPIRING';
}
