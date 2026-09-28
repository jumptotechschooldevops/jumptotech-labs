/**
 * The classroom view — "everyone start K8S-001", and then who is where.
 *
 * One request (`GET /api/admin/classroom`) every 15 seconds while the tab is
 * visible. Everything shown is the server's answer; nothing is remembered in
 * the browser, so a refresh, a second instructor or a sign-in round trip sees
 * the same page.
 */
import { useState, type FormEvent } from 'react';
import {
  AttentionList,
  CLASSROOM_REFRESH_MS,
  Freshness,
  StaffErrorNotice,
  StateBadge,
  StudentName,
  SupportId,
  Timeline,
  ago,
  usePolled,
} from '../components/classroom';
import { LoadingState, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { SUPPORT_ID_SHAPE, type ClassroomOverview, type ClassroomRow, type StudentSearchResponse } from '../lib/classroomTypes';
import { formatMoment } from '../lib/format';
import { hrefFor, navigate, usePageTitle } from '../lib/router';

function CapacityPanel({ capacity }: { capacity: ClassroomOverview['capacity'] }) {
  return (
    <section className={`panel ops-stat ${capacity.full ? 'ops-stat--problem' : ''}`} aria-labelledby="ops-capacity">
      <h2 id="ops-capacity" className="ops-stat__label">
        Labs running
      </h2>
      <p className="ops-stat__value" data-testid="capacity">
        {capacity.active} / {capacity.max}
      </p>
      <p className="ops-stat__note">
        {capacity.full
          ? 'Classroom capacity reached — the next student to press Start is refused until someone ends a lab.'
          : `${capacity.available} ${capacity.available === 1 ? 'slot' : 'slots'} free.`}
        {capacity.perStudentLimit ? ` Each student may run ${capacity.perStudentLimit} at a time.` : ''}
      </p>
    </section>
  );
}

function NewLabsPanel({ data }: { data: ClassroomOverview }) {
  const tone = data.newLabs.verdict === 'yes' ? '' : data.newLabs.verdict === 'degraded' ? 'ops-stat--attention' : 'ops-stat--problem';
  return (
    <section className={`panel ops-stat ${tone}`} aria-labelledby="ops-newlabs">
      <h2 id="ops-newlabs" className="ops-stat__label">
        Can students start labs?
      </h2>
      <p className="ops-stat__value ops-stat__value--text" data-testid="new-labs">
        {data.newLabs.summary}
      </p>
      {data.newLabs.reasons.length > 0 ? (
        <ul className="plain-list ops-stat__reasons">
          {data.newLabs.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {data.newLabs.operatorReasons && data.newLabs.operatorReasons.length > 0 ? (
        <details className="ops-operator">
          <summary>Operator detail</summary>
          <ul className="plain-list">
            {data.newLabs.operatorReasons.map((reason) => (
              <li key={reason}>
                <code>{reason}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function RuntimesPanel({ data }: { data: ClassroomOverview }) {
  return (
    <section className="panel ops-stat" aria-labelledby="ops-runtimes">
      <h2 id="ops-runtimes" className="ops-stat__label">
        Lab types
      </h2>
      <ul className="plain-list ops-runtimes">
        {data.runtimes.map((runtime) => (
          <li key={runtime.provider}>
            <span>{runtime.label}</span>{' '}
            <span
              className={`badge ${runtime.state === 'available' ? 'badge--success' : runtime.state === 'unavailable' ? 'badge--danger' : ''}`}
            >
              {runtime.state === 'available' ? 'Available' : runtime.state === 'unavailable' ? 'Unavailable' : 'Not offered'}
            </span>
            {runtime.detail ? <code className="ops-runtimes__detail">{runtime.detail}</code> : null}
          </li>
        ))}
      </ul>
      {!data.cleanupWorker.healthy ? (
        <p className="ops-stat__note ops-stat__note--problem">Finished labs are not being cleaned up. Escalate to DevOps.</p>
      ) : null}
      <a className="text-link" href={hrefFor({ name: 'classroomLabs' })}>
        Which labs can run →
      </a>
    </section>
  );
}

function FindBox() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<StudentSearchResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (SUPPORT_ID_SHAPE.test(q)) {
      navigate({ name: 'classroomSession', sessionId: q });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await api.classroom.searchStudents(q));
    } catch (cause) {
      setResult(null);
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="ops-find">
      <h2 id="ops-find" className="panel__title">
        Find a student or a lab
      </h2>
      <form className="ops-find" onSubmit={(event) => void onSubmit(event)} role="search">
        <label className="field field--grow">
          <span className="field__label">Name, email, or the Support ID the student sees</span>
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            minLength={2}
            maxLength={64}
            required
            placeholder="dana@example.com or sess-…"
          />
        </label>
        <button type="submit" className="btn btn--secondary" disabled={busy}>
          {busy ? 'Searching…' : 'Find'}
        </button>
      </form>
      {error ? <StaffErrorNotice error={error} /> : null}
      {result ? (
        result.students.length === 0 ? (
          <p className="ops-muted">No student matches “{result.query}”.</p>
        ) : (
          <ul className="plain-list ops-find__results" aria-label="Students found">
            {result.students.map((entry) => (
              <li key={entry.student.userId}>
                <StudentName student={entry.student} />
                {entry.student.email && entry.student.email !== entry.student.name ? (
                  <span className="ops-muted"> · {entry.student.email}</span>
                ) : null}
                {entry.role !== 'STUDENT' ? <span className="badge">{entry.role}</span> : null}
                {' — '}
                {entry.liveSessions.length === 0 ? (
                  <span className="ops-muted">no lab running</span>
                ) : (
                  entry.liveSessions.map((row) => (
                    <span key={row.sessionId}>
                      {row.lab.id} <StateBadge state={row.state} /> <SupportId sessionId={row.sessionId} />
                    </span>
                  ))
                )}
              </li>
            ))}
            {result.students.length >= result.limit ? (
              <li className="ops-muted">Showing the first {result.limit}. Type more of the name to narrow it.</li>
            ) : null}
          </ul>
        )
      ) : null}
    </section>
  );
}

function SessionsTable({ rows, caption, finished = false }: { rows: ClassroomRow[]; caption: string; finished?: boolean }) {
  return (
    <div className="ops-table-wrap">
      <table className="ops-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Student</th>
            <th scope="col">Lab</th>
            <th scope="col">State</th>
            <th scope="col">{finished ? 'Ended' : 'Started'}</th>
            {finished ? <th scope="col">Cleanup</th> : <th scope="col">Last activity</th>}
            <th scope="col">Last Check</th>
            <th scope="col">Support ID</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sessionId} data-testid={`row-${row.sessionId}`}>
              <td>
                <StudentName student={row.student} />
              </td>
              <td>
                <span className="ops-lab">{row.lab.id}</span> <span className="ops-muted">{row.lab.title}</span>
              </td>
              <td>
                <StateBadge state={row.state} />
                <AttentionList items={row.attention} />
              </td>
              <td>{finished ? formatMoment(row.endedAt ?? row.statusChangedAt) : ago(row.startedAt)}</td>
              {finished ? (
                <td>{row.cleanup === 'confirmed' ? 'Confirmed' : row.cleanup === 'automatic' ? 'Slot released' : 'In progress'}</td>
              ) : (
                <td>{ago(row.lastActivityAt)}</td>
              )}
              <td>
                {row.lastCheck ? (
                  <span className={row.lastCheck.outcome === 'error' ? 'ops-problem' : undefined}>{row.lastCheck.text}</span>
                ) : (
                  <span className="ops-muted">Not yet</span>
                )}
              </td>
              <td>
                <SupportId sessionId={row.sessionId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClassroomPage() {
  usePageTitle('Classroom');
  const polled = usePolled(() => api.classroom.overview(), CLASSROOM_REFRESH_MS, 'overview');
  const { data } = polled;

  if (!data && polled.error) {
    return (
      <div className="page">
        <StaffErrorNotice
          error={polled.error}
          headingLevel={1}
          actions={
            <button type="button" className="btn btn--secondary" onClick={() => void polled.refresh()}>
              Try again
            </button>
          }
        />
      </div>
    );
  }
  if (!data) return <LoadingState label="Loading the classroom…" />;

  const needAttention = data.sessions.filter((row) => row.attention.length > 0);

  return (
    <div className="page ops">
      <PageHeader
        eyebrow={data.viewer.role === 'ADMIN' ? 'Administrator' : 'Instructor'}
        title="Classroom"
        description="Every student’s lab, as the platform sees it now. Refreshes every 15 seconds."
        actions={<Freshness polled={polled} />}
      />

      <div className="ops-stats">
        <CapacityPanel capacity={data.capacity} />
        <NewLabsPanel data={data} />
        <RuntimesPanel data={data} />
      </div>

      <FindBox />

      {needAttention.length > 0 ? (
        <section className="panel ops-section" aria-labelledby="ops-attention-title">
          <h2 id="ops-attention-title" className="panel__title">
            Needs attention ({needAttention.length})
          </h2>
          <SessionsTable rows={needAttention} caption="Labs that need attention" />
        </section>
      ) : null}

      <section className="panel ops-section" aria-labelledby="ops-running-title">
        <h2 id="ops-running-title" className="panel__title">
          Labs in progress ({data.sessions.length})
        </h2>
        {data.sessions.length === 0 ? (
          <p className="ops-muted">No student has a lab running.</p>
        ) : (
          <SessionsTable rows={data.sessions} caption="Labs in progress" />
        )}
      </section>

      <section className="panel ops-section" aria-labelledby="ops-problems-title">
        <h2 id="ops-problems-title" className="panel__title">
          Problems in the last hour ({data.problems.length})
        </h2>
        <p className="panel__lead">
          Starts that were refused or failed, Checks that could not run, Resets that failed, and cleanups still running. A
          Check that ran and found the lab unfinished is not a problem and is not listed.
        </p>
        <Timeline events={data.problems} showStudent />
      </section>

      <section className="panel ops-section" aria-labelledby="ops-recent-title">
        <h2 id="ops-recent-title" className="panel__title">
          Recently finished ({data.recent.length})
        </h2>
        {data.recent.length === 0 ? (
          <p className="ops-muted">No lab has finished in the last few minutes.</p>
        ) : (
          <SessionsTable rows={data.recent} caption="Recently finished labs" finished />
        )}
      </section>
    </div>
  );
}
