/**
 * V1 EPIC-02 — progress through a learning path, and "what should I do next?".
 *
 * Every rule is exercised on a small path whose shape is chosen for the rule,
 * then the headline behaviours are re-checked on the shipped DevOps Engineer
 * path so the real curriculum answers the way the documentation says.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  LearningPathCatalog,
  computeLearningPathProgress,
  labSourceFromRegistry,
  learningPathsDirectory,
  type PathLabSource,
  type PathLabStatus,
  type ResolvedLearningPath,
} from '../src/index.js';
import { LABS_DIR, realCatalog } from './real-catalog.js';

const SKILLS = stringify({
  skills: [
    { id: 'demo.one', title: 'One', description: 'Basics skill.' },
    { id: 'demo.two', title: 'Two', description: 'Containers skill.' },
    { id: 'demo.three', title: 'Three', description: 'Clusters skill.' },
    { id: 'demo.gap', title: 'Gap', description: 'No lab covers this.' },
  ],
});

const PREREQUISITES: Record<string, string[]> = {
  'AA-001': [],
  'AA-002': ['AA-001'],
  'AA-003': ['AA-001'],
  'BB-001': [],
  'BB-002': ['BB-001'],
  'CC-001': ['AA-002'],
  'CC-002': [],
};

const source: PathLabSource = {
  lab: (id) =>
    id in PREREQUISITES
      ? {
          id,
          title: `Lab ${id}`,
          summary: 'A lab.',
          track: 'demo',
          provider: 'linux',
          difficulty: 'beginner',
          durationMinutes: 30,
          prerequisites: PREREQUISITES[id]!,
        }
      : undefined,
};

const stage = (id: string, title: string, rest: Record<string, unknown>) => ({
  id,
  title,
  summary: `${title} summary.`,
  why: `${title} matters.`,
  objectives: [`Learn ${title}`],
  ...rest,
});

/**
 * Basics (3 labs, one optional) → Gap (no labs) → Containers (requires Basics
 * and Gap) → Clusters (recommends Containers; CC-001 needs AA-002 from Basics).
 */
const DEMO = stringify({
  id: 'demo-path',
  title: 'Demo',
  summary: 'A path for tests.',
  audience: 'The test suite.',
  outcomes: ['Rules are proven'],
  stages: [
    stage('basics', 'Basics', {
      skills: ['demo.one'],
      labs: [
        { lab: 'AA-001', skills: ['demo.one'], why: 'a' },
        { lab: 'AA-002', skills: ['demo.one'], why: 'b' },
        { lab: 'AA-003', skills: ['demo.one'], why: 'c', optional: true },
      ],
    }),
    stage('gap', 'Gap', { skills: ['demo.gap'], coming_soon: 'Nothing yet.', labs: [] }),
    stage('containers', 'Containers', {
      prerequisites: [
        { stage: 'basics', kind: 'required' },
        { stage: 'gap', kind: 'required' },
      ],
      skills: ['demo.two'],
      labs: [
        { lab: 'BB-001', skills: ['demo.two', 'demo.one'], why: 'd' },
        { lab: 'BB-002', skills: ['demo.two'], why: 'e' },
      ],
    }),
    stage('clusters', 'Clusters', {
      prerequisites: [{ stage: 'containers', kind: 'recommended' }],
      skills: ['demo.three'],
      labs: [
        { lab: 'CC-001', skills: ['demo.three'], why: 'f' },
        { lab: 'CC-002', skills: ['demo.three'], why: 'g' },
      ],
    }),
  ],
});

const catalog = LearningPathCatalog.build(
  { skills: { text: SKILLS, source: 'skills.yaml' }, paths: [{ text: DEMO, source: 'demo-path.yaml' }] },
  source,
);
const PATH = catalog.get('demo-path')!;
const ALL = Object.keys(PREREQUISITES);

function progressOf(
  statuses: Record<string, PathLabStatus> = {},
  options: { unavailable?: string[]; active?: string[] | null; path?: ResolvedLearningPath } = {},
) {
  return computeLearningPathProgress({
    path: options.path ?? PATH,
    statusOf: (labId) => statuses[labId] ?? 'NOT_STARTED',
    canStart: (labId) => !(options.unavailable ?? []).includes(labId),
    activeLabIds: options.active === undefined ? [] : options.active,
  });
}

const completed = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'COMPLETED' as const]));
const stageStatus = (progress: ReturnType<typeof progressOf>) =>
  Object.fromEntries(progress.stages.map((s) => [s.stageId, s.status]));

