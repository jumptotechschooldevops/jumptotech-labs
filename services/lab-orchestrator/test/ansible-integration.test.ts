/**
 * Integration tests against REAL Docker containers and REAL Ansible.
 *
 * These exist because the properties the Ansible track claims are properties of
 * *Ansible and Docker*, not of our code: whether `ansible all -m ping` actually
 * opens an SSH session, whether a playbook actually converges on a second run,
 * whether two bridge networks actually cannot see each other. A fake that
 * returned "pong" or "changed=0" would prove none of that, so nothing in this
 * file is faked.
 *
 * Skipped unless RUN_ANSIBLE_INTEGRATION_TESTS=1, so `npm test` stays hermetic.
 *
 *   bash scripts/ansible-image-build.sh
 *   RUN_ANSIBLE_INTEGRATION_TESTS=1 \
 *     npx vitest run test/ansible-integration.test.ts --root services/lab-orchestrator
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AnsibleDockerProvider,
  DockerAnsibleSandbox,
  DockerCli,
  InMemorySessionStore,
  LabRegistry,
  SessionManager,
  SessionReaper,
  DEFAULT_SESSION_POLICY,
  topologyFor,
  type LabSession,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';
import { LABS_DIR } from './helpers.js';

const IMAGE = process.env.ANSIBLE_LAB_IMAGE ?? 'jumptotech/ansible-lab:local';
const enabled = process.env.RUN_ANSIBLE_INTEGRATION_TESTS === '1';
const suite = enabled ? describe : describe.skip;

const WORKSPACE = '/home/student/lab';

/** Containers can take a while to start on a loaded laptop. */
const MINUTE = 60_000;

const docker = new DockerCli();
const sandbox = new DockerAnsibleSandbox({ docker });
const registry = new LabRegistry(LABS_DIR);

let provider: AnsibleDockerProvider;
let sessions: SessionManager;
let store: InMemorySessionStore;

/**
 * Sessions started by the test currently running.
 *
 * Torn down after every test, not only at the end of the file: a session holds
 * a capacity slot until it is ended, and fifteen tests each leaving three
 * containers behind would exhaust the guard and the host alike. Ending is
 * idempotent, so a test that already ended its own session costs nothing here.
 */
const started: string[] = [];

async function startLab(labId: string): Promise<LabSession> {
  const result = await sessions.start(labId);
  started.push(result.session.sessionId);
  return result.session;
}

async function endStartedSessions(): Promise<void> {
  const ids = started.splice(0);
  await Promise.all(ids.map((sessionId) => sessions.end(sessionId).catch(() => undefined)));
}

/** Write a file into a session's control node, exactly as a student would. */
async function writeProjectFile(session: LabSession, file: string, content: string): Promise<void> {
  const control = topologyFor(session.namespace).control.container;
  const directory = file.includes('/') ? `${WORKSPACE}/${file.slice(0, file.lastIndexOf('/'))}` : WORKSPACE;

  const mkdir = await docker.exec({
    container: control,
    argv: ['mkdir', '-p', directory],
    user: 'student',
  });
  expect(mkdir.exitCode, mkdir.stderr).toBe(0);

  const write = await docker.exec({
    container: control,
    argv: ['tee', `${WORKSPACE}/${file}`],
    user: 'student',
    input: content,
  });
  expect(write.exitCode, write.stderr).toBe(0);
}

/** Run a command on a control node the way a student's terminal would. */
async function studentRun(session: LabSession, argv: string[]) {
  return docker.exec({
    container: topologyFor(session.namespace).control.container,
    argv,
    user: 'student',
    workdir: WORKSPACE,
    env: { HOME: '/home/student', ANSIBLE_HOST_KEY_CHECKING: 'False', ANSIBLE_FORCE_COLOR: '0' },
    timeoutMs: 120_000,
  });
}

async function check(session: LabSession) {
  return verifyLab({ ansible: sandbox, lab: registry.get(session.labId), namespace: session.namespace });
}

