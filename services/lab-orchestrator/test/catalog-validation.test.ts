/**
 * Whole-catalog validation (`validateCatalog`, `npm run validate:labs`).
 *
 * Two halves, like the learning-path suite. The shipped catalog must validate
 * with no errors — that is the gate CI runs. Then each rule is checked against
 * a small synthetic catalog built in a temporary directory, one defect at a
 * time, so a rule that stops firing fails here by name.
 *
 * Every fixture is a *valid* catalog plus exactly one mistake, and every
 * assertion reads the finding's code and subject rather than its position in
 * the list, so nothing depends on filesystem ordering.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import {
  LabRegistry,
  formatCatalogReport,
  validateCatalog,
  type CatalogFinding,
  type CatalogValidationReport,
} from '../src/index.js';
import { LABS_DIR, realCatalog } from './real-catalog.js';

// --- a synthetic catalog --------------------------------------------------------

interface FixtureLab {
  id: string;
  /** Defaults to `<id lowercased>-demo`. */
  slug?: string;
  track?: string;
  /** Directory under the track. Defaults to the slug. */
  dir?: string;
  prerequisites?: string[];
  setup?: Record<string, unknown>;
  /** Replaces the default story, objectives and hints. */
  extra?: Record<string, unknown>;
}

function labDocument(lab: FixtureLab): string {
  const slug = lab.slug ?? `${lab.id.toLowerCase()}-demo`;
  return stringify({
    id: lab.id,
    slug,
    title: `Demo ${lab.id}`,
    track: lab.track ?? 'linux',
    topic: 'files',
    difficulty: 'beginner',
    duration_minutes: 20,
    environment: { provider: 'linux' },
    prerequisites: lab.prerequisites ?? [],
    task: { summary: 'Create a file.', description: 'Create the report file in your home directory.' },
    requirements: [{ type: 'file_exists', path: '/home/student/report.txt', label: 'The report exists' }],
    ...(lab.setup ? { setup: lab.setup } : {}),
    references: [{ title: 'touch(1)', url: 'https://man7.org/linux/man-pages/man1/touch.1.html' }],
    skills: ['linux.files.create'],
    ...(lab.extra ?? {
      story: 'The payments team needs a report file.',
      objectives: ['Create a file'],
      hints: [{ level: 1, text: 'Which command creates an empty file?' }],
    }),
  });
}

const SKILLS = stringify({
  skills: [
    { id: 'linux.files', title: 'Files', description: 'Creating and finding files.' },
    { id: 'linux.spare', title: 'Spare', description: 'A skill a stage declares but no lab practises.' },
  ],
});

function pathDocument(labIds: readonly string[], overrides: { skills?: string[] } = {}): string {
  return stringify({
    id: 'devops-engineer',
    title: 'DevOps Engineer',
    summary: 'A test path.',
    audience: 'Tests.',
    outcomes: ['Pass the tests'],
    stages: [
      {
        id: 'linux',
        title: 'Linux',
        summary: 'Files.',
        why: 'Because.',
        objectives: ['Create files'],
        skills: overrides.skills ?? ['linux.files', 'linux.spare'],
        labs: labIds.map((lab) => ({ lab, skills: ['linux.files'], why: 'Practises files.' })),
      },
    ],
  });
}

interface Fixture {
  labs: FixtureLab[];
  /** Lab ids in path order. Defaults to every lab, in the order given. */
  path?: readonly string[];
  skills?: string;
  pathDocument?: string;
  /** Extra files, relative to the labs directory. */
  files?: Record<string, string>;
}

async function buildCatalog(fixture: Fixture): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'jtt-catalog-validation-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const labsDir = path.join(root, 'labs');

  const write = async (relative: string, contents: string) => {
    const target = path.join(labsDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  };

  for (const lab of fixture.labs) {
    const dir = lab.dir ?? lab.slug ?? `${lab.id.toLowerCase()}-demo`;
    await write(`${lab.track ?? 'linux'}/${dir}/lab.yaml`, labDocument(lab));
  }
  await write('learning-paths/skills.yaml', fixture.skills ?? SKILLS);
  await write(
    'learning-paths/devops-engineer.yaml',
    fixture.pathDocument ?? pathDocument(fixture.path ?? fixture.labs.map((lab) => lab.id)),
  );
  for (const [relative, contents] of Object.entries(fixture.files ?? {})) await write(relative, contents);
  return labsDir;
}

