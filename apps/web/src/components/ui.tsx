/**
 * The small shared vocabulary every page is built from.
 *
 * One badge, one progress bar, one page header, one loading state and one empty
 * state — so a "Completed" badge, a loading spinner or a page title looks and
 * behaves the same on the dashboard as in the catalog.
 */
import type { ReactNode } from 'react';
import { PROGRESS_LABEL, difficultyLabel } from '../lib/format';
import type { LabProgressStatus } from '../lib/types';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

const DIFFICULTY_TONE: Record<string, Tone> = {
  beginner: 'success',
  intermediate: 'warning',
  advanced: 'danger',
};

export function DifficultyBadge({ difficulty }: { difficulty: string }) {
  return <Badge tone={DIFFICULTY_TONE[difficulty] ?? 'neutral'}>{difficultyLabel(difficulty)}</Badge>;
}

const PROGRESS_TONE: Record<LabProgressStatus, Tone> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'warning',
  COMPLETED: 'success',
};

/**
 * Where the student stands on a lab.
 *
 * "Not started" is omitted by default: a badge on every untouched card is
 * noise, and a plain card already says it.
 */
export function ProgressBadge({
  status,
  showNotStarted = false,
}: {
  status: LabProgressStatus | undefined;
  showNotStarted?: boolean;
}) {
  if (!status) return null;
  if (status === 'NOT_STARTED' && !showNotStarted) return null;
  return (
    <Badge tone={PROGRESS_TONE[status]}>
      {status === 'COMPLETED' ? <span aria-hidden="true">✓ </span> : null}
      {PROGRESS_LABEL[status]}
    </Badge>
  );
}

/**
 * Completed out of total — a count with a bar, never a bar alone.
 *
 * `role="progressbar"` with real bounds, and a visible "3 of 12" beside it,
 * so the number is read the same way by eye and by a screen reader.
 */
export function ProgressBar({
  value,
  max,
  label,
  size = 'md',
}: {
  value: number;
  max: number;
  label: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div
      className={`meter meter--${size}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <span className="meter__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        {eyebrow ? <div className="page-header__eyebrow">{eyebrow}</div> : null}
        <h1 className="page-header__title">{title}</h1>
        {description ? <p className="page-header__description">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="state state--empty">
      <h2 className="state__title">{title}</h2>
      {children ? <div className="state__body">{children}</div> : null}
      {action ? <div className="state__action">{action}</div> : null}
    </div>
  );
}