describe('learning path progress', () => {
  it('builds the demo path', () => {
    expect(catalog.loadErrors).toEqual([]);
  });

  it('shows a student with no progress where to start, and counts nothing', () => {
    const progress = progressOf();

    expect(stageStatus(progress)).toEqual({
      basics: 'NOT_STARTED',
      gap: 'COMING_SOON',
      containers: 'LOCKED',
      clusters: 'NOT_STARTED',
    });
    expect(progress.overall.labs).toEqual({ total: 7, completed: 0, inProgress: 0, notStarted: 7 });
    expect(progress.overall.core).toEqual({ total: 6, completed: 0 });
    expect(progress.currentStageId).toBe('basics');
    expect(progress.recommendation).toEqual({
      kind: 'START_STAGE',
      labId: 'AA-001',
      stageId: 'basics',
      reason: 'Start here. Basics is the first stage of the Demo path.',
    });
  });

  it('continues a partially completed stage, and says why', () => {
    const progress = progressOf(completed('AA-001'));

    const basics = progress.stages.find((s) => s.stageId === 'basics')!;
    expect(basics).toMatchObject({
      status: 'IN_PROGRESS',
      labs: { total: 3, completed: 1, inProgress: 0 },
      core: { total: 2, completed: 1 },
      nextLabId: 'AA-002',
    });
    expect(progress.recommendation).toEqual({
      kind: 'NEXT_IN_STAGE',
      labId: 'AA-002',
      stageId: 'basics',
      reason: 'Next in Basics. Finish the Basics stage before starting Containers.',
    });
  });

  it('never counts an attempted lab as completed', () => {
    const progress = progressOf({ 'AA-001': 'IN_PROGRESS' });
    expect(progress.overall.labs).toMatchObject({ completed: 0, inProgress: 1 });
    expect(progress.stages[0]).toMatchObject({ status: 'IN_PROGRESS', core: { completed: 0 } });
    expect(progress.overall.stages.completed).toBe(0);
  });

  it('puts an attempted lab ahead of the next one in sequence', () => {
    const progress = progressOf({ 'AA-002': 'IN_PROGRESS' });
    expect(progress.recommendation).toMatchObject({
      kind: 'CONTINUE_ATTEMPT',
      labId: 'AA-002',
      reason: 'You started this lab and have not passed Verify yet.',
    });
  });

  it('completes a stage on its core labs, and a coming-soon stage never blocks the next one', () => {
    const progress = progressOf(completed('AA-001', 'AA-002'));

    const containers = progress.stages.find((s) => s.stageId === 'containers')!;
    expect(stageStatus(progress)).toMatchObject({ basics: 'COMPLETED', gap: 'COMING_SOON', containers: 'NOT_STARTED' });
    expect(containers.prerequisitesMet).toBe(true);
    expect(containers.prerequisites).toEqual([
      { stageId: 'basics', kind: 'required', met: true },
      { stageId: 'gap', kind: 'required', met: true },
    ]);
    // The optional lab is still offered from its own stage, never required.
    expect(progress.stages[0]!.nextLabId).toBe('AA-003');
    expect(progress.recommendation).toMatchObject({
      kind: 'START_STAGE',
      labId: 'BB-001',
      reason: 'Containers is the next stage of the Demo path.',
    });
  });

  it('lets a student who went ahead keep going, while still showing the unmet prerequisite', () => {
    const progress = progressOf(completed('BB-001'));

    const containers = progress.stages.find((s) => s.stageId === 'containers')!;
    expect(containers).toMatchObject({ status: 'IN_PROGRESS', prerequisitesMet: false });
    expect(progress.recommendation).toMatchObject({ kind: 'NEXT_IN_STAGE', labId: 'BB-002' });
  });

  it("sends the student to a lab's unverified prerequisite first", () => {
    const progress = progressOf(completed('CC-002'));

    expect(progress.currentStageId).toBe('clusters');
    expect(progress.recommendation).toEqual({
      kind: 'PREREQUISITE_FIRST',
      labId: 'AA-001',
      stageId: 'basics',
      reason: 'AA-001 comes before CC-001 (Lab CC-001), the next lab in Clusters.',
    });
  });

  it('puts a running lab before everything, and suggests nothing when that cannot be checked', () => {
    const running = progressOf({}, { active: ['BB-002', 'AA-001'] });
    expect(running.recommendation).toEqual({
      kind: 'RESUME_ACTIVE',
      labId: 'BB-002',
      stageId: 'containers',
      reason: 'You have a lab running. Continue it, or end it, before starting another — you can run one lab at a time.',
    });
    // The path's own position is still reported.
    expect(running.currentStageId).toBe('basics');

    const unknown = progressOf(completed('AA-001'), { active: null });
    expect(unknown.recommendation.kind).toBe('ACTIVE_SESSION_UNKNOWN');
    expect(unknown.recommendation.labId).toBeUndefined();
  });

  it('offers extra practice once every core lab is verified', () => {
    const progress = progressOf(completed('AA-001', 'AA-002', 'BB-001', 'BB-002', 'CC-001', 'CC-002'));
    expect(progress.currentStageId).toBeNull();
    expect(progress.recommendation).toMatchObject({ kind: 'EXTRA_PRACTICE', labId: 'AA-003', stageId: 'basics' });
  });

  it('completes the available curriculum without completing the gap', () => {
    const progress = progressOf(completed(...ALL));

    expect(progress.recommendation.kind).toBe('PATH_COMPLETE');
    expect(stageStatus(progress)).toEqual({
      basics: 'COMPLETED',
      gap: 'COMING_SOON',
      containers: 'COMPLETED',
      clusters: 'COMPLETED',
    });
    expect(progress.overall.stages).toEqual({ total: 4, completed: 3, comingSoon: 1 });
    expect(progress.overall.skills).toEqual({ total: 4, completed: 3, comingSoon: 1 });
    expect(progress.skills.find((s) => s.skillId === 'demo.gap')).toEqual({
      skillId: 'demo.gap',
      status: 'COMING_SOON',
      labs: { total: 0, completed: 0 },
    });
  });

  it('derives skill progress from every lab that practises the skill', () => {
    const progress = progressOf(completed('AA-001'));
    expect(progress.skills.find((s) => s.skillId === 'demo.one')).toEqual({
      skillId: 'demo.one',
      status: 'IN_PROGRESS',
      labs: { total: 4, completed: 1 },
    });
    expect(progress.skills.find((s) => s.skillId === 'demo.two')!.status).toBe('NOT_STARTED');
  });

  it('skips labs this platform cannot start, and says so when nothing is left', () => {
    const blocked = progressOf({}, { unavailable: ['AA-001', 'AA-002', 'AA-003'] });
    expect(blocked.recommendation).toMatchObject({ kind: 'START_STAGE', labId: 'CC-002' });

    const nothing = progressOf({}, { unavailable: ALL });
    expect(nothing.recommendation).toEqual({
      kind: 'NONE_AVAILABLE',
      reason: 'None of the next labs in this path can be started on this platform right now.',
    });
  });

  it('is deterministic', () => {
    const statuses = { ...completed('AA-001', 'CC-002'), 'BB-001': 'IN_PROGRESS' as const };
    expect(progressOf(statuses)).toEqual(progressOf(statuses));
  });
});

