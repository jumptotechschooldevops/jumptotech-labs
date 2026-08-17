/**
 * `AnsibleDockerProvider` lifecycle, against the in-memory Docker fake.
 *
 * These assert the platform's own contracts — that create is idempotent, that
 * reset restores the baseline without ending the session, that destroy refuses
 * anything it does not own, that teardown is safe to repeat, and that two
 * sessions never touch each other's objects.
 *
 * The properties that belong to Docker itself (two bridge networks really being
 * mutually unreachable) are asserted against real containers in
 * `ansible-integration.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  AnsibleDockerProvider,
  MANAGED_LABEL,
  SESSION_LABEL,
  loadLabDefinition,
  topologyFor,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeDocker } from './fake-docker.js';
import { LABS_DIR, TEST_POLICY } from './helpers.js';

const IMAGE = 'jumptotech/ansible-lab:local';

const SESSION_A = { sessionId: 'sess-000000000000000a', sandbox: 'lab-aaaaaaaaaaaa' };
const SESSION_B = { sessionId: 'sess-000000000000000b', sandbox: 'lab-bbbbbbbbbbbb' };

let ansible001: LoadedLabDefinition;
let ansible008: LoadedLabDefinition;

async function labs(): Promise<void> {
  ansible001 ??= await loadLabDefinition(
    path.join(LABS_DIR, 'ansible', 'ansible-001-inventory', 'lab.yaml'),
  );
  ansible008 ??= await loadLabDefinition(
    path.join(LABS_DIR, 'ansible', 'ansible-008-roles', 'lab.yaml'),
  );
}

function contextFor(
  session: { sessionId: string; sandbox: string },
  lab: LoadedLabDefinition,
): LabSessionContext {
  return {
    sessionId: session.sessionId,
    labId: lab.id,
    namespace: session.sandbox,
    serviceAccountName: 'student',
    lab,
    expiresAtMs: Date.now() + 60 * 60_000,
    policy: TEST_POLICY,
  };
}

function newProvider(docker: FakeDocker): AnsibleDockerProvider {
  return new AnsibleDockerProvider({
    docker,
    image: IMAGE,
    sleep: async () => undefined,
    readyTimeoutMs: 1_000,
  });
}

describe('AnsibleDockerProvider', () => {
  let docker: FakeDocker;
  let provider: AnsibleDockerProvider;

  beforeEach(async () => {
    await labs();
    docker = new FakeDocker();
    provider = newProvider(docker);
    // The provider only ever runs `ansible --version` itself; everything else a
    // student runs happens inside the sandbox over SSH.
    docker.script({ match: /^ansible --version$/, result: { exitCode: 0, stdout: 'ansible [core 2.18.1]\n' } });
  });

  // ------------------------------------------------------------------ create

  it('creates one network and three containers for a session', async () => {
    const result = await provider.create(contextFor(SESSION_A, ansible001));

    expect(result.ok).toBe(true);
    expect(result.environment.phase).toBe('ready');
    expect(docker.containerNames()).toEqual([
      'lab-aaaaaaaaaaaa-control',
      'lab-aaaaaaaaaaaa-node1',
      'lab-aaaaaaaaaaaa-node2',
    ]);
    expect([...docker.networks.keys()]).toEqual(['lab-aaaaaaaaaaaa-net']);
  });

  it('reports each provisioning step so a student sees real progress', async () => {
    const result = await provider.create(contextFor(SESSION_A, ansible001));

    expect(result.steps.map((step) => step.id)).toEqual([
      'container-engine',
      'environment-created',
      'ssh-ready',
      'lab-initial-state',
      'ansible',
    ]);
    expect(result.steps.every((step) => step.status === 'ok')).toBe(true);
  });

  it('labels every object with the owning session so cleanup can be safe', async () => {
    await provider.create(contextFor(SESSION_A, ansible001));

    for (const name of docker.containerNames()) {
      expect(docker.container(name)?.labels[MANAGED_LABEL]).toBe('true');
      expect(docker.container(name)?.labels[SESSION_LABEL]).toBe(SESSION_A.sessionId);
    }
    expect(docker.networks.get('lab-aaaaaaaaaaaa-net')?.labels[SESSION_LABEL]).toBe(
      SESSION_A.sessionId,
    );
  });

  it('applies CPU, memory and PID ceilings, drops privileges, and publishes only loopback SSH', async () => {
    await provider.create(contextFor(SESSION_A, ansible001));

    const control = docker.container('lab-aaaaaaaaaaaa-control')!;
    const node = docker.container('lab-aaaaaaaaaaaa-node1')!;

    expect(control.cpus).toBeGreaterThan(0);
    expect(control.memory).toMatch(/^\d+m$/);
    expect(control.pidsLimit).toBeGreaterThan(0);
    expect(control.capAdd).not.toContain('SYS_ADMIN');
    expect(control.capAdd).not.toContain('NET_RAW');

    // Only the control node is reachable from the host, and only on loopback.
    expect(control.publish).toEqual(['127.0.0.1::22']);
    expect(node.publish).toEqual([]);
  });

  it('seeds the lab workspace onto the control node', async () => {
    await provider.create(contextFor(SESSION_A, ansible008));

    expect(docker.readFile('lab-aaaaaaaaaaaa-control', '/home/student/lab/site.yml')).toContain(
      'hosts: web',
    );
    expect(
      docker.readFile('lab-aaaaaaaaaaaa-control', '/home/student/lab/templates/app.conf.j2'),
    ).toContain('{{ app_port }}');
  });

  it('never passes the private key through the container environment', async () => {
    await provider.create(contextFor(SESSION_A, ansible001));
    const control = docker.container('lab-aaaaaaaaaaaa-control')!;

    // The public half is an env var; the private half arrives on stdin, so it
    // is not visible in `docker inspect`.
    expect(control.env.JTT_AUTHORIZED_KEY).toMatch(/^ssh-rsa /);
    expect(Object.values(control.env).join('\n')).not.toContain('PRIVATE KEY');
    expect(docker.readFile('lab-aaaaaaaaaaaa-control', '/home/student/.ssh/id_lab')).toMatch(
      /BEGIN RSA PRIVATE KEY/,
    );
  });

  it('authorises the session key on every node and nowhere else', async () => {
    await provider.create(contextFor(SESSION_A, ansible001));
    await provider.create(contextFor(SESSION_B, ansible001));

    const keyA = docker.container('lab-aaaaaaaaaaaa-node1')!.env.JTT_AUTHORIZED_KEY;
    const keyB = docker.container('lab-bbbbbbbbbbbb-node1')!.env.JTT_AUTHORIZED_KEY;

    expect(keyA).toBeTruthy();
    expect(keyA).not.toBe(keyB);
    expect(docker.container('lab-aaaaaaaaaaaa-node2')!.env.JTT_AUTHORIZED_KEY).toBe(keyA);
  });

  it('initialises an existing sandbox rather than failing', async () => {
    const context = contextFor(SESSION_A, ansible008);
    await provider.create(context);
    docker.writeFile('lab-aaaaaaaaaaaa-control', '/home/student/lab/scratch.txt', 'student work');

    const second = await provider.create(context);

    expect(second.ok).toBe(true);
    expect(docker.readFile('lab-aaaaaaaaaaaa-control', '/home/student/lab/scratch.txt')).toBeUndefined();
  });

  it('fails cleanly when the sandbox image is missing', async () => {
    const noImage = newProvider(new FakeDocker({ images: [] }));
    const result = await noImage.create(contextFor(SESSION_A, ansible001));

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/sandbox image/);
    expect(result.error?.remediation).toMatch(/ansible-image-build/);
  });

  it('reports an unreachable container engine as an environment problem', async () => {
    docker.goDown();
    const result = await provider.create(contextFor(SESSION_A, ansible001));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
  });

  it('leaves nothing behind when provisioning fails part-way', async () => {
    docker.script({
      match: /^\/usr\/local\/bin\/jtt-install-key$/,
      result: { exitCode: 1, stderr: 'disk full' },
    });
    const result = await provider.create(contextFor(SESSION_A, ansible001));

    expect(result.ok).toBe(false);
    // The SSH step failed, so the sandbox is reported degraded — and End Lab
    // (or the reaper) still finds a fully labelled sandbox to remove.
    const destroyed = await provider.destroyNamespace(SESSION_A.sandbox, SESSION_A.sessionId);
    expect(destroyed.namespaceGone).toBe(true);
    expect(docker.containerNames()).toEqual([]);
  });

  // ------------------------------------------------------------------ status

  it('reports a healthy sandbox as ready and a stopped one as degraded', async () => {
    const context = contextFor(SESSION_A, ansible001);
    await provider.create(context);
    expect((await provider.status(context)).phase).toBe('ready');

    await docker.removeContainer('lab-aaaaaaaaaaaa-node2');
    const degraded = await provider.status(context);
    expect(degraded.phase).toBe('degraded');
    expect(degraded.message).toContain('node2');
  });

  it('reports a sandbox that was never created as not_created', async () => {
    expect((await provider.status(contextFor(SESSION_A, ansible001))).phase).toBe('not_created');
  });

  // ------------------------------------------------------------------- reset

  it('restores the baseline project and rebuilds the managed nodes', async () => {
    const context = contextFor(SESSION_A, ansible008);
    await provider.create(context);

    docker.writeFile('lab-aaaaaaaaaaaa-control', '/home/student/lab/site.yml', 'student edit');
    docker.writeFile('lab-aaaaaaaaaaaa-control', '/home/student/lab/notes.txt', 'scratch');
    docker.writeFile('lab-aaaaaaaaaaaa-node1', '/etc/jumptotech/app.conf', 'stale');

    const result = await provider.reset(context);

    expect(result.ok).toBe(true);
    expect(docker.readFile('lab-aaaaaaaaaaaa-control', '/home/student/lab/site.yml')).toContain(
      'hosts: web',
    );
    expect(docker.readFile('lab-aaaaaaaaaaaa-control', '/home/student/lab/notes.txt')).toBeUndefined();
    expect(docker.readFile('lab-aaaaaaaaaaaa-node1', '/etc/jumptotech/app.conf')).toBeUndefined();
  });

  it('keeps the control node alive across a reset so the terminal survives', async () => {
    const context = contextFor(SESSION_A, ansible008);
    await provider.create(context);
    const controlId = docker.container('lab-aaaaaaaaaaaa-control')!.id;

    await provider.reset(context);

    expect(docker.container('lab-aaaaaaaaaaaa-control')!.id).toBe(controlId);
    expect(docker.container('lab-aaaaaaaaaaaa-node1')!.id).not.toBe(controlId);
  });

  it('refuses to reset a sandbox it has no key for', async () => {
    const result = await provider.reset(contextFor(SESSION_A, ansible001));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RESET_FAILED');
  });

  // ----------------------------------------------------------------- destroy

  it('removes every container and the network, and confirms they are gone', async () => {
    const context = contextFor(SESSION_A, ansible001);
    await provider.create(context);

    const result = await provider.destroy(context);

    expect(result.ok).toBe(true);
    expect(result.namespaceGone).toBe(true);
    expect(docker.containerNames()).toEqual([]);
    expect(docker.networks.size).toBe(0);
  });

  it('treats an already-destroyed sandbox as destroyed', async () => {
    const context = contextFor(SESSION_A, ansible001);
    await provider.create(context);

    const first = await provider.destroy(context);
    const second = await provider.destroy(context);
    const third = await provider.destroyNamespace(SESSION_A.sandbox);

    expect([first, second, third].every((r) => r.namespaceGone)).toBe(true);
  });

  it('refuses to destroy a sandbox belonging to another session', async () => {
    await provider.create(contextFor(SESSION_A, ansible001));

    const result = await provider.destroyNamespace(SESSION_A.sandbox, SESSION_B.sessionId);

    expect(result.namespaceGone).toBe(false);
    expect(result.error?.message).toMatch(/Refusing to delete/);
    expect(docker.containerNames()).toHaveLength(3);
  });

  it('refuses to destroy anything that is not a sandbox name', async () => {
    for (const name of ['bridge', 'kind', 'default', 'kube-system', 'postgres']) {
      const result = await provider.destroyNamespace(name);
      expect(result.namespaceGone).toBe(false);
      expect(result.error?.message).toMatch(/Refusing to delete/);
    }
  });

  it('refuses to destroy a sandbox-shaped object it does not own', async () => {
    // Someone else's container, correctly named but unlabelled.
    await docker.createNetwork('lab-cccccccccccc-net', {});
    const result = await provider.destroyNamespace('lab-cccccccccccc');

    expect(result.namespaceGone).toBe(false);
    expect(docker.networks.has('lab-cccccccccccc-net')).toBe(true);
  });

  // ------------------------------------------------------------- credentials

  it('issues SSH credentials scoped to one sandbox', async () => {
    const context = contextFor(SESSION_A, ansible001);
    await provider.create(context);

    const credentials = await provider.issueCredentials(context);

    expect(credentials.shell).toBe('ssh');
    expect(credentials.kubeconfig).toBe('');
    expect(credentials.ssh?.host).toBe('127.0.0.1');
    expect(credentials.ssh?.user).toBe('student');
    expect(credentials.ssh?.privateKey).toMatch(/BEGIN RSA PRIVATE KEY/);
    expect(credentials.namespace).toBe(SESSION_A.sandbox);
  });

  it('issues different credentials to different sessions', async () => {
    await provider.create(contextFor(SESSION_A, ansible001));
    await provider.create(contextFor(SESSION_B, ansible001));

    const a = await provider.issueCredentials(contextFor(SESSION_A, ansible001));
    const b = await provider.issueCredentials(contextFor(SESSION_B, ansible001));

    expect(a.ssh?.privateKey).not.toBe(b.ssh?.privateKey);
    expect(a.ssh?.port).not.toBe(b.ssh?.port);
  });

  it('stops issuing credentials once the sandbox is destroyed', async () => {
    const context = contextFor(SESSION_A, ansible001);
    await provider.create(context);
    await provider.destroy(context);

    await expect(provider.issueCredentials(context)).rejects.toThrow(/no session key/);
  });

  // ----------------------------------------------------------------- cleanup

  it('lists every sandbox it owns, and nothing else', async () => {
    await provider.create(contextFor(SESSION_A, ansible001));
    await provider.create(contextFor(SESSION_B, ansible001));
    await docker.createNetwork('unrelated-app-net', {});

    const managed = await provider.listManagedNamespaces();

    expect(managed.map((entry) => entry.namespace).sort()).toEqual([
      SESSION_A.sandbox,
      SESSION_B.sandbox,
    ]);
    expect(managed.every((entry) => entry.expiresAtMs > 0)).toBe(true);
  });

  // --------------------------------------------------------------- isolation

  it('keeps two concurrent sessions completely separate', async () => {
    const a = contextFor(SESSION_A, ansible008);
    const b = contextFor(SESSION_B, ansible008);
    await provider.create(a);
    await provider.create(b);

    docker.writeFile('lab-bbbbbbbbbbbb-node1', '/etc/jumptotech/app.conf', 'B state');

    // Reset A: B is untouched.
    await provider.reset(a);
    expect(docker.readFile('lab-bbbbbbbbbbbb-node1', '/etc/jumptotech/app.conf')).toBe('B state');

    // End A: B is still fully provisioned.
    await provider.destroy(a);
    expect(docker.containerNames()).toEqual([
      'lab-bbbbbbbbbbbb-control',
      'lab-bbbbbbbbbbbb-node1',
      'lab-bbbbbbbbbbbb-node2',
    ]);
    expect((await provider.status(b)).phase).toBe('ready');
  });

  it('gives five concurrent sessions five disjoint sandboxes', async () => {
    const sessions = ['a', 'b', 'c', 'd', 'e'].map((letter) => ({
      sessionId: `sess-00000000000000${letter}`,
      sandbox: `lab-${letter.repeat(12)}`,
    }));

    for (const session of sessions) {
      const result = await provider.create(contextFor(session, ansible001));
      expect(result.ok).toBe(true);
    }

    expect(docker.containerNames()).toHaveLength(15);
    expect(docker.networks.size).toBe(5);

    for (const session of sessions) {
      const topology = topologyFor(session.sandbox);
      for (const node of topology.nodes) {
        expect(docker.container(node.container)?.network).toBe(topology.network);
        expect(docker.container(node.container)?.labels[SESSION_LABEL]).toBe(session.sessionId);
      }
    }
  });

  // ----------------------------------------------------------------- execute

  it('runs only allow-listed binaries, with no shell', async () => {
    const context = contextFor(SESSION_A, ansible001);
    await provider.create(context);

    await expect(
      provider.execute(context, { command: 'bash', args: ['-c', 'echo hi'] }),
    ).rejects.toThrow(/not allow-listed/);
    await expect(provider.execute(context, { command: 'rm', args: ['-rf', '/'] })).rejects.toThrow(
      /not allow-listed/,
    );

    docker.script({ match: /^ansible-inventory --list$/, result: { exitCode: 0, stdout: '{}' } });
    const result = await provider.execute(context, { command: 'ansible-inventory', args: ['--list'] });
    expect(result.exitCode).toBe(0);
  });
});
