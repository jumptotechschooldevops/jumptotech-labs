/**
 * A lab's definition, rendered.
 *
 * This component renders *any* lab. Every string comes from lab.yaml by way of
 * the API, and there is no branch anywhere on a lab id — a new lab shows up here
 * with no change to this file. Sections a lab does not define (a story,
 * objectives, prerequisites) simply do not render.
 *
 * The same renderer serves two places: the lab page, where the student reads
 * before launching (no hints — a hint revealed there has no attempt to be
 * recorded against), and the workspace's instructions panel, where the
 * checklist also shows what the last verification found.
 */
import { hrefFor } from '../lib/router';
import { formatMinutes, skillLabel } from '../lib/format';
import type { CheckResult, LabDetail, LabHint } from '../lib/types';
import { HintPanel } from './HintPanel';
import { InlineText, Paragraphs } from './RichText';
import { DifficultyBadge } from './ui';

/**
 * Match the last verification's checks to the requirement labels.
 *
 * The verifier returns checks in requirement order with the same labels, so
 * index-and-label is exact. If the lab changed underneath a stale result the
 * lengths or labels differ, and nothing is matched rather than something
 * wrong.
 */
function statusByRequirement(requirements: string[], checks: CheckResult[] | undefined) {
  if (!checks || checks.length !== requirements.length) return null;
  const statuses = requirements.map((label, index) => (checks[index]?.label === label ? checks[index] : undefined));
  return statuses.every(Boolean) ? (statuses as CheckResult[]) : null;
}

const CHECK_TEXT: Record<CheckResult['status'], { mark: string; label: string }> = {
  pass: { mark: '✓', label: 'passed' },
  fail: { mark: '✗', label: 'not yet passing' },
  skipped: { mark: '–', label: 'not checked' },
};

