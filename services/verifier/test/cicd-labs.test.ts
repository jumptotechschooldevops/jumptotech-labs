/**
 * The shipped CI/CD labs, graded end to end against their own workspaces.
 *
 * `cicd-requirements.test.ts` proves what each requirement type does. This
 * proves what each *lab* accepts: its untouched workspace fails, a correct
 * solution passes, and the shortcuts a lab-quality audit found — a comment that
 * names a variable, a secret echoed in a shell step, an upload that collects
 * nothing — fail.
 *
 * The build and the test suite are not run here (see the header of
 * `cicd-requirements.test.ts` for why a unit test may not run host
 * processes); every task reports success, and where a lab reads what the
 * build wrote, the solution world holds those files. That is the most
 * favourable answer the platform could give, so a shortcut that still fails
 * here fails on the checks that read the student's files.
 */
import { describe, expect, it } from 'vitest';
import { loadSetupFiles, type LoadedLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import type { SandboxPort } from '../src/sandbox-reader.js';

/** A project whose files the test states and whose every task succeeds. */
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

/** What `node build.mjs` leaves behind, for the labs that read it. */
const BUILD_OUTPUT: Record<string, string> = {
  'dist/statements.bundle.js': `// bundle\n${'export const x = 1;\n'.repeat(40)}`,
  'dist/build-info.json': '{"sources":["src/statements.mjs"]}\n',
};

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

const failing = (result: Awaited<ReturnType<typeof grade>>) =>
  result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

function withBuild(files: Map<string, string>) {
  for (const [path, text] of Object.entries(BUILD_OUTPUT)) files.set(path, text);
}

// ------------------------------------------------------------------ CICD-003

const CICD_003_STEPS = (setupWith: string) => `
      - name: Set up Node.js
        uses: actions/setup-node@v4
${setupWith}
      - name: Build
        run: node build.mjs
      - name: Test
        run: node --test
`;

function cicd003(setupWith: string) {
  return (files: Map<string, string>) => {
    files.set('.github/workflows/ci.yml', files.get('.github/workflows/ci.yml')! + CICD_003_STEPS(setupWith));
    withBuild(files);
  };
}

describe('CICD-003 — build and test in GitHub Actions', () => {
  const VERSION = 'A step provisions a chosen Node.js version';

  it('fails the untouched workflow', async () => {
    expect(failing(await grade('CICD-003'))).toContain(VERSION);
  });

  it('passes a version given inline', async () => {
    expect(failing(await grade('CICD-003', cicd003('        with:\n          node-version: 20')))).toEqual([]);
  });

  it('passes a version read from a version file — setup-node documents both', async () => {
    const result = await grade('CICD-003', cicd003('        with:\n          node-version-file: package.json'));
    expect(failing(result)).toEqual([]);
  });

  it('fails setup-node with no version, or with an empty one: the runner picks whatever it has', async () => {
    for (const setupWith of ['', '        with:\n          node-version:', "        with:\n          node-version: ''", '        with:\n          cache: npm']) {
      expect(failing(await grade('CICD-003', cicd003(setupWith))), JSON.stringify(setupWith)).toEqual([VERSION]);
    }
  });
});

// ------------------------------------------------------------------ CICD-004

const CICD_004_UPLOAD = (path: string) => `
      - name: Upload build output
        uses: actions/upload-artifact@v4
        with:
          name: statements-dist
          path: ${path}
`;

describe('CICD-004 — publishing build artifacts', () => {
  const workflow = '.github/workflows/ci.yml';

  it('fails on the starter workspace', async () => {
    expect((await grade('CICD-004')).passed).toBe(false);
  });

  it('passes an upload of the build output', async () => {
    const result = await grade('CICD-004', (files) => {
      files.set(workflow, files.get(workflow)! + CICD_004_UPLOAD('dist/'));
      withBuild(files);
    });
    expect(failing(result)).toEqual([]);
  });

  it('fails an upload whose path collects nothing — the mistake the lab is about', async () => {
    const result = await grade('CICD-004', (files) => {
      files.set(workflow, files.get(workflow)! + CICD_004_UPLOAD('nothing-here/'));
      withBuild(files);
    });
    expect(failing(result)).toEqual(['A step uploads a named artifact from the build output, once it exists']);
    const detail = result.checks.find((c) => c.status !== 'pass')?.detail ?? '';
    expect(detail).toContain("'path' input does not have the value this lab expects");
    expect(detail).not.toContain('dist');
  });
});

// ------------------------------------------------------------------ CICD-005

const CICD_005_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "src/cli.mjs"]\n';

