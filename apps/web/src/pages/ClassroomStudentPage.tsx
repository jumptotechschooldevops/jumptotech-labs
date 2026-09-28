/**
 * One student: the lab they have running, what they did recently, and their
 * last attempts. Support history, not analytics — bounded to the last 20
 * attempts and 50 events, and never what they typed.
 */
import {
  AttentionList,
  CLASSROOM_REFRESH_MS,
  Freshness,
  StaffErrorNotice,
  StateBadge,
  SupportId,
  Timeline,
  ago,
  usePolled,
} from '../components/classroom';
import { LoadingState, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { ATTEMPT_LABEL, formatMoment } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';

export function ClassroomStudentPage({ userId }: { userId: string }) {
  const polled = usePolled(() => api.classroom.student(userId), CLASSROOM_REFRESH_MS, userId);
  const { data } = polled;
  usePageTitle(data ? `${data.student.name} · Classroom` : 'Student · Classroom');

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
  if (!data) return <LoadingState label="Loading this student…" />;

  return (
    <div className="page ops">
      {back}
      <PageHeader
        eyebrow={data.role === 'STUDENT' ? 'Student' : data.role}
        title={data.student.name}
        description={data.student.email && data.student.email !== data.student.name ? data.student.email : undefined}
        actions={<Freshness polled={polled} />}
      />

      <section className="panel ops-section" aria-labelledby="ops-student-live">
        <h2 id="ops-student-live" className="panel__title">
          Lab running now
        </h2>
        {data.liveSessions.length === 0 ? (
          <p className="ops-muted">No lab running. The student can start one.</p>
        ) : (
          <ul className="plain-list">
            {data.liveSessions.map((row) => (
              <li key={row.sessionId}>
                <strong>{row.lab.id}</strong> {row.lab.title} <StateBadge state={row.state} /> started {ago(row.startedAt)} ·{' '}
                <SupportId sessionId={row.sessionId} />
                <AttentionList items={row.attention} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel ops-section" aria-labelledby="ops-student-timeline">
        <h2 id="ops-student-timeline" className="panel__title">
          Recent activity
        </h2>
        <Timeline events={data.timeline} showStudent={false} />
      </section>

      <section className="panel ops-section" aria-labelledby="ops-student-history">
        <h2 id="ops-student-history" className="panel__title">
          Recent attempts
        </h2>
        {data.history === null ? (
          <p className="ops-muted">Attempt history could not be read right now.</p>
        ) : data.history.length === 0 ? (
          <p className="ops-muted">No attempts yet.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <caption className="visually-hidden">Recent attempts</caption>
              <thead>
                <tr>
                  <th scope="col">Lab</th>
                  <th scope="col">Started</th>
                  <th scope="col">Result</th>
                  <th scope="col">Checks</th>
                  <th scope="col">Resets</th>
                  <th scope="col">Ended</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((attempt) => (
                  <tr key={attempt.attemptId}>
                    <td>
                      <span className="ops-lab">{attempt.labId}</span> <span className="ops-muted">{attempt.labTitle}</span>
                    </td>
                    <td>{formatMoment(attempt.startedAt)}</td>
                    <td>{ATTEMPT_LABEL[attempt.status as keyof typeof ATTEMPT_LABEL] ?? attempt.status}</td>
                    <td>{attempt.checkCount}</td>
                    <td>{attempt.resetCount}</td>
                    <td>{formatMoment(attempt.endedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.history && data.history.length >= data.historyLimit ? (
          <p className="ops-muted">The last {data.historyLimit} attempts.</p>
        ) : null}
      </section>
    </div>
  );
}
