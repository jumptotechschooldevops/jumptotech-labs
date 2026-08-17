/**
 * PLATFORM-CICD-001 — every shipped CI/CD lab, end to end.
 *
 * For each of CICD-001 … CICD-010 this suite:
 *
 *   1. seeds a real temporary workspace from the lab's own `setup.workspace`;
 *   2. asserts the lab's `setup.verify` passes — the starting condition the
 *      student is handed is the one the author declared;
 *   3. asserts the *unsolved* workspace reports LAB NOT COMPLETE, so no lab
 *      can be passed by doing nothing;
 *   4. applies a reference solution and asserts LAB PASSED.
 *
 * Step 4 is what makes these labs honest. A lab whose requirements cannot all
 * be satisfied is unsolvable and would waste a student's evening; the only way
 * to know is to solve it, and the only way to keep knowing is to solve it on
 * every run. The reference solutions live here rather than under `labs/`
 * precisely so they are test fixtures and never shipped content.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FsWorkspace,
  LabRegistry,
  loadWorkspaceSeed,
  type LoadedLabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { verifyLab, waitForRequirements } from '../src/index.js';

/*
 * These tests deliberately spawn real processes — a workspace build, a real
 * test run — so the 5s default meant for pure unit tests does not apply. The
 * budget below is generous on purpose: a timeout here should mean something is
 * genuinely wrong, not that the machine was busy running the rest of the suite.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let registry: LabRegistry;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

/** Seed a lab's baseline into a fresh temporary workspace. */
async function seedWorkspace(lab: LoadedLabDefinition): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `jtt-${lab.id.toLowerCase()}-`));
  for (const file of await loadWorkspaceSeed(lab)) {
    const absolute = path.join(root, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.contents);
  }
  return root;
}

