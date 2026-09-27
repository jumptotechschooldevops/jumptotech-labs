/**
 * Ansible labs: grading defects found by the 2026-09-21 lab product audit,
 * pinned so they stay closed.
 *
 * Real catalog, real verifyLab, every requirement of the lab. The Ansible port
 * is a fake whose `runPlaybook` applies a per-scenario MODEL of what a real
 * `ansible-playbook site.yml` would do with the playbook the test writes. The
 * project checks (file_key_value, file_contains, yaml_valid …) read the real
 * YAML the test writes; nothing about them is modelled.
 */
import { describe, expect, it } from 'vitest';
import {
  loadSetupFiles,
  type AnsiblePathInfo,
  type AnsiblePlaybookRun,
  type AnsibleRunResult,
  type AnsibleSandboxPort,
  type SandboxPathRead,
} from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import type { SandboxPort } from '../src/sandbox-reader.js';

type NodeFs = Map<string, { kind: 'file' | 'directory'; content?: string }>;
/** Apply the modelled playbook to one node; return how many tasks changed. */
type Model = (node: string, fs: NodeFs) => number;

const NODES = ['node1', 'node2'] as const;

/** Write a file on a node the way copy/template would: changed only if different. */
function put(fs: NodeFs, path: string, content: string): number {
  const current = fs.get(path);
  if (current?.kind === 'file' && current.content === content) return 0;
  fs.set(path, { kind: 'file', content });
  return 1;
}
function dir(fs: NodeFs, path: string): number {
  if (fs.get(path)?.kind === 'directory') return 0;
  fs.set(path, { kind: 'directory' });
  return 1;
}

