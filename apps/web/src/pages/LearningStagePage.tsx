/**
 * One stage of a learning path: what it teaches, why it matters, its labs in
 * recommended order, its skills, what comes first, and the next step.
 *
 * "Next in this stage" is the stage's own next lab from the API; the path-wide
 * recommendation (dashboard, path page) may point elsewhere — a running lab, or
 * an earlier stage. Prerequisites are advice: every lab link here works, and the
 * page says so rather than hiding labs behind a lock.
 */
import { ErrorNotice } from '../components/ErrorNotice';
import { SkillStatusText, StageStatusBadge } from '../components/LearningPath';
import { Badge, DifficultyBadge, LoadingState, PageHeader, ProgressBadge, ProgressBar } from '../components/ui';
import { useActiveSession } from '../lib/ActiveSessionContext';
import { describeError } from '../lib/errors';
import { formatMinutes, plural } from '../lib/format';
import { findPathLab, gapSkills, isUnknownPath, useLearningPath, useProgressLookup } from '../lib/learningPath';
import { hrefFor, usePageTitle } from '../lib/router';
import type { LearningPathDetail, LearningStage, StageProgressEntry } from '../lib/types';
import { PathNotFound } from './LearningPathPage';

function NextStep({
  path,
  stage,
  progress,
}: {
  path: LearningPathDetail;
  stage: LearningStage;
  progress: StageProgressEntry;
}) {
  const { entries } = useActiveSession();
  const running = entries[0]?.session.labId;
  const following = path.stages.find((candidate) => candidate.position > stage.position && candidate.labs.length > 0);

  if (stage.labs.length === 0) {
    return (
      <p className="panel__text">
        There are no labs to do here yet.{' '}
        {following ? (
          <a className="text-link" href={hrefFor({ name: 'stage', pathId: path.id, stageId: following.id })}>
            Continue with {following.title}
          </a>
        ) : (
          <a className="text-link" href={hrefFor({ name: 'path', pathId: path.id })}>
            Back to the path
          </a>
        )}
      </p>
    );
  }

  if (running) {
    return (
      <>
        <p className="panel__text">
          You have <span className="mono-id">{running}</span> running. Continue it, or end it, before starting another
          lab — you can run one lab at a time.
        </p>
        <a className="btn btn--primary" href={hrefFor({ name: 'workspace', labId: running })}>
          Continue lab
        </a>
      </>
    );
  }

  const next = progress.nextLabId ? findPathLab(path, progress.nextLabId) : undefined;
  if (!next) {
    return (
      <p className="panel__text">
        You have completed every lab in this stage.{' '}
        {following ? (
          <a className="text-link" href={hrefFor({ name: 'stage', pathId: path.id, stageId: following.id })}>
            Next stage: {following.title}
          </a>
        ) : null}
      </p>
    );
  }

  const started = progress.labs.completed + progress.labs.inProgress > 0;
  return (
    <>
      <p className="panel__lead">
        <span className="mono-id">{next.lab.labId}</span> {next.lab.title}
      </p>
      <p className="recommendation__reason">
        {next.stage.id !== stage.id
          ? `${next.lab.labId} is in ${next.stage.title}, and comes before the next lab here.`
          : progress.status === 'COMPLETED'
            ? 'Extra practice: the core labs of this stage are done.'
            : next.lab.why}
      </p>
      <a className="btn btn--primary" href={hrefFor({ name: 'lab', labId: next.lab.labId })}>
        {started ? 'Continue learning' : 'Start this stage'}
        <span className="visually-hidden">: {next.lab.labId}</span>
      </a>
    </>
  );
}

