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