class Project implements SandboxPort {
  constructor(private readonly files: Map<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.files.get(p);
    const base = { mode: '644', owner: 'student', group: 'student' };
    if (content === undefined) {
      const kids = [...this.files.keys()].filter((k) => k.startsWith(`${p}/`));
      return kids.length ? { ...base, type: 'directory', mode: '755', sizeBytes: 0 } : null;
    }
    return { ...base, type: 'file', sizeBytes: Buffer.byteLength(content), content };
  }
  async inspect() {
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
}

class FakeAnsible implements AnsibleSandboxPort {
  readonly workspaceDir = '/home/student/lab';
  readonly nodes = new Map<string, NodeFs>(NODES.map((n) => [n, new Map()]));
  runs = 0;
  constructor(
    private readonly files: Map<string, string>,
    private readonly model: Model,
    private readonly group = 'web',
  ) {}
  async ping() {}
  managedNodes() {
    return NODES;
  }
  async readWorkspaceFile(_s: string, p: string) {
    return this.files.get(p) ?? null;
  }
  async statWorkspacePath(_s: string, p: string): Promise<AnsiblePathInfo> {
    if (this.files.has(p)) return { path: p, exists: true, kind: 'file' };
    const isDir = [...this.files.keys()].some((k) => k.startsWith(`${p}/`));
    return isDir ? { path: p, exists: true, kind: 'directory' } : { path: p, exists: false, kind: 'other' };
  }
  async listWorkspaceDirectory(_s: string, p: string) {
    const kids = [...this.files.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1).split('/')[0]!);
    return kids.length ? [...new Set(kids)] : null;
  }
  async readManagedFile(_s: string, node: string, p: string) {
    const e = this.nodes.get(node)!.get(p);
    return e?.kind === 'file' ? e.content ?? '' : null;
  }
  async statManagedPath(_s: string, node: string, p: string): Promise<AnsiblePathInfo> {
    const e = this.nodes.get(node)!.get(p);
    return e ? { path: p, exists: true, kind: e.kind, mode: '0644' } : { path: p, exists: false, kind: 'other' };
  }
  async removeManagedPath(_s: string, node: string, p: string) {
    const fs = this.nodes.get(node)!;
    for (const key of [...fs.keys()]) if (key === p || key.startsWith(`${p}/`)) fs.delete(key);
  }
  async processRunning() {
    return false;
  }
  async run(_s: string, command: Parameters<AnsibleSandboxPort['run']>[1]): Promise<AnsibleRunResult> {
    if (command.kind === 'inventory') {
      const json = { _meta: { hostvars: {} }, all: { children: ['ungrouped', this.group] }, [this.group]: { hosts: [...NODES] } };
      return { exitCode: 0, stdout: JSON.stringify(json), stderr: '', timedOut: false };
    }
    if (command.kind === 'ping') {
      return { exitCode: 0, stdout: NODES.map((n) => `${n} | SUCCESS => {"ping": "pong"}`).join('\n'), stderr: '', timedOut: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
  async runPlaybook(): Promise<AnsiblePlaybookRun> {
    this.runs += 1;
    const stats: AnsiblePlaybookRun['stats'] = {};
    for (const node of NODES) {
      const changed = this.model(node, this.nodes.get(node)!);
      stats[node] = { ok: 3, changed, failures: 0, unreachable: 0, skipped: 0 };
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, stats };
  }
}

async function grade(labId: string, change: (files: Map<string, string>) => void, model: Model, group = 'web') {
  const lab = (await realCatalog()).get(labId);
  const files = new Map<string, string>();
  for (const f of await loadSetupFiles(lab)) files.set(f.path, f.content.toString());
  change(files);
  const ansible = new FakeAnsible(files, model, group);
  const result = await verifyLab({ lab, namespace: 'jtt-lab-00000000a0a0', sandbox: new Project(files), ansible });
  expect(result.error).toBeUndefined();
  return { result, failing: result.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label} :: ${c.detail ?? ''}`), ansible };
}

// ---------------------------------------------------------------- ANSIBLE-004
const SITE_004 = (role: string) => `---
- name: Configure the ledger service
  hosts: web
  tasks:
    - name: Write the application configuration
      ansible.builtin.copy:
        dest: /etc/jumptotech/app.conf
        content: |
          app_name=ledger
          app_port={{ app_port }}
          app_release={{ app_release }}
          node_role=${role}
    - name: Read the hostname
      ansible.builtin.command: hostname
      register: host_out
      changed_when: false
    - name: Record it
      ansible.builtin.copy:
        dest: /etc/jumptotech/node.facts
        content: "detected_hostname={{ host_out.stdout }}\\n"
`;
const model004: Model = (node, fs) => {
  const role = node === 'node1' ? 'primary' : 'replica';
  return (
    put(fs, '/etc/jumptotech/app.conf', `app_name=ledger\napp_port=8080\napp_release=2.4.1\nnode_role=${role}\n`) +
    put(fs, '/etc/jumptotech/node.facts', `detected_hostname=${node}\n`)
  );
};
describe('ANSIBLE-004 — the values live in group_vars and host_vars', () => {
  it('passes group_vars + host_vars + register', async () => {
    const { failing } = await grade(
      'ANSIBLE-004',
      (f) => {
        f.set('group_vars/web.yml', '---\napp_port: 8080\napp_release: "2.4.1"\n');
        f.set('host_vars/node1.yml', '---\nnode_role: primary\n');
        f.set('host_vars/node2.yml', '---\nnode_role: replica\n');
        f.set('site.yml', SITE_004('{{ node_role }}'));
      },
      model004,
    );
    expect(failing).toEqual([]);
  });
  it('refuses empty host_vars files with node_role computed in site.yml from inventory_hostname', async () => {
    // Real Ansible: node_role is a play-level Jinja expression; both host_vars files are empty.
    const { failing } = await grade(
      'ANSIBLE-004',
      (f) => {
        f.set('group_vars/web.yml', '---\napp_port: 8080\napp_release: "2.4.1"\n');
        f.set('host_vars/node1.yml', '');
        f.set('host_vars/node2.yml', '');
        f.set('site.yml', SITE_004("{{ 'primary' if inventory_hostname == 'node1' else 'replica' }}").replace('  hosts: web\n', '  hosts: web\n  vars:\n    node_role_unused: true\n'));
      },
      model004,
    );
    expect(failing.map((f) => f.split(' :: ')[0])).toEqual(["node1's host variables give it its role", "node2's host variables give it its role"]);
  });
  it('refuses group_vars holding the values only in a comment, with the real values in host_vars', async () => {
    const { failing } = await grade(
      'ANSIBLE-004',
      (f) => {
        f.set('group_vars/web.yml', '---\n# was: app_port 8080, app_release 2.4.1 (moved to host_vars)\nteam: ledger\n');
        f.set('host_vars/node1.yml', '---\napp_port: 8080\napp_release: "2.4.1"\nnode_role: primary\n');
        f.set('host_vars/node2.yml', '---\napp_port: 8080\napp_release: "2.4.1"\nnode_role: replica\n');
        f.set('site.yml', SITE_004('{{ node_role }}'));
      },
      model004,
    );
    expect(failing.map((f) => f.split(' :: ')[0])).toEqual([
      "The web group's variables set the application port",
      "The web group's variables set the release",
    ]);
  });
});

// ---------------------------------------------------------------- ANSIBLE-005
describe('ANSIBLE-005 — the condition reads the role, never a node name', () => {
  const SITE = (when: string) => `---
- name: Ledger layout
  hosts: web
  tasks:
    - name: Directories
      ansible.builtin.file:
        path: "/opt/jumptotech/{{ item }}"
        state: directory
      loop: "{{ app_directories }}"
    - name: Scheduler lock
      ansible.builtin.copy:
        dest: /etc/jumptotech/scheduler.lock
        content: "owner=node1\\n"
      when: ${when}
    - name: Release
      ansible.builtin.copy:
        dest: /etc/jumptotech/release.txt
        content: "release={{ app_release }}\\n"
`;
  const model: Model = (node, fs) =>
    ['bin', 'conf', 'logs', 'releases'].reduce((n, d) => n + dir(fs, `/opt/jumptotech/${d}`), 0) +
    (node === 'node1' ? put(fs, '/etc/jumptotech/scheduler.lock', 'owner=node1\n') : 0) +
    put(fs, '/etc/jumptotech/release.txt', 'release=2.4.1\n');
  it('passes when: node_role == "primary"', async () => {
    expect((await grade('ANSIBLE-005', (f) => f.set('site.yml', SITE('node_role == "primary"')), model)).failing).toEqual([]);
  });
  it.each(["inventory_hostname in ['node1']", "\"'node1' == inventory_hostname\"", "inventory_hostname is match('node1')"])('refuses when: %s', async (when) => {
    // Before: `inventory_hostname in ['node1']` passed, node_role only in a comment.
    const { failing } = await grade(
      'ANSIBLE-005',
      (f) => f.set('site.yml', `${SITE(when)}# TODO: use node_role\n`),
      model,
    );
    expect(failing.map((f) => f.split(' :: ')[0])).toEqual(["The condition reads the node's role rather than naming a node"]);
  });
});
