/**
 * SEC-LAB-1: a lab asset cannot read outside its lab directory through a symlink.
 *
 * `setup.files`, `setup.seed_scripts`, `setup.manifests` and `setup.workspace_dir`
 * were confined lexically (`path.resolve` + `startsWith`), but `readFile`
 * follows symlinks, so `setup/x -> /outside/secret` passed the check and the
 * api process's copy of that file was seeded into a student's sandbox.
 * `validate:labs` refuses symlinks in CI; these tests prove the loaders refuse
 * them at the point of use too.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LabDefinitionError,
  loadLabDefinition,
  loadSeedScripts,
  loadSetupFiles,
  loadSetupManifests,
  type LoadedLabDefinition,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SECRET = 'outside-the-lab-directory';

const LAB_YAML = `id: K8S-902
slug: k8s-902-demo
title: Symlink Fixture
track: kubernetes
topic: pods
difficulty: beginner
duration_minutes: 15
environment:
  provider: kubernetes
task:
  summary: Fixture.
  description: Fixture lab used by the lab-asset symlink tests.
requirements:
  - type: deployment_exists
    name: app
    label: Deployment app exists
references:
  - title: Kubernetes Pods
    url: https://kubernetes.io/docs/concepts/workloads/pods/
skills:
  - kubernetes.pods.create
`;

const CONFIGMAP = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\ndata:\n  key: value\n';

/** A real loaded lab, plus a sibling directory outside it holding a "secret". */
async function fixture(): Promise<{ lab: LoadedLabDefinition; root: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'jtt-lab-symlink-'));
  tempDirs.push(base);
  const root = path.join(base, 'lab');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'setup'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), SECRET, 'utf8');
  await writeFile(path.join(outside, 'seed.sh'), `#!/bin/sh\necho ${SECRET}\n`, 'utf8');
  await writeFile(path.join(outside, 'app.yaml'), CONFIGMAP, 'utf8');
  await writeFile(path.join(root, 'lab.yaml'), LAB_YAML, 'utf8');
  return { lab: await loadLabDefinition(path.join(root, 'lab.yaml')), root, outside };
}

function withSetup(lab: LoadedLabDefinition, setup: Partial<LoadedLabDefinition['setup']>): LoadedLabDefinition {
  return { ...lab, setup: { ...lab.setup, ...setup } };
}

async function refusal(promise: Promise<unknown>): Promise<LabDefinitionError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(LabDefinitionError);
  expect(String((error as Error).message)).not.toContain(SECRET);
  return error as LabDefinitionError;
}

describe('lab assets cannot escape the lab directory through a symlink', () => {
  it('refuses a setup file that is a symlink to a file outside the lab', async () => {
    const { lab, root, outside } = await fixture();
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'setup', 'notes.txt'));
    const error = await refusal(
      loadSetupFiles(withSetup(lab, { files: [{ source: 'setup/notes.txt', path: 'notes.txt', mode: '644' }] })),
    );
    expect(error.message).toMatch(/resolves outside the lab directory/);
  });

  it('refuses a setup file reached through a symlinked parent directory', async () => {
    const { lab, root, outside } = await fixture();
    await symlink(outside, path.join(root, 'starter'));
    const error = await refusal(
      loadSetupFiles(withSetup(lab, { files: [{ source: 'starter/secret.txt', path: 'notes.txt', mode: '644' }] })),
    );
    expect(error.message).toMatch(/resolves outside the lab directory/);
  });

  it('refuses a workspace_dir that is itself a symlink out of the lab', async () => {
    const { lab, root, outside } = await fixture();
    await symlink(outside, path.join(root, 'workspace'));
    const error = await refusal(loadSetupFiles(withSetup(lab, { workspace_dir: 'workspace' })));
    expect(error.message).toMatch(/resolves outside the lab directory/);
  });

  it('refuses a seed script that is a symlink to a script outside the lab', async () => {
    const { lab, root, outside } = await fixture();
    await symlink(path.join(outside, 'seed.sh'), path.join(root, 'setup', 'seed.sh'));
    const error = await refusal(loadSeedScripts(withSetup(lab, { seed_scripts: ['setup/seed.sh'] })));
    expect(error.message).toMatch(/resolves outside the lab directory/);
  });

  it('refuses a setup manifest that is a symlink to a manifest outside the lab', async () => {
    const { lab, root, outside } = await fixture();
    await symlink(path.join(outside, 'app.yaml'), path.join(root, 'setup', 'app.yaml'));
    const error = await refusal(loadSetupManifests(withSetup(lab, { manifests: ['setup/app.yaml'] })));
    expect(error.message).toMatch(/resolves outside the lab directory/);
  });

  it('still loads regular files inside the lab, and reports a missing one as unreadable', async () => {
    const { lab, root } = await fixture();
    await writeFile(path.join(root, 'setup', 'notes.txt'), 'hello', 'utf8');
    await writeFile(path.join(root, 'setup', 'app.yaml'), CONFIGMAP, 'utf8');

    const files = await loadSetupFiles(
      withSetup(lab, { files: [{ source: 'setup/notes.txt', path: 'notes.txt', mode: '644' }] }),
    );
    expect(files.map((f) => f.content)).toEqual(['hello']);
    expect(await loadSetupManifests(withSetup(lab, { manifests: ['setup/app.yaml'] }))).toHaveLength(1);

    const missing = await refusal(
      loadSetupFiles(withSetup(lab, { files: [{ source: 'setup/absent.txt', path: 'absent.txt', mode: '644' }] })),
    );
    expect(missing.message).toMatch(/^Cannot read setup file 'setup\/absent\.txt'/);
  });
});
