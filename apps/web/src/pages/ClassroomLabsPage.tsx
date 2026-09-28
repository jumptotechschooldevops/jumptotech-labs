/**
 * Which labs can run on this platform right now, and how many are running.
 * Read-only: the catalog is changed in the repository, not here.
 */
import { useMemo, useState } from 'react';
import { Freshness, StaffErrorNotice, usePolled } from '../components/classroom';
import { LoadingState, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { hrefFor, usePageTitle } from '../lib/router';

/** Availability changes rarely; once a minute is plenty. */
const LABS_REFRESH_MS = 60_000;

export function ClassroomLabsPage() {
  usePageTitle('Lab availability · Classroom');
  const polled = usePolled(() => api.classroom.labs(), LABS_REFRESH_MS, 'labs');
  const [filter, setFilter] = useState('');
  const { data } = polled;

  const labs = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = data?.labs ?? [];
    return needle
      ? all.filter((lab) => `${lab.id} ${lab.title} ${lab.track} ${lab.runtime}`.toLowerCase().includes(needle))
      : all;
  }, [data, filter]);

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
  if (!data) return <LoadingState label="Loading lab availability…" />;

  const unavailable = data.labs.filter((lab) => lab.runnable === false).length;

  return (
    <div className="page ops">
      {back}
      <PageHeader
        title="Lab availability"
        description={`${data.count} labs in the catalog; ${data.count - unavailable} can start on this platform right now.`}
        actions={<Freshness polled={polled} />}
      />
      <label className="field">
        <span className="field__label">Filter</span>
        <input className="input" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="K8S, docker, terraform…" />
      </label>
      <div className="ops-table-wrap">
        <table className="ops-table">
          <caption className="visually-hidden">Labs and whether they can start</caption>
          <thead>
            <tr>
              <th scope="col">Lab</th>
              <th scope="col">Track</th>
              <th scope="col">Needs</th>
              <th scope="col">Can start?</th>
              <th scope="col">Running</th>
            </tr>
          </thead>
          <tbody>
            {labs.map((lab) => (
              <tr key={lab.id}>
                <td>
                  <span className="ops-lab">{lab.id}</span> <span className="ops-muted">{lab.title}</span>
                </td>
                <td>{lab.track}</td>
                <td>{lab.runtime}</td>
                <td>
                  <span className={`badge ${lab.runnable ? 'badge--success' : lab.runnable === false ? 'badge--danger' : 'badge--warning'}`}>
                    {lab.availability}
                  </span>
                </td>
                <td>{lab.running}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