async function validate(labsDir: string): Promise<CatalogValidationReport> {
  const registry = new LabRegistry(labsDir);
  await registry.load();
  return validateCatalog({ labsDir, registry });
}

async function validateFixture(fixture: Fixture): Promise<CatalogValidationReport> {
  return validate(await buildCatalog(fixture));
}

function withCode(report: CatalogValidationReport, code: CatalogFinding['code']): CatalogFinding[] {
  return report.findings.filter((finding) => finding.code === code);
}

const SEED_VERIFY = [{ type: 'file_exists', path: '/home/student/notes.txt', label: 'Notes are present' }];

// --- the shipped catalog --------------------------------------------------------

describe('the shipped catalog', () => {
  it('validates with no errors', async () => {
    const report = await validateCatalog({ labsDir: LABS_DIR, registry: await realCatalog() });

    expect(
      report.findings.filter((f) => f.severity === 'error'),
      formatCatalogReport(report),
    ).toEqual([]);
    expect(report.labCount).toBe(report.definitionFiles);
    expect(report.learningPaths).toContain('devops-engineer');
  });

  it('reports no machine-specific paths', async () => {
    const report = await validateCatalog({ labsDir: LABS_DIR, registry: await realCatalog() });
    expect(JSON.stringify(report)).not.toContain(path.resolve(LABS_DIR));
  });
});

// --- a clean fixture ------------------------------------------------------------

describe('a valid synthetic catalog', () => {
  it('produces no findings at all', async () => {
    const report = await validateFixture({ labs: [{ id: 'LINUX-901' }, { id: 'LINUX-902', prerequisites: ['LINUX-901'] }] });

    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ labCount: 2, definitionFiles: 2, errors: 0, warnings: 0, learningPaths: ['devops-engineer'] });
  });

  it('is deterministic: two runs over one directory produce the same report', async () => {
    const labsDir = await buildCatalog({
      labs: [{ id: 'LINUX-901' }, { id: 'LINUX-902', dir: 'wrong-name' }, { id: 'LINUX-903' }],
      path: ['LINUX-903'],
    });

    const first = await validate(labsDir);
    const second = await validate(labsDir);

    expect(second).toEqual(first);
    expect(first.findings.length).toBeGreaterThan(1);
    expect(JSON.stringify(first)).not.toContain(labsDir);
  });
});

// --- lab identity and the prerequisite graph -------------------------------------

describe('lab identity and prerequisites', () => {
  it('fails on a duplicate lab id', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901' }, { id: 'LINUX-901', slug: 'linux-901-other' }],
      path: ['LINUX-901'],
    });

    const [finding] = withCode(report, 'LAB_LOAD');
    expect(finding).toMatchObject({ severity: 'error', subject: 'LINUX-901' });
    expect(finding!.message).toMatch(/duplicate lab id/);
  });

  it('fails on an unknown prerequisite', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901' }, { id: 'LINUX-902', prerequisites: ['LINUX-999'] }],
      path: ['LINUX-901'],
    });

    expect(withCode(report, 'LAB_LOAD')).toEqual([
      expect.objectContaining({ subject: 'LINUX-902', message: expect.stringMatching(/unknown lab\(s\): LINUX-999/) }),
    ]);
  });

  it('fails on a prerequisite cycle', async () => {
    const report = await validateFixture({
      labs: [
        { id: 'LINUX-901', prerequisites: ['LINUX-902'] },
        { id: 'LINUX-902', prerequisites: ['LINUX-901'] },
      ],
      path: [],
    });

    const messages = withCode(report, 'LAB_LOAD').map((f) => f.message);
    expect(messages.some((m) => /cycle: LINUX-90[12] → LINUX-90[12] → LINUX-90[12]/.test(m))).toBe(true);
    expect(report.errors).toBeGreaterThan(0);
  });

  it('fails on a lab that lists itself as a prerequisite', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901', prerequisites: ['LINUX-901'] }],
      path: [],
    });

    expect(withCode(report, 'LAB_LOAD')[0]?.message).toMatch(/must not include the lab's own id/);
  });
});

