/**
 * Left-hand lab brief.
 *
 * This component renders *any* lab. Every string comes from lab.yaml by way of
 * the API, and there is no branch anywhere on a lab id — adding K8S-011 shows
 * up here with no change to this file. Sections that a lab does not define
 * (a story, objectives, prerequisites) simply do not render.
 */
import type { LabDetail, LabHint } from '../lib/types';
import { HintPanel } from './HintPanel';

/** Split a YAML block scalar into paragraphs on blank lines. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function LabBrief({
  lab,
  onOpenLab,
  onHintReveal,
}: {
  lab: LabDetail;
  onOpenLab?: (labId: string) => void;
  /**
   * Called when the student reveals a hint, so it can be recorded against
   * their attempt. The brief itself stores nothing — it forwards the event.
   */
  onHintReveal?: (hint: LabHint, revealedCount: number) => void;
}) {
  return (
    <aside className="brief" aria-label="Lab instructions">
      <header className="brief__header">
        <div className="brief__id">{lab.id}</div>
        <h1 className="brief__title">{lab.title}</h1>
        <div className="brief__meta">
          <span className={`chip chip--${lab.difficulty}`}>{lab.difficulty}</span>
          <span className="chip chip--muted">{lab.durationMinutes} min</span>
          <span className="chip chip--muted">{lab.topicTitle || lab.topic}</span>
          {lab.certifications.map((cert) => (
            <span key={cert.certification} className="chip chip--cert">
              {cert.certification}
            </span>
          ))}
        </div>
      </header>

      {lab.prerequisites.length > 0 && (
        <section className="brief__section">
          <h2 className="brief__heading">Prerequisites</h2>
          <ul className="prereqs">
            {lab.prerequisites.map((prerequisite) => (
              <li key={prerequisite.id}>
                {onOpenLab && prerequisite.available ? (
                  <button
                    type="button"
                    className="prereqs__link"
                    onClick={() => onOpenLab(prerequisite.id)}
                  >
                    <span className="prereqs__id">{prerequisite.id}</span>
                    {prerequisite.title}
                  </button>
                ) : (
                  <span>
                    <span className="prereqs__id">{prerequisite.id}</span>
                    {prerequisite.title}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {/* Say plainly that this is advice. There are no accounts and no
              stored progress yet, so implying a gate would be a lie. */}
          {!lab.prerequisitesEnforced && (
            <p className="prereqs__note">
              Recommended background. Nothing stops you starting this lab now.
            </p>
          )}
        </section>
      )}

      {lab.story && (
        <section className="brief__section brief__section--story">
          <h2 className="brief__heading">Scenario</h2>
          {paragraphs(lab.story).map((paragraph, i) => (
            <p key={i} className="brief__story">
              {paragraph}
            </p>
          ))}
        </section>
      )}

      {lab.objectives.length > 0 && (
        <section className="brief__section">
          <h2 className="brief__heading">Objectives</h2>
          <ul className="objectives">
            {lab.objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="brief__section">
        <h2 className="brief__heading">Task</h2>
        <p className="brief__lead">{lab.task.summary}</p>
        {paragraphs(lab.task.description).map((paragraph, i) => (
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
        <h2 className="brief__heading">Official documentation</h2>
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

      <HintPanel hints={lab.hints} {...(onHintReveal ? { onReveal: onHintReveal } : {})} />

      {lab.skills.length > 0 && (
        <section className="brief__section">
          <h2 className="brief__heading">Skills practised</h2>
          <div className="skills">
            {lab.skills.map((skill) => (
              <span key={skill} className="skills__tag">
                {skill.split('.').slice(1).join(' · ') || skill}
              </span>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