function cicd005Workflow(files: Map<string, string>, opts: { env: string; run: string }) {
  const original = files.get('.github/workflows/ci.yml')!;
  files.set(
    '.github/workflows/ci.yml',
    original.replace('jobs:\n', `${opts.env}jobs:\n`) +
      `
  image:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - name: Build the image
        run: ${opts.run}
`,
  );
  files.set('Dockerfile', CICD_005_DOCKERFILE);
}

describe('CICD-005 — building a container image in CI', () => {
  it('fails on the starter workspace', async () => {
    expect((await grade('CICD-005')).passed).toBe(false);
  });

  it('passes an image job that builds from IMAGE_NAME declared in env', async () => {
    const result = await grade('CICD-005', (files) =>
      cicd005Workflow(files, {
        env: 'env:\n  IMAGE_NAME: jumptotech/statements\n\n',
        run: 'docker build -t "$IMAGE_NAME:${{ github.sha }}" .',
      }),
    );
    expect(failing(result)).toEqual([]);
  });

  it('fails IMAGE_NAME that is used in a step but never declared', async () => {
    const result = await grade('CICD-005', (files) =>
      cicd005Workflow(files, { env: '', run: 'docker build -t "$IMAGE_NAME:latest" .' }),
    );
    expect(failing(result)).toEqual(['The image name comes from a workflow variable']);
  });

  it('fails IMAGE_NAME that appears only in a comment', async () => {
    const result = await grade('CICD-005', (files) =>
      cicd005Workflow(files, {
        env: '# IMAGE_NAME: jumptotech/statements\n',
        run: 'docker build -t jumptotech/statements:latest . # IMAGE_NAME',
      }),
    );
    expect(failing(result)).toEqual([
      'A step builds the container image, named from IMAGE_NAME',
      'The image name comes from a workflow variable',
    ]);
  });
});

// ------------------------------------------------------------------ CICD-008

function cicd008(files: Map<string, string>, environment: string, publish: string) {
  const original = files.get('Jenkinsfile')!;
  const next = original
    .replace(/ {4}environment \{\n[\s\S]*?\n {4}\}\n/, environment)
    .replace(`sh 'echo "publishing to the registry"'`, publish);
  expect(next).not.toBe(original);
  files.set('Jenkinsfile', next);
}

describe('CICD-008 — environment variables and credentials', () => {
  it('fails on the starter workspace', async () => {
    expect((await grade('CICD-008')).passed).toBe(false);
  });

  it('passes configuration in environment and the password bound with credentials()', async () => {
    const result = await grade('CICD-008', (files) =>
      cicd008(
        files,
        `    environment {
        REGISTRY_URL = 'registry.jumptotech.example'
        REGISTRY_PASSWORD = credentials('statements-registry')
    }
`,
        `sh 'echo "publishing to $REGISTRY_URL"'`,
      ),
    );
    expect(failing(result)).toEqual([]);
  });

  it('passes the password bound for one block with withCredentials', async () => {
    const result = await grade('CICD-008', (files) =>
      cicd008(
        files,
        `    environment {
        REGISTRY_URL = 'registry.jumptotech.example'
    }
`,
        `withCredentials([string(credentialsId: 'statements-registry', variable: 'REGISTRY_PASSWORD')]) {
                    sh 'echo "publishing to $REGISTRY_URL"'
                }`,
      ),
    );
    expect(failing(result)).toEqual([]);
  });

  it('fails a pipeline that uses both names in a shell step and declares neither', async () => {
    const result = await grade('CICD-008', (files) =>
      cicd008(
        files,
        '',
        `sh 'echo $REGISTRY_PASSWORD | docker login $REGISTRY_URL --password-stdin'`,
      ),
    );
    expect(failing(result)).toEqual([
      'REGISTRY_URL is declared as pipeline configuration',
      'REGISTRY_PASSWORD is bound from the credential store by id',
    ]);
    const details = result.checks.filter((c) => c.status !== 'pass').map((c) => c.detail);
    expect(details).toEqual([
      "REGISTRY_URL is used, but never declared in the pipeline's environment block",
      "REGISTRY_PASSWORD is used, but never bound with credentials('…')",
    ]);
  });

  it('fails declarations that exist only in comments', async () => {
    const result = await grade('CICD-008', (files) =>
      cicd008(
        files,
        `    // environment {
    //     REGISTRY_URL = 'registry.jumptotech.example'
    //     REGISTRY_PASSWORD = credentials('statements-registry')
    // }
    /* withCredentials([string(credentialsId: 'x', variable: 'REGISTRY_PASSWORD')]) */
`,
        `sh 'echo "publishing to the registry"' // REGISTRY_URL`,
      ),
    );
    expect(failing(result)).toEqual([
      'REGISTRY_URL is declared as pipeline configuration',
      'REGISTRY_PASSWORD is bound from the credential store by id',
      'The Publish stage uses the REGISTRY_URL variable',
    ]);
  });
});