// --- layout ------------------------------------------------------------------

describe('layout', () => {
  it('fails when the directory does not match the slug', async () => {
    const report = await validateFixture({ labs: [{ id: 'LINUX-901', dir: 'linux-901-renamed' }] });

    expect(withCode(report, 'LAB_LAYOUT')).toEqual([
      expect.objectContaining({
        severity: 'error',
        subject: 'LINUX-901',
        message: "directory 'linux-901-renamed' does not match its slug 'linux-901-demo'",
      }),
    ]);
  });

  it('fails when a lab lives under another track, or its slug does not start with its id', async () => {
    const report = await validateFixture({
      labs: [
        { id: 'LINUX-901', dir: 'linux-901-demo' },
        { id: 'LINUX-902', slug: 'files-demo' },
      ],
      files: { 'docker/linux-903-demo/lab.yaml': labDocument({ id: 'LINUX-903' }) },
      path: ['LINUX-901', 'LINUX-902', 'LINUX-903'],
    });

    const messages = withCode(report, 'LAB_LAYOUT').map((f) => `${f.subject}: ${f.message}`);
    expect(messages).toContain("LINUX-903: declares track 'linux' but lives under labs/docker/");
    expect(messages).toContain("LINUX-902: slug 'files-demo' does not begin with its id ('linux-902-')");
  });

  it('fails when one track mixes id prefixes', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901' }, { id: 'LNX-902', slug: 'lnx-902-demo' }],
    });

    expect(withCode(report, 'LAB_ID_PREFIX')).toEqual([
      expect.objectContaining({ subject: 'linux', message: "track 'linux' mixes lab id prefixes: LINUX (LINUX-901); LNX (LNX-902)" }),
    ]);
  });

  it('fails on a lab directory whose definition is missing or misnamed', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901' }],
      files: { 'linux/linux-902-demo/lab.yml': labDocument({ id: 'LINUX-902' }) },
    });

    expect(withCode(report, 'LAB_DIRECTORY_WITHOUT_DEFINITION').map((f) => f.subject)).toEqual([
      'labs/linux/linux-902-demo',
    ]);
    expect(withCode(report, 'LAB_LAYOUT').map((f) => f.subject)).toEqual(['labs/linux/linux-902-demo/lab.yml']);
  });
});

// --- setup assets --------------------------------------------------------------

describe('setup assets', () => {
  it('fails on a starter file that does not exist', async () => {
    const report = await validateFixture({
      labs: [
        {
          id: 'LINUX-901',
          setup: { files: [{ source: 'setup/notes.txt', path: 'notes.txt' }], verify: SEED_VERIFY },
        },
      ],
    });

    const [finding] = withCode(report, 'SETUP_ASSET');
    expect(finding).toMatchObject({ severity: 'error', subject: 'LINUX-901' });
    expect(finding!.message).toMatch(/^setup\.files: Cannot read setup file 'setup\/notes\.txt'/);
  });

  it('fails on a seed script that does not exist, or is not a script', async () => {
    const missing = await validateFixture({
      labs: [{ id: 'LINUX-901', setup: { seed_scripts: ['setup/seed.sh'], verify: SEED_VERIFY } }],
    });
    expect(withCode(missing, 'SETUP_ASSET')[0]?.message).toMatch(/Cannot read seed script 'setup\/seed\.sh'/);

    const notAScript = await validateFixture({
      labs: [{ id: 'LINUX-901', setup: { seed_scripts: ['setup/seed.sh'], verify: SEED_VERIFY } }],
      files: { 'linux/linux-901-demo/setup/seed.sh': 'echo no interpreter line\n' },
    });
    expect(withCode(notAScript, 'SETUP_ASSET')[0]?.message).toMatch(/must begin with a #! interpreter line/);
  });

  it('fails on a workspace directory that does not exist', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901', setup: { workspace_dir: 'workspace', verify: SEED_VERIFY } }],
    });

    expect(withCode(report, 'SETUP_ASSET')[0]?.message).toMatch(/Cannot read setup\.workspace_dir 'workspace'/);
  });

  it('fails when a workspace file and a starter file land on the same destination', async () => {
    const report = await validateFixture({
      labs: [
        {
          id: 'LINUX-901',
          setup: {
            workspace_dir: 'workspace',
            files: [{ source: 'setup/notes.txt', path: 'notes.txt' }],
            verify: SEED_VERIFY,
          },
        },
      ],
      files: {
        'linux/linux-901-demo/workspace/notes.txt': 'from the workspace\n',
        'linux/linux-901-demo/setup/notes.txt': 'from setup.files\n',
      },
    });

    expect(withCode(report, 'SETUP_DESTINATION_COLLISION')).toEqual([
      expect.objectContaining({
        severity: 'error',
        subject: 'LINUX-901',
        message: "'notes.txt' is seeded by workspace/notes.txt and setup/notes.txt; only one of them would reach the student",
      }),
    ]);
  });

  it('accepts a lab whose declared assets all load', async () => {
    const report = await validateFixture({
      labs: [
        {
          id: 'LINUX-901',
          setup: {
            seed_scripts: ['setup/seed.sh'],
            files: [{ source: 'setup/notes.txt', path: 'notes.txt' }],
            verify: SEED_VERIFY,
          },
        },
      ],
      files: {
        'linux/linux-901-demo/setup/seed.sh': '#!/bin/sh\ntrue\n',
        'linux/linux-901-demo/setup/notes.txt': 'starter\n',
      },
    });

    expect(report.findings).toEqual([]);
  });
});

