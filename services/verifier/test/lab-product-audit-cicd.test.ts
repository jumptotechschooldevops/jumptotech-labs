/**
 * CI/CD labs: grading defects found by the 2026-09-21 lab product audit,
 * pinned so they stay closed. Harness as in cicd-labs.test.ts (every build and
 * test task succeeds); the real catalog lab, graded by the real `verifyLab`.
 */
import { describe, expect, it } from 'vitest';
import { loadSetupFiles, type LoadedLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import type { SandboxPort } from '../src/sandbox-reader.js';

class Project implements SandboxPort {
  constructor(private readonly files: Map<string, string>) {}
  async read(relativePath: string): Promise<SandboxPathRead | null> {
    const content = this.files.get(relativePath);
    const base = { mode: '644', owner: 'student', group: 'student' };
    if (content === undefined) {
      const prefix = `${relativePath}/`;
      const children = [...this.files.entries()].filter(([key]) => key.startsWith(prefix));
      if (children.length === 0) return null;
      const size = children.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
      return { ...base, type: 'directory', mode: '755', sizeBytes: size };
    }
    return { ...base, type: 'file', sizeBytes: Buffer.byteLength(content), content };
  }
  async inspect() {
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
}

async function starter(lab: LoadedLabDefinition): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of await loadSetupFiles(lab)) files.set(file.path, file.content.toString());
  return files;
}

const BUILD_OUTPUT: Record<string, string> = {
  'dist/statements.bundle.js': `// bundle\n${'export const x = 1;\n'.repeat(40)}`,
  'dist/build-info.json': '{"sources":["src/statements.mjs"]}\n',
};
function withBuild(files: Map<string, string>) {
  for (const [path, text] of Object.entries(BUILD_OUTPUT)) files.set(path, text);
}

async function grade(labId: string, change: (files: Map<string, string>) => void = () => {}) {
  const registry = await realCatalog();
  const lab = registry.get(labId);
  const files = await starter(lab);
  change(files);
  const project = new Project(files);
  const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001', sandbox: project, cicd: project });
  expect(result.error).toBeUndefined();
  return result;
}
const failing = (r: Awaited<ReturnType<typeof grade>>) => r.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

const WF = '.github/workflows/ci.yml';

// ---------------------------------------------------------------- CICD-003
const cicd003 = (build: string, test: string, jobExtra = '') => (files: Map<string, string>) => {
  let wf = files.get(WF)!;
  if (jobExtra) wf = wf.replace('    runs-on: ubuntu-latest\n', `    runs-on: ubuntu-latest\n${jobExtra}`);
  files.set(
    WF,
    `${wf}
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
${build}
${test}
`,
  );
  withBuild(files);
};
const BUILD_STEP = '      - name: Build\n        run: node build.mjs';
const TEST_STEP = '      - name: Test\n        run: node --test';

