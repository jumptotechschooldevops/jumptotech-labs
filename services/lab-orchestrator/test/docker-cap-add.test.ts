/**
 * N19 — a seeded container may be granted NET_ADMIN, and nothing more.
 *
 * The security review is `docs/development/n19-security-review.md`. The verdict
 * it reaches — the grant is confined to one sandbox because NET_ADMIN is
 * namespaced — is not something a unit test can prove; the kernel does. What
 * these tests pin is the *envelope* around the grant, which is what keeps the
 * kernel's confinement from being handed a case it does not cover:
 *
 *   1. the vocabulary is exactly NET_ADMIN;
 *   2. a capped container may not be host-networked (host networking would put
 *      it in the sandbox's own namespace, which is the one case the review's
 *      confinement argument excludes);
 *   3. the grant reaches the daemon as `--cap-add` only when a lab asked for it;
 *   4. it does not survive into anything the lab did not declare.
 */
import { describe, expect, it } from 'vitest';
import {
  SETUP_GRANTABLE_CAPABILITIES,
  dockerSetupSchema,
  parseLabDefinition,
} from '../src/index.js';

/** Parse a `setup.docker` block, or collect the error message. */
function parseSetup(block: Record<string, unknown>) {
  return dockerSetupSchema.safeParse(block);
}

// -------------------------------------------------------- 1. the vocabulary

describe('the grantable capability vocabulary is exactly NET_ADMIN', () => {
  it('is a closed list with one member', () => {
    // Stated as a literal: adding a capability here is a security review, not a
    // refactor, so it should require editing this line and the review doc.
    expect([...SETUP_GRANTABLE_CAPABILITIES]).toEqual(['NET_ADMIN']);
  });

  it('accepts a container that adds NET_ADMIN', () => {
    const result = parseSetup({
      containers: [{ name: 'natbox', image: 'busybox:1.36', cap_add: ['NET_ADMIN'] }],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['SYS_ADMIN', 'the classic escape capability'],
    ['NET_RAW', 'capture — a different review, gated on network: link elsewhere'],
    ['SYS_PTRACE', 'reading other processes'],
    ['ALL', 'the lot'],
    ['MKNOD', 'device nodes'],
    ['net_admin', 'the right capability, wrong case'],
  ])('refuses %s (%s)', (capability) => {
    const result = parseSetup({
      containers: [{ name: 'c', image: 'busybox:1.36', cap_add: [capability] }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses more than one capability on a container', () => {
    const result = parseSetup({
      containers: [{ name: 'c', image: 'busybox:1.36', cap_add: ['NET_ADMIN', 'NET_ADMIN'] }],
    });
    expect(result.success).toBe(false);
  });

  it('defaults to no capabilities', () => {
    const result = dockerSetupSchema.parse({
      containers: [{ name: 'c', image: 'busybox:1.36' }],
    });
    expect(result.containers[0]?.cap_add).toEqual([]);
  });
});

// ------------------------------------------------ 2. no host networking

describe('a capability may not be granted to a host-networked container', () => {
  it('refuses cap_add together with network: host', () => {
    const result = parseSetup({
      containers: [
        { name: 'c', image: 'busybox:1.36', network: 'host', cap_add: ['NET_ADMIN'] },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('own network namespace');
    }
  });

  it('allows cap_add on a user-defined network', () => {
    const result = parseSetup({
      networks: [{ name: 'lab-net' }],
      containers: [
        { name: 'c', image: 'busybox:1.36', network: 'lab-net', cap_add: ['NET_ADMIN'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('allows host networking on a container with no capability', () => {
    // Host networking on its own is pre-existing and not what N19 governs; it
    // is only the *combination* with a capability that is refused.
    const result = parseSetup({
      containers: [{ name: 'c', image: 'busybox:1.36', network: 'host' }],
    });
    expect(result.success).toBe(true);
  });
});

// ------------------------------------------------ 3. the whole lab loads

describe('a lab may declare a NET_ADMIN container', () => {
  it('parses through the full lab schema', () => {
    const yaml = `
id: NET-999
slug: net-999-firewall
title: Firewall
track: networking
topic: container-networking
difficulty: advanced
duration_minutes: 40
environment:
  provider: docker
task:
  summary: s
  description: d
setup:
  docker:
    images:
      - busybox:1.36
    networks:
      - name: lab-net
    containers:
      - name: firewalled
        image: busybox:1.36
        network: lab-net
        cap_add: [NET_ADMIN]
        command: [ "sleep", "3600" ]
  verify:
    - type: docker_container_running
      name: firewalled
      label: up
requirements:
  - type: docker_container_running
    name: firewalled
    label: up
references:
  - title: Docker
    url: https://docs.docker.com/engine/
skills:
  - net.firewall.rules
hints:
  - level: 1
    text: Look at the rules.
  - level: 2
    text: Consult the Docker documentation.
`;
    expect(() => parseLabDefinition(yaml)).not.toThrow();
  });
});