// ------------------------------------------------------------------ CICD-009

function cicd009(files: Map<string, string>, opts: { image: string; deploy: string }) {
  const original = files.get('.github/workflows/ci.yml')!;
  files.set(
    '.github/workflows/ci.yml',
    original.replace('on:\n  push:\n  pull_request:\n', 'on:\n  push:\n    branches: [main]\n  pull_request:\n\nenv:\n  IMAGE_TAG: ${{ github.sha }}\n') +
      `
  image:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - run: ${opts.image}

  deploy:
    runs-on: ubuntu-latest
    needs: image
    steps:
      - uses: actions/checkout@v4
      - run: ${opts.deploy}
`,
  );
  withBuild(files);
}

describe('CICD-009 — a complete delivery pipeline', () => {
  it('fails on the starter workspace', async () => {
    expect((await grade('CICD-009')).passed).toBe(false);
  });

  it('passes an image tagged from IMAGE_TAG and a manifest updated with it', async () => {
    const result = await grade('CICD-009', (files) =>
      cicd009(files, {
        image: 'docker build -t "jumptotech/statements:$IMAGE_TAG" .',
        deploy: `sed -i "s|jumptotech/statements:.*|jumptotech/statements:$IMAGE_TAG|" deploy/app.yml`,
      }),
    );
    expect(failing(result)).toEqual([]);
  });

  it('fails an untagged build and a deploy step that only reads the manifest', async () => {
    const result = await grade('CICD-009', (files) =>
      cicd009(files, { image: 'docker build .', deploy: 'cat deploy/app.yml' }),
    );
    expect(failing(result)).toEqual([
      'The image job builds the container image, tagged from IMAGE_TAG',
      'The deploy job writes the new tag into the deployment manifest',
    ]);
  });
});

// ------------------------------------------------------------------ CICD-010

const CICD_010_WORKFLOW = (opts: { env?: string; name?: string; path?: string }) => `name: CI

on:
  push:
${opts.env ?? '\nenv:\n  APP_VERSION: 1.4.1\n'}
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

      - name: Publish the build output
        uses: actions/upload-artifact@v4
        with:
          name: ${opts.name ?? 'statements-${{ env.APP_VERSION }}'}
          path: ${opts.path ?? 'dist/'}
`;

const CICD_010_JENKINSFILE = `pipeline {
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
            steps {
                sh 'node --test'
            }
        }

        stage('Package') {
            steps {
                sh 'ls -l dist'
            }
        }
    }
}
`;

function cicd010(files: Map<string, string>, workflow: string) {
  files.delete('.github/workflow/ci.yml');
  files.set('.github/workflows/ci.yml', workflow);
  files.set('Jenkinsfile', CICD_010_JENKINSFILE);
  withBuild(files);
}