const INVENTORY = `[web]
node1
node2
`;

suite('Ansible track — real containers, real Ansible', () => {
  beforeAll(async () => {
    await registry.load();
    expect(registry.loadErrors).toEqual([]);

    await docker.ping();
    expect(
      await docker.imageExists(IMAGE),
      `${IMAGE} is not built — run: bash scripts/ansible-image-build.sh`,
    ).toBe(true);

    provider = new AnsibleDockerProvider({
      docker,
      image: IMAGE,
      waitForRequirements: (input) => waitForRequirements({ ansible: sandbox, ...input }),
      readyTimeoutMs: 90_000,
    });

    store = new InMemorySessionStore();
    sessions = new SessionManager({
      registry,
      provider,
      store,
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: {
        maxSessionSeconds: 3600,
        idleTimeoutSeconds: 1800,
        warningSeconds: 300,
        maxActiveSessions: 10,
      },
      namespaceSecret: 'ansible-integration-namespace-derivation-secret',
    });
  }, 5 * MINUTE);

  // Cleanup must leave the host exactly as it was found, even after a failure.
  afterEach(endStartedSessions, 5 * MINUTE);
  afterAll(endStartedSessions, 5 * MINUTE);

  // ------------------------------------------------ 3. isolated environment

  it(
    'creates an isolated control node and managed nodes, and Ansible really runs',
    async () => {
      const session = await startLab('ANSIBLE-001');
      const topology = topologyFor(session.namespace);

      for (const node of topology.nodes) {
        const info = await docker.inspectContainer(node.container);
        expect(info?.state, `${node.name} should be running`).toBe('running');
      }

      const version = await studentRun(session, ['ansible', '--version']);
      expect(version.exitCode, version.stderr).toBe(0);
      expect(version.stdout).toMatch(/^ansible \[core/);
    },
    5 * MINUTE,
  );

  // ------------------------------ 4, 5. inventory verification + real ping

  it(
    'verifies a real inventory, and a real ansible ping',
    async () => {
      const session = await startLab('ANSIBLE-001');

      // The lab ships no inventory: the checks must fail before the work.
      const before = await check(session);
      expect(before.passed).toBe(false);
      expect(before.summary).toBe('LAB NOT COMPLETE');

      await writeProjectFile(session, 'inventory.ini', INVENTORY);

      // Ansible's own view of the inventory, and a real SSH round trip.
      const listed = await studentRun(session, ['ansible-inventory', '--list']);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout).web.hosts.sort()).toEqual(['node1', 'node2']);

      const ping = await studentRun(session, ['ansible', 'all', '-m', 'ping']);
      expect(ping.exitCode, ping.stderr).toBe(0);
      expect(ping.stdout).toContain('"ping": "pong"');
      expect(ping.stdout).toContain('node1 | SUCCESS');
      expect(ping.stdout).toContain('node2 | SUCCESS');

      const after = await check(session);
      expect(after.checks.filter((c) => c.status !== 'pass')).toEqual([]);
      expect(after.passed).toBe(true);
      expect(after.summary).toBe('LAB PASSED');
    },
    5 * MINUTE,
  );

  it(
    'reports a broken inventory as not complete, and recovers when it is fixed',
    async () => {
      const session = await startLab('ANSIBLE-001');
      await writeProjectFile(session, 'inventory.ini', INVENTORY);
      expect((await check(session)).passed).toBe(true);

      // Break it the way a student would: rename the group.
      await writeProjectFile(session, 'inventory.ini', INVENTORY.replace('[web]', '[frontend]'));
      const broken = await check(session);
      expect(broken.passed).toBe(false);
      expect(broken.checks.find((c) => c.label.includes("'web'"))?.detail).toMatch(/frontend/);

      await writeProjectFile(session, 'inventory.ini', INVENTORY);
      expect((await check(session)).passed).toBe(true);
    },
    5 * MINUTE,
  );

  // ------------------------------------------------ 6. real ad-hoc commands

  it(
    'grades an ad-hoc command by the state it left on the managed nodes',
    async () => {
      const session = await startLab('ANSIBLE-002');
      expect((await check(session)).passed).toBe(false);

      const mkdir = await studentRun(session, [
        'ansible',
        'web',
        '-m',
        'file',
        '-a',
        'path=/opt/jumptotech/releases state=directory',
      ]);
      expect(mkdir.exitCode, mkdir.stderr).toBe(0);

      const notice = await studentRun(session, [
        'ansible',
        'web',
        '-m',
        'copy',
        '-a',
        'dest=/etc/jumptotech/maintenance.txt content=status=scheduled',
      ]);
      expect(notice.exitCode, notice.stderr).toBe(0);

      const result = await check(session);
      expect(result.checks.filter((c) => c.status !== 'pass')).toEqual([]);
      expect(result.passed).toBe(true);

      // The state is genuinely on the nodes, read back through the sandbox.
      for (const node of ['node1', 'node2']) {
        const content = await sandbox.readManagedFile(
          session.namespace,
          node,
          '/etc/jumptotech/maintenance.txt',
        );
        expect(content).toContain('status=scheduled');
      }
    },
    5 * MINUTE,
  );

  // -------------------------------- 7, 8, 9. playbooks: run, fail, and pass

  it(
    'runs a real playbook, rejects an invalid one, and passes a correct one',
    async () => {
      const session = await startLab('ANSIBLE-003');
      await writeProjectFile(session, 'inventory.ini', INVENTORY);

      // An invalid playbook: Ansible itself refuses it, and so does the check.
      await writeProjectFile(session, 'site.yml', 'this: is: not: a playbook\n');
      const syntax = await studentRun(session, ['ansible-playbook', '--syntax-check', 'site.yml']);
      expect(syntax.exitCode).not.toBe(0);

      const broken = await check(session);
      expect(broken.passed).toBe(false);
      expect(broken.checks.some((c) => c.status === 'fail')).toBe(true);

      await writeProjectFile(
        session,
        'site.yml',
        `---
- name: Configure the ledger service
  hosts: web
  tasks:
    - name: Ensure the application directory exists
      ansible.builtin.file:
        path: /opt/jumptotech/app
        state: directory
        mode: "0755"

    - name: Write the application configuration
      ansible.builtin.copy:
        dest: /etc/jumptotech/app.conf
        mode: "0644"
        content: |
          app_name=ledger
          environment=staging
`,
      );

      const run = await studentRun(session, ['ansible-playbook', 'site.yml']);
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/changed=[1-9]/);

      const result = await check(session);
      expect(result.checks.filter((c) => c.status !== 'pass')).toEqual([]);
      expect(result.passed).toBe(true);
    },
    5 * MINUTE,
  );

  // -------------------------------------------------- 10. variables verified

  it(
    'grades variables by the per-host state they produce',
    async () => {
      const session = await startLab('ANSIBLE-004');

      await writeProjectFile(session, 'group_vars/web.yml', 'app_port: 8080\napp_release: "2.4.1"\n');
      await writeProjectFile(session, 'host_vars/node1.yml', 'node_role: primary\n');
      await writeProjectFile(session, 'host_vars/node2.yml', 'node_role: replica\n');
      await writeProjectFile(
        session,
        'site.yml',
        `---
- name: Configure the ledger service
  hosts: web
  tasks:
    - name: Ensure the application directory exists
      ansible.builtin.file:
        path: /opt/jumptotech/app
        state: directory
        mode: "0755"

    - name: Look up the node's own hostname
      ansible.builtin.command: hostname
      register: detected
      changed_when: false

    - name: Write the application configuration
      ansible.builtin.copy:
        dest: /etc/jumptotech/app.conf
        mode: "0644"
        content: |
          app_name=ledger
          app_port={{ app_port }}
          app_release={{ app_release }}
          node_role={{ node_role }}

    - name: Record what the node calls itself
      ansible.builtin.copy:
        dest: /etc/jumptotech/node.facts
        mode: "0644"
        content: |
          detected_hostname={{ detected.stdout }}
`,
      );

      const run = await studentRun(session, ['ansible-playbook', 'site.yml']);
      expect(run.exitCode, run.stderr).toBe(0);

      const result = await check(session);
      expect(result.checks.filter((c) => c.status !== 'pass')).toEqual([]);
      expect(result.passed).toBe(true);
    },
    5 * MINUTE,
  );

  // ------------------------------ 11, 15. handlers and real idempotency

  it(
    'grades a handler by the reload it caused, and proves the playbook converges',
    async () => {
      const session = await startLab('ANSIBLE-006');

      await writeProjectFile(session, 'group_vars/web.yml', 'app_name: ledger\napp_port: 9090\n');
      await writeProjectFile(
        session,
        'site.yml',
        `---
- name: Configure the ledger service
  hosts: web
  tasks:
    - name: Ensure the configuration directory exists
      ansible.builtin.file:
        path: /etc/jumptotech
        state: directory
        mode: "0755"

    - name: Ensure the log directory exists
      ansible.builtin.file:
        path: /var/log/jumptotech
        state: directory
        mode: "0755"

    - name: Write the application configuration
      ansible.builtin.copy:
        dest: /etc/jumptotech/app.conf
        mode: "0644"
        content: |
          app_name={{ app_name }}
          app_port={{ app_port }}
      notify: reload ledger

  handlers:
    - name: reload ledger
      ansible.builtin.copy:
        dest: /var/log/jumptotech/reload.log
        mode: "0644"
        content: |
          reloaded ledger
`,
      );

      // First run does the work; the recap proves the handler ran.
      const first = await studentRun(session, ['ansible-playbook', 'site.yml']);
      expect(first.exitCode, first.stderr).toBe(0);
      expect(first.stdout).toMatch(/changed=[1-9]/);
      expect(first.stdout).toContain('RUNNING HANDLER');

      // Second run changes nothing, and does not run the handler at all.
      const second = await studentRun(session, ['ansible-playbook', 'site.yml']);
      expect(second.exitCode, second.stderr).toBe(0);
      expect(second.stdout).toMatch(/changed=0/);
      expect(second.stdout).not.toContain('RUNNING HANDLER');

      const result = await check(session);
      expect(result.checks.filter((c) => c.status !== 'pass')).toEqual([]);
      expect(result.passed).toBe(true);
    },
    6 * MINUTE,
  );

  it(
    'fails the idempotency check for a playbook that changes something every run',
    async () => {
      const session = await startLab('ANSIBLE-006');

      await writeProjectFile(session, 'group_vars/web.yml', 'app_name: ledger\napp_port: 9090\n');
      await writeProjectFile(
        session,
        'site.yml',
        `---
- name: A playbook that never settles
  hosts: web
  tasks:
    - name: Ensure the configuration directory exists
      ansible.builtin.file:
        path: /etc/jumptotech
        state: directory

    # The command module reports changed on every single run, which is
    # exactly the habit the idempotency check exists to catch.
    - name: Touch the configuration
      ansible.builtin.command: touch /etc/jumptotech/app.conf
`,
      );

      const result = await check(session);
      const idempotency = result.checks.find((c) => c.label.includes('second run'));

      expect(idempotency?.status).toBe('fail');
      expect(idempotency?.detail).toMatch(/not converging|still reported/);
    },
    6 * MINUTE,
  );

  // ---------------------------------- 12, 13, 14. templates, roles, two nodes

  it(
    'grades a template by what it rendered, a role by its structure and result, and a deployment on both nodes',
    async () => {
      const session = await startLab('ANSIBLE-008');

      // Convert the shipped monolithic playbook into a role, as the lab asks.
      await writeProjectFile(
        session,
        'roles/web/defaults/main.yml',
        'app_name: ledger\napp_port: 8080\napp_release: "0.0.0"\n',
      );
      await writeProjectFile(
        session,
        'roles/web/templates/app.conf.j2',
        `# Managed by Ansible.
app_name={{ app_name }}
app_port={{ app_port }}
app_release={{ app_release }}
served_by={{ inventory_hostname }}
`,
      );
      await writeProjectFile(
        session,
        'roles/web/tasks/main.yml',
        `---
- name: Ensure the configuration directory exists
  ansible.builtin.file:
    path: /etc/jumptotech
    state: directory
    mode: "0755"

- name: Ensure the log directory exists
  ansible.builtin.file:
    path: /var/log/jumptotech
    state: directory
    mode: "0755"

- name: Deploy the application configuration
  ansible.builtin.template:
    src: app.conf.j2
    dest: /etc/jumptotech/app.conf
    mode: "0644"
  notify: reload ledger
`,
      );
      await writeProjectFile(
        session,
        'roles/web/handlers/main.yml',
        `---
- name: reload ledger
  ansible.builtin.copy:
    dest: /var/log/jumptotech/reload.log
    mode: "0644"
    content: |
      reloaded ledger
`,
      );
      await writeProjectFile(
        session,
        'site.yml',
        `---
- name: Configure the ledger service
  hosts: web
  roles:
    - web
`,
      );

      const run = await studentRun(session, ['ansible-playbook', 'site.yml']);
      expect(run.exitCode, run.stderr).toBe(0);

      const result = await check(session);
      expect(result.checks.filter((c) => c.status !== 'pass')).toEqual([]);
      expect(result.passed).toBe(true);

      // Both nodes rendered their own name — the template really was templated.
      expect(
        await sandbox.readManagedFile(session.namespace, 'node1', '/etc/jumptotech/app.conf'),
      ).toContain('served_by=node1');
      expect(
        await sandbox.readManagedFile(session.namespace, 'node2', '/etc/jumptotech/app.conf'),
      ).toContain('served_by=node2');
    },
    6 * MINUTE,
  );

  it(
    'fails a multi-node lab when only one node was configured',
    async () => {
      const session = await startLab('ANSIBLE-009');

      await writeProjectFile(
        session,
        'site.yml',
        `---
- name: Deploy the status page to the primary only
  hosts: node1
  tasks:
    - name: Ensure the document root exists
      ansible.builtin.file:
        path: /var/www/status
        state: directory
        mode: "0755"

    - name: Publish the status page
      ansible.builtin.copy:
        dest: /var/www/status/index.html
        mode: "0644"
        content: |
          service=ledger
          release=2.4.1
          node={{ inventory_hostname }}
`,
      );

      const run = await studentRun(session, ['ansible-playbook', 'site.yml']);
      expect(run.exitCode, run.stderr).toBe(0);

      const result = await check(session);
      expect(result.passed).toBe(false);

      const rollout = result.checks.find((c) => c.label.includes('document root'));
      expect(rollout?.status).toBe('fail');
      expect(rollout?.detail).toContain('node2');
      expect(rollout?.detail).not.toContain('node1:');
    },
    6 * MINUTE,
  );

  // ------------------------------------------------------------- 16. reset

  it(
    'reset restores the lab baseline and leaves the session active',
    async () => {
      const session = await startLab('ANSIBLE-008');
      const control = topologyFor(session.namespace).control.container;
      const controlBefore = await docker.inspectContainer(control);

      await writeProjectFile(session, 'site.yml', '# my own work\n');
      await writeProjectFile(session, 'scratch.txt', 'notes\n');
      await studentRun(session, [
        'ansible',
        'web',
        '-m',
        'file',
        '-a',
        'path=/etc/jumptotech/leftover.txt state=touch',
      ]);

      const { session: after, result } = await sessions.reset(session.sessionId);
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(after.status).toBe('ACTIVE');

      // The lab's own files are back…
      expect(await sandbox.readWorkspaceFile(session.namespace, 'site.yml')).toContain('hosts: web');
      // …the student's extra file is gone…
      expect(await sandbox.readWorkspaceFile(session.namespace, 'scratch.txt')).toBeNull();
      // …the managed nodes are clean…
      expect(
        await sandbox.readManagedFile(session.namespace, 'node1', '/etc/jumptotech/leftover.txt'),
      ).toBeNull();
      // …and the terminal's control node was never replaced.
      expect((await docker.inspectContainer(control))?.id).toBe(controlBefore?.id);
    },
    6 * MINUTE,
  );

  // --------------------------------------- 17, 19. end destroys, idempotently

  it(
    'End Lab destroys every container and the network, and is safe to repeat',
    async () => {
      const session = await startLab('ANSIBLE-001');
      const topology = topologyFor(session.namespace);

      const first = await sessions.end(session.sessionId);
      expect(first.destroy.namespaceGone).toBe(true);
      expect(first.session.status).toBe('ENDED');

      for (const node of topology.nodes) {
        expect(await docker.inspectContainer(node.container)).toBeNull();
      }
      expect(await docker.networkExists(topology.network)).toBe(false);

      // Repeating teardown reaches the same end state, and reports it.
      const second = await sessions.end(session.sessionId);
      expect(second.destroy.namespaceGone).toBe(true);
      const third = await provider.destroyNamespace(session.namespace);
      expect(third.namespaceGone).toBe(true);
    },
    5 * MINUTE,
  );

  // ------------------------------------------------------- 18. expiration

  it(
    'expiration destroys the environment through the same path End Lab uses',
    async () => {
      const session = await startLab('ANSIBLE-001');
      const topology = topologyFor(session.namespace);

      // Move the deadline into the past, then let the reaper do its job.
      await store.update(session.sessionId, { expiresAt: new Date(Date.now() - 1000).toISOString() });

      const reaper = new SessionReaper({ sessions, provider, intervalMs: 60_000, retentionMs: 0 });
      const sweep = await reaper.sweep();

      expect(sweep.removed).toContain(session.namespace);
      expect(sweep.reasons[session.namespace]).toBe('expired');
      expect((await sessions.get(session.sessionId))?.status).toBe('EXPIRED');
      for (const node of topology.nodes) {
        expect(await docker.inspectContainer(node.container)).toBeNull();
      }

      // A second sweep finds nothing to do and reports nothing removed.
      expect((await reaper.sweep()).removed).toEqual([]);
    },
    5 * MINUTE,
  );

  // --------------------------------------- 20, 21. concurrency and isolation

  it(
    'runs five simultaneous sessions, each with its own everything',
    async () => {
      const five = await Promise.all(
        Array.from({ length: 5 }, () => startLab('ANSIBLE-001')),
      );

      const sandboxes = five.map((session) => session.namespace);
      expect(new Set(sandboxes).size).toBe(5);

      // Every session got its own network, its own containers, and its own key.
      const keys = new Set<string>();
      for (const session of five) {
        const topology = topologyFor(session.namespace);
        expect(await docker.networkExists(topology.network)).toBe(true);
        for (const node of topology.nodes) {
          expect((await docker.inspectContainer(node.container))?.state).toBe('running');
        }
        const credentials = await provider.issueCredentials(sessions.contextFor(session));
        keys.add(credentials.ssh!.privateKey);
      }
      expect(keys.size).toBe(5);

      // Each session's own work is visible only to itself.
      await Promise.all(
        five.map((session, index) =>
          writeProjectFile(session, 'inventory.ini', `${INVENTORY}\n# session ${index}\n`),
        ),
      );
      for (const [index, session] of five.entries()) {
        const content = await sandbox.readWorkspaceFile(session.namespace, 'inventory.ini');
        expect(content).toContain(`# session ${index}`);
      }

      // A ping in one session reaches that session's nodes and no others.
      const pings = await Promise.all(five.map((session) => studentRun(session, ['ansible', 'all', '-m', 'ping'])));
      for (const ping of pings) {
        expect(ping.exitCode, ping.stderr).toBe(0);
        expect(ping.stdout).toContain('node1 | SUCCESS');
        expect(ping.stdout).toContain('node2 | SUCCESS');
      }
    },
    10 * MINUTE,
  );

  it(
    'session A cannot reach, name, or modify session B',
    async () => {
      const [a, b] = await Promise.all([startLab('ANSIBLE-002'), startLab('ANSIBLE-002')]);
      const topologyB = topologyFor(b!.namespace);

      // B does some work, so there is something for A to try to reach.
      await studentRun(b!, [
        'ansible',
        'web',
        '-m',
        'copy',
        '-a',
        'dest=/etc/jumptotech/maintenance.txt content=belongs-to-B',
      ]);

      // A cannot resolve B's node names — different bridge networks, and
      // Docker's embedded DNS is per-network.
      const resolve = await studentRun(a!, [
        'ssh',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'StrictHostKeyChecking=no',
        `root@${topologyB.managed[0]!.container}`,
        'true',
      ]);
      expect(resolve.exitCode).not.toBe(0);

      // A's own inventory still only ever reaches A's nodes: after A writes,
      // B's state is untouched.
      await studentRun(a!, [
        'ansible',
        'web',
        '-m',
        'copy',
        '-a',
        'dest=/etc/jumptotech/maintenance.txt content=belongs-to-A',
      ]);

      expect(await sandbox.readManagedFile(b!.namespace, 'node1', '/etc/jumptotech/maintenance.txt')).toContain(
        'belongs-to-B',
      );
      expect(await sandbox.readManagedFile(a!.namespace, 'node1', '/etc/jumptotech/maintenance.txt')).toContain(
        'belongs-to-A',
      );

      // Ending A leaves B fully operational.
      await sessions.end(a!.sessionId);
      const stillWorks = await studentRun(b!, ['ansible', 'all', '-m', 'ping']);
      expect(stillWorks.exitCode, stillWorks.stderr).toBe(0);
      expect((await provider.status(sessions.contextFor(b!))).phase).toBe('ready');
    },
    8 * MINUTE,
  );

  it(
    'refuses to destroy a sandbox on behalf of the wrong session',
    async () => {
      const [a, b] = await Promise.all([startLab('ANSIBLE-001'), startLab('ANSIBLE-001')]);

      const refused = await provider.destroyNamespace(b!.namespace, a!.sessionId);
      expect(refused.namespaceGone).toBe(false);
      expect(refused.error?.message).toMatch(/Refusing to delete/);

      // B is untouched.
      expect((await provider.status(sessions.contextFor(b!))).phase).toBe('ready');
    },
    6 * MINUTE,
  );

  it(
    'never touches a container or network it does not own',
    async () => {
      const before = await docker.listContainers('jumptotech.io/managed=true');
      const bystander = 'jumptotech-integration-bystander';
      await docker.removeContainer(bystander).catch(() => undefined);
      await docker.createNetwork(bystander, {});

      try {
        for (const name of ['bridge', 'host', 'kind', bystander]) {
          const result = await provider.destroyNamespace(name);
          expect(result.namespaceGone, `${name} must not be deletable`).toBe(false);
        }
        expect(await docker.networkExists(bystander)).toBe(true);
      } finally {
        await docker.removeNetwork(bystander).catch(() => undefined);
      }

      // No managed container was collected as a side effect.
      const after = await docker.listContainers('jumptotech.io/managed=true');
      expect(after.length).toBe(before.length);
    },
    5 * MINUTE,
  );
});
