import { useEffect, useState } from 'react';
import { ApiRequestError, api } from '../lib/api';
import type { ApiError, LabSummary } from '../lib/types';

export function CatalogPage({ onOpenLab }: { onOpenLab: (labId: string) => void }) {
  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listLabs()
      .then((data) => {
        if (!cancelled) setLabs(data.labs);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiRequestError
            ? err.error
            : { code: 'UNEXPECTED_ERROR', message: String(err) },
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tracks = [...new Set((labs ?? []).map((l) => l.track))].sort();

  return (
    <div className="page">
      <header className="topbar">
        <span className="topbar__brand">
          <span className="topbar__logo" aria-hidden="true">◆</span>
          JumpToTech <span className="topbar__brand-light">Labs</span>
        </span>
        <div className="topbar__center" />
        <div className="topbar__right">
          <span className="topbar__track">catalog</span>
        </div>
      </header>

      <main className="catalog">
        <div className="catalog__intro">
          <h1>Practice environments, not slideshows</h1>
          <p>
            Launch a disposable Kubernetes environment in your browser, run real commands, and have
            your work verified against live cluster state.
          </p>
        </div>

        {error && (
          <div className="message-card" role="alert">
            <h2>{error.code}</h2>
            <p>{error.message}</p>
            {error.remediation && <p className="message-card__hint">{error.remediation}</p>}
          </div>
        )}

        {!labs && !error && <p className="catalog__loading">Loading labs…</p>}

        {labs && labs.length === 0 && (
          <div className="message-card">
            <h2>No labs found</h2>
            <p>The API loaded zero lab definitions. Check the labs/ directory and LABS_DIR.</p>
          </div>
        )}

        {tracks.map((track) => (
          <section key={track} className="catalog__track">
            <h2 className="catalog__track-title">{track}</h2>
            <div className="catalog__grid">
              {labs
                ?.filter((lab) => lab.track === track)
                .map((lab) => (
                  <button
                    key={lab.id}
                    type="button"
                    className="labcard"
                    onClick={() => onOpenLab(lab.id)}
                  >
                    <div className="labcard__top">
                      <span className="labcard__id">{lab.id}</span>
                      <span className={`chip chip--${lab.difficulty}`}>{lab.difficulty}</span>
                    </div>
                    <h3 className="labcard__title">{lab.title}</h3>
                    <p className="labcard__summary">{lab.summary}</p>
                    <div className="labcard__footer">
                      <span>{lab.durationMinutes} min</span>
                      <span className="labcard__cta">Open lab →</span>
                    </div>
                  </button>
                ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
