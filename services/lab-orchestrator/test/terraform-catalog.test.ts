/**
 * The Terraform catalog.
 *
 * The shipped Terraform track — TF-001 through TF-010 — asserted against the
 * rules the platform sets for lab content: original tasks on the JumpToTech
 * banking scenario, official HashiCorp documentation, a progressive hint
 * ladder, and no lab that could reach a cloud account.
 *
 * These assertions run against the *shipped* labs, not fixtures. A lab that
 * would fail a student at Check Solution — because its checks disagree with its
 * declared environment, or its hints hand over the answer — fails here first.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  DISALLOWED_DOC_HOSTS,
  LabRegistry,
  loadSetupFiles,
  parseLabDefinition,
  requirementFamily,
  type LoadedLabDefinition,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

const EXPECTED_IDS = [
  'TF-001',
  'TF-002',
  'TF-003',
  'TF-004',
  'TF-005',
  'TF-006',
  'TF-007',
  'TF-008',
  'TF-009',
  'TF-010',
] as const;

/** Every Terraform lab works in this directory of the sandbox home. */
const WORK_DIR = 'terraform';

let cached: LabRegistry | null = null;
async function registry(): Promise<LabRegistry> {
  if (!cached) {
    cached = new LabRegistry(LABS_DIR);
    await cached.load();
  }
  return cached;
}

async function terraformLabs(): Promise<LoadedLabDefinition[]> {
  const reg = await registry();
  return reg.all().filter((lab) => lab.track === 'terraform');
}

// ------------------------------------------------------------ the catalog

describe('terraform catalog — it loads', () => {
  it('loads with no definition errors at all', async () => {
    expect((await registry()).loadErrors).toEqual([]);
  });

  it('registers TF-001 through TF-010 in order', async () => {
    const reg = await registry();
    expect(reg.labsForTrack('terraform').map((l) => l.id)).toEqual([...EXPECTED_IDS]);
  });

  it('presents Terraform as a track alongside Kubernetes and Linux', async () => {
    const track = (await registry()).track('terraform');

    expect(track).toMatchObject({ track: 'terraform', title: 'Terraform', labCount: 10 });
    expect(track!.difficulties).toEqual(['beginner', 'intermediate', 'advanced']);
    expect(track!.topics.map((t) => t.topic)).toEqual([
      'workflow',
      'variables',
      'outputs',
      'state',
      'dependencies',
      'expressions',
      'modules',
      'lifecycle',
      'troubleshooting',
    ]);
    expect(track!.providers).toEqual(['terraform']);
  });

  it('gives every lab the metadata a catalog card needs', async () => {
    for (const lab of await terraformLabs()) {
      expect(lab.title.length, `${lab.id} title`).toBeGreaterThan(5);
      expect(lab.task.summary.length, `${lab.id} summary`).toBeGreaterThan(20);
      expect(lab.task.description.length, `${lab.id} description`).toBeGreaterThan(200);
      expect(lab.objectives.length, `${lab.id} objectives`).toBeGreaterThanOrEqual(3);
      expect(lab.skills.length, `${lab.id} skills`).toBeGreaterThanOrEqual(2);
      expect(lab.duration_minutes, `${lab.id} duration`).toBeGreaterThanOrEqual(15);
      expect(lab.story, `${lab.id} must set a scenario`).toBeDefined();
    }
  });

  it('builds a prerequisite chain that starts at TF-001', async () => {
    const labs = await terraformLabs();
    const byId = new Map(labs.map((l) => [l.id, l]));

    expect(byId.get('TF-001')!.prerequisites).toEqual([]);
    for (const lab of labs.filter((l) => l.id !== 'TF-001')) {
      expect(lab.prerequisites.length, `${lab.id} should build on something`).toBeGreaterThan(0);
      for (const prerequisite of lab.prerequisites) {
        expect(byId.has(prerequisite), `${lab.id} → ${prerequisite}`).toBe(true);
        // A prerequisite must come earlier in the track, or the path is a loop
        // in spirit even when the registry's cycle check passes.
        expect(prerequisite < lab.id, `${lab.id} must not depend on a later lab`).toBe(true);
      }
    }
  });
});