/** Apply a solution's files, and remove anything it maps to `null`. */
async function apply(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    if (contents === null) {
      await rm(absolute, { recursive: true, force: true });
      continue;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

function check(lab: LoadedLabDefinition, root: string) {
  return verifyLab({
    lab,
    workspace: new FsWorkspace({ root }),
    namespace: 'lab-0000000000aa',
  });
}

/** Names of the checks that did not pass, for a readable failure message. */
function failures(result: Awaited<ReturnType<typeof check>>): string[] {
  return result.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label} — ${c.detail ?? ''}`);
}

// ---------------------------------------------------------------- solutions

/**
 * A correct answer for each lab.
 *
 * Written the way a student would write it, not generated from the
 * requirements — a solution derived from the checks would prove only that the
 * checks agree with themselves.
 */
const PIPELINE_SH = `#!/bin/sh
# The delivery pipeline, by hand. Every stage stops the run if it fails.
set -e

echo "--- build ---"
node build.mjs

echo "--- test ---"
node --test

echo "--- smoke ---"
node src/cli.mjs --selftest
`;

const CI_BUILD_AND_TEST = `name: CI

on:
  push:
  pull_request:

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
`;

const CI_WITH_ARTIFACT = `${CI_BUILD_AND_TEST}
      - name: Upload build output
        uses: actions/upload-artifact@v4
        with:
          name: statements-dist
          path: dist/
`;

const DOCKERFILE = `FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY build.mjs ./
COPY src ./src

USER node

CMD ["node", "src/cli.mjs"]
`;

const CI_WITH_IMAGE = `name: CI

on:
  push:
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
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Build the image
        run: docker build -t "$IMAGE_NAME:$GITHUB_SHA" .
`;

const CI_FULL_DELIVERY = `name: Deliver

on:
  push:
    branches:
      - main

env:
  IMAGE_NAME: jumptotech/statements
  IMAGE_TAG: \${{ github.sha }}

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
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Build the image
        run: docker build -t "$IMAGE_NAME:$IMAGE_TAG" .

  deploy:
    needs: image
    runs-on: ubuntu-latest
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      # A block scalar, because the command contains ': ' and a bare YAML
      # scalar cannot. This is the mistake the lab's level-3 hint warns about.
      - name: Point staging at the new image
        run: |
          sed -i "s|image: .*|image: $IMAGE_NAME:$IMAGE_TAG|" deploy/app.yml
`;

const JENKINSFILE_BUILD_ONLY = `pipeline {
    agent any

    stages {
        stage('Build') {
            steps {
                sh 'node build.mjs'
            }
        }
    }
}
`;

const JENKINSFILE_FOUR_STAGES = `pipeline {
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

const JENKINSFILE_CREDENTIALS = `pipeline {
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

        stage('Publish') {
            steps {
                sh 'echo "publishing to $REGISTRY_URL"'
            }
        }
    }
}
`;

/** The workflow a student ends up with after repairing CICD-010. */
const CI_REPAIRED = `name: CI

on:
  push:

env:
  APP_VERSION: '1.4.1'

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
          name: statements-\${{ env.APP_VERSION }}
          path: dist/
`;

/** The test whose expectation, not whose subject, was wrong. */
const REPAIRED_TEST_LINE = "  assert.equal(formatAmount(500_00), '$500.00');";

const SOLUTIONS: Record<string, Record<string, string | null>> = {
  'CICD-001': { 'ci/pipeline.sh': PIPELINE_SH },
  'CICD-002': { '.github/workflows/ci.yml': CI_BUILD_AND_TEST },
  'CICD-003': { '.github/workflows/ci.yml': CI_BUILD_AND_TEST },
  'CICD-004': { '.github/workflows/ci.yml': CI_WITH_ARTIFACT },
  'CICD-005': { '.github/workflows/ci.yml': CI_WITH_IMAGE, Dockerfile: DOCKERFILE },
  'CICD-006': { Jenkinsfile: JENKINSFILE_BUILD_ONLY },
  'CICD-007': { Jenkinsfile: JENKINSFILE_FOUR_STAGES },
  'CICD-008': { Jenkinsfile: JENKINSFILE_CREDENTIALS },
  'CICD-009': { '.github/workflows/ci.yml': CI_FULL_DELIVERY },
  'CICD-010': {
    // The workflow moves to where GitHub reads workflows from, and is repaired.
    '.github/workflow/ci.yml': null,
    '.github/workflows/ci.yml': CI_REPAIRED,
    Jenkinsfile: JENKINSFILE_FOUR_STAGES,
  },
};

const LAB_IDS = Object.keys(SOLUTIONS);

// -------------------------------------------------------------------- tests

describe('the CI/CD track (story tests 1, 2)', () => {
  it('loads as a track with all ten labs, in order', () => {
    const track = registry.track('cicd');
    expect(track).not.toBeNull();
    expect(track?.title).toBe('CI/CD');
    expect(track?.labCount).toBe(10);
    expect(registry.labsForTrack('cicd').map((l) => l.id)).toEqual(LAB_IDS);
  });

  it('every lab declares the file-backed sandbox and ships a seed', () => {
    for (const id of LAB_IDS) {
      const lab = registry.get(id);
      expect(lab.environment.provider, id).toBe('workspace');
      expect(lab.environment.isolation, id).toBe('workspace');
      expect(lab.setup.workspace, id).toBe('workspace');
      expect(lab.setup.manifests, id).toEqual([]);
      expect(lab.setup.verify.length, id).toBeGreaterThan(0);
    }
  });
});

describe.each(LAB_IDS)('%s', (labId) => {
  let lab: LoadedLabDefinition;
  let root: string;

  beforeAll(async () => {
    lab = registry.get(labId);
    root = await seedWorkspace(lab);
  });

  it('hands the student the starting condition its author declared', async () => {
    const result = await waitForRequirements({
      workspace: new FsWorkspace({ root }),
      namespace: 'lab-0000000000aa',
      requirements: lab.setup.verify as readonly Requirement[],
      timeoutMs: 0,
    });
    expect(result.ok, JSON.stringify(result.checks, null, 2)).toBe(true);
  });

  it('reports LAB NOT COMPLETE before the student does anything', async () => {
    const result = await check(lab, root);
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    // ...and it fails for a reason, not because verification broke.
    expect(result.error).toBeUndefined();
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });

  it('reports LAB PASSED for a correct solution', async () => {
    const solution = SOLUTIONS[labId];
    if (!solution) throw new Error(`no reference solution for ${labId}`);
    await apply(root, solution);

    // CICD-010 also asks the student to decide which side of a failing test is
    // wrong. The expectation contradicts the documented format, so it is the
    // expectation that changes.
    if (labId === 'CICD-010') {
      const testPath = path.join(root, 'test/statements.test.mjs');
      const original = await (await import('node:fs/promises')).readFile(testPath, 'utf8');
      await writeFile(
        testPath,
        original.replace("  assert.equal(formatAmount(500_00), '$500');", REPAIRED_TEST_LINE),
      );
    }

    const result = await check(lab, root);
    expect(failures(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });
});
