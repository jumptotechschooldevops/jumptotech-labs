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
import { expandsVariable } from '../src/ci/workflow.js';
import { requirementSchema, type Requirement } from '@jumptotech/lab-orchestrator';
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

  /*
   * 444 bytes that expand to 10^9 nodes. The parser refuses to build it
   * ("Excessive alias count"), but that refusal came from `toJS()`, outside
   * the try: it escaped the check, then verifyLab, and every Check of the lab
   * answered HTTP 500 for as long as the file stayed. It is a file that does
   * not parse, and fails like one.
   */
  it('fails, rather than throwing, on YAML whose aliases expand without bound', async () => {
    let laughs = 'a: &a ["x","x","x","x","x","x","x","x","x","x"]\n';
    const names = 'abcdefghi';
    for (let i = 1; i < names.length; i += 1) {
      laughs += `${names[i]}: &${names[i]} [${Array(10).fill(`*${names[i - 1]}`).join(',')}]\n`;
    }
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, `${GOOD_WORKFLOW}${laughs}`);
    const result = await check({ type: 'github_workflow_exists', path: WORKFLOW }, sandbox);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/alias/i);
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

describe('github_workflow_step_exists — with_contains', () => {
  const workflow = (withBlock: string) => `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
${withBlock}
`;
  const req = (withContains: Record<string, string>) => ({
    type: 'github_workflow_step_exists',
    path: WORKFLOW,
    job: 'build',
    uses: 'actions/setup-node',
    with_contains: withContains,
  });

  it('matches a number or a string by its YAML text', async () => {
    for (const value of ['22', "'22'", '"22.4.0"']) {
      const sandbox = new FakeCicdSandbox().put(WORKFLOW, workflow(`          node-version: ${value}`));
      expect((await check(req({ 'node-version': '22' }), sandbox)).status).toBe('pass');
    }
  });

  it('fails a wrong value, and names the input but never the expected value', async () => {
    const sandbox = new FakeCicdSandbox().put(WORKFLOW, workflow('          node-version: 18'));
    const result = await check(req({ 'node-version': '22' }), sandbox);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain("'node-version' input does not have the value this lab expects");
    expect(result.detail).not.toContain('22');
  });

  it('fails an input that is missing or is not a scalar', async () => {
    for (const block of ['          cache: npm', '          node-version:\n            - 22']) {
      const sandbox = new FakeCicdSandbox().put(WORKFLOW, workflow(block));
      expect((await check(req({ 'node-version': '22' }), sandbox)).status).toBe('fail');
    }
  });

  it('is refused by the schema when it names no input', () => {
    expect(() => requirementSchema.parse(req({}))).toThrow();
  });
});

describe('github_workflow_step_exists — with_keys and with_any_key', () => {
  const workflow = (withBlock: string) => `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
${withBlock}
`;
  const req = (extra: Record<string, unknown>) => ({
    type: 'github_workflow_step_exists',
    path: WORKFLOW,
    job: 'build',
    uses: 'actions/setup-node',
    ...extra,
  });
  const run = (extra: Record<string, unknown>, withBlock: string) =>
    check(req(extra), new FakeCicdSandbox().put(WORKFLOW, workflow(withBlock))).then((r) => r.status);

  it('with_any_key passes when any one of the inputs is set', async () => {
    const anyOf = { with_any_key: ['node-version', 'node-version-file'] };
    expect(await run(anyOf, '        with:\n          node-version: 22')).toBe('pass');
    expect(await run(anyOf, '        with:\n          node-version-file: .nvmrc')).toBe('pass');
    expect(await run(anyOf, '        with:\n          cache: npm')).toBe('fail');
    expect(await run(anyOf, '')).toBe('fail');
  });

  it('does not count an input written with no value, for either field', async () => {
    for (const empty of ['          node-version:', "          node-version: ''", '          node-version: ~']) {
      const block = `        with:\n${empty}`;
      expect(await run({ with_keys: ['node-version'] }, block), empty).toBe('fail');
      expect(await run({ with_any_key: ['node-version', 'node-version-file'] }, block), empty).toBe('fail');
    }
    // A value of false or 0 is still a value.
    expect(await run({ with_keys: ['node-version'] }, '        with:\n          node-version: 0')).toBe('pass');
  });

  it('is refused by the schema with fewer than two alternatives', () => {
    expect(() => requirementSchema.parse(req({ with_any_key: ['node-version'] }))).toThrow();
  });
});

