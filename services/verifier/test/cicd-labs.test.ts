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
    expect(failing(result)).toEqual(['A step uploads a named artifact from the build output']);
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
    expect(failing(result)).toEqual(['The job uploads the build output, named with APP_VERSION']);
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
    expect(failing(result)).toEqual(['The job uploads the build output, named with APP_VERSION']);
  });
});