export function LearningStagePage({ pathId, stageId }: { pathId: string; stageId: string }) {
  const { definition, progress, reloadDefinition, reloadProgress } = useLearningPath(pathId);
  const lookup = useProgressLookup(progress.data);
  const path = definition.data;
  const stage = path?.stages.find((candidate) => candidate.id === stageId);

  usePageTitle(stage ? stage.title : 'Learning path stage');

  if (definition.status === 'loading') return <LoadingState label="Loading this stage…" />;
  if (!path) {
    if (isUnknownPath(definition.error)) return <PathNotFound />;
    return (
      <div className="page">
        <ErrorNotice
          headingLevel={1}
          error={{ ...describeError(definition.error!, 'load'), title: 'This stage could not be loaded' }}
          actions={
            <button type="button" className="btn btn--secondary" onClick={reloadDefinition}>
              Try again
            </button>
          }
        />
      </div>
    );
  }
  if (!stage) return <PathNotFound title="Stage not found" />;

  const stageProgress = lookup.stage(stage.id);
  const gaps = gapSkills(stage);
  const optionalCount = stage.labs.filter((lab) => lab.optional).length;
  const prerequisiteMet = (id: string) => stageProgress?.prerequisites.find((p) => p.stageId === id)?.met;

  return (
    <div className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <a href={hrefFor({ name: 'path', pathId: path.id })}>{path.title} path</a>
          </li>
          <li aria-current="page">{stage.title}</li>
        </ol>
      </nav>

      <PageHeader
        eyebrow={`Stage ${stage.position} of ${path.stages.length}`}
        title={stage.title}
        description={stage.summary}
      >
        <p className="page-header__badges">
          {stageProgress ? <StageStatusBadge status={stageProgress.status} gapCount={gaps.length} /> : null}
          {stage.labs.length > 0 ? (
            <span className="page-header__facts">
              {plural(stage.labs.length, 'lab')} · about {formatMinutes(stage.estimatedMinutes.core)} of core lab time
            </span>
          ) : null}
        </p>
      </PageHeader>

      {stage.comingSoon ? (
        <p className="callout callout--info">
          <strong>{stage.labs.length === 0 ? 'Coming soon. ' : 'Not covered yet. '}</strong>
          {stage.comingSoon}
        </p>
      ) : null}
      {stageProgress?.status === 'LOCKED' ? (
        <p className="callout callout--info">
          We recommend finishing the earlier stage listed under “Before you start” first. You can still open any lab
          here — for example if your instructor has asked you to.
        </p>
      ) : null}

      <div className="path-layout">
        <aside className="path-layout__side" aria-label="Stage progress and next step">
          <section className="panel panel--accent" aria-labelledby="stage-progress-heading">
            <h2 id="stage-progress-heading" className="panel__title">
              Your progress
            </h2>
            {progress.status === 'loading' ? (
              <LoadingState label="Loading your progress…" />
            ) : !stageProgress ? (
              <ErrorNotice
                error={describeError(progress.error ?? { code: 'PROGRESS_UNAVAILABLE', message: '' }, 'progress')}
                headingLevel={3}
                live={false}
                actions={
                  <button type="button" className="btn btn--secondary btn--sm" onClick={reloadProgress}>
                    Try again
                  </button>
                }
              />
            ) : stage.labs.length === 0 ? (
              <p className="panel__text">Nothing to count yet: this stage has no labs.</p>
            ) : (
              <>
                <p className="stat">
                  <span className="stat__value">{stageProgress.labs.completed}</span>
                  <span className="stat__label">of {plural(stageProgress.labs.total, 'lab')} completed</span>
                </p>
                <ProgressBar
                  value={stageProgress.labs.completed}
                  max={stageProgress.labs.total}
                  label={`${stage.title}: ${stageProgress.labs.completed} of ${stageProgress.labs.total} labs completed`}
                />
                <p className="panel__meta">
                  Core labs: {stageProgress.core.completed} of {stageProgress.core.total}
                  {optionalCount > 0 ? ` · ${plural(optionalCount, 'extra practice lab')}` : ''}
                </p>
              </>
            )}
            {stageProgress ? (
              <div className="recommendation">
                <h3 className="recommendation__heading">Next step</h3>
                <NextStep path={path} stage={stage} progress={stageProgress} />
              </div>
            ) : null}
          </section>

          <section className="panel" aria-labelledby="before-heading">
            <h2 id="before-heading" className="panel__title">
              Before you start
            </h2>
            {stage.prerequisites.length === 0 ? (
              <p className="panel__text">No earlier stage is needed.</p>
            ) : (
              <ul className="plain-list">
                {stage.prerequisites.map((prerequisite) => {
                  const met = prerequisiteMet(prerequisite.stageId);
                  return (
                    <li key={prerequisite.stageId}>
                      <a
                        className="text-link"
                        href={hrefFor({ name: 'stage', pathId: path.id, stageId: prerequisite.stageId })}
                      >
                        {prerequisite.title}
                      </a>{' '}
                      — {prerequisite.kind === 'required' ? 'finish first' : 'recommended'}
                      {met === undefined ? '' : met ? ' (done)' : ' (not yet)'}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="skills-heading">
            <h2 id="skills-heading" className="panel__title">
              Skills in this stage
            </h2>
            <ul className="skill-list">
              {stage.skills.map((skill) => {
                const skillProgress = lookup.skill(skill.id);
                return (
                  <li key={skill.id} className="skill-list__item">
                    <span className="skill-list__title">{skill.title}</span>
                    {skill.labIds.length === 0 ? (
                      <SkillStatusText status="COMING_SOON" />
                    ) : skillProgress ? (
                      <>
                        <SkillStatusText status={skillProgress.status} />
                        <span className="skill-list__count">
                          {skillProgress.labs.completed} of {plural(skillProgress.labs.total, 'lab')}
                        </span>
                      </>
                    ) : (
                      <span className="skill-list__count">{plural(skill.labIds.length, 'lab')}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>

        <div className="path-layout__main">
          <section className="panel" aria-labelledby="learn-heading">
            <h2 id="learn-heading" className="panel__title">
              What you will learn
            </h2>
            <ul className="plain-list">
              {stage.objectives.map((objective) => (
                <li key={objective}>{objective}</li>
              ))}
            </ul>
            <h3 className="panel__subtitle">Why this matters in DevOps work</h3>
            <p className="panel__text">{stage.why}</p>
          </section>

          <section className="stage-section" aria-labelledby="labs-heading">
            <h2 id="labs-heading" className="section-title">
              Labs in recommended order
            </h2>
            {stage.labs.length === 0 ? (
              <p className="panel__text">There are no labs in this stage yet.</p>
            ) : (
              <ol className="stage-labs">
                {stage.labs.map((lab) => {
                  const status = lookup.lab(lab.labId);
                  return (
                    <li
                      key={lab.labId}
                      className={`stage-lab${status ? ` stage-lab--${status.toLowerCase()}` : ''}`}
                    >
                      <span className="stage-lab__mark" aria-hidden="true">
                        {status === 'COMPLETED' ? '✓' : status === 'IN_PROGRESS' ? '◐' : '○'}
                      </span>
                      <div className="stage-lab__body">
                        <h3 className="stage-lab__title">
                          <a href={hrefFor({ name: 'lab', labId: lab.labId })}>
                            <span className="mono-id">{lab.labId}</span> {lab.title}
                          </a>
                        </h3>
                        <p className="stage-lab__why">{lab.why}</p>
                        <p className="stage-lab__meta">
                          {status ? <ProgressBadge status={status} showNotStarted /> : null}
                          {lab.optional ? <Badge tone="info">Extra practice</Badge> : null}
                          <DifficultyBadge difficulty={lab.difficulty} />
                          <span>
                            {formatMinutes(lab.durationMinutes)} · {lab.trackTitle}
                          </span>
                          {lab.prerequisites.length > 0 ? (
                            <span>Recommended first: {lab.prerequisites.map((p) => p.id).join(', ')}</span>
                          ) : null}
                          {!lab.availability.available ? <span>Cannot be started on this platform right now</span> : null}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {gaps.length > 0 ? (
            <section className="stage-section" aria-labelledby="gaps-heading">
              <h2 id="gaps-heading" className="section-title">
                Skills coming soon
              </h2>
              <p className="panel__text">
                These skills belong in this stage, but JumpToTech Labs has no lab for them yet. They are not counted in
                your progress.
              </p>
              <ul className="gap-list">
                {gaps.map((skill) => (
                  <li key={skill.id}>
                    <strong>{skill.title}.</strong> {skill.description}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