describe('environment_reference_exists — what counts as a declaration', () => {
  const ref = (name: string, via?: string) => ({
    type: 'environment_reference_exists',
    path: WORKFLOW,
    name,
    ...(via ? { via } : {}),
  });
  const workflow = (body: string) => `name: CI
on: push
${body}`;

  it('does not take an action input for an environment variable', async () => {
    const sandbox = new FakeCicdSandbox().put(
      WORKFLOW,
      workflow(`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: some/action@v1
        with:
          IMAGE_TAG: abc123
`),
    );
    const result = await check(ref('IMAGE_TAG', 'workflow_env'), sandbox);
    expect(result.status).toBe('fail');
  });

  it('accepts env at workflow, job and step level for workflow_env', async () => {
    const bodies = [
      'env:\n  IMAGE_TAG: abc\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n',
      'jobs:\n  build:\n    runs-on: ubuntu-latest\n    env:\n      IMAGE_TAG: abc\n    steps:\n      - run: echo\n',
      'jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n        env:\n          IMAGE_TAG: abc\n',
    ];
    for (const body of bodies) {
      const sandbox = new FakeCicdSandbox().put(WORKFLOW, workflow(body));
      expect((await check(ref('IMAGE_TAG', 'workflow_env'), sandbox)).status).toBe('pass');
    }
  });

  it('with no via, counts a use in code but not a comment', async () => {
    const used = new FakeCicdSandbox().put(
      WORKFLOW,
      workflow('jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "$DEPLOY_TARGET"\n'),
    );
    expect((await check(ref('DEPLOY_TARGET'), used)).status).toBe('pass');

    const commented = new FakeCicdSandbox().put(
      WORKFLOW,
      workflow('# DEPLOY_TARGET: staging\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n'),
    );
    expect((await check(ref('DEPLOY_TARGET'), commented)).status).toBe('fail');
  });

  it('for workflow_secret, accepts the secrets context used directly and nothing weaker', async () => {
    const direct = new FakeCicdSandbox().put(
      WORKFLOW,
      workflow(
        'jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/login-action@v3\n        with:\n          password: ${{ secrets.REGISTRY_TOKEN }}\n',
      ),
    );
    expect((await check(ref('REGISTRY_TOKEN', 'workflow_secret'), direct)).status).toBe('pass');

    const shell = new FakeCicdSandbox().put(
      WORKFLOW,
      workflow('jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "$REGISTRY_TOKEN" | docker login --password-stdin\n'),
    );
    const result = await check(ref('REGISTRY_TOKEN', 'workflow_secret'), shell);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('REGISTRY_TOKEN is used, but never read from the secrets context');
  });
});

describe('jenkins_stage_exists — steps_contain reads code, not comments', () => {
  it('does not count a commented-out step, and does count one inside a string with //', async () => {
    const jenkinsfile = (steps: string) => `pipeline {
  agent any
  stages {
    stage('Publish') {
      steps {
${steps}
      }
    }
  }
}
`;
    const req = { type: 'jenkins_stage_exists', path: 'Jenkinsfile', stage: 'Publish', steps_contain: ['docker push'] };

    const commented = new FakeCicdSandbox().put('Jenkinsfile', jenkinsfile("        // sh 'docker push x'\n        sh 'echo skipped'"));
    expect((await check(req, commented)).status).toBe('fail');

    const real = new FakeCicdSandbox().put('Jenkinsfile', jenkinsfile("        sh 'docker push https://registry.example/x' // pushed"));
    expect((await check(req, real)).status).toBe('pass');
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

describe('expandsVariable — a variable is read, not merely named', () => {
  it('accepts the shell, workflow and Groovy expansion forms', () => {
    for (const code of ['$IMAGE_NAME', '"${IMAGE_NAME}"', '${IMAGE_NAME:-x}', '${{ env.IMAGE_NAME }}', '${env.IMAGE_NAME}', 'env.IMAGE_NAME']) {
      expect(expandsVariable(code, 'IMAGE_NAME'), code).toBe(true);
    }
  });

  it('rejects the bare name, a longer name, and a different namespace', () => {
    for (const code of ['IMAGE_NAME', '$IMAGE_NAMES', '$MY_IMAGE_NAME', 'github.env.IMAGE_NAME', '$ IMAGE_NAME']) {
      expect(expandsVariable(code, 'IMAGE_NAME'), code).toBe(false);
    }
  });
});