// --- content hygiene -----------------------------------------------------------

describe('content hygiene', () => {
  it('fails on a symlink inside a lab directory, even one the lab never references', async () => {
    const labsDir = await buildCatalog({ labs: [{ id: 'LINUX-901' }] });
    await symlink('/etc/passwd', path.join(labsDir, 'linux', 'linux-901-demo', 'passwd.txt'));

    const report = await validate(labsDir);

    expect(withCode(report, 'LAB_SYMLINK')).toEqual([
      expect.objectContaining({ severity: 'error', subject: 'LINUX-901', message: expect.stringMatching(/^passwd\.txt is a symlink/) }),
    ]);
  });

  it('warns about an executable starter file, an unreferenced file and a solution-named seeded file', async () => {
    const labsDir = await buildCatalog({
      labs: [
        {
          id: 'LINUX-901',
          setup: {
            seed_scripts: ['setup/seed.sh'],
            files: [{ source: 'setup/solution.txt', path: 'notes.txt' }],
            verify: SEED_VERIFY,
          },
        },
      ],
      files: {
        'linux/linux-901-demo/setup/seed.sh': '#!/bin/sh\ntrue\n',
        'linux/linux-901-demo/setup/solution.txt': 'the finished answer\n',
        'linux/linux-901-demo/NOTES-FOR-REVIEWERS.md': 'draft\n',
      },
    });
    const lab = path.join(labsDir, 'linux', 'linux-901-demo');
    await chmod(path.join(lab, 'setup', 'seed.sh'), 0o755);
    await chmod(path.join(lab, 'setup', 'solution.txt'), 0o755);

    const report = await validate(labsDir);

    expect(report.errors).toBe(0);
    expect(report.findings.map((f) => `${f.severity} ${f.code} ${f.message.split(' ')[0]}`)).toEqual([
      'warning LAB_EXECUTABLE_FILE setup/solution.txt',
      'warning LAB_UNREFERENCED_FILE NOTES-FOR-REVIEWERS.md',
      'warning SETUP_SOLUTION_NAME setup/solution.txt',
    ]);
  });

  it('does not treat a blank answers worksheet as a solution', async () => {
    const report = await validateFixture({
      labs: [
        {
          id: 'LINUX-901',
          setup: { files: [{ source: 'setup/answers.txt', path: 'answers.txt' }], verify: SEED_VERIFY },
        },
      ],
      files: { 'linux/linux-901-demo/setup/answers.txt': 'question = \n' },
    });

    expect(report.findings).toEqual([]);
  });
});

// --- metadata --------------------------------------------------------------------

