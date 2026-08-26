/**
 * The CI/CD requirement types.
 *
 * These grade what a student wrote — a workflow, a Jenkinsfile, a pipeline
 * script — and what their project did when it was built. The first is tested
 * here against real file contents; the second is tested here against *canned*
 * task results, and against a real container in
 * `cicd-runtime-integration.test.ts`.
 *
 * The split is not a convenience. `@jumptotech/test-support/host-execution`
 * denies a unit test any real host process, and a fixture that spawned one is
 * precisely the defect that guard exists to catch — three suites once looked
 * hermetic while quietly running the host's `kubectl`. So "the build really
 * runs" is proved where a real sandbox exists, and "the handler does the right
 * thing with a build's result" is proved here, where it can be exhaustive.
 */
import { describe, expect, it } from 'vitest';
import type { Requirement } from '@jumptotech/lab-orchestrator';
import { verifyRequirement } from '../src/index.js';
import { CicdVerifyReader } from '../src/cicd-reader.js';
import type { SandboxPathRead } from '@jumptotech/lab-orchestrator';
import type { SandboxPort } from '../src/sandbox-reader.js';

/** An in-memory project, with task results the test decides. */
class FakeCicdSandbox implements SandboxPort {
  readonly inspections: string[] = [];
  readonly #files = new Map<string, string>();
  readonly #results = new Map<string, { exitCode: number; stdout: string; stderr: string }>();

  put(relativePath: string, contents: string): this {
    this.#files.set(relativePath, contents);
    return this;
  }

  /** What a task will report, keyed by the argv line it runs. */
  willRun(line: string, result: { exitCode: number; stdout?: string; stderr?: string }): this {
    this.#results.set(line, {
      exitCode: result.exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
    return this;
  }

  async read(relativePath: string): Promise<SandboxPathRead | null> {
    const content = this.#files.get(relativePath);
    if (content === undefined) {
      const prefix = `${relativePath}/`;
      for (const key of this.#files.keys()) {
        if (key.startsWith(prefix)) return { type: 'directory', mode: '755', owner: 'student', group: 'student', sizeBytes: 0 };
      }
      return null;
    }
    return {
      type: 'file',
      mode: '644',
      owner: 'student',
      group: 'student',
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      content,
    };
  }

  async inspect(command: string, args: readonly string[]) {
    const line = [command, ...args].join(' ');
    this.inspections.push(line);
    const canned = this.#results.get(line) ?? { exitCode: 0, stdout: '', stderr: '' };
    return { ...canned, timedOut: false };
  }
}

/** A sandbox that can read but cannot run anything — the fail-closed case. */
class ReadOnlySandbox implements SandboxPort {
  async read(): Promise<SandboxPathRead | null> {
    return null;
  }
}

function check(requirement: Record<string, unknown>, sandbox: SandboxPort) {
  return verifyRequirement(requirement as unknown as Requirement, {
    cicd: new CicdVerifyReader(sandbox),
  });
}

const WORKFLOW = '.github/workflows/ci.yml';

const GOOD_WORKFLOW = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Build
        run: node build.mjs
      - name: Test
        run: node --test
