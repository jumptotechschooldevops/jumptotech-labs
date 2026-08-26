/**
 * The Ansible topology against a real Docker daemon.
 *
 * `ansible-isolation.test.ts` asserts what the platform *asks for*. This asserts
 * what the kernel actually gives, which is the only way to know that the
 * capability set is both sufficient and minimal:
 *
 *   · sufficient — sshd starts, a real `ansible -m ping` succeeds, and a
 *     playbook that templates files and starts a daemon runs twice with no
 *     change the second time. Every lab in the track rests on those three.
 *   · minimal — the bounding set read back from `/proc` is exactly the seven
 *     capabilities the review approved, the control node's is empty, and
 *     nothing on the segment can reach the host, the internet, or another
 *     session.
 *
 * The capability question is not theoretical. Dropping `SYS_CHROOT` leaves sshd
 * listening and closing every connection with
 * `chroot("/var/empty"): Operation not permitted [preauth]`, which is why the
 * negative control below asserts a *failed* login rather than trusting the
 * comment that says one is needed.
 *
 * Tier: E2E. Gated on RUN_INTEGRATION_TESTS=1 and a built sandbox image.
 *
 * What it mutates on the shared daemon, and nothing else: containers and
 * networks named from this run's id, all removed in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ANSIBLE_MANAGED_NODE_CAPABILITIES,
  ANSIBLE_SSH_PORT,
  DockerAnsibleSandbox,
  DockerCliRuntime,
  DockerRuntimeExecPort,
} from '../src/index.js';
import { testRunId } from '@jumptotech/test-support/run-id';

const run = promisify(execFile);
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';
const IMAGE = process.env.ANSIBLE_SANDBOX_IMAGE ?? 'jumptotech/lab-ansible:latest';

const RUN_HEX = createHash('sha256').update(testRunId()).digest('hex').slice(0, 10);
/** Two independent sessions, so cross-session reachability is testable. */
const A = { net: `jtt-net-${RUN_HEX}a1`, control: `jtt-lab-${RUN_HEX}a1` };
const B = { net: `jtt-net-${RUN_HEX}b2`, control: `jtt-lab-${RUN_HEX}b2` };
const nodeA = (i: number) => `jtt-node${i}-${RUN_HEX}a1`;
const nodeB = (i: number) => `jtt-node${i}-${RUN_HEX}b2`;

