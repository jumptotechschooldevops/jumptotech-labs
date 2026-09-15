/**
 * One lab in a list — catalog, track page, dashboard.
 *
 * Every field comes from the lab's definition via the API. The card has one
 * destination: the lab's page, where the student reads what they are about to
 * get before anything is created. The exception is a lab that is already
 * running for this student, whose card goes straight back into it — offering
 * "View lab" for a lab they are in the middle of would be a detour.
 *
 * Nothing that grades the lab is on a card: requirements, setup and expected
 * values are not in the catalog payload at all.
 */
import { hrefFor } from '../lib/router';
import { formatMinutes, plural } from '../lib/format';
import type { LabProgressStatus, LabSummary } from '../lib/types';
import { Badge, DifficultyBadge, ProgressBadge } from './ui';

export function LabCard({
  lab,
  progress,
  running = false,
  trackTitle,
  headingLevel = 3,
}: {
  lab: LabSummary;
  progress?: LabProgressStatus | undefined;
  /** This student has a live session of this lab. */
  running?: boolean;
  /** Shown when the card appears outside its own track's section. */
  trackTitle?: string;
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const unavailable = lab.availability?.available === false;
  const href = running ? hrefFor({ name: 'workspace', labId: lab.id }) : hrefFor({ name: 'lab', labId: lab.id });
  const titleId = `lab-card-${lab.id}`;

  return (
    <article
      className={`labcard${progress === 'COMPLETED' ? ' labcard--completed' : ''}${running ? ' labcard--running' : ''}`}
      aria-labelledby={titleId}
    >
      <div className="labcard__top">
        <span className="labcard__id">{lab.id}</span>
        <div className="labcard__badges">
          {running ? <Badge tone="accent">Running</Badge> : null}
          <ProgressBadge status={progress} />
          <DifficultyBadge difficulty={lab.difficulty} />
        </div>
      </div>

      <Heading className="labcard__title" id={titleId}>
        {lab.title}
      </Heading>
      {trackTitle ? <p className="labcard__track">{trackTitle}</p> : null}
      <p className="labcard__summary">{lab.summary}</p>

      <dl className="labcard__facts">
        <div>
          <dt>Time</dt>
          <dd>{formatMinutes(lab.durationMinutes)}</dd>
        </div>
        <div>
          <dt>Topic</dt>
          <dd>{lab.topicTitle}</dd>
        </div>
        {lab.prerequisites.length > 0 ? (
          <div>
            <dt>Recommended first</dt>
            <dd>{lab.prerequisites.map((prerequisite) => prerequisite.id).join(', ')}</dd>
          </div>
        ) : null}
      </dl>

      <div className="labcard__footer">
        <span className="labcard__note">
          {unavailable
            ? 'Not available on this platform right now'
            : lab.hintCount > 0
              ? plural(lab.hintCount, 'hint')
              : ''}
        </span>
        <a className={`btn btn--sm ${running ? 'btn--primary' : 'btn--secondary'}`} href={href}>
          {running ? 'Continue lab' : 'View lab'}
          <span className="visually-hidden">: {lab.title}</span>
        </a>
      </div>
    </article>
  );
}
