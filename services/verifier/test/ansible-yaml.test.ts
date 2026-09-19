/**
 * Reading a task's module the way Ansible does: the one key left once the
 * directives are set aside.
 */
import { describe, expect, it } from 'vitest';
import { parseYamlText, playbookTasks, taskModule } from '../src/ansible-yaml.js';

const tasksOf = (yaml: string) => playbookTasks(parseYamlText(yaml).value);

describe('taskModule', () => {
  it('ignores the old with_* loop keys wherever they sit in the task', () => {
    // A correct ANSIBLE-005 task written with with_items, which the second
    // audit found was reported as running the module "with_items".
    const tasks = tasksOf(`
- hosts: all
  tasks:
    - name: directories
      with_items: [bin, conf]
      ansible.builtin.file:
        path: "/opt/jumptotech/{{ item }}"
        state: directory
    - name: templated
      with_fileglob: ["templates/*.j2"]
      template: { src: "{{ item }}", dest: /etc/x }
    - name: modern
      loop: [a]
      ansible.builtin.copy: { dest: /tmp/a, content: a }
`);
    expect(tasks.map(taskModule)).toEqual(['ansible.builtin.file', 'template', 'ansible.builtin.copy']);
  });
});