describe('the DevOps Engineer path, for real students', () => {
  let devops: ResolvedLearningPath;
  let labCount: number;

  beforeAll(async () => {
    const registry = await realCatalog();
    labCount = registry.size;
    const shipped = await LearningPathCatalog.load(learningPathsDirectory(LABS_DIR), labSourceFromRegistry(registry));
    devops = shipped.get('devops-engineer')!;
  });

  it('starts a new student at the beginning, with later stages waiting and gaps shown as gaps', () => {
    const progress = progressOf({}, { path: devops });

    expect(progress.recommendation).toEqual({
      kind: 'START_STAGE',
      labId: 'CS-001',
      stageId: 'foundations',
      reason: 'Start here. Foundations is the first stage of the DevOps Engineer path.',
    });
    expect(progress.overall.labs.total).toBe(labCount);
    const statuses = stageStatus(progress);
    expect(statuses.git).toBe('COMING_SOON');
    expect(statuses['helm-gitops']).toBe('COMING_SOON');
    expect(statuses['production-engineer']).toBe('COMING_SOON');
    expect(statuses.docker).toBe('LOCKED');
    expect(statuses.kubernetes).toBe('LOCKED');
  });

  it('continues Linux for a student who completed LINUX-001 to LINUX-007', () => {
    const done = completed('LINUX-001', 'LINUX-002', 'LINUX-003', 'LINUX-004', 'LINUX-005', 'LINUX-006', 'LINUX-007');
    const progress = progressOf(done, { path: devops });

    expect(progress.currentStageId).toBe('linux');
    expect(progress.recommendation).toEqual({
      kind: 'NEXT_IN_STAGE',
      labId: 'LINUX-008',
      stageId: 'linux',
      reason: 'Next in Linux. Finish the Linux stage before starting Networking.',
    });
  });

  it('never reports a gap skill or an empty stage as completed, even with every lab verified', () => {
    const progress = progressOf(completed(...devops.labs.keys()), { path: devops });

    expect(progress.recommendation.kind).toBe('PATH_COMPLETE');
    for (const skill of progress.skills) {
      if (devops.labsForSkill(skill.skillId).length === 0) expect(skill.status, skill.skillId).toBe('COMING_SOON');
    }
    for (const s of progress.stages) {
      expect(s.status, s.stageId).toBe(devops.stage(s.stageId)!.labs.length === 0 ? 'COMING_SOON' : 'COMPLETED');
    }
  });
});
