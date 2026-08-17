/**
 * Ansible sandbox primitives: topology derivation, path admission, session
 * keys, and workspace loading.
 *
 * Everything here is pure or fake-backed. The properties that belong to Docker
 * and to Ansible themselves — that two bridge networks really are unreachable
 * from one another, that a playbook really converges — are asserted against
 * real containers in `ansible-integration.test.ts`, because a fake that
 * returned "unreachable" would prove nothing.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createPublicKey, createSign, createVerify } from 'node:crypto';
import {
  ALLOWED_MANAGED_ROOTS,
  ANSIBLE_WORKSPACE_DIR,
  DockerAnsibleSandbox,
  DockerCli,
  ForbiddenSandboxPathError,
  InvalidSandboxIdError,
  MAX_WORKSPACE_FILES,
  assertValidSandboxId,
  generateSessionKeyPair,
  isSandboxObjectName,
  loadLabWorkspace,
  loadLabDefinition,
  managedNodeNames,
  nodeByName,
  resolveManagedPath,
  resolveWorkspacePath,
  toOpenSshPublicKey,
  topologyFor,
  workspaceDirectories,
} from '../src/index.js';
import { FakeDocker } from './fake-docker.js';
import { LABS_DIR } from './helpers.js';

const SANDBOX_A = 'lab-aaaaaaaaaaaa';
const SANDBOX_B = 'lab-bbbbbbbbbbbb';

describe('sandbox topology', () => {
  it('derives every name from the sandbox id', () => {
    const topology = topologyFor(SANDBOX_A);

    expect(topology.network).toBe('lab-aaaaaaaaaaaa-net');
    expect(topology.control.container).toBe('lab-aaaaaaaaaaaa-control');
    expect(topology.managed.map((node) => node.container)).toEqual([
      'lab-aaaaaaaaaaaa-node1',
      'lab-aaaaaaaaaaaa-node2',
    ]);
  });

  it('gives two sessions disjoint names', () => {
    const a = topologyFor(SANDBOX_A);
    const b = topologyFor(SANDBOX_B);

    const namesOf = (t: typeof a) => [t.network, ...t.nodes.map((node) => node.container)];
    expect(namesOf(a).some((name) => namesOf(b).includes(name))).toBe(false);
  });

  it('keeps student-visible node names identical across sessions', () => {
    // This is the point of per-session networks: `node1` means "my node1" in
    // every sandbox, so a lab can name it without leaking across sessions.
    expect(topologyFor(SANDBOX_A).managed.map((n) => n.name)).toEqual(['node1', 'node2']);
    expect(topologyFor(SANDBOX_B).managed.map((n) => n.name)).toEqual(['node1', 'node2']);
  });

  it('rejects a sandbox id that is not a lab sandbox name', () => {
    for (const bad of ['default', 'kube-system', '', 'lab', 'LAB-AAAA', '../lab-a', 'lab-aaaa/../x']) {
      expect(() => assertValidSandboxId(bad)).toThrow(InvalidSandboxIdError);
    }
  });

  it('recognises only its own object names', () => {
    expect(isSandboxObjectName('lab-aaaaaaaaaaaa-net')).toBe(true);
    expect(isSandboxObjectName('lab-aaaaaaaaaaaa-control')).toBe(true);
    expect(isSandboxObjectName('lab-aaaaaaaaaaaa-node2')).toBe(true);
    expect(isSandboxObjectName('bridge')).toBe(false);
    expect(isSandboxObjectName('kind')).toBe(false);
    expect(isSandboxObjectName('lab-aaaaaaaaaaaa-postgres')).toBe(false);
  });

  it('resolves nodes by their student-visible name', () => {
    const topology = topologyFor(SANDBOX_A);
    expect(nodeByName(topology, 'node1')?.container).toBe('lab-aaaaaaaaaaaa-node1');
    expect(nodeByName(topology, 'node9')).toBeNull();
  });

  it('refuses an unreasonable node count', () => {
    expect(() => managedNodeNames(0)).toThrow();
    expect(() => managedNodeNames(5)).toThrow();
    expect(managedNodeNames(3)).toEqual(['node1', 'node2', 'node3']);
  });
});

describe('path admission', () => {
  it('resolves a project path inside the workspace', () => {
    expect(resolveWorkspacePath(ANSIBLE_WORKSPACE_DIR, 'site.yml')).toBe(
      `${ANSIBLE_WORKSPACE_DIR}/site.yml`,
    );
    expect(resolveWorkspacePath(ANSIBLE_WORKSPACE_DIR, 'roles/web/tasks/main.yml')).toBe(
      `${ANSIBLE_WORKSPACE_DIR}/roles/web/tasks/main.yml`,
    );
  });

  it('refuses to leave the workspace', () => {
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/../../b', '..', 'a\\b', 'a\0b']) {
      expect(() => resolveWorkspacePath(ANSIBLE_WORKSPACE_DIR, bad)).toThrow(ForbiddenSandboxPathError);
    }
  });

  it('admits managed-node paths only under the allowed roots', () => {
    for (const root of ALLOWED_MANAGED_ROOTS) {
      expect(resolveManagedPath(root)).toBe(root);
      expect(resolveManagedPath(`${root}/app.conf`)).toBe(`${root}/app.conf`);
    }
  });

  it('refuses managed-node paths outside the allowed roots', () => {
    for (const bad of [
      '/etc/shadow',
      '/root/.ssh/id_lab',
      '/etc/jumptotech/../../etc/shadow',
      '/home/student/.ssh/id_lab',
      '/',
      'etc/jumptotech/app.conf',
    ]) {
      expect(() => resolveManagedPath(bad)).toThrow(ForbiddenSandboxPathError);
    }
  });
});

describe('session keys', () => {
  it('mints a usable keypair whose halves match', async () => {
    const keys = await generateSessionKeyPair(SANDBOX_A);

    expect(keys.privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    expect(keys.publicKey).toMatch(/^ssh-rsa [A-Za-z0-9+/=]+ jumptotech-lab-aaaaaaaaaaaa$/);

    // Sign with the private half, verify with the public half: proof the two
    // are actually a pair rather than two unrelated blobs.
    const signature = createSign('sha256').update('jumptotech').sign(keys.privateKey);
    const derived = createPublicKey(keys.privateKey).export({ type: 'spki', format: 'pem' }) as string;
    expect(createVerify('sha256').update('jumptotech').verify(derived, signature)).toBe(true);
  });

  it('mints a different key for every session', async () => {
    const [a, b] = await Promise.all([
      generateSessionKeyPair(SANDBOX_A),
      generateSessionKeyPair(SANDBOX_B),
    ]);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('encodes the public key in the OpenSSH wire format', async () => {
    const keys = await generateSessionKeyPair(SANDBOX_A);
    const [algorithm = '', blob = ''] = keys.publicKey.split(' ');
    const decoded = Buffer.from(blob, 'base64');

    expect(algorithm).toBe('ssh-rsa');
    // The blob begins with a length-prefixed algorithm name.
    expect(decoded.readUInt32BE(0)).toBe('ssh-rsa'.length);
    expect(decoded.subarray(4, 4 + 7).toString()).toBe('ssh-rsa');
  });

  it('refuses to encode a non-RSA key as ssh-rsa', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(() => toOpenSshPublicKey(publicKey, 'x')).toThrow(/only RSA/);
  });
});

describe('lab workspace loading', () => {
  it('reads a lab workspace tree in parent-before-child order', async () => {
    const lab = await loadLabDefinition(
      path.join(LABS_DIR, 'ansible', 'ansible-008-roles', 'lab.yaml'),
    );
    const files = await loadLabWorkspace(lab);
    const names = files.map((file) => file.relativePath);

    expect(names).toContain('ansible.cfg');
    expect(names).toContain('site.yml');
    expect(names).toContain('templates/app.conf.j2');
    expect(files.length).toBeLessThanOrEqual(MAX_WORKSPACE_FILES);
    expect(files.every((file) => file.mode === '0644')).toBe(true);
  });

  it('returns nothing for a lab that declares no workspace', async () => {
    const lab = await loadLabDefinition(
      path.join(LABS_DIR, 'kubernetes', 'k8s-001-pods', 'lab.yaml'),
    );
    expect(await loadLabWorkspace(lab)).toEqual([]);
  });

  it('derives the directories that must be created first', () => {
    const directories = workspaceDirectories([
      { relativePath: 'roles/web/tasks/main.yml', content: '', mode: '0644' },
      { relativePath: 'ansible.cfg', content: '', mode: '0644' },
      { relativePath: 'roles/web/handlers/main.yml', content: '', mode: '0644' },
    ]);

    expect(directories).toEqual(['roles', 'roles/web', 'roles/web/handlers', 'roles/web/tasks']);
  });
});

describe('the docker CLI adapter', () => {
  /**
   * Run the adapter against `/bin/echo` so the argv it *builds* is observable
   * without a Docker daemon. This is the layer where a wrong separator or a
   * misplaced flag silently breaks every sandbox, and it is not something the
   * in-memory fake can catch — the fake never sees a command line.
   */
  const echo = new DockerCli({ binary: '/bin/echo' });

  it('puts docker options before the container and the command after it', async () => {
    const result = await echo.exec({
      container: 'lab-aaaaaaaaaaaa-control',
      argv: ['ansible-playbook', 'site.yml'],
      user: 'student',
      workdir: '/home/student/lab',
      env: { HOME: '/home/student' },
    });

    expect(result.stdout.trim()).toBe(
      'exec --user student --workdir /home/student/lab --env HOME=/home/student ' +
        'lab-aaaaaaaaaaaa-control ansible-playbook site.yml',
    );
  });

  it('never emits a `--` separator — docker would run it as the command', async () => {
    const result = await echo.exec({
      container: 'lab-aaaaaaaaaaaa-control',
      argv: ['pgrep', '-x', 'sshd'],
      user: 'root',
    });

    expect(result.stdout).not.toContain(' -- ');
    expect(result.stdout.trim()).toBe('exec --user root lab-aaaaaaaaaaaa-control pgrep -x sshd');
  });

  it('asks for an interactive exec only when there is something to write', async () => {
    const withInput = await echo.exec({
      container: 'lab-aaaaaaaaaaaa-control',
      argv: ['tee', '/home/student/lab/site.yml'],
      input: 'hello',
    });
    expect(withInput.stdout).toContain('exec --interactive');

    const withoutInput = await echo.exec({
      container: 'lab-aaaaaaaaaaaa-control',
      argv: ['ls', '-1A', '/home/student/lab'],
    });
    expect(withoutInput.stdout).not.toContain('--interactive');
  });

  it('refuses an argv that is not an array of strings', async () => {
    await expect(echo.exec({ container: 'c', argv: [] })).rejects.toThrow(/non-empty argv/);
    await expect(
      echo.exec({ container: 'c', argv: ['ls', 7 as unknown as string] }),
    ).rejects.toThrow(/only strings/);
  });

  /**
   * A child that exits without draining stdin must not take the process down.
   *
   * This is a real failure mode, not a contrived one: `docker exec` exits
   * immediately when the container is already gone, which happens whenever a
   * session is torn down while a workspace write is in flight — the reaper
   * collecting an expired session, or a student pressing End Lab mid-reset.
   * The write then fails with EPIPE on the stdin stream, and an EPIPE with no
   * listener is an *uncaught exception*: one student's teardown race would
   * crash the orchestrator for everyone.
   *
   * `/bin/echo` stands in for that container: it exits without ever reading
   * stdin. The payload is comfortably larger than a pipe buffer so the write
   * cannot simply be absorbed and the error is raised every run rather than
   * only under load.
   */
  it('survives a child that exits without reading the input written to it', async () => {
    const uncaught: unknown[] = [];
    const capture = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', capture);

    try {
      const result = await echo.exec({
        container: 'lab-aaaaaaaaaaaa-control',
        argv: ['tee', '/home/student/lab/site.yml'],
        input: 'x'.repeat(1_000_000),
      });

      // The call still reports the child's own outcome…
      expect(result.stdout).toContain('exec --interactive');
      expect(result.timedOut).toBe(false);

      // …and the broken pipe never reached the process as an uncaught error.
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', capture);
    }
  });
});