describe('CICD-003 — a step or job that never runs does not count', () => {
  it('passes the correct workflow', async () => {
    expect(failing(await grade('CICD-003', cicd003(BUILD_STEP, TEST_STEP)))).toEqual([]);
  });

  it.each(['if: false', 'if: ${{ false }}', "if: 'false'"])('refuses the test step disabled with `%s`', async (condition) => {
    // Before: passed every check.
    const r = await grade('CICD-003', cicd003(BUILD_STEP, `      - name: Test\n        ${condition}\n        run: node --test`));
    expect(failing(r)).toContain('A step runs the tests, after the build');
  });

  it('refuses the whole build job disabled with a job-level `if: false`', async () => {
    const r = await grade('CICD-003', cicd003(BUILD_STEP, TEST_STEP, '    if: false\n'));
    expect(r.passed).toBe(false);
  });

  it('still counts a step behind a real condition — the parser does not evaluate expressions', async () => {
    const r = await grade('CICD-003', cicd003(BUILD_STEP, "      - name: Test\n        if: github.event_name == 'push'\n        run: node --test"));
    expect(failing(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------- CICD-007
const JENKINS_007 = (test: string) => `pipeline {
    agent any
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
${test}
        }
        stage('Package') {
            steps {
                sh 'ls -l dist'
            }
        }
    }
}
`;
describe('CICD-007 — the Test stage runs on every build', () => {
  const grade007 = (test: string) =>
    grade('CICD-007', (files) => {
      files.set('Jenkinsfile', JENKINS_007(test));
      withBuild(files);
    });

  it('passes the correct four-stage pipeline', async () => {
    expect(failing(await grade007("            steps {\n                sh 'node --test'\n            }"))).toEqual([]);
  });

  it('refuses a Test stage behind `when { expression { return false } }`', async () => {
    // Before: passed.
    const r = await grade007(
      "            when {\n                expression { return false }\n            }\n            steps {\n                sh 'node --test'\n            }",
    );
    expect(failing(r)).toEqual(['Test runs the test suite, after Build']);
  });
});

// ---------------------------------------------------------------- CICD-009
function cicd009(files: Map<string, string>, branches: string, deployIf = '') {
  const original = files.get(WF)!;
  files.set(
    WF,
    original.replace('on:\n  push:\n  pull_request:\n', `on:\n  push:\n    branches: ${branches}\n  pull_request:\n\nenv:\n  IMAGE_TAG: \${{ github.sha }}\n`) +
      `
  image:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t "jumptotech/statements:$IMAGE_TAG" .

  deploy:
    runs-on: ubuntu-latest
    needs: image
${deployIf}    steps:
      - uses: actions/checkout@v4
      - run: sed -i "s|jumptotech/statements:.*|jumptotech/statements:$IMAGE_TAG|" deploy/app.yml
`,
  );
  withBuild(files);
}
describe('CICD-009 — a deploy job that never runs does not count', () => {
  it('passes branches [main] with every job enabled', async () => {
    expect(failing(await grade('CICD-009', (f) => cicd009(f, '[main]')))).toEqual([]);
  });

  it("refuses branches [main, '**'], which also runs on every other branch", async () => {
    // Before: passed "Delivery runs only on pushes to main".
    expect(failing(await grade('CICD-009', (f) => cicd009(f, "[main, '**']")))).toEqual([
      'Delivery runs only on pushes to main',
    ]);
  });

  it('passes [main] narrowed further by a negated pattern', async () => {
    expect(failing(await grade('CICD-009', (f) => cicd009(f, "[main, '!main-archive']")))).toEqual([]);
  });

  it('refuses a deploy job disabled with `if: false`', async () => {
    // Before: passed.
    expect((await grade('CICD-009', (f) => cicd009(f, '[main]', '    if: false\n'))).passed).toBe(false);
  });
});

// ---------------------------------------------------------------- CICD-008
function cicd008(files: Map<string, string>, environment: string, publish: string) {
  const original = files.get('Jenkinsfile')!;
  const next = original
    .replace(/ {4}environment \{\n[\s\S]*?\n {4}\}\n/, environment)
    .replace(`sh 'echo "publishing to the registry"'`, publish);
  expect(next).not.toBe(original);
  files.set('Jenkinsfile', next);
}
const ENV_008 = `    environment {
        REGISTRY_URL = 'registry.jumptotech.example'
        REGISTRY_PASSWORD = credentials('statements-registry')
    }
`;
describe('CICD-008 — the seeded password leaves the Jenkinsfile, not just the environment block', () => {
  it('refuses the literal moved into the Publish sh step', async () => {
    const r = await grade('CICD-008', (files) =>
      cicd008(files, ENV_008, `sh "docker login -u ci -p placeholder-do-not-ship-this $REGISTRY_URL"`),
    );
    // Before: passed every check.
    expect(failing(r)).toEqual(['The seeded password is gone from the whole file']);
  });
  it('refuses the literal kept in a Groovy `def` above the pipeline', async () => {
    const r = await grade('CICD-008', (files) => {
      cicd008(files, ENV_008, `sh 'echo "publishing to $REGISTRY_URL"'`);
      files.set('Jenkinsfile', `def REGISTRY_PASSWORD_LITERAL = 'placeholder-do-not-ship-this'\n${files.get('Jenkinsfile')!}`);
    });
    // Before: passed every check.
    expect(failing(r)).toEqual(['The seeded password is gone from the whole file']);
  });
  it('refuses a withEnv([...]) literal in a stage', async () => {
    const r = await grade('CICD-008', (files) =>
      cicd008(
        files,
        ENV_008,
        `withEnv(['REGISTRY_TOKEN=placeholder-do-not-ship-this']) {\n                    sh 'echo "publishing to $REGISTRY_URL"'\n                }`,
      ),
    );
    // Before: passed every check.
    expect(failing(r)).toEqual(['The seeded password is gone from the whole file']);
  });

  it('passes the password bound from the credential store', async () => {
    const r = await grade('CICD-008', (files) => cicd008(files, ENV_008, `sh 'echo "publishing to $REGISTRY_URL"'`));
    expect(failing(r)).toEqual([]);
  });
});