describe('CICD-010 — troubleshooting a broken pipeline', () => {
  it('fails on the starter workspace', async () => {
    expect((await grade('CICD-010')).passed).toBe(false);
  });

  it('uses the variable the way GitHub Actions expands it in a with: input', async () => {
    // `with:` is not a shell: `${APP_VERSION}` there is literal text. The
    // starter must show the fault the hints describe — used, never defined —
    // and not a second, unannounced one.
    const registry = await realCatalog();
    const files = await starter(registry.get('CICD-010'));
    const workflow = files.get('.github/workflow/ci.yml')!;
    expect(workflow).toContain('${{ env.APP_VERSION }}');
    expect(workflow).not.toMatch(/\$\{APP_VERSION\}/);
  });

  it('passes the repaired pipelines', async () => {
    const result = await grade('CICD-010', (files) => cicd010(files, CICD_010_WORKFLOW({})));
    expect(failing(result)).toEqual([]);
  });

  it('fails when the artifact path still names a directory the build never creates', async () => {
    const result = await grade('CICD-010', (files) => cicd010(files, CICD_010_WORKFLOW({ path: 'build/' })));
    expect(failing(result)).toEqual(['The job uploads the build output, named with APP_VERSION, after the build']);
  });

  it('fails when APP_VERSION is still never defined, or defined only in a comment', async () => {
    for (const env of ['\n', '\n# env:\n#   APP_VERSION: 1.4.1\n']) {
      const result = await grade('CICD-010', (files) => cicd010(files, CICD_010_WORKFLOW({ env })));
      expect(failing(result)).toEqual(['APP_VERSION is defined in the workflow']);
    }
  });

  it('fails a name written with shell syntax, which with: never expands', async () => {
    const result = await grade('CICD-010', (files) =>
      cicd010(files, CICD_010_WORKFLOW({ name: 'statements-${APP_VERSION}' })),
    );
    expect(failing(result)).toEqual(['The job uploads the build output, named with APP_VERSION, after the build']);
  });
});

// ------------------------------------------------- shortcuts, second audit

