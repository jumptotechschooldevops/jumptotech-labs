/**
 * V1 EPIC-02 — the learning-path model and its validation.
 *
 * Two halves. The shipped paths are checked against the shipped catalog as
 * properties rather than literals (every lab placed once, every gap explained),
 * so adding a lab or closing a gap needs no edit here beyond placing the lab.
 * The validator is then checked rule by rule against small inline paths.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import {
  LearningPathCatalog,
  LearningPathDefinitionError,
  labSourceFromRegistry,
  learningPathsDirectory,
  parseLearningPath,
  parseSkillCatalog,
  validateLearningPath,
  type LabRegistry,
  type PathLabSource,
  type ResolvedLearningPath,
} from '../src/index.js';
import { LABS_DIR, realCatalog } from './real-catalog.js';

// --- the shipped paths --------------------------------------------------------

describe('the shipped learning paths', () => {
  let registry: LabRegistry;
  let catalog: LearningPathCatalog;
  let devops: ResolvedLearningPath;

  beforeAll(async () => {
    registry = await realCatalog();
    catalog = await LearningPathCatalog.load(learningPathsDirectory(LABS_DIR), labSourceFromRegistry(registry));
    devops = catalog.get('devops-engineer')!;
  });

  it('load against the real lab catalog with no errors', () => {
    expect(catalog.loadErrors).toEqual([]);
    expect(devops).toBeDefined();
  });

  it('arrange the DevOps Engineer path in the intended stage order', () => {
    expect(devops.stages.map((stage) => stage.id)).toEqual([
      'foundations',
      'linux',
      'networking',
      'git',
      'docker',
      'cicd',
      'aws',
      'terraform',
      'kubernetes',
      'ansible',
      'helm-gitops',
      'observability',
      'devsecops',
      'production-engineer',
    ]);
    expect(devops.stages.map((stage) => stage.position)).toEqual(devops.stages.map((_, index) => index + 1));
  });

  it('place every lab in the catalog exactly once', () => {
    // A new lab added to labs/ without being placed fails here, so the path
    // cannot silently fall behind the catalog.
    const catalogIds = registry.all().map((lab) => lab.id).sort();
    expect([...devops.labs.keys()].sort()).toEqual(catalogIds);
  });

  it('never point a lab at a stage that comes before one of its own prerequisites', () => {
    const position = (labId: string) => {
      const lab = devops.labs.get(labId)!;
      return [devops.stage(lab.stageId)!.position, lab.sequence] as const;
    };
    for (const lab of devops.labs.values()) {
      for (const prerequisite of lab.info.prerequisites) {
        const [stage, sequence] = position(prerequisite);
        const [ownStage, ownSequence] = position(lab.labId);
        expect(stage < ownStage || (stage === ownStage && sequence < ownSequence), `${lab.labId} ← ${prerequisite}`).toBe(true);
      }
    }
  });

  it('explain every curriculum gap where it is', () => {
    for (const stage of devops.stages) {
      const gaps = stage.skills.filter((skill) => devops.labsForSkill(skill).length === 0);
      if (gaps.length > 0 || stage.labs.length === 0) {
        expect(stage.comingSoon, `stage ${stage.id} has gaps [${gaps.join(', ')}] but no coming_soon note`).toBeTruthy();
      }
    }
  });

  it('cover a skill of an empty stage only with labs placed in other stages', () => {
    // The Git stage has no labs, yet software delivery concepts are genuinely
    // taught by CICD-001 in the CI/CD stage. That is honest evidence, and it
    // does not make the Git stage any less "coming soon".
    const git = devops.stage('git')!;
    expect(git.labs).toEqual([]);
    expect(devops.labsForSkill('delivery.concepts').map((lab) => [lab.labId, lab.stageId])).toEqual([['CICD-001', 'cicd']]);
    for (const skill of ['git.fundamentals', 'git.branching', 'git.collaboration']) {
      expect(devops.labsForSkill(skill), skill).toEqual([]);
    }
  });

  it('has no Git, Helm/GitOps or production-engineering labs to pretend with', () => {
    // Stated from the catalog, not assumed: no lab anywhere is tagged with these
    // skill families, which is why those stages are empty.
    const labSkills = registry.all().flatMap((lab) => lab.skills);
    expect(labSkills.some((skill) => /^(git|helm|argocd|gitops)\./.test(skill))).toBe(false);
    for (const id of ['git', 'helm-gitops', 'production-engineer']) {
      expect(devops.stage(id)!.labs).toEqual([]);
    }
  });

  it('only uses skills that the skill catalog defines, each owned by one stage', () => {
    const owners = new Map<string, string>();
    for (const stage of devops.stages) {
      for (const skill of stage.skills) {
        expect(catalog.skills.has(skill), skill).toBe(true);
        expect(owners.has(skill), `${skill} in ${owners.get(skill)} and ${stage.id}`).toBe(false);
        owners.set(skill, stage.id);
      }
    }
  });
});

// --- validation, rule by rule -------------------------------------------------

const SKILLS = stringify({
  skills: [
    { id: 'demo.one', title: 'One', description: 'The first skill.' },
    { id: 'demo.two', title: 'Two', description: 'The second skill.' },
    { id: 'demo.gap', title: 'Gap', description: 'A skill no lab covers.' },
  ],
});

const LAB_PREREQUISITES: Record<string, string[]> = {
  'AA-001': [],
  'AA-002': ['AA-001'],
  'BB-001': [],
  'BB-002': ['BB-001'],
};

function labs(prerequisites: Record<string, string[]> = LAB_PREREQUISITES): PathLabSource {
  return {
    lab: (id) =>
      id in prerequisites
        ? {
            id,
            title: `Lab ${id}`,
            summary: 'A lab.',
            track: 'demo',
            provider: 'linux',
            difficulty: 'beginner',
            durationMinutes: 30,
            prerequisites: prerequisites[id]!,
          }
        : undefined,
  };
}

function demoPath() {
  return {
    id: 'demo-path',
    title: 'Demo',
    summary: 'A path for tests.',
    audience: 'The test suite.',
    outcomes: ['Validation is proven'],
    stages: [
      {
        id: 'basics',
        title: 'Basics',
        summary: 'The basics.',
        why: 'Everything builds on them.',
        objectives: ['Learn the basics'],
        skills: ['demo.one'],
        labs: [
          { lab: 'AA-001', skills: ['demo.one'], why: 'First.' },
          { lab: 'AA-002', skills: ['demo.one'], why: 'Second.' },
        ],
      },
      {
        id: 'advanced',
        title: 'Advanced',
        summary: 'Further.',
        why: 'Real work.',
        objectives: ['Go further'],
        prerequisites: [{ stage: 'basics', kind: 'required' }],
        skills: ['demo.two', 'demo.gap'],
        coming_soon: 'The gap skill has no lab yet.',
        labs: [
          { lab: 'BB-001', skills: ['demo.two'], why: 'Third.' },
          { lab: 'BB-002', skills: ['demo.two'], why: 'Fourth.' },
        ],
      },
    ],
  };
}

type Doc = ReturnType<typeof demoPath>;

function issuesFor(mutate: (doc: Doc) => void = () => undefined, source = labs()): string[] {
  const doc = demoPath();
  mutate(doc);
  return validateLearningPath(parseLearningPath(stringify(doc)), parseSkillCatalog(SKILLS), source);
}

describe('validateLearningPath', () => {
  it('accepts a well-formed path', () => {
    expect(issuesFor()).toEqual([]);
  });

  it('rejects a lab id the catalog does not have', () => {
    const issues = issuesFor((doc) => {
      doc.stages[0]!.labs.push({ lab: 'ZZ-999', skills: ['demo.one'], why: 'Missing.' });
    });
    expect(issues).toContain("stage 'basics': lab ZZ-999 does not exist in the lab catalog");
  });

  it('rejects a lab assigned twice', () => {
    const issues = issuesFor((doc) => {
      doc.stages[1]!.labs.push({ lab: 'AA-001', skills: ['demo.two'], why: 'Again.' });
    });
    expect(issues).toContain("lab AA-001 is assigned more than once (stage 'basics' and stage 'advanced')");
  });

  it('rejects unknown skills, skills owned by two stages, and lab skills no stage declares', () => {
    expect(issuesFor((doc) => doc.stages[0]!.skills.push('demo.nope'))).toContain(
      "stage 'basics': skill 'demo.nope' is not defined in skills.yaml",
    );
    expect(issuesFor((doc) => doc.stages[1]!.skills.push('demo.one'))).toContain(
      "skill 'demo.one' is declared by both stage 'basics' and stage 'advanced'",
    );
    expect(
      issuesFor((doc) => {
        doc.stages[1]!.skills = ['demo.two'];
        doc.stages[1]!.labs[0]!.skills = ['demo.gap'];
      }),
    ).toContain("stage 'advanced': lab BB-001 names skill 'demo.gap', which no stage of this path declares");
  });

  it('rejects a prerequisite stage that does not exist, is itself, or comes later', () => {
    expect(
      issuesFor((doc) => {
        doc.stages[1]!.prerequisites = [{ stage: 'nowhere', kind: 'required' }];
      }),
    ).toContain("stage 'advanced': prerequisite stage 'nowhere' does not exist in this path");
    expect(
      issuesFor((doc) => {
        doc.stages[1]!.prerequisites = [{ stage: 'advanced', kind: 'recommended' }];
      }),
    ).toContain("stage 'advanced' lists itself as a prerequisite");
    expect(
      issuesFor((doc) => {
        (doc.stages[0] as { prerequisites?: unknown }).prerequisites = [{ stage: 'advanced', kind: 'recommended' }];
        doc.stages[1]!.prerequisites = [];
      }),
    ).toContain(
      "stage 'basics': prerequisite stage 'advanced' comes later in the path — a prerequisite must come before the stage that needs it",
    );
  });

  it('rejects circular stage prerequisites', () => {
    const issues = issuesFor((doc) => {
      (doc.stages[0] as { prerequisites?: unknown }).prerequisites = [{ stage: 'advanced', kind: 'required' }];
    });
    expect(issues).toContain('stage prerequisites form a cycle: basics → advanced → basics');
  });

  it('rejects a lab placed before its own lab.yaml prerequisite', () => {
    const issues = issuesFor((doc) => {
      doc.stages[0]!.labs.reverse();
    });
    expect(issues).toContain(
      "lab AA-002 is placed before its prerequisite AA-001 — move it after AA-001 in stage 'basics' or into a later stage",
    );
  });

  it('rejects a lab whose prerequisite is not in the path at all', () => {
    const issues = issuesFor(undefined, labs({ ...LAB_PREREQUISITES, 'AA-001': ['CC-001'], 'CC-001': [] }));
    expect(issues).toContain("lab AA-001 (stage 'basics') requires CC-001, which is not placed in this path");
  });

  it('rejects a core lab that depends on an optional one, and a stage with no core lab', () => {
    expect(
      issuesFor((doc) => {
        (doc.stages[0]!.labs[0] as { optional?: boolean }).optional = true;
      }),
    ).toContain('core lab AA-002 requires AA-001, which is optional — a core lab cannot depend on extra practice');
    expect(
      issuesFor((doc) => {
        for (const lab of doc.stages[1]!.labs) (lab as { optional?: boolean }).optional = true;
      }),
    ).toContain("stage 'advanced' has labs but no core lab — at least one lab must not be optional");
  });

  it('rejects a duplicate stage id', () => {
    expect(issuesFor((doc) => (doc.stages[1]!.id = 'basics'))).toContain("stage 'basics' is declared more than once");
  });

  it('refuses a path with missing required metadata, naming the field', () => {
    const doc = demoPath() as Record<string, unknown> & Doc;
    delete (doc.stages[0]!.labs[0] as { why?: string }).why;
    delete (doc as { audience?: string }).audience;
    try {
      parseLearningPath(stringify(doc), 'demo.yaml');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LearningPathDefinitionError);
      const issues = (error as LearningPathDefinitionError).issues;
      expect(issues).toContain('audience: Required');
      expect(issues).toContain('stages[0].labs[0].why: Required');
    }
  });

  it('refuses an unknown key rather than ignoring it', () => {
    expect(() => parseLearningPath(stringify({ ...demoPath(), completed: true }))).toThrow(LearningPathDefinitionError);
  });

  it('refuses a skill catalog that defines a skill twice', () => {
    const doubled = stringify({
      skills: [
        { id: 'demo.one', title: 'One', description: 'x' },
        { id: 'demo.one', title: 'Again', description: 'y' },
      ],
    });
    expect(() => parseSkillCatalog(doubled)).toThrow(LearningPathDefinitionError);
    try {
      parseSkillCatalog(doubled);
    } catch (error) {
      expect((error as LearningPathDefinitionError).issues).toEqual(['skills are defined more than once: demo.one']);
    }
  });
});

describe('LearningPathCatalog', () => {
  const source = (doc: object, name = 'demo-path') => ({ text: stringify(doc), source: `${name}.yaml`, expectedId: name });

  it('keeps valid paths and records, without throwing, why others were refused', () => {
    const broken = demoPath();
    broken.id = 'broken-path';
    broken.stages[0]!.labs.push({ lab: 'ZZ-999', skills: ['demo.one'], why: 'Missing.' });

    const catalog = LearningPathCatalog.build(
      { skills: { text: SKILLS, source: 'skills.yaml' }, paths: [source(demoPath()), source(broken, 'broken-path')] },
      labs(),
    );

    expect(catalog.list().map((p) => p.id)).toEqual(['demo-path']);
    expect(catalog.get('broken-path')).toBeUndefined();
    expect(catalog.loadErrors).toHaveLength(1);
    expect(catalog.loadErrors[0]).toMatch(/^LEARNING_PATH_INVALID\n\nbroken-path\.yaml:\nstage 'basics': lab ZZ-999/);
  });

  it('requires the file name to match the path id', () => {
    const catalog = LearningPathCatalog.build(
      { skills: { text: SKILLS, source: 'skills.yaml' }, paths: [source(demoPath(), 'other-name')] },
      labs(),
    );
    expect(catalog.size).toBe(0);
    expect(catalog.loadErrors[0]).toContain("id 'demo-path' does not match the file name (expected 'other-name')");
  });

  it('resolves gaps from data: a skill with no lab, a stage with no labs', () => {
    const doc = demoPath();
    doc.stages.push({
      id: 'later',
      title: 'Later',
      summary: 'Not built yet.',
      why: 'Eventually.',
      objectives: ['Wait'],
      prerequisites: [],
      skills: [],
      coming_soon: 'No labs yet.',
      labs: [],
    });
    doc.stages[1]!.skills = ['demo.two'];
    doc.stages[2]!.skills = ['demo.gap'];
    const catalog = LearningPathCatalog.build({ skills: { text: SKILLS, source: 's' }, paths: [source(doc)] }, labs());
    const resolved = catalog.get('demo-path')!;

    expect(resolved.labsForSkill('demo.gap')).toEqual([]);
    expect(resolved.labsForSkill('demo.one').map((lab) => lab.labId)).toEqual(['AA-001', 'AA-002']);
    expect(resolved.stage('later')!.labs).toEqual([]);
  });

  it('treats a missing directory as no paths, and a missing skill catalog as an error', async () => {
    const empty = await LearningPathCatalog.load(path.join(tmpdir(), 'jtt-no-such-learning-paths'), labs());
    expect(empty.size).toBe(0);
    expect(empty.loadErrors).toEqual([]);

    const dir = await mkdtemp(path.join(tmpdir(), 'jtt-learning-paths-'));
    try {
      await writeFile(path.join(dir, 'demo-path.yaml'), stringify(demoPath()));
      const noSkills = await LearningPathCatalog.load(dir, labs());
      expect(noSkills.size).toBe(0);
      expect(noSkills.loadErrors[0]).toMatch(/skills\.yaml is missing$/);

      await writeFile(path.join(dir, 'skills.yaml'), SKILLS);
      const loaded = await LearningPathCatalog.load(dir, labs());
      expect(loaded.loadErrors).toEqual([]);
      expect(loaded.get('demo-path')!.stages).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
