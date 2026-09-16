/**
 * No lab passes on the state it hands the student.
 *
 * A starter file is written by the platform before the terminal opens. If one
 * of them already *is* the finished configuration — a completed `main.tf`, an
 * already-correct report — Verify passes a student who has typed nothing. The
 * per-lab suites prove that for the labs they cover; this proves it for every
 * lab it can, so a lab added tomorrow is held to it without anyone writing a
 * new test.
 *
 * What "can" means, precisely:
 *
 *   - the lab's whole starting state is its declared starter files — no seed
 *     script, because a seed script's effect on a container cannot be derived
 *     without running it;
 *   - every requirement is answered by *reading* the sandbox (the filesystem,
 *     Terraform, IAM and CloudFormation families), so the in-memory sandbox is a
 *     faithful model of what Verify would see. Checks that run an inspection
 *     command or a script are left to the per-lab suites.
 *
 * Starter files are placed exactly where the provider writes them (under the
 * sandbox home) and under the home-relative name a lab may also use.
 */
import { describe, expect, it } from 'vitest';
import {
  loadSetupFiles,
  requirementFamily,
  type LoadedLabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const HOME = '/home/student';
const READ_ONLY_FAMILIES = new Set(['filesystem', 'terraform', 'iam', 'cloudformation']);

function isStaticallyModelled(lab: LoadedLabDefinition): boolean {
  return (
    lab.setup.seed_scripts.length === 0 &&
    lab.setup.manifests.length === 0 &&
    (lab.requirements as readonly Requirement[]).every((r) => READ_ONLY_FAMILIES.has(requirementFamily(r.type)))
  );
}

async function starterWorld(lab: LoadedLabDefinition): Promise<FakeWorld> {
  const files: NonNullable<FakeWorld['files']> = {};
  const directory = (name: string) => {
    files[name] ??= { type: 'directory', mode: '755' };
  };
  for (const file of await loadSetupFiles(lab)) {
    for (const name of [`${HOME}/${file.path}`, file.path]) {
      files[name] = { type: 'file', content: file.content, mode: file.mode };
      const segments = name.split('/');
      for (let i = 1; i < segments.length; i += 1) {
        const parent = segments.slice(0, i).join('/');
        if (parent !== '' && parent !== '/home') directory(parent);
      }
    }
  }
  directory(HOME);
  return { files };
}

describe('the starting state of every statically modelled lab', () => {
  it('covers the labs it claims to, so the guard cannot quietly shrink to nothing', async () => {
    const registry = await realCatalog();
    const modelled = registry.all().filter(isStaticallyModelled);

    // Every Terraform lab is graded by reading, and seeds with starter files only.
    const terraform = registry.labsForTrack('terraform').map((lab) => lab.id);
    expect(terraform.length).toBeGreaterThan(0);
    expect(modelled.map((lab) => lab.id)).toEqual(expect.arrayContaining(terraform));
  });

  it('fails Verify before the student has done anything', async () => {
    const registry = await realCatalog();
    const passedAtStart: string[] = [];

    for (const lab of registry.all().filter(isStaticallyModelled)) {
      const result = await verifyLab({
        lab,
        namespace: 'jtt-lab-000000000001',
        sandbox: new FakeSandbox(await starterWorld(lab)),
      });
      expect(result.error, `${lab.id} could not be verified`).toBeUndefined();
      if (result.passed) passedAtStart.push(lab.id);
    }

    expect(passedAtStart, 'these labs pass on their untouched starter files').toEqual([]);
  });
});
