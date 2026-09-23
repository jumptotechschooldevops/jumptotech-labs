/**
 * A platform error, explained.
 *
 * Title, what happened, what to do, and the API's code as a small reference a
 * student can quote to an instructor. The code is never the headline and never
 * hidden — see `lib/errors.ts`.
 */
import type { ReactNode } from 'react';
import type { ErrorKind, StudentError } from '../lib/errors';

const TONE: Record<ErrorKind, 'danger' | 'warning' | 'info'> = {
  capacity: 'warning',
  'student-limit': 'info',
  auth: 'warning',
  access: 'warning',
  network: 'danger',
  'not-found': 'warning',
  'not-ready': 'warning',
  unavailable: 'warning',
  environment: 'danger',
  failed: 'danger',
  pending: 'info',
  unknown: 'danger',
};

export function ErrorNotice({
  error,
  actions,
  headingLevel = 2,
  live = true,
}: {
  error: StudentError;
  actions?: ReactNode;
  /** 1 when the notice *is* the page (a page that could not load), so it keeps an h1. */
  headingLevel?: 1 | 2 | 3;
  /**
   * Announce it. True for an error that appears in response to something the
   * student did; false for one that is simply part of a page as it loads.
   */
  live?: boolean;
}) {
  const Heading = headingLevel === 1 ? 'h1' : headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={`notice notice--${TONE[error.kind]}`} role={live ? 'alert' : undefined}>
      <Heading className="notice__title">{error.title}</Heading>
      <p className="notice__message">{error.message}</p>
      {error.guidance ? <p className="notice__guidance">{error.guidance}</p> : null}
      {actions ? <div className="notice__actions">{actions}</div> : null}
      <p className="notice__reference">
        Reference: <code>{error.reference}</code>
      </p>
    </div>
  );
}