// ------------------------------------------------------------- environment

describe('terraform catalog — every lab declares a Terraform sandbox', () => {
  it('runs on the terraform provider in a container', async () => {
    for (const lab of await terraformLabs()) {
      expect(lab.environment, lab.id).toEqual({ provider: 'terraform', isolation: 'container' });
    }
  });

  it('uses only checks a Terraform sandbox can answer', async () => {
    for (const lab of await terraformLabs()) {
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
        expect(
          ['terraform', 'filesystem'],
          `${lab.id}: ${requirement.type}`,
        ).toContain(requirementFamily(requirement.type));
      }
    }
  });

  it('grades one working directory, the one it seeds into', async () => {
    for (const lab of await terraformLabs()) {
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
        if ('dir' in requirement) {
          expect(requirement.dir, `${lab.id}: ${requirement.type}`).toBe(WORK_DIR);
        }
        if ('path' in requirement) {
          expect(requirement.path, `${lab.id}: ${requirement.type}`).toMatch(/^terraform\//);
        }
      }
      for (const file of lab.setup.files) {
        expect(file.path, `${lab.id} seeds outside ${WORK_DIR}/`).toMatch(/^terraform\//);
      }
    }
  });

  it('never declares a Kubernetes setup manifest', async () => {
    for (const lab of await terraformLabs()) {
      expect(lab.setup.manifests, lab.id).toEqual([]);
    }
  });

  it('seeds a starter configuration and verifies that it arrived', async () => {
    for (const lab of await terraformLabs()) {
      expect(lab.setup.files.length, `${lab.id} seeds nothing`).toBeGreaterThan(0);
      expect(lab.setup.verify.length, `${lab.id} seeds a workspace unverified`).toBeGreaterThan(0);
      expect(
        lab.setup.files.some((f) => f.path === 'terraform/versions.tf'),
        `${lab.id} must seed the provider requirements`,
      ).toBe(true);
    }
  });
});

// ------------------------------------------------------------- cost safety

