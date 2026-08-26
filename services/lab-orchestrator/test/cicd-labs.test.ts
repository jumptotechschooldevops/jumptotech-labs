/**
 * The CI/CD track, as the catalog sees it.
 *
 * A track is discovered from its labs alone — nothing in React, the API, the
 * orchestrator or the verifier names CICD-001 — so these tests are the check
 * that the discovery actually happened and that every lab in it is loadable,
 * ordered, and pointed at real documentation.
 */
import { describe, expect, it } from 'vitest';
import {
  LabRegistry,
  PROVIDER_REQUIREMENT_FAMILIES,
  requirementFamily,
  type LoadedLabDefinition,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';
import { scanLabsDirectory } from './catalog-shape.js';

let cached: LabRegistry | undefined;
async function realRegistry(): Promise<LabRegistry> {
  if (!cached) {
    cached = new LabRegistry(LABS_DIR);
    await cached.load();
  }
  return cached;
}

describe('the CI/CD track appears in the catalog', () => {
  it('loads with no definition errors anywhere in the catalog', async () => {
    const registry = await realRegistry();
    expect(registry.loadErrors).toEqual([]);
  });

  it('surfaces every CI/CD lab on disk and invents none', async () => {
    const registry = await realRegistry();
    const disk = await scanLabsDirectory(LABS_DIR);
    const onDisk = disk.idsForTrack('cicd');

    expect(onDisk.length).toBeGreaterThan(0);
    expect(registry.list({ track: 'cicd' }).map((lab) => lab.id).sort()).toEqual(
      [...onDisk].sort(),
    );
  });

  it('orders the track by its teaching sequence, with no two labs in one slot', async () => {
    const labs = (await realRegistry()).list({ track: 'cicd' });
    const orders = labs.map((lab) => lab.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('resolves every declared prerequisite to a lab that exists', async () => {
    const registry = await realRegistry();
    const known = new Set(registry.list({}).map((lab) => lab.id));
    for (const summary of registry.list({ track: 'cicd' })) {
      for (const prerequisite of registry.get(summary.id).prerequisites ?? []) {
        expect(known.has(prerequisite), `${summary.id} → ${prerequisite}`).toBe(true);
      }
    }
  });
});

describe('every CI/CD lab is runnable by the provider it declares', () => {
  async function cicdLabs(): Promise<LoadedLabDefinition[]> {
    const registry = await realRegistry();
    return registry.list({ track: 'cicd' }).map((summary) => registry.get(summary.id));
  }

  it('declares the CI/CD provider and a container sandbox', async () => {
    for (const lab of await cicdLabs()) {
      expect(lab.environment.provider, lab.id).toBe('cicd');
      expect(lab.environment.isolation, lab.id).toBe('container');
    }
  });

  it('asks for no network, no peer and no kernel capability', async () => {
    for (const lab of await cicdLabs()) {
      // The defaults, asserted rather than assumed: a CI/CD lab that quietly
      // acquired a segment or a capability is the regression worth catching.
      expect(lab.environment.network, lab.id).toBe('none');
      expect(lab.environment.peer, lab.id).toBe(false);
      expect(lab.environment.sandbox_capabilities, lab.id).toEqual([]);
    }
  });

  it('only uses requirement families the CI/CD provider can actually verify', async () => {
    const allowed = new Set(PROVIDER_REQUIREMENT_FAMILIES.cicd);
    for (const lab of await cicdLabs()) {
      for (const requirement of lab.requirements) {
        const family = requirementFamily(requirement.type);
        expect(allowed.has(family), `${lab.id}: ${requirement.type} → ${family}`).toBe(true);
      }
    }
  });

  it('seeds its project from the lab directory, never from an absolute path', async () => {
    for (const lab of await cicdLabs()) {
      // `workspace_dir` is a single directory name inside the lab's own folder.
      // A lab cannot name a path on the host, which is what keeps a student's
      // project derived from their session rather than from lab content.
      expect(lab.setup.workspace_dir, lab.id).toBe('workspace');
      expect(lab.setup.workspace_dir, lab.id).not.toContain('/');
    }
  });
});