describe('sandbox reads', () => {
  async function sandboxWith(files: Record<string, string>) {
    const docker = new FakeDocker();
    const sandbox = new DockerAnsibleSandbox({ docker });
    const topology = topologyFor(SANDBOX_A);

    await docker.createNetwork(topology.network, {});
    for (const node of topology.nodes) {
      await docker.runContainer({
        name: node.container,
        image: 'jumptotech/ansible-lab:local',
        network: topology.network,
        aliases: [node.name],
        hostname: node.name,
        labels: {},
        env: {},
        cpus: 1,
        memory: '256m',
        pidsLimit: 128,
      });
    }
    for (const [where, content] of Object.entries(files)) {
      const [container = '', file = ''] = where.split('::');
      docker.writeFile(container, file, content);
    }
    return { docker, sandbox, topology };
  }

  it('reads a project file from the control node', async () => {
    const { sandbox } = await sandboxWith({
      [`${SANDBOX_A}-control::${ANSIBLE_WORKSPACE_DIR}/site.yml`]: '---\n- hosts: web\n',
    });

    expect(await sandbox.readWorkspaceFile(SANDBOX_A, 'site.yml')).toBe('---\n- hosts: web\n');
    expect(await sandbox.readWorkspaceFile(SANDBOX_A, 'missing.yml')).toBeNull();
  });

  it('reads managed-node state from the node itself', async () => {
    const { sandbox } = await sandboxWith({
      [`${SANDBOX_A}-node2::/etc/jumptotech/app.conf`]: 'app_port=9090\n',
    });

    expect(await sandbox.readManagedFile(SANDBOX_A, 'node2', '/etc/jumptotech/app.conf')).toBe(
      'app_port=9090\n',
    );
    expect(await sandbox.readManagedFile(SANDBOX_A, 'node1', '/etc/jumptotech/app.conf')).toBeNull();
  });

  it('refuses to read a managed-node path outside the allowed roots', async () => {
    const { sandbox } = await sandboxWith({});
    await expect(sandbox.readManagedFile(SANDBOX_A, 'node1', '/etc/shadow')).rejects.toThrow(
      ForbiddenSandboxPathError,
    );
  });

  it('refuses to address the control node as a managed node', async () => {
    const { sandbox } = await sandboxWith({});
    await expect(
      sandbox.readManagedFile(SANDBOX_A, 'control', '/etc/jumptotech/app.conf'),
    ).rejects.toThrow(ForbiddenSandboxPathError);
  });

  it('reports whether a process is running on a node', async () => {
    const { docker, sandbox } = await sandboxWith({});

    expect(await sandbox.processRunning(SANDBOX_A, 'node1', 'nginx')).toBe(false);
    docker.startProcess(`${SANDBOX_A}-node1`, 'nginx');
    expect(await sandbox.processRunning(SANDBOX_A, 'node1', 'nginx')).toBe(true);
  });

  it('runs only the platform-authored argv for a command variant', async () => {
    const { docker, sandbox } = await sandboxWith({});
    docker.script({ match: /^ansible-inventory --list$/, result: { exitCode: 0, stdout: '{}' } });

    await sandbox.run(SANDBOX_A, { kind: 'inventory' });
    const last = docker.execLog.at(-1);

    expect(last?.argv).toEqual(['ansible-inventory', '--list']);
    expect(last?.container).toBe(`${SANDBOX_A}-control`);
  });

  it('refuses an inventory pattern that is not one', async () => {
    const { sandbox } = await sandboxWith({});
    await expect(
      sandbox.run(SANDBOX_A, { kind: 'ping', pattern: 'all; rm -rf /' }),
    ).rejects.toThrow(ForbiddenSandboxPathError);
  });

  it('reports a sandbox whose control node is gone as unreachable', async () => {
    const { docker, sandbox } = await sandboxWith({});
    await docker.removeContainer(`${SANDBOX_A}-control`);
    await expect(sandbox.ping(SANDBOX_A)).rejects.toThrow(/not running/);
  });
});