describe('CI/CD shortcuts found by the second lab-quality audit', () => {
  const WF = '.github/workflows/ci.yml';

  it('CICD-003: the right four steps in the wrong order fail — the runner executes them as listed', async () => {
    const result = await grade('CICD-003', (files) => {
      const starter = files.get(WF)!.replace(/\n {6}- name: Check out the repository\n {8}uses: actions\/checkout@v4\n/, '\n');
      files.set(
        WF,
        `${starter}      - run: node --test
      - run: node build.mjs
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: actions/checkout@v4
`,
      );
      withBuild(files);
    });
    expect(failing(result).sort()).toEqual([
      'A step runs the build, once the code and Node.js are in place',
      'A step runs the tests, after the build',
    ]);
    const detail = result.checks.find((c) => c.label.startsWith('A step runs the build'))?.detail ?? '';
    expect(detail).toContain('runs before a step it depends on');
  });

  it('CICD-003: a command written as a comment in a run block does not run', async () => {
    const result = await grade('CICD-003', cicd003('        with:\n          node-version: 20'));
    expect(failing(result)).toEqual([]);
    const commented = await grade('CICD-003', (files) => {
      cicd003('        with:\n          node-version: 20')(files);
      files.set(WF, files.get(WF)!.replace('        run: node build.mjs', '        run: |\n          echo skipping\n          # node build.mjs'));
    });
    expect(failing(commented)).toContain('A step runs the build, once the code and Node.js are in place');
  });

  it('CICD-004: an upload placed before the build fails', async () => {
    const result = await grade('CICD-004', (files) => {
      const wf = files.get(WF)!;
      const buildAt = wf.indexOf('      - name: Build');
      expect(buildAt).toBeGreaterThan(0);
      files.set(WF, wf.slice(0, buildAt) + CICD_004_UPLOAD('dist/').slice(1) + wf.slice(buildAt));
      withBuild(files);
    });
    expect(failing(result)).toEqual(['A step uploads a named artifact from the build output, once it exists']);
  });

  it('CICD-005: the bare name is not the variable; every expansion form is', async () => {
    const env = 'env:\n  IMAGE_NAME: jumptotech/statements\n\n';
    const bare = await grade('CICD-005', (files) => cicd005Workflow(files, { env, run: 'docker build -t IMAGE_NAME .' }));
    expect(failing(bare)).toEqual(['A step builds the container image, named from IMAGE_NAME']);
    expect(bare.checks.find((c) => c.status === 'fail')?.detail).toContain('does not expand $IMAGE_NAME');
    for (const run of ['docker build -t "${IMAGE_NAME}:1" .', 'docker build -t "${{ env.IMAGE_NAME }}:1" .']) {
      expect(failing(await grade('CICD-005', (files) => cicd005Workflow(files, { env, run }))), run).toEqual([]);
    }
  });

  it('CICD-005: an image job without a checkout fails — it would build from an empty directory', async () => {
    const result = await grade('CICD-005', (files) => {
      cicd005Workflow(files, { env: 'env:\n  IMAGE_NAME: jumptotech/statements\n\n', run: 'docker build -t "$IMAGE_NAME" .' });
      files.set(WF, files.get(WF)!.replace(/(needs: build\n {4}steps:\n) {6}- uses: actions\/checkout@v4\n/, '$1'));
    });
    expect(failing(result)).toEqual([
      'The image job checks the repository out',
      'A step builds the container image, named from IMAGE_NAME',
    ]);
  });

  it('CICD-008: REGISTRY_URL declared only in another stage is invisible to Publish', async () => {
    const result = await grade('CICD-008', (files) => {
      cicd008(files, `    environment {\n        REGISTRY_PASSWORD = credentials('statements-registry')\n    }\n`, `sh 'echo "publishing to $REGISTRY_URL"'`);
      files.set('Jenkinsfile', files.get('Jenkinsfile')!.replace("stage('Build') {\n", "stage('Build') {\n            environment {\n                REGISTRY_URL = 'registry.jumptotech.example'\n            }\n"));
    });
    expect(failing(result)).toEqual(['REGISTRY_URL is declared as pipeline configuration']);
  });

  it('CICD-008: the name alone is not a use of the variable; env.REGISTRY_URL is', async () => {
    const env = `    environment {\n        REGISTRY_URL = 'registry.jumptotech.example'\n        REGISTRY_PASSWORD = credentials('statements-registry')\n    }\n`;
    const bare = await grade('CICD-008', (files) => cicd008(files, env, `sh 'echo "publishing to REGISTRY_URL"'`));
    expect(failing(bare)).toEqual(['The Publish stage uses the REGISTRY_URL variable']);
    const groovy = await grade('CICD-008', (files) => cicd008(files, env, 'echo "publishing to ${env.REGISTRY_URL}"'));
    expect(failing(groovy)).toEqual([]);
  });

  it('CICD-006: an agent declared only inside a stage is not the pipeline agent Jenkins requires', async () => {
    const pipeline = (topAgent: string, stageAgent: string) => `pipeline {
${topAgent}    stages {
        stage('Build') {
${stageAgent}            steps {
                sh 'node build.mjs'
            }
        }
    }
}
`;
    const good = await grade('CICD-006', (files) => {
      files.set('Jenkinsfile', pipeline('    agent any\n', ''));
      withBuild(files);
    });
    expect(failing(good)).toEqual([]);
    const stageOnly = await grade('CICD-006', (files) => {
      files.set('Jenkinsfile', pipeline('', '            agent any\n'));
      withBuild(files);
    });
    expect(failing(stageOnly)).toEqual(['It is a declarative pipeline with an agent and stages']);
  });

  it('CICD-009: a tag that does not identify the commit fails', async () => {
    const result = await grade('CICD-009', (files) => {
      cicd009(files, {
        image: 'docker build -t "jumptotech/statements:$IMAGE_TAG" .',
        deploy: 'sed -i "s|:REPLACE_ME|:$IMAGE_TAG|" deploy/app.yml',
      });
      files.set(WF, files.get(WF)!.replace('IMAGE_TAG: ${{ github.sha }}', 'IMAGE_TAG: latest'));
    });
    expect(failing(result)).toEqual(['The image tag comes from a workflow variable that identifies the commit']);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).not.toContain('sha');
  });
});

