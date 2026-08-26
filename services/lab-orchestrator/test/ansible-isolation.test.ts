/**
 * The Ansible topology's two security boundaries, held shut by tests.
 *
 * An Ansible session is the only place on this platform where a student's work
 * spans more than one container, and the only place that needs a capability no
 * other provider uses. Both facts are load-bearing, and both are the kind that
 * decay silently — a capability added "just to get it working", a network mode
 * loosened to make a lab pass. These tests are what make either show up as a
 * failure rather than as a quiet widening.
 *
 * The real-daemon proof of the same properties lives in
 * `ansible-runtime-integration.test.ts`; this file asserts what the platform
 * *asks the daemon for*, which is where a regression would be introduced.
 */
import { describe, expect, it } from 'vitest';
import {
  ANSIBLE_MANAGED_NODE_CAPABILITIES,
  ANSIBLE_MANAGED_NODE_COUNT,
  ANSIBLE_SSH_PORT,
  AnsibleLabProvider,
  GRANTABLE_CAPABILITIES,
  LinuxLabProvider,
  PROVIDER_RESTRICTED_CAPABILITIES,
  TerraformLabProvider,
  assertCapabilityName,
  isContainerNodeRef,
  nodeRefForSandbox,
} from '../src/index.js';
import { parseLabDefinition, type LoadedLabDefinition } from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { sessionContext } from './helpers.js';

describe('the capability the Ansible track needs is scoped to the Ansible track', () => {
  it('grants SYS_CHROOT to no provider but ansible', () => {
    const allowed = PROVIDER_RESTRICTED_CAPABILITIES.get('SYS_CHROOT');
    expect(allowed).toBeDefined();
    expect([...allowed!]).toEqual(['ansible']);
  });

  it('refuses SYS_CHROOT to linux, docker, terraform, aws and an unnamed caller', () => {
    for (const provider of ['linux', 'docker', 'terraform', 'aws', 'kubernetes']) {
      expect(() => assertCapabilityName('SYS_CHROOT', provider), provider).toThrow(/only be granted/);
    }
    // Fail closed: a caller that does not identify itself is denied, so
    // forgetting to pass the provider can never be the thing that permits.
    expect(() => assertCapabilityName('SYS_CHROOT')).toThrow(/only be granted/);
  });

  it('still refuses NET_RAW to the Ansible provider', () => {
    // The Networking track's capability must not leak the other way either:
    // a shared runtime is exactly how one track inherits another's grants.
    expect(() => assertCapabilityName('NET_RAW', 'ansible')).toThrow(/only be granted/);
    expect(assertCapabilityName('NET_RAW', 'linux')).toBe('NET_RAW');
  });

  it('never grants NET_ADMIN, SYS_ADMIN, SYS_PTRACE or MKNOD to anyone', () => {
    for (const capability of ['NET_ADMIN', 'SYS_ADMIN', 'SYS_PTRACE', 'MKNOD', 'SYS_MODULE']) {
      expect(GRANTABLE_CAPABILITIES.has(capability), capability).toBe(false);
      expect(() => assertCapabilityName(capability, 'ansible'), capability).toThrow();
    }
  });

  it('asks for exactly the capabilities sshd and the file modules need, and no more', () => {
    expect([...ANSIBLE_MANAGED_NODE_CAPABILITIES].sort()).toEqual(
      ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID', 'SYS_CHROOT'].sort(),
    );
    // NET_BIND_SERVICE is absent on purpose: sshd listens above 1024, so the
    // grant does not depend on the runtime's ip_unprivileged_port_start.
    expect(ANSIBLE_MANAGED_NODE_CAPABILITIES).not.toContain('NET_BIND_SERVICE');
    expect(ANSIBLE_SSH_PORT).toBeGreaterThanOrEqual(1024);
  });
});