export function LabBrief({
  lab,
  onHintReveal,
  showHeader = true,
  showHints = true,
  hintsRevealed,
  checks,
}: {
  lab: LabDetail;
  /**
   * Called when the student reveals a hint, so it can be recorded against
   * their attempt. The brief itself stores nothing — it forwards the event.
   */
  onHintReveal?: (hint: LabHint, revealedCount: number) => void;
  showHeader?: boolean;
  showHints?: boolean;
  /** Hints this attempt revealed before the page loaded. */
  hintsRevealed?: number;
  /** The last verification's checks, to mark the checklist. */
  checks?: CheckResult[];
}) {
  const matched = statusByRequirement(lab.requirements, checks);

  return (
    <div className="brief">
      {showHeader ? (
        <header className="brief__header">
          <div className="brief__id">{lab.id}</div>
          <h1 className="brief__title">{lab.title}</h1>
          <div className="brief__meta">
            <DifficultyBadge difficulty={lab.difficulty} />
            <span className="badge badge--neutral">{formatMinutes(lab.durationMinutes)}</span>
            <span className="badge badge--neutral">{lab.topicTitle || lab.topic}</span>
          </div>
        </header>
      ) : null}

      <section className="brief__section" aria-labelledby={`${lab.id}-task`}>
        <h2 className="brief__heading" id={`${lab.id}-task`}>
          Your task
        </h2>
        <p className="brief__lead">
          <InlineText text={lab.task.summary} />
        </p>
        <Paragraphs text={lab.task.description} className="brief__body" />
      </section>

      <section className="brief__section" aria-labelledby={`${lab.id}-checks`}>
        <h2 className="brief__heading" id={`${lab.id}-checks`}>
          What Verify checks
          {matched ? (
            <span className="brief__heading-meta">
              {matched.filter((check) => check.status === 'pass').length} of {matched.length} passing
            </span>
          ) : null}
        </h2>
        <ol className={`checklist${matched ? ' checklist--checked' : ''}`}>
          {lab.requirements.map((requirement, index) => {
            const check = matched?.[index];
            return (
              <li
                key={`${index}-${requirement}`}
                className={`checklist__item${check ? ` checklist__item--${check.status}` : ''}`}
              >
                <span className="checklist__mark" aria-hidden="true">
                  {check ? CHECK_TEXT[check.status].mark : index + 1}
                </span>
                <span className="checklist__label">
                  <InlineText text={requirement} />
                  {check ? <span className="visually-hidden"> — {CHECK_TEXT[check.status].label}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
        {!matched ? (
          <p className="brief__note">Verify reads the real state of your environment — how you got there does not matter.</p>
        ) : null}
      </section>

      {showHints ? (
        <HintPanel
          hints={lab.hints}
          {...(onHintReveal ? { onReveal: onHintReveal } : {})}
          {...(hintsRevealed ? { alreadyRevealed: hintsRevealed } : {})}
        />
      ) : null}

      {lab.story ? (
        <section className="brief__section brief__section--story" aria-labelledby={`${lab.id}-story`}>
          <h2 className="brief__heading" id={`${lab.id}-story`}>
            Scenario
          </h2>
          <Paragraphs text={lab.story} className="brief__story" />
        </section>
      ) : null}

      {lab.objectives.length > 0 ? (
        <section className="brief__section" aria-labelledby={`${lab.id}-objectives`}>
          <h2 className="brief__heading" id={`${lab.id}-objectives`}>
            What you will learn
          </h2>
          <ul className="objectives">
            {lab.objectives.map((objective) => (
              <li key={objective}>
                <InlineText text={objective} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {lab.prerequisites.length > 0 ? (
        <section className="brief__section" aria-labelledby={`${lab.id}-prereqs`}>
          <h2 className="brief__heading" id={`${lab.id}-prereqs`}>
            Recommended first
          </h2>
          <ul className="prereqs">
            {lab.prerequisites.map((prerequisite) => (
              <li key={prerequisite.id}>
                {prerequisite.available ? (
                  <a className="prereqs__link" href={hrefFor({ name: 'lab', labId: prerequisite.id })}>
                    <span className="prereqs__id">{prerequisite.id}</span>
                    {prerequisite.title}
                  </a>
                ) : (
                  <span>
                    <span className="prereqs__id">{prerequisite.id}</span>
                    {prerequisite.title}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {/* Say plainly that this is advice: the API serves
              `prerequisitesEnforced: false`, and implying a gate would be a lie. */}
          {!lab.prerequisitesEnforced ? (
            <p className="prereqs__note">Recommended background. Nothing stops you starting this lab now.</p>
          ) : null}
        </section>
      ) : null}

      {lab.references.length > 0 ? (
        <section className="brief__section" aria-labelledby={`${lab.id}-docs`}>
          <h2 className="brief__heading" id={`${lab.id}-docs`}>
            Official documentation
          </h2>
          <ul className="doclinks">
            {lab.references.map((doc) => (
              <li key={doc.url}>
                <a href={doc.url} target="_blank" rel="noreferrer noopener">
                  {doc.title}
                  <span className="doclinks__arrow" aria-hidden="true">
                    ↗
                  </span>
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {lab.skills.length > 0 ? (
        <section className="brief__section" aria-labelledby={`${lab.id}-skills`}>
          <h2 className="brief__heading" id={`${lab.id}-skills`}>
            Skills practised
          </h2>
          <ul className="skills">
            {lab.skills.map((skill) => (
              <li key={skill} className="skills__tag">
                {skillLabel(skill)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {lab.certifications.length > 0 ? (
        <section className="brief__section" aria-labelledby={`${lab.id}-certs`}>
          <h2 className="brief__heading" id={`${lab.id}-certs`}>
            Related certification topics
          </h2>
          <ul className="skills">
            {lab.certifications.map((cert) => (
              <li key={cert.certification} className="skills__tag skills__tag--cert">
                {cert.certification}
              </li>
            ))}
          </ul>
          <p className="brief__note">
            Practice aligned with these exam topics. Completing a lab does not award a certification.
          </p>
        </section>
      ) : null}
    </div>
  );
}
