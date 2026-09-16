/**
 * Every learning path. Today there is one; the page exists so `#/paths` is a
 * real address and a second path appears without a code change.
 */
import { useEffect, useState } from 'react';
import { ErrorNotice } from '../components/ErrorNotice';
import { EmptyState, LoadingState, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { describeError, toApiError } from '../lib/errors';
import { formatMinutes, plural } from '../lib/format';
import { hrefFor, usePageTitle } from '../lib/router';
import type { ApiError, LearningPathSummary } from '../lib/types';

export function LearningPathsPage() {
  const [paths, setPaths] = useState<LearningPathSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [request, setRequest] = useState(0);

  usePageTitle('Learning paths');

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPaths(null);
    Promise.resolve()
      .then(() => api.listLearningPaths())
      .then((result) => {
        if (!cancelled) setPaths(result.learningPaths);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(toApiError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Learning paths"
        title="Learning paths"
        description="Guided routes through the labs, in the order that makes each skill easier to learn."
      />
      {error ? (
        <ErrorNotice
          error={describeError(error, 'load')}
          actions={
            <button type="button" className="btn btn--secondary" onClick={() => setRequest((n) => n + 1)}>
              Try again
            </button>
          }
        />
      ) : paths === null ? (
        <LoadingState label="Loading learning paths…" />
      ) : paths.length === 0 ? (
        <EmptyState title="No learning paths yet">
          <p>Every lab is still available from the lab catalog.</p>
        </EmptyState>
      ) : (
        <ul className="path-cards">
          {paths.map((path) => (
            <li key={path.id} className="panel">
              <h2 className="panel__title">
                <a className="text-link" href={hrefFor({ name: 'path', pathId: path.id })}>
                  {path.title} path
                </a>
              </h2>
              <p className="panel__text">{path.summary}</p>
              <p className="panel__meta">
                {plural(path.totals.stages, 'stage')} · {plural(path.totals.labs, 'lab')} · about{' '}
                {formatMinutes(path.totals.estimatedMinutes.core)} of core lab time ·{' '}
                {plural(path.totals.comingSoonStages, 'stage')} coming soon
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
