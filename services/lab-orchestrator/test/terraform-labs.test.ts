/**
 * The Terraform lab catalog.
 *
 * Two jobs, both of which are about keeping the track honest rather than about
 * any one lab's content:
 *
 *   1. Every Terraform lab loads, and asks only for checks the Terraform
 *      provider can actually answer. A lab that names a `linux` or `docker`
 *      check would load happily and then fail a correct student at check time,
 *      so it is caught here instead.
 *
 *   2. Every Terraform lab is grounded in official documentation. The
 *      curriculum policy is that HashiCorp's own docs are the source of truth;
 *      a lab with no official reference is a lab nobody can audit, so the
 *      absence of one is a test failure, not a style note.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  LabRegistry,
  PROVIDER_REQUIREMENT_FAMILIES,
  loadLabDefinition,
  loadSetupFiles,
  requirementFamily,
  type LoadedLabDefinition,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

const TERRAFORM_IDS = ['TF-001', 'TF-004', 'TF-011', 'TF-012'];

let cached: LabRegistry | undefined;
async function realRegistry(): Promise<LabRegistry> {
  if (!cached) {
    cached = new LabRegistry(LABS_DIR);
    await cached.load();
  }
  return cached;
}

function tf011Path(): string {
  return path.join(LABS_DIR, 'terraform', 'tf-011-execution-plan', 'lab.yaml');
}

// --------------------------------------------------------- definitions load

describe('the Terraform lab catalog', () => {
  it('loads every Terraform lab with no definition errors', async () => {
    const registry = await realRegistry();
    expect(registry.loadErrors).toEqual([]);
    // Compared as a set: the catalog orders by each lab's `order`, and the
    // teaching sequence is asserted separately below. TF-004 sits at order 9
    // because the approved curriculum puts it there, even though it shipped
    // after TF-011 and TF-012.
    expect(registry.list({ track: 'terraform' }).map((lab) => lab.id).sort()).toEqual(
      [...TERRAFORM_IDS].sort(),
    );
  });

  it('orders the track by its teaching sequence, with no two labs claiming one slot', async () => {
    const labs = (await realRegistry()).list({ track: 'terraform' });
    const orders = labs.map((lab) => lab.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('resolves every declared prerequisite to a lab that exists', async () => {
    for (const lab of (await realRegistry()).list({ track: 'terraform' })) {
      for (const prerequisite of lab.prerequisites) {
        expect(prerequisite.available, `${lab.id} requires ${prerequisite.id}`).toBe(true);
      }
    }
  });

  it('cites official HashiCorp documentation in every lab', async () => {
    const registry = await realRegistry();
    for (const summary of registry.list({ track: 'terraform' })) {
      const lab = registry.get(summary.id);
      const official = lab.references.filter((reference) =>
        reference.url.startsWith('https://developer.hashicorp.com/'),
      );
      expect(official.length, `${summary.id} cites no official documentation`).toBeGreaterThan(0);
    }
  });
});

// ------------------------------------------- the provider can verify the lab

describe('Terraform labs stay inside what their provider can verify', () => {
  it('asks only for filesystem and terraform checks', async () => {
    const registry = await realRegistry();
    const allowed = PROVIDER_REQUIREMENT_FAMILIES.terraform;

    for (const summary of registry.list({ track: 'terraform' })) {
      const lab = registry.get(summary.id);
      expect(lab.environment.provider).toBe('terraform');
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
        expect(
          allowed,
          `${summary.id} asks for '${requirement.type}', which the terraform provider cannot verify`,
        ).toContain(requirementFamily(requirement.type));
      }
    }
  });

  it('runs in an isolated container with no Kubernetes setup', async () => {
    const registry = await realRegistry();
    for (const summary of registry.list({ track: 'terraform' })) {
      const lab = registry.get(summary.id);
      expect(lab.environment.isolation).toBe('container');
      expect(lab.setup.manifests).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------- TF-011

describe('TF-011 — Reading and Saving an Execution Plan', () => {
  let lab: LoadedLabDefinition;

  async function tf011(): Promise<LoadedLabDefinition> {
    lab ??= await loadLabDefinition(tf011Path());
    return lab;
  }

  it('follows TF-001 and covers the plan step of the core workflow', async () => {
    const definition = await tf011();
    expect(definition.id).toBe('TF-011');
    expect(definition.track).toBe('terraform');
    expect(definition.topic).toBe('workflow');
    expect(definition.difficulty).toBe('beginner');
    expect(definition.prerequisites).toEqual(['TF-001']);
  });

  it('maps to the current Terraform Associate exam version, not an older one', async () => {
    const definition = await tf011();
    const entry = definition.certification.find((c) => c.relevant);
    expect(entry?.certification).toBe('TERRAFORM-ASSOCIATE-004');
    // Domain 3 is "Core Terraform workflow" in the 004 content list. The ids
    // are HashiCorp's; nothing here invents an objective.
    expect(entry?.domains).toEqual(['3']);
  });

  it('seeds a starting configuration the student did not have to write', async () => {
    const definition = await tf011();
    expect(definition.setup.files.map((file) => file.path)).toEqual([
      'terraform/versions.tf',
      'terraform/main.tf',
    ]);

    // Loading proves the sources resolve inside the lab directory and are
    // readable — a lab whose setup cannot be staged is a lab that cannot start,
    // and Reset Lab re-stages exactly these.
    const files = await loadSetupFiles(definition);
    expect(files.map((file) => file.path)).toEqual([
      'terraform/versions.tf',
      'terraform/main.tf',
    ]);
    for (const file of files) expect(file.content.length).toBeGreaterThan(0);

    // The seeded configuration must declare the resource the lab plans, and
    // must not already declare the one the student is asked to add.
    const main = files.find((file) => file.path.endsWith('main.tf'))!;
    expect(main.content).toContain('"local_file" "release_manifest"');
    expect(main.content).not.toContain('rollback_plan');
  });

  it('grades the artifacts of two plan rounds, not the commands typed', async () => {
    const types = (await tf011()).requirements.map((requirement) => requirement.type);

    // State is the anchor: both resources must genuinely be in it.
    expect(types.filter((type) => type === 'terraform_resource_exists')).toHaveLength(2);
    expect(types).toContain('terraform_initialized');
    expect(types).toContain('terraform_output_equals');

    // Both rounds leave a saved plan and an exported JSON behind.
    const paths = (await tf011()).requirements
      .map((requirement) => ('path' in requirement ? requirement.path : ''))
      .filter(Boolean);
    for (const expected of ['terraform/tfplan', 'terraform/plan.json', 'terraform/tfplan2', 'terraform/plan2.json']) {
      expect(paths, `TF-011 does not check ${expected}`).toContain(expected);
    }
  });

  it('cannot be passed by planning twice without applying in between', async () => {
    // The discriminating check. A student who never applies the first plan
    // produces a second plan in which *both* resources are creates and nothing
    // is a no-op, even though the final state and artifacts look identical.
    // Removing this check would make the two-round workflow unenforceable.
    const noOp = (await tf011()).requirements.find(
      (requirement) =>
        requirement.type === 'file_content' &&
        'path' in requirement &&
        requirement.path === 'terraform/plan2.json' &&
        'contains' in requirement &&
        requirement.contains === '"no-op"',
    );
    expect(noOp).toBeDefined();
  });

  it('offers three progressive hints and never puts the answer in the first', async () => {
    const definition = await tf011();
    expect(definition.hints.map((hint) => hint.level)).toEqual([1, 2, 3]);
    expect(definition.hints[0]!.text).not.toContain('-out=tfplan');
    expect(definition.hints[2]!.text).toContain('-out=tfplan');
  });
});

// ------------------------------------------------------------------- TF-012

describe('TF-012 — Destroying Infrastructure Safely', () => {
  let lab: LoadedLabDefinition;

  async function tf012(): Promise<LoadedLabDefinition> {
    lab ??= await loadLabDefinition(
      path.join(LABS_DIR, 'terraform', 'tf-012-destroy', 'lab.yaml'),
    );
    return lab;
  }

  it('follows TF-011 and covers the destroy step of the core workflow', async () => {
    const definition = await tf012();
    expect(definition.id).toBe('TF-012');
    expect(definition.topic).toBe('workflow');
    expect(definition.prerequisites).toEqual(['TF-011']);
    const entry = definition.certification.find((c) => c.relevant);
    expect(entry?.certification).toBe('TERRAFORM-ASSOCIATE-004');
    expect(entry?.domains).toEqual(['3']);
  });

  it('seeds a three-resource stack the student has to create before destroying', async () => {
    const definition = await tf012();
    const files = await loadSetupFiles(definition);
    expect(files.map((f) => f.path)).toEqual(['terraform/versions.tf', 'terraform/main.tf']);
    const main = files.find((f) => f.path.endsWith('main.tf'))!;
    for (const name of ['draft_report', 'summary_report', 'audit_log']) {
      expect(main.content).toContain(`"local_file" "${name}"`);
    }
  });

  it('grades the destroy from state, not from the absence of a state file', async () => {
    const requirements = (await tf012()).requirements;
    // The full-destroy assertion: no address, so it means "nothing managed".
    const whole = requirements.find(
      (r) => r.type === 'terraform_state_absent' && !('address' in r && r.address),
    );
    expect(whole).toBeDefined();

    // A file check for the state file's *absence* would be the wrong shape
    // entirely — a completed destroy leaves one behind.
    const forbids = requirements.some(
      (r) => r.type === 'path_absent' && 'path' in r && String(r.path).endsWith('terraform.tfstate'),
    );
    expect(forbids).toBe(false);
  });

  it('proves the targeted destroy happened first, from the state the last destroy replaced', async () => {
    const requirements = (await tf012()).requirements;
    const sequencing = requirements.find(
      (r) =>
        r.type === 'terraform_state_absent' &&
        'state_file' in r &&
        r.state_file === 'terraform.tfstate.backup' &&
        'address' in r &&
        r.address === 'local_file.draft_report',
    );
    expect(sequencing).toBeDefined();

    // ...and that the two survivors were still managed at that point, so a
    // hand-written empty backup cannot stand in for the real one.
    const survivors = requirements.filter(
      (r) =>
        r.type === 'terraform_resource_exists' &&
        'state_file' in r &&
        r.state_file === 'terraform.tfstate.backup',
    );
    expect(survivors).toHaveLength(2);
  });

  it('requires the artifacts to be gone from disk, and the directory to remain as evidence', async () => {
    const requirements = (await tf012()).requirements;
    const absent = requirements
      .filter((r) => r.type === 'path_absent')
      .map((r) => ('path' in r ? r.path : ''));
    expect(absent).toEqual([
      'terraform/out/draft-report.txt',
      'terraform/out/summary-report.txt',
      'terraform/out/audit-log.txt',
    ]);
    expect(
      requirements.some((r) => r.type === 'directory_exists' && 'path' in r && r.path === 'terraform/out'),
    ).toBe(true);
  });
});

// ------------------------------------------------------------------- TF-004

describe('TF-004 — Terraform State', () => {
  let lab: LoadedLabDefinition;

  async function tf004(): Promise<LoadedLabDefinition> {
    lab ??= await loadLabDefinition(path.join(LABS_DIR, 'terraform', 'tf-004-state', 'lab.yaml'));
    return lab;
  }

  it('keeps the curriculum sequence: state topic, intermediate, order 9', async () => {
    const definition = await tf004();
    expect(definition.id).toBe('TF-004');
    expect(definition.topic).toBe('state');
    expect(definition.difficulty).toBe('intermediate');
    // The approved plan places TF-004 at order 9, after the labs that fill
    // orders 4–8. Implementing it early must not move it in the catalog.
    expect(definition.order).toBe(9);
    const entry = definition.certification.find((c) => c.relevant);
    expect(entry?.certification).toBe('TERRAFORM-ASSOCIATE-004');
    expect(entry?.domains).toEqual(['2', '7']);
  });

  it('seeds the three resources the refactor operates on', async () => {
    const files = await loadSetupFiles(await tf004());
    const main = files.find((f) => f.path.endsWith('main.tf'))!;
    for (const name of ['legacy_report', 'metrics', 'scratch_notes']) {
      expect(main.content).toContain(`"local_file" "${name}"`);
    }
    // The target name must not be pre-written for them.
    expect(main.content).not.toContain('quarterly_report');
  });

  it('grades the rename from state, both the new address and the old one', async () => {
    const requirements = (await tf004()).requirements;
    expect(
      requirements.some(
        (r) => r.type === 'terraform_resource_exists' && 'name' in r && r.name === 'quarterly_report',
      ),
    ).toBe(true);
    expect(
      requirements.some(
        (r) =>
          r.type === 'terraform_state_absent' &&
          'address' in r &&
          r.address === 'local_file.legacy_report',
      ),
    ).toBe(true);
  });

  it('distinguishes `state rm` from a destroy by requiring the file to survive', async () => {
    const requirements = (await tf004()).requirements;
    // Unmanaged...
    expect(
      requirements.some(
        (r) =>
          r.type === 'terraform_state_absent' &&
          'address' in r &&
          r.address === 'local_file.scratch_notes',
      ),
    ).toBe(true);
    // ...but still on disk. Without this pair, `terraform destroy -target`
    // would satisfy the lab, and it teaches the opposite lesson.
    expect(
      requirements.some(
        (r) => r.type === 'file_exists' && 'path' in r && r.path === 'terraform/out/scratch-notes.txt',
      ),
    ).toBe(true);
  });

  it('binds the exported plan to the refactor, so a stale or faked plan cannot pass', async () => {
    const planChecks = (await tf004()).requirements.filter(
      (r) => 'path' in r && r.path === 'terraform/plan.json',
    );
    const has = (type: string, text: string) =>
      planChecks.some((r) => r.type === type && 'contains' in r && r.contains === text);

    // It must be a plan, not a `terraform show -json` dump of state.
    expect(has('file_content', '"resource_changes"')).toBe(true);
    // Of the renamed configuration...
    expect(has('file_content', 'local_file.quarterly_report')).toBe(true);
    // ...and not of the configuration as it stood before the work.
    expect(has('file_content_absent', 'local_file.legacy_report')).toBe(true);
    expect(has('file_content_absent', 'local_file.scratch_notes')).toBe(true);
    // A clean refactor plans nothing at all.
    expect(has('file_content_absent', '"create"')).toBe(true);
    expect(has('file_content_absent', '"delete"')).toBe(true);
  });

  it('reads no student-authored configuration file, only state and artifacts', async () => {
    // `main.tf` is the student's own writing; grading it would be grading what
    // was typed. Every check reads state, a plan Terraform produced, or a file
    // a provider wrote.
    const paths = (await tf004()).requirements
      .filter((r) => 'path' in r)
      .map((r) => ('path' in r ? String(r.path) : ''));
    expect(paths.some((p) => p.endsWith('.tf'))).toBe(false);
  });
});
