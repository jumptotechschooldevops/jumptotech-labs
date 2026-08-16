/**
 * Left-hand lab brief. Every string here comes from lab.yaml via the API —
 * no lab content is hardcoded in the frontend.
 */
import { useState } from 'react';
import type { LabDetail } from '../lib/types';

export function LabBrief({ lab }: { lab: LabDetail }) {
  const [hintOpen, setHintOpen] = useState(false);

  return (
    <aside className="brief" aria-label="Lab instructions">
      <header className="brief__header">
        <div className="brief__id">{lab.id}</div>
        <h1 className="brief__title">{lab.title}</h1>
        <div className="brief__meta">
          <span className={`chip chip--${lab.difficulty}`}>{lab.difficulty}</span>
          <span className="chip chip--muted">{lab.durationMinutes} min</span>
          <span className="chip chip--muted">{lab.topic}</span>
        </div>
      </header>

      <section className="brief__section">
        <h2 className="brief__heading">Task</h2>
        <p className="brief__lead">{lab.task.summary}</p>
        {lab.task.description
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
          .map((paragraph, i) => (
            <p key={i} className="brief__body">
              {paragraph}
            </p>
          ))}
      </section>

      <section className="brief__section">
        <h2 className="brief__heading">Requirements</h2>
        <ul className="requirements">
          {lab.requirements.map((requirement) => (
            <li key={requirement}>{requirement}</li>
          ))}
        </ul>
      </section>

      <section className="brief__section">
        <h2 className="brief__heading">Documentation</h2>
        <ul className="doclinks">
          {lab.references.map((doc) => (
            <li key={doc.url}>
              <a href={doc.url} target="_blank" rel="noreferrer noopener">
                {doc.title}
                <span className="doclinks__arrow" aria-hidden="true">↗</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="brief__section">
        <button
          type="button"
          className="hint__toggle"
          onClick={() => setHintOpen((open) => !open)}
          aria-expanded={hintOpen}
        >
          <span className="hint__chevron" data-open={hintOpen} aria-hidden="true">▸</span>
          Hint
        </button>
        {hintOpen && (
          <div className="hint__body">
            {lab.hints.map((hint) => (
              <p key={hint.level}>{hint.text}</p>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
