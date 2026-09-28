/**
 * One student's lab, by Support ID: its state, what needs doing, what happened
 * to it, and — for an administrator — ending it.
 *
 * Ending names the student, the lab and the Support ID before it asks, and the
 * request repeats the Support ID as its confirmation; the server refuses it
 * otherwise, and refuses it for anyone but an ADMIN whatever this page shows.
 */
import { useState } from 'react';
import {
  AttentionList,
  CLASSROOM_REFRESH_MS,
  Freshness,
  StaffErrorNotice,
  StateBadge,
  StudentName,
  Timeline,
  ago,
  usePolled,
} from '../components/classroom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LoadingState, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import type { StaffEndResponse } from '../lib/classroomTypes';
import { formatMoment } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';

const ENVIRONMENT_WORDS: Record<string, string> = {
  ready: 'Reachable — the runtime reports the lab environment ready',
  provisioning: 'Still being prepared',
  degraded: 'Partly working — some of the environment is not healthy',
  not_created: 'Missing — the platform thinks this lab is running, but the runtime has no such environment',
  error: 'Not reachable — the runtime could not be read',
  unknown: 'Unknown — the runtime did not answer',
};

export function ClassroomSessionPage({ sessionId }: { sessionId: string }) {
  usePageTitle(`Lab ${sessionId}`);
  const polled = usePolled(() => api.classroom.session(sessionId), CLASSROOM_REFRESH_MS, sessionId);
  const [confirming, setConfirming] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<unknown>(null);
  const [ended, setEnded] = useState<StaffEndResponse | null>(null);
  const { data } = polled;

  const back = (
    <a className="text-link" href={hrefFor({ name: 'classroom' })}>
      ← Classroom
    </a>
  );

  if (!data && polled.error) {
    return (
      <div className="page">
        {back}
        <StaffErrorNotice error={polled.error} headingLevel={1} />
      </div>
    );
  }
  if (!data) return <LoadingState label="Loading this lab…" />;

  const row = data.session;
  const student = row?.student ?? data.summary?.student ?? null;
  const lab = row?.lab ?? data.summary?.lab;

  const endLab = async () => {
    setEnding(true);
    setEndError(null);
    try {
      setEnded(await api.classroom.endSession(sessionId));
      setConfirming(false);
      await polled.refresh();
    } catch (cause) {
      setEndError(cause);
      setConfirming(false);
      await polled.refresh();
    } finally {
      setEnding(false);
    }
  };

  return (
    <div className="page ops">
      {back}
      <PageHeader
        eyebrow={
          <>
            Support ID <code data-testid="support-id">{sessionId}</code>
          </>
        }
        title={
          <>
            {lab ? `${lab.id} · ${lab.title}` : sessionId}
          </>
        }
        description={
          <>
            Student: <StudentName student={student} />
            {student?.email && student.email !== student.name ? <span className="ops-muted"> · {student.email}</span> : null}
          </>
        }
        actions={<Freshness polled={polled} />}
      />

      {ended ? (
        <div className={`notice ${ended.cleanup === 'confirmed' ? 'notice--info' : 'notice--warning'}`} role="status">
          <p className="notice__message">
            {ended.cleanup === 'confirmed'
              ? 'The lab was ended and its environment is confirmed removed. The slot is free.'
              : ended.note}
          </p>
        </div>
      ) : null}
      {endError ? <StaffErrorNotice error={endError} /> : null}

      {!row ? (
        <section className="panel">
          <p>{data.summary?.note}</p>
        </section>
      ) : (
        <section className="panel ops-section" aria-labelledby="ops-state">
          <h2 id="ops-state" className="panel__title">
            State: <StateBadge state={row.state} />
          </h2>
          <AttentionList items={row.attention} />
          <dl className="definition-list ops-facts">
            <dt>Lab type</dt>
            <dd>{row.runtime}</dd>
            <dt>Started</dt>
            <dd>
              {formatMoment(row.startedAt)} ({ago(row.startedAt)})
            </dd>
            <dt>In this state since</dt>
            <dd>{formatMoment(row.statusChangedAt)}</dd>
            <dt>Last student activity</dt>
            <dd>
              {ago(row.lastActivityAt)}
              <span className="ops-muted"> — terminal typing, Check, Reset or Continue</span>
            </dd>
            {row.occupiesSlot ? (
              <>
                <dt>Closes</dt>
                <dd>
                  {formatMoment(row.expiresAt)} at the latest
                  {row.status === 'ACTIVE' ? `; after ${Math.max(1, Math.round(row.secondsUntilIdle / 60))} more idle minute(s)` : ''}
                </dd>
              </>
            ) : (
              <>
                <dt>Ended</dt>
                <dd>{formatMoment(row.endedAt ?? row.statusChangedAt)}</dd>
              </>
            )}
            <dt>Last Check</dt>
            <dd>{row.lastCheck ? `${row.lastCheck.text} (${ago(row.lastCheck.at)})` : 'Not yet'}</dd>
            <dt>Last Reset</dt>
            <dd>{row.lastReset ? `${row.lastReset.text} (${ago(row.lastReset.at)})` : 'Not yet'}</dd>
            <dt>Cleanup</dt>
            <dd>
              {row.cleanup === 'confirmed'
                ? 'Confirmed — the environment is gone'
                : row.cleanup === 'in-progress'
                  ? 'In progress — the platform retries until the environment is gone'
                  : row.cleanup === 'not-needed'
                    ? 'Nothing to clean up'
                    : 'Not started — the lab is still in use'}
            </dd>
            {data.environment ? (
              <>
                <dt>Environment</dt>
                <dd data-testid="environment">
                  {ENVIRONMENT_WORDS[data.environment.phase] ?? data.environment.phase}
                  <span className="ops-muted"> (asked {ago(data.environment.checkedAt)})</span>
                </dd>
              </>
            ) : null}
            {data.attempt ? (
              <>
                <dt>This attempt</dt>
                <dd>
                  {data.attempt.checkCount} Check{data.attempt.checkCount === 1 ? '' : 's'} graded, {data.attempt.resetCount}{' '}
                  Reset{data.attempt.resetCount === 1 ? '' : 's'}
                  {data.attempt.completedAt ? ' — completed' : ''}
                </dd>
              </>
            ) : null}
          </dl>
          {row.operator ? (
            <details className="ops-operator">
              <summary>Operator detail</summary>
              <dl className="definition-list">
                <dt>Sandbox</dt>
                <dd>
                  <code>{row.operator.sandboxRef}</code>
                </dd>
                {row.operator.namespace ? (
                  <>
                    <dt>Namespace</dt>
                    <dd>
                      <code>{row.operator.namespace}</code>
                    </dd>
                  </>
                ) : null}
                {row.operator.statusReason ? (
                  <>
                    <dt>Status reason</dt>
                    <dd>
                      <code>{row.operator.statusReason}</code>
                    </dd>
                  </>
                ) : null}
              </dl>
            </details>
          ) : null}
          {data.actions.canEnd ? (
            <div className="ops-actions">
              <button type="button" className="btn btn--danger-outline" onClick={() => setConfirming(true)} disabled={ending}>
                End this student’s lab…
              </button>
              <p className="ops-muted">
                Only when the student cannot end it themselves. Their work in the environment is deleted; their progress is kept.
              </p>
            </div>
          ) : null}
        </section>
      )}

      <section className="panel ops-section" aria-labelledby="ops-timeline">
        <h2 id="ops-timeline" className="panel__title">
          What happened
        </h2>
        <Timeline events={data.timeline} />
      </section>

      <ConfirmDialog
        open={confirming}
        title="End this student’s lab?"
        confirmLabel="End lab"
        busyLabel="Ending…"
        busy={ending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void endLab()}
      >
        <dl className="definition-list">
          <dt>Student</dt>
          <dd>{student?.name ?? 'No owner'}</dd>
          <dt>Lab</dt>
          <dd>{lab ? `${lab.id} — ${lab.title}` : '—'}</dd>
          <dt>Support ID</dt>
          <dd>
            <code>{sessionId}</code>
          </dd>
        </dl>
        <p>
          The lab environment and everything the student did in it are deleted. Their progress and completed labs are kept,
          and they can start again. This is recorded under your account.
        </p>
      </ConfirmDialog>
    </div>
  );
}