`;

const GOOD_JENKINSFILE = `pipeline {
  agent any
  environment {
    REGISTRY_URL = 'registry.example.com'
  }
  stages {
    stage('Build') {
      steps { sh 'node build.mjs' }
    }
    stage('Test') {
      steps { sh 'node --test' }
    }
  }
}
`;

// --- GitHub Actions ---------------------------------------------------------

describe('github_workflow_exists', () => {
  it('passes for a workflow that parses', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, GOOD_WORKFLOW);
    const result = await check({ type: 'github_workflow_exists', path: WORKFLOW }, sandbox);
    expect(result.status).toBe('pass');
  });

  it('fails when absent, naming the path the student must create', async () => {
    const result = await check(
      { type: 'github_workflow_exists', path: WORKFLOW },
      new FakeCicdSandbox(),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(WORKFLOW);
  });

  it('fails on YAML that does not parse', async () => {
    const sandbox = new FakeCicdSandbox().put(
      WORKFLOW,
      'name: CI\njobs:\n  build:\n   x:\n  - bad\n',
    );
    const result = await check({ type: 'github_workflow_exists', path: WORKFLOW }, sandbox);
    expect(result.status).toBe('fail');
  });
});

describe('github_workflow_trigger', () => {
  it('recognises a declared event', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, GOOD_WORKFLOW);
    const result = await check(
      { type: 'github_workflow_trigger', path: WORKFLOW, trigger: 'push' },
      sandbox,
    );
    expect(result.status).toBe('pass');
  });

  it('fails for an event the workflow does not declare', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, GOOD_WORKFLOW);
    const result = await check(
      { type: 'github_workflow_trigger', path: WORKFLOW, trigger: 'schedule' },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });
});

describe('github_workflow_job_exists and github_workflow_step_exists', () => {
  it('finds a job by id', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, GOOD_WORKFLOW);
    const result = await check(
      { type: 'github_workflow_job_exists', path: WORKFLOW, job: 'build' },
      sandbox,
    );
    expect(result.status).toBe('pass');
  });

  it('fails for a job that is not there', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, GOOD_WORKFLOW);
    const result = await check(
      { type: 'github_workflow_job_exists', path: WORKFLOW, job: 'deploy' },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });

  it('finds a step by the action it uses', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, GOOD_WORKFLOW);
    const result = await check(
      {
        type: 'github_workflow_step_exists',
        path: WORKFLOW,
        job: 'build',
        uses: 'actions/checkout',
      },
      sandbox,
    );
    expect(result.status).toBe('pass');
  });

  it('finds a step by a fragment of what it runs', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, GOOD_WORKFLOW);
    const result = await check(
      {
        type: 'github_workflow_step_exists',
        path: WORKFLOW,
        job: 'build',
        run_contains: ['node --test'],
      },
      sandbox,
    );
    expect(result.status).toBe('pass');
  });

  it('does not credit a step that belongs to a different job', async () => {
    const sandbox = new FakeCicdSandbox().put(
      WORKFLOW,
      'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node build.mjs\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test\n',
    );
    const result = await check(
      {
        type: 'github_workflow_step_exists',
        path: WORKFLOW,
        job: 'build',
        run_contains: ['node --test'],
      },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });
});

// --- Jenkins ----------------------------------------------------------------

describe('jenkinsfile_exists and jenkins_stage_exists', () => {
  it('accepts a declarative pipeline', async () => {
    const sandbox = new FakeCicdSandbox().put('Jenkinsfile', GOOD_JENKINSFILE);
    const result = await check({ type: 'jenkinsfile_exists', path: 'Jenkinsfile' }, sandbox);
    expect(result.status).toBe('pass');
  });

  it('finds a stage by name', async () => {
    const sandbox = new FakeCicdSandbox().put('Jenkinsfile', GOOD_JENKINSFILE);
    const result = await check(
      { type: 'jenkins_stage_exists', path: 'Jenkinsfile', stage: 'Build' },
      sandbox,
    );
    expect(result.status).toBe('pass');
  });

  it('fails for a stage the pipeline does not declare', async () => {
    const sandbox = new FakeCicdSandbox().put('Jenkinsfile', GOOD_JENKINSFILE);
    const result = await check(
      { type: 'jenkins_stage_exists', path: 'Jenkinsfile', stage: 'Deploy' },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });

  it('fails rather than throws on an empty Jenkinsfile', async () => {
    const sandbox = new FakeCicdSandbox().put('Jenkinsfile', '');
    const result = await check({ type: 'jenkinsfile_exists', path: 'Jenkinsfile' }, sandbox);
    expect(result.status).toBe('fail');
  });
});

// --- secrets ----------------------------------------------------------------

const SECRET = 'ghp_ZmFrZXRva2VuZm9ydGVzdHMwMDAwMDAwMDAw';

function jenkinsfileWith(assignment: string): string {
  return `pipeline {\n  agent any\n  environment {\n    API_TOKEN = ${assignment}\n  }\n  stages { stage('Build') { steps { sh 'node build.mjs' } } }\n}\n`;
}

describe('secret_not_hardcoded', () => {
  it('passes when the value comes from a credential reference', async () => {
    const sandbox = new FakeCicdSandbox().put(
      'Jenkinsfile',
      jenkinsfileWith("credentials('api-token')"),
    );
    const result = await check({ type: 'secret_not_hardcoded', path: 'Jenkinsfile' }, sandbox);
    expect(result.status).toBe('pass');
  });

  it('fails when a literal secret is assigned in the file', async () => {
    const sandbox = new FakeCicdSandbox().put('Jenkinsfile', jenkinsfileWith(`'${SECRET}'`));
    const result = await check({ type: 'secret_not_hardcoded', path: 'Jenkinsfile' }, sandbox);
    expect(result.status).toBe('fail');
  });

  it('never repeats the secret it found', async () => {
    const sandbox = new FakeCicdSandbox().put('Jenkinsfile', jenkinsfileWith(`'${SECRET}'`));
    const result = await check({ type: 'secret_not_hardcoded', path: 'Jenkinsfile' }, sandbox);
    // The whole serialised result, because that is what the API returns and the
    // browser renders. Reporting a leaked credential by quoting it leaks it a
    // second time, into a place more people can read.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('environment_reference_exists', () => {
  it('passes when the pipeline references the variable', async () => {
    const sandbox = new FakeCicdSandbox().put('Jenkinsfile', GOOD_JENKINSFILE);
    const result = await check(
      { type: 'environment_reference_exists', path: 'Jenkinsfile', name: 'REGISTRY_URL' },
      sandbox,
    );
    expect(result.status).toBe('pass');
  });

  it('fails when it does not', async () => {
    const sandbox = new FakeCicdSandbox().put('Jenkinsfile', GOOD_JENKINSFILE);
    const result = await check(
      { type: 'environment_reference_exists', path: 'Jenkinsfile', name: 'MISSING_VAR' },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });
});

// --- what the handlers do with a build's result ------------------------------

describe('project_builds, tests_pass and artifact_exists', () => {
  it('passes on a build that exits zero, running the task from the closed table', async () => {
    const sandbox = new FakeCicdSandbox().willRun('node build.mjs', { exitCode: 0 });
    const result = await check({ type: 'project_builds' }, sandbox);
    expect(result.status).toBe('pass');
    // The argv came from WORKSPACE_TASKS, not from the requirement.
    expect(sandbox.inspections).toEqual(['node build.mjs']);
  });

  it('fails on a build that exits non-zero, and shows the reason', async () => {
    const sandbox = new FakeCicdSandbox().willRun('node build.mjs', {
      exitCode: 1,
      stderr: 'build failed: missing entry point',
    });
    const result = await check({ type: 'project_builds' }, sandbox);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('missing entry point');
  });

  it('fails a build that exits zero but produced nothing', async () => {
    const sandbox = new FakeCicdSandbox().willRun('node build.mjs', { exitCode: 0 });
    const result = await check(
      { type: 'project_builds', produces: 'dist/statements.bundle.js' },
      sandbox,
    );
    // Exactly the CICD-010 fault: the build "succeeded" and wrote nowhere.
    expect(result.status).toBe('fail');
  });

  it('passes a build that produced a non-empty artifact', async () => {
    const sandbox = new FakeCicdSandbox()
      .willRun('node build.mjs', { exitCode: 0 })
      .put('dist/statements.bundle.js', 'export const ok = true;\n');
    const result = await check(
      { type: 'project_builds', produces: 'dist/statements.bundle.js' },
      sandbox,
    );
    expect(result.status).toBe('pass');
  });

  it('fails an artifact that exists but is empty', async () => {
    const sandbox = new FakeCicdSandbox()
      .willRun('node build.mjs', { exitCode: 0 })
      .put('dist/statements.bundle.js', '');
    const result = await check(
      { type: 'project_builds', produces: 'dist/statements.bundle.js' },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });

  it('passes when the test task exits zero', async () => {
    const sandbox = new FakeCicdSandbox().willRun('node --test', { exitCode: 0 });
    const result = await check({ type: 'tests_pass' }, sandbox);
    expect(result.status).toBe('pass');
  });

  it('fails when a test fails', async () => {
    const sandbox = new FakeCicdSandbox().willRun('node --test', {
      exitCode: 1,
      stdout: '# fail 1',
    });
    const result = await check({ type: 'tests_pass' }, sandbox);
    expect(result.status).toBe('fail');
  });

  it('runs one build for several checks about it', async () => {
    const sandbox = new FakeCicdSandbox()
      .willRun('node build.mjs', { exitCode: 0 })
      .put('dist/statements.bundle.js', 'x');
    const reader = new CicdVerifyReader(sandbox);
    await verifyRequirement({ type: 'project_builds' } as unknown as Requirement, { cicd: reader });
    await verifyRequirement(
      { type: 'artifact_exists', path: 'dist/statements.bundle.js' } as unknown as Requirement,
      { cicd: reader },
    );
    // Two claims about one build. Running it twice could report a pass and a
    // fail for the same project.
    expect(sandbox.inspections.filter((line) => line === 'node build.mjs')).toHaveLength(1);
  });

  it('honours the expected exit code of a named task', async () => {
    const sandbox = new FakeCicdSandbox().willRun('node src/cli.mjs --selftest', { exitCode: 0 });
    const result = await check(
      { type: 'workspace_task_exit_code', command: 'app_smoke', expected_exit_code: 0 },
      sandbox,
    );
    expect(result.status).toBe('pass');
  });

  it('fails a named task that exits with the wrong code', async () => {
    const sandbox = new FakeCicdSandbox().willRun('node src/cli.mjs --selftest', { exitCode: 3 });
    const result = await check(
      { type: 'workspace_task_exit_code', command: 'app_smoke', expected_exit_code: 0 },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });
});

// --- fail-closed -------------------------------------------------------------

describe('fail-closed behaviour', () => {
  it('does not pass a build check when the environment cannot run anything', async () => {
    const result = await check({ type: 'project_builds' }, new ReadOnlySandbox());
    // A sandbox with no `inspect` cannot have built anything, so the one thing
    // this must never report is success.
    expect(result.status).not.toBe('pass');
  });

  it('reports a skip, not a failure, when there is no CI/CD reader at all', async () => {
    const result = await verifyRequirement({ type: 'project_builds' } as unknown as Requirement, {});
    // The platform could not look. Telling a student they failed would blame
    // them for a gap in the platform.
    expect(result.status).toBe('skipped');
  });

  it('fails rather than throws on a workflow that is not a mapping', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, 'just a string, not a mapping\n');
    const result = await check(
      { type: 'github_workflow_job_exists', path: WORKFLOW, job: 'build' },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });

  it('fails rather than throws when a workflow job holds no steps', async () => {
    const sandbox = new FakeCicdSandbox().put(
      WORKFLOW,
      'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n',
    );
    const result = await check(
      {
        type: 'github_workflow_step_exists',
        path: WORKFLOW,
        job: 'build',
        uses: 'actions/checkout',
      },
      sandbox,
    );
    expect(result.status).toBe('fail');
  });
});
