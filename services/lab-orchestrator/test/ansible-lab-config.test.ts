/**
 * BETA-P0-019 — an Ansible lab keeps the `ansible.cfg` it ships.
 *
 * Found by the five-student validation on the real stack: ANSIBLE-001 could
 * never pass. Two faults, each hiding the other:
 *
 *   1. The base create gated seeding on `setup.files`/`seed_scripts` only, so a
 *      lab that ships just a `workspace_dir` — every Ansible lab — was never
 *      seeded. Its `ansible.cfg`, whose `inventory = inventory.ini` is what the
 *      lab teaches, and its starter inventories and playbooks never arrived.
 *   2. The provider's SSH setup wrote its own `ansible.cfg` unconditionally, so
 *      with (1) fixed it would still have replaced the lab's file with one that
 *      has no `inventory` line. And because it always existed, the lab's own
 *      "ansible.cfg is in place" setup check passed and hid (1).
 *
 * The student's `inventory.ini` was ignored by `ansible` and by the verifier
 * alike. `ansible-runtime-integration.test.ts` did not catch it: it writes its
 * own `ansible.cfg` with `docker exec` instead of provisioning through the
 * provider.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ANSIBLE_WORKSPACE_DIR, AnsibleLabProvider, parseLabDefinition, type LabRegistry, type LoadedLabDefinition } from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { sessionContext } from './helpers.js';
import { realCatalog } from './real-catalog.js';

const SANDBOX = 'jtt-lab-00000000019a';
const CONFIG_PATH = `${ANSIBLE_WORKSPACE_DIR}/ansible.cfg`;

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
}, 60_000);

/** A lab that ships no workspace at all: the platform's file is its only config. */
function labWithoutConfig(): LoadedLabDefinition {
  const yaml = `
id: ANSIBLE-902
slug: ansible-902-no-config
title: Ansible without a shipped config
track: ansible
topic: inventory
difficulty: beginner
duration_minutes: 10
environment:
  provider: ansible
  network: link
task:
  summary: s
  description: d
requirements:
  - type: ansible_inventory_valid
    label: Ansible can parse the inventory
references:
  - title: Ansible inventory guide
    url: https://docs.ansible.com/ansible/latest/inventory_guide/index.html
skills:
  - ansible.inventory
`;
  return { ...parseLabDefinition(yaml), directory: '/labs/ansible-902', sourcePath: '/labs/ansible-902/lab.yaml' };
}

function controlConfig(runtime: FakeContainerRuntime): string | undefined {
  return runtime.containers.get(SANDBOX)?.files.get(CONFIG_PATH)?.content;
}

describe('an Ansible lab keeps the ansible.cfg it ships', () => {
  it('provisions ANSIBLE-001 with the lab’s own ansible.cfg, byte for byte', async () => {
    const lab = registry.get('ANSIBLE-001');
    const shipped = readFileSync(path.join(lab.directory, 'workspace', 'ansible.cfg'), 'utf8');
    expect(shipped).toMatch(/^inventory = inventory\.ini$/m);

    const runtime = new FakeContainerRuntime();
    const provider = new AnsibleLabProvider({ runtime, sleep: async () => undefined });
    const result = await provider.create(sessionContext(lab, { sandboxRef: SANDBOX, sessionId: 'sess-000000000000019a' }));

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(controlConfig(runtime)).toBe(shipped);
    // The session identity is still installed where ssh looks for it.
    expect(runtime.containers.get(SANDBOX)?.files.get('/home/student/.ssh/config')?.content).toMatch(/Port 2222/);
  });

  it('keeps it across a reset, which provisions the topology again', async () => {
    const lab = registry.get('ANSIBLE-001');
    const shipped = readFileSync(path.join(lab.directory, 'workspace', 'ansible.cfg'), 'utf8');
    const runtime = new FakeContainerRuntime();
    const provider = new AnsibleLabProvider({ runtime, sleep: async () => undefined });
    const context = sessionContext(lab, { sandboxRef: SANDBOX, sessionId: 'sess-000000000000019b' });

    expect((await provider.create(context)).ok).toBe(true);
    const reset = await provider.reset(context);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
    expect(controlConfig(runtime)).toBe(shipped);
  });

  it('every shipped Ansible lab declares the inventory, user and port the platform file would have supplied', () => {
    const labs = registry.list().map((summary) => registry.get(summary.id)).filter((def) => def.environment.provider === 'ansible');
    expect(labs.length).toBeGreaterThanOrEqual(10);
    for (const def of labs) {
      const cfg = readFileSync(path.join(registry.get(def.id).directory, 'workspace', 'ansible.cfg'), 'utf8');
      expect(cfg, def.id).toMatch(/^inventory = /m);
      expect(cfg, def.id).toMatch(/^remote_user = root$/m);
      expect(cfg, def.id).toMatch(/^remote_port = 2222$/m);
    }
  });

  it('still writes the platform ansible.cfg for a lab that ships none', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new AnsibleLabProvider({ runtime, sleep: async () => undefined });
    const result = await provider.create(
      sessionContext(labWithoutConfig(), { sandboxRef: SANDBOX, sessionId: 'sess-000000000000019c' }),
    );

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    const cfg = controlConfig(runtime);
    expect(cfg).toMatch(/^private_key_file = \/home\/student\/\.ssh\/id_rsa$/m);
    expect(cfg).toMatch(/-o Port=2222/);
  });
});
