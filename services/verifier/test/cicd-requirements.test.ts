/**
 * PLATFORM-CICD-001 — the file-backed requirement types.
 *
 * Covers story tests 4–12: GitHub Actions YAML verification, an invalid
 * workflow failing, a correct workflow passing, Jenkinsfile verification,
 * Jenkins stage verification, build verification, test verification, artifact
 * verification, and the hardcoded-secret scenario.
 *
 * Every test writes real files into a real temporary directory and reads them
 * back through the real `FsWorkspace`. "The check passes" therefore means the
 * verifier read bytes off a disk, and the build and test checks really do run
 * the project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsWorkspace, REQUIREMENT_TYPES, type Requirement } from '@jumptotech/lab-orchestrator';
import { VerifyReader, registeredRequirementTypes, verifyRequirement } from '../src/index.js';

/*
 * These tests deliberately spawn real processes — a workspace build, a real
 * test run — so the 5s default meant for pure unit tests does not apply. The
 * budget below is generous on purpose: a timeout here should mean something is
 * genuinely wrong, not that the machine was busy running the rest of the suite.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jtt-verify-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a file into the temporary workspace, creating parents. */
async function put(relative: string, contents: string): Promise<void> {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

/** Run one requirement against the temporary workspace. */
function check(requirement: Requirement) {
  const reader = new VerifyReader({
    workspace: new FsWorkspace({ root }),
    namespace: 'lab-0000000000aa',
  });
  return verifyRequirement(requirement, reader);
}

const WORKFLOW_PATH = '.github/workflows/ci.yml';

/** A complete, correct workflow — the CICD-003 end state. */
const GOOD_WORKFLOW = `
name: CI

on:
  push:
    branches:
      - main
  pull_request:

env:
  IMAGE_NAME: jumptotech/statements

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Build
        run: node build.mjs
      - name: Test
        run: node --test
      - name: Upload build output
        uses: actions/upload-artifact@v4
        with:
          name: statements-dist
          path: dist/

  image:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: docker build -t "$IMAGE_NAME:$GITHUB_SHA" .
`;

// -------------------------------------------------------- files and YAML

describe('file_exists', () => {
  it('passes for a file with content', async () => {
    await put('Jenkinsfile', 'pipeline { agent any }\n');
    const result = await check({ type: 'file_exists', path: 'Jenkinsfile', kind: 'file', label: 'x' });
    expect(result.status).toBe('pass');
  });

  it('fails for a path that does not exist', async () => {
    const result = await check({ type: 'file_exists', path: 'Jenkinsfile', kind: 'file', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/No 'Jenkinsfile' found/);
  });

  it('fails an empty file when the lab asks for content', async () => {
    await put('Jenkinsfile', '');
    const result = await check({
      type: 'file_exists',
      path: 'Jenkinsfile',
      kind: 'file',
      min_bytes: 40,
      label: 'x',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/exists but is empty/);
  });

  it('distinguishes a directory from a file', async () => {
    await put('dist/statements.bundle.js', 'x'.repeat(100));
    expect((await check({ type: 'file_exists', path: 'dist', kind: 'directory', label: 'x' })).status).toBe('pass');
    expect((await check({ type: 'file_exists', path: 'dist', kind: 'file', label: 'x' })).status).toBe('fail');
  });
});

describe('yaml_valid', () => {
  it('passes valid YAML', async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
    expect((await check({ type: 'yaml_valid', path: WORKFLOW_PATH, label: 'x' })).status).toBe('pass');
  });

  it('fails an indentation error and says where', async () => {
    await put(
      WORKFLOW_PATH,
      ['jobs:', '  build:', '    runs-on: ubuntu-latest', '      steps:', '        - run: echo hi', ''].join('\n'),
    );
    const result = await check({ type: 'yaml_valid', path: WORKFLOW_PATH, label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not valid YAML/);
    expect(result.detail).toMatch(/line \d+/);
  });
});

// ------------------------------------------------------------ GitHub Actions

describe('github_workflow_exists (story tests 4, 5, 6)', () => {
  it('passes a correct workflow', async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
    const result = await check({
      type: 'github_workflow_exists',
      path: WORKFLOW_PATH,
      require_name: true,
      label: 'x',
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/2 jobs/);
  });

  it('fails when the file is not where GitHub reads workflows from', async () => {
    // The CICD-010 fault: a valid workflow in `.github/workflow` (singular).
    await put('.github/workflow/ci.yml', GOOD_WORKFLOW);
    const result = await check({
      type: 'github_workflow_exists',
      path: WORKFLOW_PATH,
      require_name: false,
      label: 'x',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/\.github\/workflows/);
  });

  it('fails a workflow with no trigger', async () => {
    await put(WORKFLOW_PATH, 'name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
    const result = await check({
      type: 'github_workflow_exists',
      path: WORKFLOW_PATH,
      require_name: false,
      label: 'x',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no 'on:' trigger/);
  });

  it('fails a workflow with no jobs', async () => {
    await put(WORKFLOW_PATH, 'name: CI\non: push\n');
    const result = await check({
      type: 'github_workflow_exists',
      path: WORKFLOW_PATH,
      require_name: false,
      label: 'x',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no jobs/);
  });

  it('fails invalid YAML rather than reporting a missing workflow', async () => {
    await put(WORKFLOW_PATH, 'name: CI\non:\n  push:\njobs:\n  build:\n   runs-on: x\n     steps: []\n');
    const result = await check({
      type: 'github_workflow_exists',
      path: WORKFLOW_PATH,
      require_name: false,
      label: 'x',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not a valid workflow/);
  });

  it('requires a name only when the lab asks for one', async () => {
    await put(WORKFLOW_PATH, 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
    expect(
      (await check({ type: 'github_workflow_exists', path: WORKFLOW_PATH, require_name: false, label: 'x' })).status,
    ).toBe('pass');
    expect(
      (await check({ type: 'github_workflow_exists', path: WORKFLOW_PATH, require_name: true, label: 'x' })).status,
    ).toBe('fail');
  });
});

describe('github_workflow_trigger', () => {
  it('accepts a mapping, a sequence, and a bare string form of on:', async () => {
    for (const on of ['on: push', 'on: [push, pull_request]', 'on:\n  push:\n']) {
      await put(WORKFLOW_PATH, `name: CI\n${on}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`);
      const result = await check({ type: 'github_workflow_trigger', path: WORKFLOW_PATH, trigger: 'push', label: 'x' });
      expect(result.status, on).toBe('pass');
    }
  });

  it('names the triggers that are declared when the expected one is absent', async () => {
    await put(WORKFLOW_PATH, `name: CI\non: workflow_dispatch\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`);
    const result = await check({ type: 'github_workflow_trigger', path: WORKFLOW_PATH, trigger: 'push', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/workflow_dispatch/);
  });

  it('checks a branches filter when the lab pins one', async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
    expect(
      (await check({ type: 'github_workflow_trigger', path: WORKFLOW_PATH, trigger: 'push', branches: ['main'], label: 'x' }))
        .status,
    ).toBe('pass');

    const wrong = await check({
      type: 'github_workflow_trigger',
      path: WORKFLOW_PATH,
      trigger: 'pull_request',
      branches: ['main'],
      label: 'x',
    });
    expect(wrong.status).toBe('fail');
    expect(wrong.detail).toMatch(/no branches filter/);
  });
});

describe('github_workflow_job_exists', () => {
  it('passes a job with the right runner, step count and dependencies', async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
    expect(
      (await check({
        type: 'github_workflow_job_exists',
        path: WORKFLOW_PATH,
        job: 'build',
        runs_on: 'ubuntu-latest',
        min_steps: 5,
        label: 'x',
      })).status,
    ).toBe('pass');
    expect(
      (await check({
        type: 'github_workflow_job_exists',
        path: WORKFLOW_PATH,
        job: 'image',
        needs: ['build'],
        label: 'x',
      })).status,
    ).toBe('pass');
  });

  it('lists the jobs that do exist when the named one does not', async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
    const result = await check({ type: 'github_workflow_job_exists', path: WORKFLOW_PATH, job: 'deploy', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/'build'/);
    expect(result.detail).toMatch(/'image'/);
  });

  it('fails a wrong runner and a missing dependency', async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
    expect(
      (await check({ type: 'github_workflow_job_exists', path: WORKFLOW_PATH, job: 'build', runs_on: 'windows-latest', label: 'x' }))
        .status,
    ).toBe('fail');
    expect(
      (await check({ type: 'github_workflow_job_exists', path: WORKFLOW_PATH, job: 'build', needs: ['image'], label: 'x' }))
        .status,
    ).toBe('fail');
  });
});

describe('github_workflow_step_exists', () => {
  beforeEach(async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
  });

  it('matches an action regardless of its version when the lab does not pin one', async () => {
    for (const uses of ['actions/checkout', 'actions/checkout@v4']) {
      const result = await check({ type: 'github_workflow_step_exists', path: WORKFLOW_PATH, job: 'build', uses, label: 'x' });
      expect(result.status, uses).toBe('pass');
    }
  });

  it('fails a pinned version the workflow does not use', async () => {
    const result = await check({
      type: 'github_workflow_step_exists',
      path: WORKFLOW_PATH,
      job: 'build',
      uses: 'actions/checkout@v9',
      label: 'x',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/actions\/checkout@v4/);
  });

  it('matches a run step by the fragments it contains', async () => {
    expect(
      (await check({ type: 'github_workflow_step_exists', path: WORKFLOW_PATH, job: 'build', run_contains: ['node build.mjs'], label: 'x' }))
        .status,
    ).toBe('pass');
    expect(
      (await check({ type: 'github_workflow_step_exists', path: WORKFLOW_PATH, job: 'build', run_contains: ['npm run build'], label: 'x' }))
        .status,
    ).toBe('fail');
  });

  it('checks the with: inputs an action was given', async () => {
    expect(
      (await check({
        type: 'github_workflow_step_exists',
        path: WORKFLOW_PATH,
        job: 'build',
        uses: 'actions/upload-artifact',
        with_keys: ['name', 'path'],
        label: 'x',
      })).status,
    ).toBe('pass');
    expect(
      (await check({
        type: 'github_workflow_step_exists',
        path: WORKFLOW_PATH,
        job: 'build',
        uses: 'actions/upload-artifact',
        with_keys: ['retention-days'],
        label: 'x',
      })).status,
    ).toBe('fail');
  });

  it('requires one step to satisfy every clause, not two steps between them', async () => {
    const result = await check({
      type: 'github_workflow_step_exists',
      path: WORKFLOW_PATH,
      job: 'build',
      uses: 'actions/checkout',
      run_contains: ['node build.mjs'],
      label: 'x',
    });
    expect(result.status).toBe('fail');
  });
});

// -------------------------------------------------------------------- Jenkins

const GOOD_JENKINSFILE = `
pipeline {
    agent any

    environment {
        REGISTRY_URL = 'registry.internal.jumptotech.example'
        REGISTRY_PASSWORD = credentials('statements-registry')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        stage('Build') {
            steps {
                sh 'node build.mjs'
            }
        }
        stage('Test') {
            steps {
                sh 'node --test'
            }
        }
        stage('Package') {
            steps {
                sh "echo publishing to \${REGISTRY_URL}"
                sh 'ls -l dist'
            }
        }
    }
}
`;

describe('jenkinsfile_exists (story test 7)', () => {
  it('passes a well-formed declarative pipeline', async () => {
    await put('Jenkinsfile', GOOD_JENKINSFILE);
    const result = await check({ type: 'jenkinsfile_exists', path: 'Jenkinsfile', require_agent: true, label: 'x' });
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/4 stages/);
  });

  it('fails an unclosed block and says how many', async () => {
    await put('Jenkinsfile', "pipeline {\n  agent any\n  stages {\n    stage('Build') {\n      steps {\n        sh 'x'\n    }\n  }\n}\n");
    const result = await check({ type: 'jenkinsfile_exists', path: 'Jenkinsfile', require_agent: true, label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/unclosed block/);
  });

  it('fails a file with no pipeline block', async () => {
    await put('Jenkinsfile', "node {\n  sh 'node build.mjs'\n}\n");
    const result = await check({ type: 'jenkinsfile_exists', path: 'Jenkinsfile', require_agent: true, label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no `pipeline/);
  });

  it('fails a pipeline with no agent when the lab requires one', async () => {
    await put('Jenkinsfile', "pipeline {\n  stages {\n    stage('Build') {\n      steps {\n        sh 'x'\n      }\n    }\n  }\n}\n");
    const result = await check({ type: 'jenkinsfile_exists', path: 'Jenkinsfile', require_agent: true, label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no 'agent' directive/);
  });

  it('is not fooled by a brace inside a string or a comment', async () => {
    await put(
      'Jenkinsfile',
      [
        'pipeline {',
        '    agent any',
        '    // a closing brace in a comment: }',
        '    stages {',
        "        stage('Build') {",
        '            steps {',
        `                sh 'echo "{ not a block }"'`,
        '            }',
        '        }',
        '    }',
        '}',
        '',
      ].join('\n'),
    );
    const result = await check({ type: 'jenkinsfile_exists', path: 'Jenkinsfile', require_agent: true, label: 'x' });
    expect(result.status, result.detail).toBe('pass');
  });
});

describe('jenkins_stage_exists (story test 8)', () => {
  beforeEach(async () => {
    await put('Jenkinsfile', GOOD_JENKINSFILE);
  });

  it('finds a stage and what its steps run', async () => {
    const result = await check({
      type: 'jenkins_stage_exists',
      path: 'Jenkinsfile',
      stage: 'Build',
      steps_contain: ['node build.mjs'],
      label: 'x',
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/stage 2 of 4/);
  });

  it('lists the stages that exist when the named one does not', async () => {
    const result = await check({ type: 'jenkins_stage_exists', path: 'Jenkinsfile', stage: 'Deploy', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/'Checkout'/);
    expect(result.detail).toMatch(/'Package'/);
  });

  it('enforces stage order, because Jenkins runs them in file order', async () => {
    expect(
      (await check({ type: 'jenkins_stage_exists', path: 'Jenkinsfile', stage: 'Test', after: ['Build'], label: 'x' })).status,
    ).toBe('pass');

    const backwards = await check({
      type: 'jenkins_stage_exists',
      path: 'Jenkinsfile',
      stage: 'Build',
      after: ['Test'],
      label: 'x',
    });
    expect(backwards.status).toBe('fail');
    expect(backwards.detail).toMatch(/declared before 'Test'/);
  });

  it('fails a stage whose steps block is missing or empty', async () => {
    await put('Jenkinsfile', "pipeline {\n  agent any\n  stages {\n    stage('Build') {\n    }\n  }\n}\n");
    const result = await check({ type: 'jenkins_stage_exists', path: 'Jenkinsfile', stage: 'Build', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no 'steps' block/);
  });
});

// ----------------------------------------------- environment and credentials

describe('environment_reference_exists', () => {
  it('finds a workflow env value', async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
    expect(
      (await check({ type: 'environment_reference_exists', path: WORKFLOW_PATH, name: 'IMAGE_NAME', via: 'workflow_env', label: 'x' }))
        .status,
    ).toBe('pass');
  });

  it('fails a name the workflow never declares', async () => {
    await put(WORKFLOW_PATH, GOOD_WORKFLOW);
    const result = await check({
      type: 'environment_reference_exists',
      path: WORKFLOW_PATH,
      name: 'IMAGE_TAG',
      via: 'workflow_env',
      label: 'x',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/IMAGE_NAME/);
  });

  it('distinguishes a Jenkins credentials binding from a plain environment entry', async () => {
    await put('Jenkinsfile', GOOD_JENKINSFILE);

    expect(
      (await check({
        type: 'environment_reference_exists',
        path: 'Jenkinsfile',
        name: 'REGISTRY_PASSWORD',
        via: 'jenkins_credentials',
        label: 'x',
      })).status,
    ).toBe('pass');

    // REGISTRY_URL is configuration, not a credential binding.
    const wrong = await check({
      type: 'environment_reference_exists',
      path: 'Jenkinsfile',
      name: 'REGISTRY_URL',
      via: 'jenkins_credentials',
      label: 'x',
    });
    expect(wrong.status).toBe('fail');
    expect(wrong.detail).toMatch(/credentials/);
  });
});

describe('secret_not_hardcoded (story test 12)', () => {
  it('passes a pipeline that references its credential', async () => {
    await put('Jenkinsfile', GOOD_JENKINSFILE);
    expect((await check({ type: 'secret_not_hardcoded', path: 'Jenkinsfile', label: 'x' })).status).toBe('pass');
  });

  it('fails a credential written as a literal, and never echoes the value', async () => {
    const planted = 'literal-value-that-must-not-be-echoed';
    await put(
      'Jenkinsfile',
      `pipeline {\n  agent any\n  environment {\n    REGISTRY_PASSWORD = '${planted}'\n  }\n  stages {\n    stage('Build') {\n      steps {\n        sh 'node build.mjs'\n      }\n    }\n  }\n}\n`,
    );

    const result = await check({ type: 'secret_not_hardcoded', path: 'Jenkinsfile', label: 'x' });

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/REGISTRY_PASSWORD/);
    // The check reports the key and the location; the value never leaves the file.
    expect(result.detail).not.toContain(planted);
  });

  it('fails a token written into a workflow env or a with: input', async () => {
    await put(
      WORKFLOW_PATH,
      `name: CI\non: push\nenv:\n  DEPLOY_TOKEN: ghp-example-literal-0000\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    );
    expect((await check({ type: 'secret_not_hardcoded', path: WORKFLOW_PATH, label: 'x' })).status).toBe('fail');

    await put(
      WORKFLOW_PATH,
      `name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: some/action@v1\n        with:\n          api_key: hardcoded-inline-value\n`,
    );
    expect((await check({ type: 'secret_not_hardcoded', path: WORKFLOW_PATH, label: 'x' })).status).toBe('fail');
  });

  it('passes the documented ways of referencing a secret', async () => {
    await put(
      WORKFLOW_PATH,
      [
        'name: CI',
        'on: push',
        'env:',
        '  DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}',
        '  REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}',
        '  BUILD_SECRET: $FROM_THE_ENVIRONMENT',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo hi',
        '',
      ].join('\n'),
    );
    expect((await check({ type: 'secret_not_hardcoded', path: WORKFLOW_PATH, label: 'x' })).status).toBe('pass');
  });

  it('does not fail an ordinary setting that merely sounds credential-ish', async () => {
    await put(
      WORKFLOW_PATH,
      `name: CI\non: push\nenv:\n  TOKEN_TYPE: bearer\n  PASSWORD_FILE: /run/secrets/registry\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    );
    expect((await check({ type: 'secret_not_hardcoded', path: WORKFLOW_PATH, label: 'x' })).status).toBe('pass');
  });
});

// ---------------------------------------------------- build, test, artifacts

/** The dependency-free sample project, written straight into the workspace. */
async function seedProject(options: { failingTest?: boolean; brokenBuild?: boolean } = {}): Promise<void> {
  await put('package.json', JSON.stringify({ name: 'demo', version: '9.9.9' }, null, 2));
  await put(
    'src/statements.mjs',
    'export function double(n) {\n  return n * 2;\n}\n',
  );
  await put(
    'test/demo.test.mjs',
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { double } from '../src/statements.mjs';",
      "test('double', () => { assert.equal(double(2), " + (options.failingTest ? '5' : '4') + '); });',
      '',
    ].join('\n'),
  );
  await put(
    'build.mjs',
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      options.brokenBuild ? "throw new Error('build is broken');" : '',
      "await mkdir('dist', { recursive: true });",
      "await writeFile('dist/statements.bundle.js', 'x'.repeat(600));",
      "await writeFile('dist/build-info.json', JSON.stringify({ ok: true }));",
      "console.log('built dist/statements.bundle.js');",
      '',
    ].join('\n'),
  );
}

describe('project_builds (story test 9)', () => {
  it('passes when the build succeeds and writes what it should', async () => {
    await seedProject();
    const result = await check({ type: 'project_builds', produces: 'dist/build-info.json', label: 'x' });
    expect(result.status, result.detail).toBe('pass');
    expect(result.detail).toMatch(/dist\/build-info\.json/);
  });

  it('fails when the build command itself fails, and quotes the error', async () => {
    await seedProject({ brokenBuild: true });
    const result = await check({ type: 'project_builds', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/build is broken/);
  });

  it('fails when a build exits zero but produces nothing', async () => {
    await put('build.mjs', "console.log('nothing to do');\n");
    const result = await check({ type: 'project_builds', produces: 'dist/build-info.json', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/produced no 'dist\/build-info\.json'/);
  });
});

describe('tests_pass (story test 10)', () => {
  it('passes a green suite and reports how many ran', async () => {
    await seedProject();
    const result = await check({ type: 'tests_pass', label: 'x' });
    expect(result.status, result.detail).toBe('pass');
    expect(result.detail).toMatch(/1 tests? passed/);
  });

  it('fails a red suite', async () => {
    await seedProject({ failingTest: true });
    const result = await check({ type: 'tests_pass', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/reported failures/);
  });

  it('fails a workspace with no tests at all rather than passing vacuously', async () => {
    await put('package.json', '{}');
    const result = await check({ type: 'tests_pass', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/ran no tests|reported failures/);
  });
});

describe('artifact_exists (story test 11)', () => {
  it('passes once the build has produced the artifact', async () => {
    await seedProject();
    // Nothing has run yet, so there is no artifact.
    const before = await check({ type: 'artifact_exists', path: 'dist/statements.bundle.js', kind: 'file', min_bytes: 500, label: 'x' });
    expect(before.status).toBe('fail');
    expect(before.detail).toMatch(/Nothing in the workspace has produced it yet/);

    await check({ type: 'project_builds', label: 'x' });

    const after = await check({ type: 'artifact_exists', path: 'dist/statements.bundle.js', kind: 'file', min_bytes: 500, label: 'x' });
    expect(after.status).toBe('pass');
  });

  it('fails an artifact that exists but is empty', async () => {
    await put('dist/statements.bundle.js', '');
    const result = await check({ type: 'artifact_exists', path: 'dist/statements.bundle.js', kind: 'file', min_bytes: 1, label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/exists but is empty/);
  });

  it('sizes a directory artifact from what is inside it', async () => {
    await put('dist/a.js', 'x'.repeat(300));
    await put('dist/b.js', 'y'.repeat(300));
    const result = await check({ type: 'artifact_exists', path: 'dist', kind: 'directory', min_bytes: 500, label: 'x' });
    expect(result.status).toBe('pass');
  });
});

describe('command_exit_code', () => {
  it('runs only an allow-listed task and reports the real exit code', async () => {
    await seedProject({ failingTest: true });
    expect((await check({ type: 'command_exit_code', command: 'node_version', expected_exit_code: 0, label: 'x' })).status).toBe('pass');

    const failing = await check({ type: 'command_exit_code', command: 'app_test', expected_exit_code: 0, label: 'x' });
    expect(failing.status).toBe('fail');
    expect(failing.detail).toMatch(/exited with 1/);
  });
});

// ------------------------------------------------------------- registry shape

describe('the requirement vocabulary stays closed and complete', () => {
  it('has exactly one verifier handler for every requirement type', () => {
    expect([...registeredRequirementTypes()].sort()).toEqual([...REQUIREMENT_TYPES].sort());
  });

  it('includes every file-backed type this story added', () => {
    expect(registeredRequirementTypes()).toEqual(
      expect.arrayContaining([
        'file_exists',
        'yaml_valid',
        'github_workflow_exists',
        'github_workflow_trigger',
        'github_workflow_job_exists',
        'github_workflow_step_exists',
        'jenkinsfile_exists',
        'jenkins_stage_exists',
        'environment_reference_exists',
        'secret_not_hardcoded',
        'artifact_exists',
        'command_exit_code',
        'project_builds',
        'tests_pass',
      ]),
    );
  });
});