async function docker(args: string[], timeoutMs = 120_000) {
  return run('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}
async function dockerOrNull(args: string[]) {
  try {
    return await docker(args);
  } catch {
    return null;
  }
}
/** Run inside a container, returning stdout+stderr and the exit status. */
async function exec(
  container: string,
  argv: string[],
  opts: { user?: string; workdir?: string } = {},
): Promise<{ ok: boolean; out: string }> {
  const flags = ['exec'];
  if (opts.user) flags.push('--user', opts.user);
  if (opts.workdir) flags.push('--workdir', opts.workdir);
  try {
    const { stdout, stderr } = await docker([...flags, container, ...argv]);
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let publicKey = '';
let privateKey = '';

/** Build one session's topology exactly as `AnsibleLabProvider` does. */
async function buildSession(
  session: { net: string; control: string },
  node: (i: number) => string,
  capabilities: readonly string[] = ANSIBLE_MANAGED_NODE_CAPABILITIES,
) {
  await docker(['network', 'create', '--internal', '--driver', 'bridge', session.net]);
  for (const i of [1, 2]) {
    await docker([
      'run', '--detach',
      '--name', node(i),
      '--network', session.net,
      '--network-alias', `node${i}`,
      '--hostname', `node${i}`,
      '--cap-drop', 'ALL',
      ...capabilities.flatMap((c) => ['--cap-add', c]),
      '--security-opt', 'no-new-privileges:true',
      '--env', 'JTT_ROLE=node',
      '--env', `JTT_SSH_PORT=${ANSIBLE_SSH_PORT}`,
      '--env', `JTT_AUTHORIZED_KEY=${publicKey}`,
      IMAGE, '/usr/local/bin/jtt-entrypoint',
    ]);
  }
  await docker([
    'run', '--detach',
    '--name', session.control,
    '--network', session.net,
    '--hostname', 'control',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--user', 'student',
    '--workdir', '/home/student/lab',
    IMAGE, 'sleep', 'infinity',
  ]);
}

async function teardown() {
  for (const name of [A.control, B.control, nodeA(1), nodeA(2), nodeB(1), nodeB(2)]) {
    await dockerOrNull(['rm', '--force', '--volumes', name]);
  }
  for (const net of [A.net, B.net]) await dockerOrNull(['network', 'rm', net]);
}

describe.skipIf(!ENABLED)('the Ansible topology, against a real daemon', () => {
  beforeAll(async () => {
    const check = await dockerOrNull(['image', 'inspect', IMAGE]);
    if (!check) {
      throw new Error(`${IMAGE} is not built — run: npm run sandbox:build`);
    }
    await teardown();

    // One keypair for the whole run, generated the way the provider does:
    // the public half travels in env, the private half never does.
    const { stdout } = await docker([
      'run', '--rm', '--entrypoint', 'sh', IMAGE,
      '-c', 'ssh-keygen -q -t ed25519 -N "" -f /tmp/k >/dev/null && cat /tmp/k && echo "---SPLIT---" && cat /tmp/k.pub',
    ]);
    const [priv, pub] = stdout.split('---SPLIT---');
    publicKey = (pub ?? '').trim();
    privateKey = (priv ?? '').trim();
    expect(publicKey).toMatch(/^ssh-ed25519 /);

    await buildSession(A, nodeA);
    await buildSession(B, nodeB);
    // Install the private key on A's control node over an exec stream, never
    // as an environment variable — `docker inspect` would show that.
    await run('sh', [
      '-c',
      `printf '%s\\n' "$KEY" | docker exec -i --user student ${A.control} sh -c 'umask 077; mkdir -p ~/.ssh; cat > ~/.ssh/id_ed25519'`,
    ], { env: { ...process.env, KEY: privateKey }, timeout: 60_000 });

    const project = [
      '[web]\nnode1\nnode2\n\n[web:vars]\nansible_port=2222\nansible_user=root\n',
      '[defaults]\ninventory = inventory.ini\nremote_user = root\nhost_key_checking = False\nretry_files_enabled = False\ninterpreter_python = /usr/bin/python3\n',
    ];
    await run('sh', ['-c',
      `printf '%s' "$INV" | docker exec -i --user student ${A.control} sh -c 'cat > /home/student/lab/inventory.ini'`,
    ], { env: { ...process.env, INV: project[0] }, timeout: 60_000 });
    await run('sh', ['-c',
      `printf '%s' "$CFG" | docker exec -i --user student ${A.control} sh -c 'cat > /home/student/lab/ansible.cfg'`,
    ], { env: { ...process.env, CFG: project[1] }, timeout: 60_000 });
  }, 300_000);

  afterAll(teardown, 180_000);

  // --- the capability set is minimal ---------------------------------------

  it('gives the control node — where the student is — no capabilities at all', async () => {
    const caps = await exec(A.control, ['grep', 'CapBnd', '/proc/1/status']);
    expect(caps.ok).toBe(true);
    expect(caps.out).toMatch(/CapBnd:\s+0{16}/);
  });

  it('gives a managed node exactly the seven reviewed capabilities', async () => {
    const caps = await exec(nodeA(1), ['grep', 'CapBnd', '/proc/1/status']);
    const hex = /CapBnd:\s+([0-9a-f]+)/.exec(caps.out)?.[1] ?? '';
    const bits = BigInt(`0x${hex}`);

    // CHOWN(0) DAC_OVERRIDE(1) FOWNER(3) FSETID(4) SETGID(6) SETUID(7) SYS_CHROOT(18)
    const expected = [0, 1, 3, 4, 6, 7, 18].reduce((acc, b) => acc | (1n << BigInt(b)), 0n);
    expect(bits).toBe(expected);

    // Named individually so a failure says which one leaked in.
    const forbidden = { NET_ADMIN: 12, NET_RAW: 13, SYS_ADMIN: 21, SYS_PTRACE: 19, MKNOD: 27 };
    for (const [name, bit] of Object.entries(forbidden)) {
      expect((bits >> BigInt(bit)) & 1n, name).toBe(0n);
    }
  });

  it('needs no NET_BIND_SERVICE, because sshd listens above 1024', async () => {
    const listening = await exec(nodeA(1), ['sh', '-c', 'netstat -ltn | grep 2222']);
    expect(listening.out).toContain('2222');
    expect(ANSIBLE_MANAGED_NODE_CAPABILITIES).not.toContain('NET_BIND_SERVICE');
  });

  // --- the capability set is sufficient ------------------------------------

  it('reaches every managed node with a real ansible ping', async () => {
    const ping = await exec(A.control, ['ansible', 'web', '-m', 'ping'], {
      user: 'student',
      workdir: '/home/student/lab',
    });
    expect(ping.out).toContain('node1 | SUCCESS');
    expect(ping.out).toContain('node2 | SUCCESS');
  }, 120_000);

  it('runs a real playbook, and a second run changes nothing', async () => {
    const playbook = [
      '- name: Configure the web tier',
      '  hosts: web',
      '  tasks:',
      '    - name: Status directory',
      '      ansible.builtin.file:',
      '        path: /var/www/status',
      '        state: directory',
      '        owner: root',
      "        mode: '0755'",
      '    - name: Status page',
      '      ansible.builtin.copy:',
      '        content: "node={{ inventory_hostname }}\\n"',
      '        dest: /var/www/status/index.html',
      "        mode: '0644'",
      '    - name: Is nginx running?',
      '      ansible.builtin.command: pgrep -x nginx',
      '      register: nginx_ps',
      '      changed_when: false',
      '      failed_when: false',
      '    - name: Start nginx',
      '      ansible.builtin.command: nginx',
      '      when: nginx_ps.rc != 0',
      '',
    ].join('\n');
    await run('sh', ['-c',
      `printf '%s' "$PB" | docker exec -i --user student ${A.control} sh -c 'cat > /home/student/lab/site.yml'`,
    ], { env: { ...process.env, PB: playbook }, timeout: 60_000 });

    const first = await exec(A.control, ['ansible-playbook', 'site.yml'], {
      user: 'student',
      workdir: '/home/student/lab',
    });
    expect(first.out).toContain('failed=0');

    const second = await exec(A.control, ['ansible-playbook', 'site.yml'], {
      user: 'student',
      workdir: '/home/student/lab',
    });
    // The property every handler and idempotency lab in the track rests on.
    expect(second.out).toMatch(/node1\s+: ok=\d+\s+changed=0/);
    expect(second.out).toMatch(/node2\s+: ok=\d+\s+changed=0/);
  }, 300_000);

  it('will not let a managed node start sshd without SYS_CHROOT', async () => {
    // The negative control for the one capability this track added. Without it
    // sshd listens and then refuses everyone, which is the failure mode the
    // review claimed — asserted rather than assumed.
    const name = `jtt-node9-${RUN_HEX}c3`;
    await dockerOrNull(['rm', '--force', name]);
    await docker([
      'run', '--detach', '--name', name,
      '--network', A.net, '--network-alias', 'node9',
      '--cap-drop', 'ALL',
      '--cap-add', 'SETUID', '--cap-add', 'SETGID',
      '--env', 'JTT_ROLE=node',
      '--env', `JTT_SSH_PORT=${ANSIBLE_SSH_PORT}`,
      '--env', `JTT_AUTHORIZED_KEY=${publicKey}`,
      IMAGE, '/usr/local/bin/jtt-entrypoint',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const reach = await exec(A.control, [
      'ssh', '-i', '/home/student/.ssh/id_ed25519', '-p', String(ANSIBLE_SSH_PORT),
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
      'root@node9', 'true',
    ], { user: 'student' });
    expect(reach.ok).toBe(false);

    const logs = await dockerOrNull(['logs', name]);
    expect(`${logs?.stdout ?? ''}${logs?.stderr ?? ''}`).toContain('chroot');
    await dockerOrNull(['rm', '--force', name]);
  }, 180_000);

  // --- the verification port reads the real topology ------------------------

  it('reads the student project and the managed nodes through the real port', async () => {
    const sandbox = new DockerAnsibleSandbox({
      docker: new DockerRuntimeExecPort(new DockerCliRuntime()),
    });

    // The control node is up, and the topology resolves to this session only.
    await expect(sandbox.ping(A.control)).resolves.toBeUndefined();
    expect(sandbox.managedNodes(A.control)).toEqual(['node1', 'node2']);

    // The student's project, read from the control node.
    const cfg = await sandbox.readWorkspaceFile(A.control, 'ansible.cfg');
    expect(cfg).toContain('inventory = inventory.ini');
    expect(await sandbox.readWorkspaceFile(A.control, 'nope.yml')).toBeNull();

    // Real state on a managed node, written by the playbook run above.
    const page = await sandbox.readManagedFile(A.control, 'node1', '/var/www/status/index.html');
    expect(page).toContain('node=node1');
    expect(await sandbox.processRunning(A.control, 'node1', 'nginx')).toBe(true);

    // A path outside the allowed roots is refused rather than read.
    await expect(
      sandbox.readManagedFile(A.control, 'node1', '/etc/shadow'),
    ).rejects.toThrow();
  }, 180_000);

  it('runs a real inventory command through the port', async () => {
    const sandbox = new DockerAnsibleSandbox({
      docker: new DockerRuntimeExecPort(new DockerCliRuntime()),
    });
    const result = await sandbox.run(A.control, { kind: 'inventory' });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toContain('web');
  }, 180_000);

  // --- isolation ------------------------------------------------------------

  it('cannot reach the host, the internet, or anything off its own segment', async () => {
    const route = await exec(A.control, ['sh', '-c', 'ip route | grep -c default || true']);
    expect(route.out.trim()).toBe('0');

    const egress = await exec(A.control, ['ping', '-c1', '-W2', '1.1.1.1']);
    expect(egress.ok).toBe(false);
  }, 120_000);

  it('cannot reach another session, even knowing its address', async () => {
    const { stdout } = await docker([
      'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', nodeB(1),
    ]);
    const other = stdout.trim();
    expect(other).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    const reach = await exec(A.control, [
      'sh', '-c', `nc -z -w2 ${other} ${ANSIBLE_SSH_PORT} && echo REACHED || echo blocked`,
    ]);
    expect(reach.out).toContain('blocked');
  }, 120_000);

  it('resolves node1 to its own session, never the other one', async () => {
    const mine = await exec(A.control, ['getent', 'hosts', 'node1']);
    const theirs = await docker([
      'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', nodeB(1),
    ]);
    expect(mine.out).not.toContain(theirs.stdout.trim());
  });

  it('exposes no Docker socket and publishes no host port', async () => {
    const socket = await exec(A.control, ['sh', '-c', 'test -S /var/run/docker.sock && echo yes || echo no']);
    expect(socket.out).toContain('no');

    for (const name of [A.control, nodeA(1), nodeA(2)]) {
      const { stdout } = await docker(['inspect', '-f', '{{json .NetworkSettings.Ports}}', name]);
      expect(stdout.trim(), name).toMatch(/^(\{\}|null)$/);
    }
  });

  it('keeps the private key out of anything `docker inspect` shows', async () => {
    for (const name of [nodeA(1), nodeA(2)]) {
      const { stdout } = await docker(['inspect', '-f', '{{json .Config.Env}}', name]);
      expect(stdout, name).not.toContain('PRIVATE KEY');
      expect(stdout, name).toContain('JTT_AUTHORIZED_KEY');
    }
  });
});