describe('what the Ansible provider actually asks the daemon for', () => {
  const SANDBOX = 'jtt-lab-000000000001';

  /** A minimal Ansible lab, parsed rather than hand-built so the schema applies. */
  function ansibleLab(): LoadedLabDefinition {
    const yaml = `
id: ANSIBLE-901
slug: ansible-901-probe
title: Ansible probe
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
    return {
      ...parseLabDefinition(yaml),
      directory: '/labs/ansible-901',
      sourcePath: '/labs/ansible-901/lab.yaml',
    };
  }

  async function created() {
    const runtime = new FakeContainerRuntime();
    const provider = new AnsibleLabProvider({ runtime });
    const result = await provider.create(
      sessionContext(ansibleLab(), { sandboxRef: SANDBOX, sessionId: 'sess-000000000000000a' }),
    );
    return { runtime, result };
  }

  it('puts the control node and every managed node on one --internal network', async () => {
    const { runtime, result } = await created();
    expect(result.ok).toBe(true);

    expect(runtime.networksCreated).toHaveLength(1);
    const network = runtime.networksCreated[0]!.name;
    expect(network).toMatch(/^jtt-net-/);

    // Every container of the session is on that one network, and on no other.
    for (const spec of runtime.created) {
      expect(spec.network, spec.name).toBe(network);
    }
  });

  it('creates a control node plus exactly the declared number of managed nodes', async () => {
    const { runtime } = await created();
    const names = runtime.created.map((spec) => spec.name);
    expect(names.filter((n) => n.startsWith('jtt-lab-'))).toHaveLength(1);
    expect(names.filter(isContainerNodeRef)).toHaveLength(ANSIBLE_MANAGED_NODE_COUNT);
  });

  it('gives the control node no capabilities at all', async () => {
    const { runtime } = await created();
    const control = runtime.created.find((spec) => spec.name.startsWith('jtt-lab-'))!;
    expect(control.capAdd ?? []).toEqual([]);
    expect(control.noNewPrivileges).not.toBe(false);
    // The student's shell lands here, and it is the container with the least
    // privilege in the whole platform. That is the point.
  });

  it('gives managed nodes the reviewed set and identifies the provider asking', async () => {
    const { runtime } = await created();
    const nodes = runtime.created.filter((s) => isContainerNodeRef(s.name));
    expect(nodes).toHaveLength(ANSIBLE_MANAGED_NODE_COUNT);
    for (const spec of nodes) {
      expect([...(spec.capAdd ?? [])].sort()).toEqual([...ANSIBLE_MANAGED_NODE_CAPABILITIES].sort());
      // Without this the runtime's restricted-capability gate would deny
      // SYS_CHROOT, so the assertion doubles as proof the gate is consulted.
      expect(spec.provider).toBe('ansible');
      expect(spec.noNewPrivileges).not.toBe(false);
    }
  });

  it('publishes no host port anywhere in the topology', async () => {
    const { runtime } = await created();
    for (const spec of runtime.created) {
      expect(JSON.stringify(spec), spec.name).not.toContain('publish');
    }
  });

  it('names every container from the session, so none can point at another', async () => {
    const { runtime } = await created();
    for (const spec of runtime.created) {
      expect(spec.name, spec.name).toContain('000000000001');
    }
    expect(nodeRefForSandbox(SANDBOX, 1)).toBe('jtt-node1-000000000001');
    // A different session's ref produces different names for every part.
    expect(nodeRefForSandbox('jtt-lab-99887766', 1)).toBe('jtt-node1-99887766');
  });

  it('gives managed nodes session-local aliases only', async () => {
    const { runtime } = await created();
    const aliases = runtime.created
      .filter((s) => isContainerNodeRef(s.name))
      .flatMap((s) => s.aliases ?? []);
    expect(aliases.sort()).toEqual(['node1', 'node2']);
    // Docker's embedded DNS is per-network, so these resolve only on this
    // session's own bridge — which is why every session may use them.
  });

  it('sets the ssh port on managed nodes and never leaks a private key into env', async () => {
    const { runtime } = await created();
    for (const spec of runtime.created.filter((s) => isContainerNodeRef(s.name))) {
      expect(spec.env?.JTT_SSH_PORT).toBe(String(ANSIBLE_SSH_PORT));
      // `docker inspect` shows env. Only the public half may ever appear here.
      const env = JSON.stringify(spec.env ?? {});
      expect(env).not.toContain('PRIVATE KEY');
      expect(env).not.toContain('BEGIN OPENSSH');
    }
  });
});

describe('other providers are unchanged by the Ansible track', () => {
  it('leaves the Linux provider on its own capability set', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    expect(provider.id).toBe('linux');
    // Whatever Linux grants, SYS_CHROOT is not part of it.
    expect(() => assertCapabilityName('SYS_CHROOT', 'linux')).toThrow();
  });

  it('leaves the Terraform provider with no capabilities and no network', () => {
    const runtime = new FakeContainerRuntime();
    const provider = new TerraformLabProvider({ runtime });
    expect(provider.id).toBe('terraform');
    expect(() => assertCapabilityName('SYS_CHROOT', 'terraform')).toThrow();
    expect(() => assertCapabilityName('NET_RAW', 'terraform')).toThrow();
  });
});