describe('CI/CD shortcuts found by the final hardening pass', () => {
  const WF = '.github/workflows/ci.yml';
  const BUILD = 'A step runs the build, once the code and Node.js are in place';
  const TESTS = 'A step runs the tests, after the build';

  it.each([
    ['a carriage return', '"# node build.mjs\\rtrue"', '"# node --test\\rtrue"'],
    ['U+2028', '|\n          # node build.mjs \u2028\n          true', '|\n          # node --test \u2028\n          true'],
  ])('CICD-003: a commented-out command ending in %s does not run', async (_name, build, test) => {
    const result = await grade('CICD-003', (files) => {
      cicd003('        with:\n          node-version: 20')(files);
      files.set(
        WF,
        files
          .get(WF)!
          .replace('        run: node build.mjs', `        run: ${build}`)
          .replace('        run: node --test', `        run: ${test}`),
      );
    });
    expect(failing(result)).toEqual(expect.arrayContaining([BUILD, TESTS]));
  });

  const BOUND = 'REGISTRY_PASSWORD is bound from the credential store by id';
  const PLAIN = 'No credential is written in plain text';

  it('CICD-008: a password still written in the file, with credentials() in a trailing comment, fails', async () => {
    const result = await grade('CICD-008', (files) =>
      cicd008(
        files,
        `    environment {
        REGISTRY_URL = 'registry.jumptotech.example'
        REGISTRY_PASSWORD = 'placeholder-do-not-ship-this' // credentials('statements-registry')
    }
`,
        `sh 'echo "publishing to $REGISTRY_URL"'`,
      ),
    );
    expect(failing(result)).toEqual(expect.arrayContaining([BOUND, PLAIN]));
  });

  it('CICD-008: a binding that exists only inside a block comment binds nothing', async () => {
    const result = await grade('CICD-008', (files) =>
      cicd008(
        files,
        `    environment {
        REGISTRY_URL = 'registry.jumptotech.example'
        /*
        REGISTRY_PASSWORD = credentials('statements-registry')
        */
    }
`,
        `sh 'echo "publishing to $REGISTRY_URL"'`,
      ),
    );
    expect(failing(result)).toContain(BOUND);
  });

  it('CICD-008: a password whose literal text contains credentials(…) is still a literal', async () => {
    const result = await grade('CICD-008', (files) =>
      cicd008(
        files,
        `    environment {
        REGISTRY_URL = 'registry.jumptotech.example'
        REGISTRY_PASSWORD = "hunter2 credentials('statements-registry')"
    }
`,
        `sh 'echo "publishing to $REGISTRY_URL"'`,
      ),
    );
    expect(failing(result)).toContain(BOUND);
  });

  it('CICD-008: withCredentials spelled inside a shell string binds nothing', async () => {
    const result = await grade('CICD-008', (files) =>
      cicd008(
        files,
        `    environment {
        REGISTRY_URL = 'registry.jumptotech.example'
    }
`,
        `sh "echo passwordVariable: 'REGISTRY_PASSWORD' to $REGISTRY_URL"`,
      ),
    );
    expect(failing(result)).toContain(BOUND);
  });
});

describe('CICD-009: a variable the shell never expands is not a tag', () => {
  const IMAGE = 'The image job builds the container image, tagged from IMAGE_TAG';
  const DEPLOY = 'The deploy job writes the new tag into the deployment manifest';

  it.each([
    [
      'single quotes',
      "docker build -t 'jumptotech/statements:$IMAGE_TAG' .",
      "sed -i 's|jumptotech/statements:.*|jumptotech/statements:$IMAGE_TAG|' deploy/app.yml",
    ],
    [
      'a backslash',
      'docker build -t "jumptotech/statements:\\$IMAGE_TAG" .',
      'sed -i "s|jumptotech/statements:.*|jumptotech/statements:\\$IMAGE_TAG|" deploy/app.yml',
    ],
  ])('fails $IMAGE_TAG behind %s', async (_name, image, deploy) => {
    const result = await grade('CICD-009', (files) => cicd009(files, { image, deploy }));
    expect(failing(result)).toEqual(expect.arrayContaining([IMAGE, DEPLOY]));
  });

  it.each([
    ['${IMAGE_TAG} in double quotes', 'docker build -t "jumptotech/statements:${IMAGE_TAG}" .'],
    ['a quote closed before it', "docker build -t 'jumptotech/statements':$IMAGE_TAG ."],
    ['the runner expression, in single quotes', "docker build -t 'jumptotech/statements:${{ env.IMAGE_TAG }}' ."],
  ])('passes %s', async (_name, image) => {
    const result = await grade('CICD-009', (files) =>
      cicd009(files, {
        image,
        deploy: `sed -i "s|jumptotech/statements:.*|jumptotech/statements:$IMAGE_TAG|" deploy/app.yml`,
      }),
    );
    expect(failing(result)).toEqual([]);
  });
});

// ------------------------------------ Jenkins comments (certification pass)

