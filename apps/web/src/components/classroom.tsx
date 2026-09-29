/**
 * Pieces the classroom pages share: loading and refreshing, errors in staff
 * words, the state badge, attention, and the timeline.
 *
 * Refreshing is one request per page every `CLASSROOM_REFRESH_MS`, only while
 * the tab is visible, never overlapping itself, and immediately when the tab
 * comes back. A failed refresh keeps the last answer on screen and says how old
 * it is: an instructor mid-class needs a stale view labelled as stale, not a
 * blank page.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiRequestError } from '../lib/api';
import type { Attention, ClassroomEvent, ClassroomRow, Tone } from '../lib/classroomTypes';
import { formatMoment } from '../lib/format';
import { hrefFor } from '../lib/router';

export const CLASSROOM_REFRESH_MS = 15_000;

export interface Polled<T> {
  data: T | null;
  error: ApiRequestError | Error | null;
  loadedAt: number | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/** Load now, then every `intervalMs` while visible. `intervalMs` 0: load once. */
export function usePolled<T>(load: () => Promise<T>, intervalMs: number, key: string): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  const mounted = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    setRefreshing(true);
    try {
      const next = await loadRef.current();
      // An older request answering after a newer one never wins.
      if (!mounted.current || ticket !== latest.current) return;
      setData(next);
      setError(null);
      setLoadedAt(Date.now());
    } catch (cause) {
      if (!mounted.current || ticket !== latest.current) return;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (mounted.current && ticket === latest.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setData(null);
    setError(null);
    setLoadedAt(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== 'hidden') await refresh();
      if (!stopped && intervalMs > 0) timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      mounted.current = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, intervalMs, refresh]);

  return { data, error, loadedAt, refreshing, refresh };
}

export interface StaffError {
  title: string;
  message: string;
  guidance?: string;
  code: string;
}

/** An API failure, as an instructor needs it: what, and what to do. Never a stack. */
export function staffError(error: unknown): StaffError {
  if (error instanceof ApiRequestError) {
    const { status } = error;
    const code = error.error.code;
    if (status === 0) {
      return {
        title: 'Cannot reach JumpToTech Labs',
        message: 'The platform did not answer. Your connection may have dropped, or the platform may be down.',
        guidance: 'This page keeps retrying. If other people cannot reach the site either, that is a P0: escalate to DevOps.',
        code,
      };
    }
    if (status === 401) {
      return { title: 'You are signed out', message: 'Sign in again to see the classroom.', code };
    }
    if (status === 403) {
      return {
        title: 'Not available for your account',
        message: error.error.message || 'The classroom view is for instructors and administrators.',
        guidance: 'If you teach a class and should see this page, ask an administrator to give your account the INSTRUCTOR role.',
        code,
      };
    }
    return {
      title: status === 404 ? 'Not found' : status >= 500 ? 'The platform could not answer' : 'That did not work',
      message: error.error.message,
      ...(error.error.remediation ? { guidance: error.error.remediation } : {}),
      code,
    };
  }
  return {
    title: 'Something went wrong',
    message: error instanceof Error ? error.message : String(error),
    code: 'UNEXPECTED_ERROR',
  };
}

export function StaffErrorNotice({ error, actions, headingLevel = 2 }: { error: unknown; actions?: ReactNode; headingLevel?: 1 | 2 }) {
  const described = staffError(error);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <div className="notice notice--danger" role="alert">
      <Heading className="notice__title">{described.title}</Heading>
      <p className="notice__message">{described.message}</p>
      {described.guidance ? <p className="notice__guidance">{described.guidance}</p> : null}
      {actions ? <div className="notice__actions">{actions}</div> : null}
      <p className="notice__reference">
        Reference: <code>{described.code}</code>
      </p>
    </div>
  );
}

/** "Updated 10:04:31" and, when the last refresh failed, how stale the page is. */
export function Freshness({ polled }: { polled: Pick<Polled<unknown>, 'loadedAt' | 'error' | 'refreshing' | 'refresh'> }) {
  const time = polled.loadedAt ? new Date(polled.loadedAt).toLocaleTimeString() : null;
  return (
    <div className="ops-freshness">
      {polled.error && time ? (
        <span className="ops-freshness__stale" role="status">
          Could not refresh — showing what was true at {time}
        </span>
      ) : time ? (
        <span className="ops-freshness__time">Updated {time}</span>
      ) : null}
      <button type="button" className="btn btn--ghost btn--small" onClick={() => void polled.refresh()} disabled={polled.refreshing}>
        {polled.refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}

const TONE_BADGE: Record<Tone, string> = {
  ok: 'badge--success',
  progress: 'badge--info',
  attention: 'badge--warning',
  problem: 'badge--danger',
  done: '',
};

export function StateBadge({ state }: { state: { label: string; tone: Tone } }) {
  return <span className={`badge ${TONE_BADGE[state.tone]}`}>{state.label}</span>;
}

export function AttentionList({ items }: { items: Attention[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="ops-attention">
      {items.map((item) => (
        <li key={item.code} className={`ops-attention__item ops-attention__item--${item.severity}`}>
          <strong>{item.message}</strong> <span className="ops-attention__next">{item.nextStep}</span>
        </li>
      ))}
    </ul>
  );
}

export function StudentName({ student }: { student: ClassroomRow['student'] }) {
  if (!student) return <span className="ops-muted">No owner</span>;
  return (
    <a className="text-link" href={hrefFor({ name: 'classroomStudent', userId: student.userId })}>
      {student.name}
    </a>
  );
}

export function SupportId({ sessionId }: { sessionId: string }) {
  return (
    <a className="mono-id" href={hrefFor({ name: 'classroomSession', sessionId })} title="Open this lab’s details">
      {sessionId}
    </a>
  );
}

/** "3 min ago" for recent moments, the date and time beyond an hour. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return formatMoment(iso);
}

const BY_LABEL: Record<ClassroomEvent['by'], string> = { student: 'student', staff: 'staff', platform: 'platform' };

export function Timeline({ events, showStudent = false }: { events: ClassroomEvent[]; showStudent?: boolean }) {
  if (events.length === 0) return <p className="ops-muted">Nothing recorded yet.</p>;
  return (
    <ol className="ops-timeline">
      {events.map((event) => (
        <li key={event.eventId} className={event.problem ? 'ops-timeline__item ops-timeline__item--problem' : 'ops-timeline__item'}>
          <time dateTime={event.at} className="ops-timeline__when">
            {formatMoment(event.at)}
          </time>
          <span className="ops-timeline__text">
            {event.text}
            {showStudent && event.student ? <> · <StudentName student={event.student} /></> : null}
            {showStudent ? <> · {event.lab.id}</> : null}
          </span>
          <span className="ops-timeline__meta">
            by {BY_LABEL[event.by]}
            {event.code ? <> · <code>{event.code}</code></> : null}
            {event.sessionId && showStudent ? <> · <SupportId sessionId={event.sessionId} /></> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