describe('metadata', () => {
  it('warns about a lab with no story, objectives or hints, without failing', async () => {
    const report = await validateFixture({ labs: [{ id: 'LINUX-901', extra: {} }] });

    expect(report.errors).toBe(0);
    expect(withCode(report, 'LAB_METADATA_INCOMPLETE')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        subject: 'LINUX-901',
        message: 'has no story, objectives, hints; every shipped lab gives the student these',
      }),
    ]);
  });
});

// --- learning paths ------------------------------------------------------------

describe('learning paths', () => {
  it('fails on a path that names a lab the catalog does not have', async () => {
    const report = await validateFixture({ labs: [{ id: 'LINUX-901' }], path: ['LINUX-901', 'LINUX-999'] });

    const [finding] = withCode(report, 'LEARNING_PATH');
    expect(finding).toMatchObject({ severity: 'error', subject: 'labs/learning-paths/devops-engineer.yaml' });
    expect(finding!.message).toMatch(/lab LINUX-999 does not exist in the lab catalog/);
  });

  it('fails on an unknown skill', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901' }],
      pathDocument: pathDocument(['LINUX-901'], { skills: ['linux.files', 'linux.spare', 'linux.filez'] }),
    });

    expect(withCode(report, 'LEARNING_PATH')[0]?.message).toMatch(/skill 'linux\.filez' is not defined in skills\.yaml/);
  });

  it('fails on a lab placed twice', async () => {
    const report = await validateFixture({ labs: [{ id: 'LINUX-901' }], path: ['LINUX-901', 'LINUX-901'] });

    expect(withCode(report, 'LEARNING_PATH')[0]?.message).toMatch(/lab LINUX-901 is assigned more than once/);
  });

  it('fails on a lab placed before its own prerequisite', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901' }, { id: 'LINUX-902', prerequisites: ['LINUX-901'] }],
      path: ['LINUX-902', 'LINUX-901'],
    });

    expect(withCode(report, 'LEARNING_PATH')[0]?.message).toMatch(/lab LINUX-902 is placed before its prerequisite LINUX-901/);
  });

  it('fails when the flagship path leaves a catalog lab out', async () => {
    const report = await validateFixture({ labs: [{ id: 'LINUX-901' }, { id: 'LINUX-902' }], path: ['LINUX-901'] });

    expect(withCode(report, 'LEARNING_PATH_COVERAGE')).toEqual([
      expect.objectContaining({ severity: 'error', subject: 'devops-engineer', message: expect.stringMatching(/^lab LINUX-902 is not placed/) }),
    ]);
  });

  it('fails when the flagship path does not exist', async () => {
    const labsDir = await buildCatalog({ labs: [{ id: 'LINUX-901' }] });
    await rm(path.join(labsDir, 'learning-paths', 'devops-engineer.yaml'));

    const report = await validate(labsDir);

    expect(withCode(report, 'LEARNING_PATH_COVERAGE').map((f) => f.message)).toEqual([
      "the flagship learning path 'devops-engineer' is not defined",
    ]);
  });

  it('warns about a skill no stage declares, without failing', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901' }],
      pathDocument: pathDocument(['LINUX-901'], { skills: ['linux.files'] }),
    });

    expect(report.errors).toBe(0);
    expect(withCode(report, 'SKILL_UNDECLARED')).toEqual([
      expect.objectContaining({ severity: 'warning', subject: 'linux.spare' }),
    ]);
  });
});

describe('formatCatalogReport', () => {
  it('prints errors before warnings, one line each, then a summary', async () => {
    const report = await validateFixture({
      labs: [{ id: 'LINUX-901' }, { id: 'LINUX-902' }],
      path: ['LINUX-901'],
      pathDocument: pathDocument(['LINUX-901'], { skills: ['linux.files'] }),
    });

    expect(formatCatalogReport(report).split('\n')).toEqual([
      "ERROR LEARNING_PATH_COVERAGE devops-engineer: lab LINUX-902 is not placed in the flagship learning path 'devops-engineer'; every catalog lab must appear in it exactly once",
      "WARNING SKILL_UNDECLARED linux.spare: skill 'linux.spare' is defined in skills.yaml but no stage of any learning path declares it",
      '2 labs registered from 2 lab.yaml files; learning paths: devops-engineer; 1 error, 1 warning',
    ]);
  });
});