describe('CICD-007 — a commented line in a Jenkinsfile is not code', () => {
  const pipeline = (stages: string) => (files: Map<string, string>) => {
    files.set('Jenkinsfile', `pipeline {\n    agent any\n    stages {\n${stages}\n    }\n}\n`);
    withBuild(files);
  };
  const CHECKOUT = "        stage('Checkout') { steps { checkout scm } }";
  const BUILD = "        stage('Build') { steps { sh 'node build.mjs' } }";
  const TEST = "        stage('Test') { steps { sh 'node --test' } }";
  const PACKAGE = "        stage('Package') { steps { sh 'ls -l dist' } }";

  it('passes the four stages in order', async () => {
    expect(failing(await grade('CICD-007', pipeline([CHECKOUT, BUILD, TEST, PACKAGE].join('\n'))))).toEqual([]);
  });

  it('passes with an old stage kept in a // comment between two real ones', async () => {
    // Before: the commented header was read as a stage called Lint, took the
    // Test stage's body, and the real Test stage was reported missing.
    const lint = "        // stage('Lint') {\n        //     steps { sh 'npx eslint .' }\n        // }";
    expect(failing(await grade('CICD-007', pipeline([CHECKOUT, BUILD, lint, TEST, PACKAGE].join('\n'))))).toEqual([]);
  });

  it('passes with an old stage kept in a block comment', async () => {
    const old = "        /* kept for reference:\n        stage('Package') {\n            steps { sh 'tar czf out.tgz dist' }\n        }\n        */";
    expect(failing(await grade('CICD-007', pipeline([CHECKOUT, BUILD, old, TEST, PACKAGE].join('\n'))))).toEqual([]);
  });

  it('fails a commented-out Checkout, rather than crediting it with Build', async () => {
    const result = await grade(
      'CICD-007',
      pipeline(["        // stage('Checkout') {\n        //     steps { checkout scm }\n        // }", BUILD, TEST, PACKAGE].join('\n')),
    );
    // Before: Checkout passed with Build's body, and Build was reported missing.
    expect(failing(result)).toEqual(['A Checkout stage gets the source', 'Build runs the build command, after Checkout']);
    const build = result.checks.find((c) => c.label.startsWith('Build runs'));
    expect(build?.detail ?? '').not.toMatch(/no stage called 'Build'/);
  });

  it('fails a test command left behind a shell comment inside sh', async () => {
    // Before: `# node --test` inside the sh block counted as running the tests.
    const skipped = "        stage('Test') {\n            steps {\n                sh '''\n                    # node --test   (flaky, re-enable later)\n                    echo \"tests skipped\"\n                '''\n            }\n        }";
    const result = await grade('CICD-007', pipeline([CHECKOUT, BUILD, skipped, PACKAGE].join('\n')));
    expect(failing(result).some((label) => /test/i.test(label))).toBe(true);
  });
});

// ------------------------------- workflow scope and inert steps (certification)

describe('CICD-009 — IMAGE_TAG is workflow-level, so both jobs read it', () => {
  it('fails IMAGE_TAG declared only in the image job, which leaves deploy with an empty tag', async () => {
    const result = await grade('CICD-009', (files) => {
      cicd009(files, {
        image: 'docker build -t "jumptotech/statements:$IMAGE_TAG" .',
        deploy: `sed -i "s|jumptotech/statements:.*|jumptotech/statements:$IMAGE_TAG|" deploy/app.yml`,
      });
      const ci = files.get('.github/workflows/ci.yml')!;
      files.set(
        '.github/workflows/ci.yml',
        ci
          .replace('\nenv:\n  IMAGE_TAG: ${{ github.sha }}\n', '\n')
          .replace('  image:\n    runs-on: ubuntu-latest\n', '  image:\n    runs-on: ubuntu-latest\n    env:\n      IMAGE_TAG: ${{ github.sha }}\n'),
      );
    });
    // Before: all fourteen checks passed.
    expect(failing(result)).toEqual(['The image tag comes from a workflow variable that identifies the commit']);
  });
});

describe('CICD-002 — a step must run something to count', () => {
  const workflow = (steps: string) =>
    `name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;

  it('passes one step that runs a command', async () => {
    const result = await grade('CICD-002', (files) => files.set('.github/workflows/ci.yml', workflow('      - run: echo hello\n')));
    expect(failing(result)).toEqual([]);
  });

  it('fails a job whose only step has a name and nothing else, which GitHub rejects', async () => {
    const result = await grade('CICD-002', (files) =>
      files.set('.github/workflows/ci.yml', workflow('      - name: Say hello\n')),
    );
    expect(failing(result)).toEqual(['A build job runs on ubuntu-latest with at least one step']);
    expect(result.checks.find((c) => c.status !== 'pass')?.detail).toContain("neither 'run' nor 'uses'");
  });
});
