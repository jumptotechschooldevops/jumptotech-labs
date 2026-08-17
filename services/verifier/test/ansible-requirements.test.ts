/**
 * One suite per Ansible requirement type.
 *
 * Each handler is exercised against a passing observation and at least one
 * realistic failing one, and every failure message is checked for the property
 * that matters most in a lab: it says what is wrong with the observed state,
 * and it does not hand over the answer.
 */
import { describe, expect, it } from 'vitest';
import {
  ANSIBLE_REQUIREMENT_TYPES,
  requirementDomain,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import {
  AnsibleVerifyReader,
  hasHandler,
  parsePingOutput,
  verifyRequirement,
  verifyRequirements,
} from '../src/index.js';
import {
  FakeAnsibleSandbox,
  inventoryJson,
  pingOutput,
  playbookRun,
  type FakeSandboxOptions,
} from './fake-ansible-sandbox.js';

const SANDBOX = 'lab-aaaaaaaaaaaa';

function check(requirement: Requirement, options: FakeSandboxOptions = {}) {
  const sandbox = new FakeAnsibleSandbox(options);
  return verifyRequirement(requirement, {
    ansible: new AnsibleVerifyReader(sandbox, SANDBOX),
  });
}

/** A minimally correct project, used as the baseline most cases start from. */
const WORKING_PLAYBOOK = `---
- name: Configure the ledger service
  hosts: web
  tasks:
    - name: Ensure the configuration directory exists
      ansible.builtin.file:
        path: /etc/jumptotech
        state: directory

    - name: Deploy the application configuration
      ansible.builtin.template:
        src: app.conf.j2
        dest: /etc/jumptotech/app.conf
      notify: reload ledger

  handlers:
    - name: reload ledger
      ansible.builtin.copy:
        dest: /var/log/jumptotech/reload.log
        content: |
          reloaded ledger
`;

describe('coverage', () => {
  it('registers a handler for every Ansible requirement type', () => {
    for (const type of ANSIBLE_REQUIREMENT_TYPES) {
      expect(hasHandler(type)).toBe(true);
      expect(requirementDomain(type)).toBe('ansible');
    }
  });
});

describe('file_exists', () => {
  it('passes when the file is there', async () => {
    const result = await check(
      { type: 'file_exists', path: 'inventory.ini', kind: 'file', label: 'x' },
      { workspace: { 'inventory.ini': '[web]\nnode1\n' } },
    );
    expect(result.status).toBe('pass');
  });

  it('fails when it is missing', async () => {
    const result = await check({ type: 'file_exists', path: 'inventory.ini', kind: 'file', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/does not exist/);
  });

  it('distinguishes a directory from a file', async () => {
    const asFile = await check(
      { type: 'file_exists', path: 'roles', kind: 'file', label: 'x' },
      { workspaceDirectories: ['roles'] },
    );
    expect(asFile.status).toBe('fail');
    expect(asFile.detail).toMatch(/is a directory/);

    const asDirectory = await check(
      { type: 'file_exists', path: 'roles', kind: 'directory', label: 'x' },
      { workspaceDirectories: ['roles'] },
    );
    expect(asDirectory.status).toBe('pass');
  });
});

describe('yaml_valid', () => {
  it('passes for parseable YAML', async () => {
    const result = await check(
      { type: 'yaml_valid', path: 'group_vars/web.yml', label: 'x' },
      { workspace: { 'group_vars/web.yml': 'app_port: 9090\n' } },
    );
    expect(result.status).toBe('pass');
  });

  it('fails for a YAML error, and names the parse problem', async () => {
    const result = await check(
      { type: 'yaml_valid', path: 'group_vars/web.yml', label: 'x' },
      { workspace: { 'group_vars/web.yml': 'app_name: ledger\n app_prt: 9090\n' } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not valid YAML/);
  });

  it('fails for an empty file rather than calling it valid', async () => {
    const result = await check(
      { type: 'yaml_valid', path: 'group_vars/web.yml', label: 'x' },
      { workspace: { 'group_vars/web.yml': '' } },
    );
    expect(result.status).toBe('fail');
  });
});

describe('ansible_inventory_valid', () => {
  it('passes when Ansible parses an inventory with hosts', async () => {
    const result = await check(
      { type: 'ansible_inventory_valid', label: 'x' },
      { inventory: inventoryJson({ web: ['node1', 'node2'] }) },
    );
    expect(result.status).toBe('pass');
  });

  it('fails when ansible-inventory itself fails', async () => {
    const result = await check(
      { type: 'ansible_inventory_valid', label: 'x' },
      {
        inventory: {
          exitCode: 1,
          stdout: '',
          stderr: 'ERROR! Syntax Error while loading YAML.',
          timedOut: false,
        },
      },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/Syntax Error/);
  });

  it('fails when the inventory parses but is empty', async () => {
    const result = await check(
      { type: 'ansible_inventory_valid', label: 'x' },
      { inventory: inventoryJson({}) },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no hosts/);
  });
});

describe('ansible_group_exists', () => {
  const inventory = inventoryJson({ web: ['node1', 'node2'], db: ['node1'] });

  it('passes when the group holds the expected hosts', async () => {
    const result = await check(
      { type: 'ansible_group_exists', group: 'web', hosts: ['node1', 'node2'], label: 'x' },
      { inventory },
    );
    expect(result.status).toBe('pass');
  });

  it('names the groups that do exist when the one asked for does not', async () => {
    const result = await check(
      { type: 'ansible_group_exists', group: 'frontend', label: 'x' },
      { inventory },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('web');
    expect(result.detail).toContain('db');
  });

  it('fails when a required member is missing', async () => {
    const result = await check(
      { type: 'ansible_group_exists', group: 'db', hosts: ['node1', 'node2'], label: 'x' },
      { inventory },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/does not contain: node2/);
  });

  it('enforces a minimum membership', async () => {
    const result = await check(
      { type: 'ansible_group_exists', group: 'db', min_hosts: 2, label: 'x' },
      { inventory },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/1 host/);
  });

  it('resolves group children, as Ansible does', async () => {
    const nested = {
      exitCode: 0,
      stderr: '',
      timedOut: false,
      stdout: JSON.stringify({
        _meta: { hostvars: {} },
        all: { children: ['production'] },
        production: { children: ['web'] },
        web: { hosts: ['node1', 'node2'] },
      }),
    };
    const result = await check(
      { type: 'ansible_group_exists', group: 'production', hosts: ['node1', 'node2'], label: 'x' },
      { inventory: nested },
    );
    expect(result.status).toBe('pass');
  });
});

describe('ansible_host_exists', () => {
  const inventory = inventoryJson({ web: ['node1', 'node2'] });

  it('passes for a host in the inventory', async () => {
    expect((await check({ type: 'ansible_host_exists', host: 'node1', label: 'x' }, { inventory })).status).toBe(
      'pass',
    );
  });

  it('passes for a host in the required group', async () => {
    const result = await check(
      { type: 'ansible_host_exists', host: 'node2', group: 'web', label: 'x' },
      { inventory },
    );
    expect(result.status).toBe('pass');
  });

  it('fails when the host exists but not in the required group', async () => {
    const result = await check(
      { type: 'ansible_host_exists', host: 'node2', group: 'db', label: 'x' },
      { inventory: inventoryJson({ web: ['node1', 'node2'], db: ['node1'] }) },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not a member of 'db'/);
  });

  it('fails for a host nobody declared', async () => {
    const result = await check({ type: 'ansible_host_exists', host: 'node9', label: 'x' }, { inventory });
    expect(result.status).toBe('fail');
  });
});

describe('ansible_playbook_valid', () => {
  it('passes when the syntax check passes', async () => {
    const result = await check(
      { type: 'ansible_playbook_valid', playbook: 'site.yml', label: 'x' },
      { workspace: { 'site.yml': WORKING_PLAYBOOK } },
    );
    expect(result.status).toBe('pass');
  });

  it('reports the tool complaint when the syntax check fails', async () => {
    const result = await check(
      { type: 'ansible_playbook_valid', playbook: 'site.yml', label: 'x' },
      {
        workspace: { 'site.yml': 'not a playbook' },
        syntaxCheck: {
          'site.yml': {
            exitCode: 4,
            stdout: '',
            stderr: 'ERROR! playbooks must be a list of plays',
            timedOut: false,
          },
        },
      },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/must be a list of plays/);
  });

  it('fails before running anything when the playbook is missing', async () => {
    const result = await check({ type: 'ansible_playbook_valid', playbook: 'site.yml', label: 'x' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/does not exist/);
  });
});

describe('ansible_task_exists', () => {
  const workspace = { 'site.yml': WORKING_PLAYBOOK };

  it('matches a module regardless of its collection prefix', async () => {
    for (const module of ['template', 'ansible.builtin.template']) {
      const result = await check(
        { type: 'ansible_task_exists', playbook: 'site.yml', module, label: 'x' },
        { workspace },
      );
      expect(result.status).toBe('pass');
    }
  });

  it('matches a task by name fragment, case-insensitively', async () => {
    const result = await check(
      { type: 'ansible_task_exists', playbook: 'site.yml', name: 'deploy the application', label: 'x' },
      { workspace },
    );
    expect(result.status).toBe('pass');
  });

  it('fails when no task uses the module, and says so without naming the fix', async () => {
    const result = await check(
      { type: 'ansible_task_exists', playbook: 'site.yml', module: 'lineinfile', label: 'x' },
      { workspace },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no task in the playbook uses the lineinfile module/);
  });

  it('finds a task nested inside a block', async () => {
    const withBlock = `---
- hosts: web
  tasks:
    - name: Grouped work
      block:
        - name: Install the unit file
          ansible.builtin.copy:
            dest: /etc/jumptotech/app.conf
            content: hello
`;
    const result = await check(
      { type: 'ansible_task_exists', playbook: 'site.yml', module: 'copy', label: 'x' },
      { workspace: { 'site.yml': withBlock } },
    );
    expect(result.status).toBe('pass');
  });

  it('checks for a loop, accepting either spelling', async () => {
    for (const key of ['loop', 'with_items']) {
      const looping = `---
- hosts: web
  tasks:
    - name: Create directories
      ansible.builtin.file:
        path: "/opt/jumptotech/{{ item }}"
        state: directory
      ${key}: [bin, conf]
`;
      const result = await check(
        { type: 'ansible_task_exists', playbook: 'site.yml', module: 'file', has_loop: true, label: 'x' },
        { workspace: { 'site.yml': looping } },
      );
      expect(result.status).toBe('pass');
    }
  });

  it('fails a loop check when the tasks are simply repeated', async () => {
    const repeated = `---
- hosts: web
  tasks:
    - name: bin
      ansible.builtin.file: { path: /opt/jumptotech/bin, state: directory }
    - name: conf
      ansible.builtin.file: { path: /opt/jumptotech/conf, state: directory }
`;
    const result = await check(
      { type: 'ansible_task_exists', playbook: 'site.yml', module: 'file', has_loop: true, label: 'x' },
      { workspace: { 'site.yml': repeated } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/does not loop/);
  });

  it('checks for a condition and for a notify target', async () => {
    const conditional = `---
- hosts: web
  tasks:
    - name: Claim the lock
      ansible.builtin.copy:
        dest: /etc/jumptotech/scheduler.lock
        content: owner=node1
      when: node_role == "primary"
      notify: reload ledger
`;
    const workspaceOne = { workspace: { 'site.yml': conditional } };

    expect(
      (await check({ type: 'ansible_task_exists', playbook: 'site.yml', has_when: true, label: 'x' }, workspaceOne))
        .status,
    ).toBe('pass');
    expect(
      (
        await check(
          { type: 'ansible_task_exists', playbook: 'site.yml', module: 'copy', notifies: 'reload ledger', label: 'x' },
          workspaceOne,
        )
      ).status,
    ).toBe('pass');
    expect(
      (
        await check(
          { type: 'ansible_task_exists', playbook: 'site.yml', module: 'copy', notifies: 'restart nginx', label: 'x' },
          workspaceOne,
        )
      ).status,
    ).toBe('fail');
  });
});

describe('ansible_role_exists', () => {
  const roleProject = {
    workspace: {
      'roles/web/tasks/main.yml': '- name: x\n  ansible.builtin.file: { path: /tmp/x, state: touch }\n',
      'roles/web/handlers/main.yml': '- name: reload ledger\n  ansible.builtin.command: /bin/true\n',
      'roles/web/defaults/main.yml': 'app_port: 9090\n',
      'roles/web/templates/app.conf.j2': 'port={{ app_port }}\n',
      'site.yml': '---\n- hosts: web\n  roles:\n    - web\n',
    },
  };

  it('passes for a complete role applied by the playbook', async () => {
    const result = await check(
      {
        type: 'ansible_role_exists',
        role: 'web',
        requires: ['tasks', 'handlers', 'templates', 'defaults'],
        roles_dir: 'roles',
        used_by: 'site.yml',
        label: 'x',
      },
      roleProject,
    );
    expect(result.status).toBe('pass');
  });

  it('names the missing pieces of an incomplete role', async () => {
    const result = await check(
      {
        type: 'ansible_role_exists',
        role: 'web',
        requires: ['tasks', 'handlers'],
        roles_dir: 'roles',
        label: 'x',
      },
      { workspace: { 'roles/web/tasks/main.yml': '- name: x\n  ansible.builtin.debug: {}\n' } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/handlers/);
  });

  it('fails when the role exists but nothing applies it', async () => {
    const result = await check(
      {
        type: 'ansible_role_exists',
        role: 'web',
        requires: ['tasks'],
        roles_dir: 'roles',
        used_by: 'site.yml',
        label: 'x',
      },
      {
        workspace: {
          ...roleProject.workspace,
          'site.yml': '---\n- hosts: web\n  tasks:\n    - ansible.builtin.debug: {}\n',
        },
      },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/does not apply any role/);
  });
});

describe('ansible_handler_exists', () => {
  it('passes when the handler exists and a task notifies it', async () => {
    const result = await check(
      {
        type: 'ansible_handler_exists',
        playbook: 'site.yml',
        name: 'reload ledger',
        notified: true,
        roles_dir: 'roles',
        label: 'x',
      },
      { workspace: { 'site.yml': WORKING_PLAYBOOK } },
    );
    expect(result.status).toBe('pass');
  });

  it('catches the classic typo: handler declared, nothing notifies it', async () => {
    const mismatched = WORKING_PLAYBOOK.replace('notify: reload ledger', 'notify: reload app');
    const result = await check(
      {
        type: 'ansible_handler_exists',
        playbook: 'site.yml',
        name: 'reload ledger',
        notified: true,
        roles_dir: 'roles',
        label: 'x',
      },
      { workspace: { 'site.yml': mismatched } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no task notifies it/);
  });

  it('lists the handlers that do exist when the named one does not', async () => {
    const result = await check(
      {
        type: 'ansible_handler_exists',
        playbook: 'site.yml',
        name: 'restart nginx',
        notified: false,
        roles_dir: 'roles',
        label: 'x',
      },
      { workspace: { 'site.yml': WORKING_PLAYBOOK } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/reload ledger/);
  });

  it('finds a handler that lives in a role', async () => {
    const result = await check(
      {
        type: 'ansible_handler_exists',
        role: 'web',
        name: 'reload ledger',
        notified: true,
        roles_dir: 'roles',
        label: 'x',
      },
      {
        workspace: {
          'roles/web/handlers/main.yml': '- name: reload ledger\n  ansible.builtin.command: /bin/true\n',
          'roles/web/tasks/main.yml':
            '- name: config\n  ansible.builtin.copy: { dest: /etc/jumptotech/a, content: b }\n  notify: reload ledger\n',
        },
      },
    );
    expect(result.status).toBe('pass');
  });

  it('accepts a handler matched by listen', async () => {
    const listening = `---
- hosts: web
  tasks:
    - name: config
      ansible.builtin.copy: { dest: /etc/jumptotech/a, content: b }
      notify: jumptotech reload
  handlers:
    - name: reload the service
      listen: jumptotech reload
      ansible.builtin.command: /bin/true
`;
    const result = await check(
      {
        type: 'ansible_handler_exists',
        playbook: 'site.yml',
        name: 'jumptotech reload',
        notified: true,
        roles_dir: 'roles',
        label: 'x',
      },
      { workspace: { 'site.yml': listening } },
    );
    expect(result.status).toBe('pass');
  });
});

describe('ansible_template_exists', () => {
  const template = 'app_name={{ app_name }}\napp_port={{ app_port }}\nserved_by={{ inventory_hostname }}\n';

  it('passes when the template renders the required variables', async () => {
    const result = await check(
      {
        type: 'ansible_template_exists',
        path: 'templates/app.conf.j2',
        references: ['app_name', 'app_port'],
        label: 'x',
      },
      { workspace: { 'templates/app.conf.j2': template } },
    );
    expect(result.status).toBe('pass');
  });

  it('fails a file with no Jinja2 in it — that is a copy, not a template', async () => {
    const result = await check(
      { type: 'ansible_template_exists', path: 'templates/app.conf.j2', references: [], label: 'x' },
      { workspace: { 'templates/app.conf.j2': 'app_port=9090\n' } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no Jinja2 expressions/);
  });

  it('names the variables a template never uses', async () => {
    const result = await check(
      {
        type: 'ansible_template_exists',
        path: 'templates/app.conf.j2',
        references: ['app_name', 'app_release'],
        label: 'x',
      },
      { workspace: { 'templates/app.conf.j2': template } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/app_release/);
    expect(result.detail).not.toMatch(/app_name/);
  });

  it('does not count a variable name that appears only outside an expression', async () => {
    const result = await check(
      {
        type: 'ansible_template_exists',
        path: 'templates/app.conf.j2',
        references: ['app_release'],
        label: 'x',
      },
      { workspace: { 'templates/app.conf.j2': '# app_release is set elsewhere\nport={{ app_port }}\n' } },
    );
    expect(result.status).toBe('fail');
  });
});

describe('managed_file_exists', () => {
  const managed = { managedDirectories: { node1: ['/opt/jumptotech/releases'], node2: ['/opt/jumptotech/releases'] } };

  it('passes only when every selected node has it', async () => {
    const both = await check(
      {
        type: 'managed_file_exists',
        path: '/opt/jumptotech/releases',
        kind: 'directory',
        hosts: 'all',
        state: 'present',
        label: 'x',
      },
      managed,
    );
    expect(both.status).toBe('pass');
  });

  it('fails a half-finished rollout and names the node that is behind', async () => {
    const result = await check(
      {
        type: 'managed_file_exists',
        path: '/opt/jumptotech/releases',
        kind: 'directory',
        hosts: 'all',
        state: 'present',
        label: 'x',
      },
      { managedDirectories: { node1: ['/opt/jumptotech/releases'], node2: [] } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('node2');
    expect(result.detail).not.toContain('node1');
  });

  it('checks a path is absent, which is how a conditional is graded', async () => {
    const result = await check(
      {
        type: 'managed_file_exists',
        path: '/etc/jumptotech/scheduler.lock',
        kind: 'file',
        hosts: ['node2'],
        state: 'absent',
        label: 'x',
      },
      { managed: { node2: { '/etc/jumptotech/scheduler.lock': 'owner=node2' } } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/should not exist/);
  });

  it('compares modes ignoring a leading zero', async () => {
    const result = await check(
      {
        type: 'managed_file_exists',
        path: '/etc/jumptotech/app.conf',
        kind: 'file',
        hosts: ['node1'],
        state: 'present',
        mode: '644',
        label: 'x',
      },
      { managed: { node1: { '/etc/jumptotech/app.conf': 'x' } } },
    );
    expect(result.status).toBe('pass');
  });
});

describe('managed_file_content', () => {
  const rendered = 'app_name=ledger\napp_port=9090\nserved_by=node1\n';

  it('passes when every fragment is present on every node', async () => {
    const result = await check(
      {
        type: 'managed_file_content',
        path: '/etc/jumptotech/app.conf',
        hosts: 'all',
        contains: ['app_name=ledger', 'app_port=9090'],
        not_contains: [],
        label: 'x',
      },
      {
        managed: {
          node1: { '/etc/jumptotech/app.conf': rendered },
          node2: { '/etc/jumptotech/app.conf': rendered.replace('node1', 'node2') },
        },
      },
    );
    expect(result.status).toBe('pass');
  });

  it('names the fragment that is missing', async () => {
    const result = await check(
      {
        type: 'managed_file_content',
        path: '/etc/jumptotech/app.conf',
        hosts: ['node1'],
        contains: ['app_release=2.4.1'],
        not_contains: [],
        label: 'x',
      },
      { managed: { node1: { '/etc/jumptotech/app.conf': rendered } } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/app_release=2\.4\.1/);
  });

  it('catches an unrendered template through not_contains', async () => {
    const result = await check(
      {
        type: 'managed_file_content',
        path: '/etc/jumptotech/app.conf',
        hosts: ['node1'],
        contains: [],
        not_contains: ['{{'],
        label: 'x',
      },
      { managed: { node1: { '/etc/jumptotech/app.conf': 'app_port={{ app_port }}\n' } } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/still contains/);
  });

  it('compares an exact file ignoring trailing whitespace', async () => {
    const result = await check(
      {
        type: 'managed_file_content',
        path: '/etc/jumptotech/maintenance.txt',
        hosts: ['node1'],
        contains: [],
        not_contains: [],
        equals: 'status=scheduled',
        label: 'x',
      },
      { managed: { node1: { '/etc/jumptotech/maintenance.txt': 'status=scheduled\n' } } },
    );
    expect(result.status).toBe('pass');
  });

  it('fails when the file is not there at all', async () => {
    const result = await check({
      type: 'managed_file_content',
      path: '/etc/jumptotech/app.conf',
      hosts: 'all',
      contains: ['anything'],
      not_contains: [],
      label: 'x',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/does not exist/);
  });
});

describe('managed_service_state', () => {
  it('passes when the daemon is running everywhere it should be', async () => {
    const result = await check(
      { type: 'managed_service_state', service: 'nginx', hosts: 'all', expected: 'running', label: 'x' },
      { processes: { node1: ['sshd', 'nginx'], node2: ['sshd', 'nginx'] } },
    );
    expect(result.status).toBe('pass');
  });

  it('fails and names the node where it is not running', async () => {
    const result = await check(
      { type: 'managed_service_state', service: 'nginx', hosts: 'all', expected: 'running', label: 'x' },
      { processes: { node1: ['sshd', 'nginx'], node2: ['sshd'] } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('node2');
  });

  it('can require a daemon to be stopped', async () => {
    const result = await check(
      { type: 'managed_service_state', service: 'nginx', hosts: ['node1'], expected: 'stopped', label: 'x' },
      { processes: { node1: ['nginx'] } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/still running/);
  });
});

describe('ansible_connectivity', () => {
  it('passes when every matched host answers', async () => {
    const result = await check(
      { type: 'ansible_connectivity', pattern: 'web', min_hosts: 2, label: 'x' },
      { ping: { web: pingOutput({ node1: 'SUCCESS', node2: 'SUCCESS' }) } },
    );
    expect(result.status).toBe('pass');
  });

  it('fails and names an unreachable host', async () => {
    const result = await check(
      { type: 'ansible_connectivity', pattern: 'all', min_hosts: 2, label: 'x' },
      { ping: { all: pingOutput({ node1: 'SUCCESS', node2: 'UNREACHABLE' }) } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/unreachable: node2/);
  });

  it('fails when fewer hosts answer than the lab requires', async () => {
    const result = await check(
      { type: 'ansible_connectivity', pattern: 'web', min_hosts: 2, label: 'x' },
      { ping: { web: pingOutput({ node1: 'SUCCESS' }) } },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/at least 2/);
  });

  it('fails when the pattern matches nothing at all', async () => {
    const result = await check(
      { type: 'ansible_connectivity', pattern: 'web', min_hosts: 1, label: 'x' },
      {
        ping: {
          web: {
            exitCode: 1,
            stdout: '',
            stderr: '[WARNING]: Could not match supplied host pattern, ignoring: web',
            timedOut: false,
          },
        },
      },
    );
    expect(result.status).toBe('fail');
  });

  it('reads per-host status from the ad-hoc output contract', () => {
    const parsed = parsePingOutput(
      ['node1 | SUCCESS => {', '  "ping": "pong"', '}', 'node2 | UNREACHABLE! => {'].join('\n'),
    );
    expect(parsed).toEqual({ success: ['node1'], unreachable: ['node2'], failed: [] });
  });
});

describe('ansible_idempotent', () => {
  const base = { workspace: { 'site.yml': WORKING_PLAYBOOK } };

  it('passes when the second run changes nothing', async () => {
    const result = await check(
      {
        type: 'ansible_idempotent',
        playbook: 'site.yml',
        require_initial_change: false,
        reset_paths: [],
        label: 'x',
      },
      {
        ...base,
        playbookRuns: [
          playbookRun({ node1: { ok: 3, changed: 2 }, node2: { ok: 3, changed: 2 } }),
          playbookRun({ node1: { ok: 3 }, node2: { ok: 3 } }),
        ],
      },
    );
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/second run changed 0/);
  });

  it('fails when the second run still changes something, and names the host', async () => {
    const result = await check(
      {
        type: 'ansible_idempotent',
        playbook: 'site.yml',
        require_initial_change: false,
        reset_paths: [],
        label: 'x',
      },
      {
        ...base,
        playbookRuns: [
          playbookRun({ node1: { ok: 3, changed: 3 }, node2: { ok: 3, changed: 3 } }),
          playbookRun({ node1: { ok: 3, changed: 1 }, node2: { ok: 3 } }),
        ],
      },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not converging/);
    expect(result.detail).toContain('node1');
  });

  it('clears the baseline first and demands a first-run change when asked to', async () => {
    const sandbox = new FakeAnsibleSandbox({
      ...base,
      managed: {
        node1: { '/etc/jumptotech/app.conf': 'stale' },
        node2: { '/etc/jumptotech/app.conf': 'stale' },
      },
      playbookRuns: [
        playbookRun({ node1: { ok: 3, changed: 2 }, node2: { ok: 3, changed: 2 } }),
        playbookRun({ node1: { ok: 3 }, node2: { ok: 3 } }),
      ],
    });

    const result = await verifyRequirement(
      {
        type: 'ansible_idempotent',
        playbook: 'site.yml',
        require_initial_change: true,
        reset_paths: ['/etc/jumptotech'],
        label: 'x',
      },
      { ansible: new AnsibleVerifyReader(sandbox, SANDBOX) },
    );

    expect(result.status).toBe('pass');
    expect(sandbox.removed).toEqual([
      { node: 'node1', path: '/etc/jumptotech' },
      { node: 'node2', path: '/etc/jumptotech' },
    ]);
    expect(sandbox.playbookCalls).toEqual(['site.yml', 'site.yml']);
  });

  it('fails a playbook that does nothing from a clean baseline', async () => {
    const result = await check(
      {
        type: 'ansible_idempotent',
        playbook: 'site.yml',
        require_initial_change: true,
        reset_paths: ['/etc/jumptotech'],
        label: 'x',
      },
      {
        ...base,
        playbookRuns: [playbookRun({ node1: { ok: 1 } }), playbookRun({ node1: { ok: 1 } })],
      },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/0 changed tasks/);
  });

  it('reports a failed run as a failed run, not as non-convergence', async () => {
    const result = await check(
      {
        type: 'ansible_idempotent',
        playbook: 'site.yml',
        require_initial_change: false,
        reset_paths: [],
        label: 'x',
      },
      { ...base, playbookRuns: [playbookRun({ node1: { ok: 1, failures: 1 } })] },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/first run failed on node1/);
  });

  it('reports an unreachable host distinctly', async () => {
    const result = await check(
      {
        type: 'ansible_idempotent',
        playbook: 'site.yml',
        require_initial_change: false,
        reset_paths: [],
        label: 'x',
      },
      { ...base, playbookRuns: [playbookRun({ node2: { unreachable: 1 } })] },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/could not reach node2/);
  });

  it('reports a play that matched no hosts rather than passing it', async () => {
    const result = await check(
      {
        type: 'ansible_idempotent',
        playbook: 'site.yml',
        require_initial_change: false,
        reset_paths: [],
        label: 'x',
      },
      { ...base, playbookRuns: [playbookRun({})] },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/matched no hosts/);
  });

  it('reports a run that never produced a recap as an incomplete run', async () => {
    const result = await check(
      {
        type: 'ansible_idempotent',
        playbook: 'site.yml',
        require_initial_change: false,
        reset_paths: [],
        label: 'x',
      },
      {
        ...base,
        playbookRuns: [playbookRun(null, { exitCode: 4, stderr: 'ERROR! the role was not found' })],
      },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/did not complete/);
    expect(result.detail).toMatch(/role was not found/);
  });
});

describe('routing', () => {
  it('skips an Ansible requirement when no Ansible sandbox is available', async () => {
    const [result] = await verifyRequirements(
      [{ type: 'ansible_inventory_valid', label: 'x' }],
      {},
    );
    expect(result?.status).toBe('skipped');
    expect(result?.detail).toMatch(/No Ansible sandbox/);
  });

  it('skips a Kubernetes requirement when no cluster is available', async () => {
    const [result] = await verifyRequirements(
      [{ type: 'pod_exists', name: 'nginx', label: 'x' }],
      { ansible: new AnsibleVerifyReader(new FakeAnsibleSandbox(), SANDBOX) },
    );
    expect(result?.status).toBe('skipped');
    expect(result?.detail).toMatch(/No Kubernetes environment/);
  });

  it('runs checks sequentially so two playbook runs never race', async () => {
    const sandbox = new FakeAnsibleSandbox({
      workspace: { 'a.yml': WORKING_PLAYBOOK, 'b.yml': WORKING_PLAYBOOK },
      playbookRuns: [
        playbookRun({ node1: { changed: 1 } }),
        playbookRun({ node1: {} }),
        playbookRun({ node1: { changed: 1 } }),
        playbookRun({ node1: {} }),
      ],
    });

    await verifyRequirements(
      [
        { type: 'ansible_idempotent', playbook: 'a.yml', require_initial_change: false, reset_paths: [], label: 'a' },
        { type: 'ansible_idempotent', playbook: 'b.yml', require_initial_change: false, reset_paths: [], label: 'b' },
      ],
      { ansible: new AnsibleVerifyReader(sandbox, SANDBOX) },
    );

    expect(sandbox.playbookCalls).toEqual(['a.yml', 'a.yml', 'b.yml', 'b.yml']);
  });
});