describe('terraform catalog — no lab can create a cloud resource', () => {
  const CLOUD_MARKERS = [
    'aws_',
    'azurerm_',
    'google_',
    'hashicorp/aws',
    'hashicorp/azurerm',
    'hashicorp/google',
    'access_key',
    'secret_key',
    'AWS_ACCESS_KEY',
    'ARM_CLIENT',
    'GOOGLE_CREDENTIALS',
  ];

  it('seeds no configuration that names a cloud provider', async () => {
    for (const lab of await terraformLabs()) {
      for (const seed of await loadSetupFiles(lab)) {
        for (const marker of CLOUD_MARKERS) {
          expect(
            seed.content.includes(marker),
            `${lab.id} seed ${seed.path} mentions ${marker}`,
          ).toBe(false);
        }
      }
    }
  });

  it('seeds only the three offline providers the sandbox image carries', async () => {
    // Matches the mirror baked into infrastructure/docker/sandbox-terraform.Dockerfile.
    const ALLOWED = ['hashicorp/local', 'hashicorp/random', 'hashicorp/null'];

    for (const lab of await terraformLabs()) {
      for (const seed of await loadSetupFiles(lab)) {
        for (const [, source] of seed.content.matchAll(/source\s*=\s*"(hashicorp\/[a-z]+)"/g)) {
          expect(ALLOWED, `${lab.id} seed ${seed.path} requires ${source}`).toContain(source);
        }
      }
    }
  });

  it('never asks a student to supply a credential', async () => {
    for (const lab of await terraformLabs()) {
      const prose = [
        lab.task.description,
        lab.story ?? '',
        ...lab.hints.map((h) => h.text),
        ...lab.objectives,
      ]
        .join(' ')
        .toLowerCase();

      for (const phrase of [
        'aws account',
        'access key',
        'api key',
        'credential file',
        'sign in to',
      ]) {
        expect(prose.includes(phrase), `${lab.id} mentions '${phrase}'`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------- content

describe('terraform catalog — content rules', () => {
  it('cites official HashiCorp documentation and nothing commercial', async () => {
    const OFFICIAL = ['developer.hashicorp.com', 'registry.terraform.io'];

    for (const lab of await terraformLabs()) {
      expect(lab.references.length, `${lab.id} references`).toBeGreaterThanOrEqual(3);
      expect(
        lab.references.some((r) => OFFICIAL.includes(new URL(r.url).hostname)),
        `${lab.id} cites no official documentation`,
      ).toBe(true);

      for (const reference of lab.references) {
        const host = new URL(reference.url).hostname;
        expect(reference.url.startsWith('https://'), `${lab.id}: ${reference.url}`).toBe(true);
        for (const banned of DISALLOWED_DOC_HOSTS) {
          expect(host === banned || host.endsWith(`.${banned}`), `${lab.id} cites ${host}`).toBe(
            false,
          );
        }
      }
    }
  });

  it('provides a progressive hint ladder that never hands over the answer', async () => {
    for (const lab of await terraformLabs()) {
      expect(lab.hints.length, `${lab.id} hint count`).toBe(3);
      expect(lab.hints.map((h) => h.level)).toEqual([1, 2, 3]);

      // Each rung should say more than the one before it.
      for (let i = 1; i < lab.hints.length; i += 1) {
        expect(
          lab.hints[i]!.text.length,
          `${lab.id} hint ${i + 1} should be more specific than hint ${i}`,
        ).toBeGreaterThan(60);
      }

      // No hint may contain a pasteable resource block — that is the solution,
      // not a hint. Backticked identifiers are fine; a `resource "x" "y" {` is not.
      for (const hint of lab.hints) {
        expect(hint.text, `${lab.id} hint ${hint.level} contains a resource block`).not.toMatch(
          /resource\s+"[a-z_]+"\s+"[a-z_]+"\s*\{/,
        );
        expect(hint.text, `${lab.id} hint ${hint.level} contains a variable block`).not.toMatch(
          /variable\s+"[a-z_]+"\s*\{/,
        );
      }
    }
  });

  it('gives every student-facing check its own wording', async () => {
    for (const lab of await terraformLabs()) {
      const labels = lab.requirements.map((r) => r.label);
      expect(labels.every(Boolean), `${lab.id} has an unlabelled requirement`).toBe(true);
      expect(new Set(labels).size, `${lab.id} has duplicate check labels`).toBe(labels.length);

      for (const label of labels) {
        // A label naming a requirement type would leak how the check works,
        // which is exactly what a troubleshooting lab must not reveal.
        expect(label, `${lab.id}: ${label}`).not.toMatch(/^terraform_|^file_|^directory_/);
      }
    }
  });

  it('keeps the troubleshooting lab from naming its own faults', async () => {
    const tf010 = (await registry()).get('TF-010');

    const studentFacing = [
      tf010.task.description,
      ...tf010.requirements.map((r) => r.label ?? ''),
      ...tf010.hints.filter((h) => h.level < 3).map((h) => h.text),
    ].join(' ');

    // The seeded typo and the wrong resource label must not appear in anything
    // the student reads before hint 3.
    expect(studentFacing).not.toContain('enviroment');
    expect(studentFacing).not.toContain('local_file.setting.');
  });

  it('keeps the catalog projection free of the expected end state', async () => {
    const serialised = JSON.stringify((await registry()).list({ track: 'terraform' }));

    expect(serialised).not.toContain('requirements');
    expect(serialised).not.toContain('setup');
    expect(serialised).not.toContain('retention_days');
    expect(serialised).not.toContain('8443');
  });
});

// -------------------------------------------------------- seeded workspaces

describe('terraform catalog — seeded starter files', () => {
  it('loads every declared starter file within the seeding limits', async () => {
    for (const lab of await terraformLabs()) {
      const seed = await loadSetupFiles(lab);
      expect(seed.length, `${lab.id} seeds nothing`).toBeGreaterThan(0);
      for (const file of seed) {
        expect(file.path, `${lab.id}: ${file.path}`).toMatch(/^[A-Za-z0-9._/-]+$/);
        expect(file.content.length, `${lab.id}: ${file.path} is empty`).toBeGreaterThan(0);
        // Starter files are data. The execute bits are stripped when they are
        // written, so a lab can never ship something the platform might run.
        expect(Number.parseInt(file.mode, 8) & 0o111, `${lab.id}: ${file.path} is executable`).toBe(
          0,
        );
      }
    }
  });

  it('seeds the exercises the story describes', async () => {
    const reg = await registry();

    const state = await loadSetupFiles(reg.get('TF-004'));
    expect(state.map((f) => f.path)).toEqual(['terraform/main.tf', 'terraform/versions.tf']);

    const broken = await loadSetupFiles(reg.get('TF-010'));
    expect(broken.map((f) => f.path)).toEqual([
      'terraform/main.tf',
      'terraform/modules/audit/main.tf',
      'terraform/modules/audit/outputs.tf',
      'terraform/modules/audit/variables.tf',
      'terraform/outputs.tf',
      'terraform/terraform.tfvars',
      'terraform/variables.tf',
      'terraform/versions.tf',
    ]);
  });

  it('never seeds Terraform state or a provider cache', async () => {
    for (const lab of await terraformLabs()) {
      for (const file of await loadSetupFiles(lab)) {
        // Handing a student a state file would mean handing them a partially
        // completed lab, and a lock file would pin a provider set the image
        // might not carry.
        expect(file.path, `${lab.id} seeds ${file.path}`).not.toMatch(
          /terraform\.tfstate|\.terraform/,
        );
      }
    }
  });
});

// ------------------------------------------------------------ schema rules

describe('terraform lab schema — the environment and its checks must agree', () => {
  const base = (body: string) => `
id: TF-900
slug: tf-900-fixture
title: Schema Fixture
track: terraform
topic: fundamentals
difficulty: beginner
duration_minutes: 15
task:
  summary: Fixture.
  description: Fixture lab used by the Terraform schema tests.
references:
  - title: Terraform resources
    url: https://developer.hashicorp.com/terraform/language/resources/syntax
skills:
  - terraform.configuration.write
${body}`;

  const expectIssue = (yaml: string, pattern: RegExp) => {
    let message = '';
    try {
      parseLabDefinition(yaml);
    } catch (error) {
      message = (error as { issues?: string[] }).issues?.join('\n') ?? (error as Error).message;
    }
    expect(message).toMatch(pattern);
  };

  it('accepts a well-formed Terraform lab', () => {
    expect(() =>
      parseLabDefinition(
        base(`
environment:
  provider: terraform
requirements:
  - type: terraform_valid
    dir: terraform
    label: The configuration is valid
`),
      ),
    ).not.toThrow();
  });

  it('defaults isolation from the provider', () => {
    const lab = parseLabDefinition(
      base(`
environment:
  provider: terraform
requirements:
  - type: terraform_valid
    dir: terraform
    label: Valid
`),
    );
    expect(lab.environment.isolation).toBe('container');
  });

  it('rejects a Terraform lab that asks for a Kubernetes check', () => {
    expectIssue(
      base(`
environment:
  provider: terraform
requirements:
  - type: pod_exists
    name: nginx
    label: Pod exists
`),
      /kubernetes check, which the 'terraform' provider cannot verify/,
    );
  });

  it('rejects a Kubernetes lab that asks for a Terraform check', () => {
    expectIssue(
      base(`
environment:
  provider: kubernetes
requirements:
  - type: terraform_valid
    dir: terraform
    label: Valid
`).replace('track: terraform', 'track: kubernetes'),
      /terraform check, which the 'kubernetes' provider cannot verify/,
    );
  });

  it('rejects a Terraform lab declaring Kubernetes setup manifests', () => {
    expectIssue(
      base(`
environment:
  provider: terraform
requirements:
  - type: terraform_valid
    dir: terraform
    label: Valid
setup:
  manifests: [setup/app.yaml]
  verify:
    - type: terraform_valid
      dir: terraform
      label: Valid
`),
      /cannot be applied by the 'terraform' provider/,
    );
  });

  it('rejects a Terraform lab whose isolation its provider cannot deliver', () => {
    expectIssue(
      base(`
environment:
  provider: terraform
  isolation: namespace
requirements:
  - type: terraform_valid
    dir: terraform
    label: Valid
`),
      /isolates with 'container'/,
    );
  });

  it('rejects a sandbox path that tries to escape the sandbox home', () => {
    for (const bad of ['../../etc/passwd', '/etc/passwd', '~/.ssh/config']) {
      expectIssue(
        base(`
environment:
  provider: terraform
requirements:
  - type: file_exists
    path: ${bad}
    label: Escape
`),
        /relative path inside the sandbox home/,
      );
    }
  });

  it('rejects a seeded starter file that traverses upwards', () => {
    expectIssue(
      base(`
environment:
  provider: terraform
requirements:
  - type: terraform_valid
    dir: terraform
    label: Valid
setup:
  files:
    - source: ../../secrets/id_rsa
      path: terraform/id_rsa
  verify:
    - type: terraform_valid
      dir: terraform
      label: Valid
`),
      /must not traverse upwards/,
    );
  });

  it('rejects a check that asks for both an exact and a partial match', () => {
    expectIssue(
      base(`
environment:
  provider: terraform
requirements:
  - type: terraform_resource_attribute
    dir: terraform
    resource_type: local_file
    name: x
    attribute: content
    equals: a
    contains: b
    label: Content
`),
      /equals or contains, not both/,
    );
  });

  it('has no requirement type that carries a command, script, or shell fragment', async () => {
    // The security property, asserted against the shipped labs rather than
    // asserted in prose: nothing in a lab definition can execute.
    for (const lab of await terraformLabs()) {
      const serialised = JSON.stringify([...lab.requirements, ...lab.setup.verify]);
      for (const key of ['"command"', '"script"', '"exec"', '"shell"', '"run"', '"args"']) {
        expect(serialised, `${lab.id} carries ${key}`).not.toContain(key);
      }
    }
  });
});

// ------------------------------------------------------- lab files on disk

describe('terraform labs — files on disk', () => {
  it('places every lab in labs/terraform/<slug>/lab.yaml', async () => {
    for (const lab of await terraformLabs()) {
      expect(lab.sourcePath).toBe(path.join(LABS_DIR, 'terraform', lab.slug, 'lab.yaml'));
    }
  });

  it('writes lab content as data, never as code in the frontend', async () => {
    // The platform's rule, checked where it can actually be broken: no
    // Terraform lab id may appear in the React sources.
    const catalogPage = await readFile(
      path.join(LABS_DIR, '..', 'apps', 'web', 'src', 'pages', 'CatalogPage.tsx'),
      'utf8',
    );
    const labPage = await readFile(
      path.join(LABS_DIR, '..', 'apps', 'web', 'src', 'pages', 'LabPage.tsx'),
      'utf8',
    );

    for (const id of EXPECTED_IDS) {
      expect(catalogPage, `CatalogPage hardcodes ${id}`).not.toContain(id);
      expect(labPage, `LabPage hardcodes ${id}`).not.toContain(id);
    }
  });
});
