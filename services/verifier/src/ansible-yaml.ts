/**
 * Structural reading of Ansible project files.
 *
 * Some questions a lab asks are about *state* ("does /etc/jumptotech/app.conf
 * contain the right port on both nodes") and are answered by looking at the
 * managed nodes. Others are about *structure* ("is there a handler, and does
 * anything notify it") and can only be answered by reading the YAML the student
 * wrote.
 *
 * This module is the second kind. It is deliberately a *reader*, not an
 * interpreter: it never evaluates a template, never resolves a variable, and
 * never executes a task. It walks the document Ansible would walk and reports
 * what is there.
 *
 * Where it is generous, it is generous on purpose. `copy` and
 * `ansible.builtin.copy` are the same module and a lab must accept both; a task
 * inside a `block:` is still a task; `loop:` and `with_items:` both mean the
 * student wrote a loop. Grading structure means grading what Ansible would do,
 * not what one particular spelling looks like.
 */
import { parse as parseYaml } from 'yaml';

export interface ParsedYaml {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function parseYamlText(text: string): ParsedYaml {
  try {
    return { ok: true, value: parseYaml(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A task-level mapping, as it appears in a playbook or a role. */
export type AnsibleTask = Record<string, unknown>;

/**
 * Keys that are task *directives* rather than modules.
 *
 * Whatever key is left over after removing these is the module the task runs —
 * the same rule Ansible itself applies. The list errs towards completeness:
 * missing a directive would misreport it as a module name, which is a wrong
 * answer, while an extra entry only ever costs a task with no recognised
 * module, which the caller already handles.
 */
const TASK_DIRECTIVES = new Set([
  'action',
  'always',
  'any_errors_fatal',
  'args',
  'async',
  'become',
  'become_exe',
  'become_flags',
  'become_method',
  'become_user',
  'block',
  'changed_when',
  'check_mode',
  'collections',
  'connection',
  'debugger',
  'delay',
  'delegate_facts',
  'delegate_to',
  'diff',
  'environment',
  'failed_when',
  'ignore_errors',
  'ignore_unreachable',
  'listen',
  'local_action',
  'loop',
  'loop_control',
  'module_defaults',
  'name',
  'no_log',
  'notify',
  'poll',
  'port',
  'register',
  'remote_user',
  'rescue',
  'retries',
  'run_once',
  'tags',
  'throttle',
  'timeout',
  'until',
  'vars',
  'when',
]);

/** Loop keywords, old and new. Both mean the student wrote a loop. */
const LOOP_KEYS = ['loop', 'with_items', 'with_dict', 'with_list', 'with_nested', 'with_sequence'];

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Flatten a task list, descending into `block` / `rescue` / `always`.
 *
 * A task the student put inside a block is still a task they wrote, so a
 * `ansible_task_exists` check must find it.
 */
export function flattenTasks(value: unknown): AnsibleTask[] {
  const tasks: AnsibleTask[] = [];

  for (const entry of asArray(value)) {
    if (!isMapping(entry)) continue;
    tasks.push(entry);
    for (const nested of ['block', 'rescue', 'always']) {
      if (entry[nested] !== undefined) tasks.push(...flattenTasks(entry[nested]));
    }
  }
  return tasks;
}

/** Every task in a playbook, across every play and every task section. */
export function playbookTasks(document: unknown): AnsibleTask[] {
  const tasks: AnsibleTask[] = [];
  for (const play of asArray(document)) {
    if (!isMapping(play)) continue;
    for (const section of ['pre_tasks', 'tasks', 'post_tasks']) {
      tasks.push(...flattenTasks(play[section]));
    }
  }
  return tasks;
}

/** Every handler declared in a playbook's plays. */
export function playbookHandlers(document: unknown): AnsibleTask[] {
  const handlers: AnsibleTask[] = [];
  for (const play of asArray(document)) {
    if (!isMapping(play)) continue;
    handlers.push(...flattenTasks(play.handlers));
  }
  return handlers;
}

/** Role names referenced by a playbook's `roles:` section. */
export function playbookRoles(document: unknown): string[] {
  const roles: string[] = [];
  for (const play of asArray(document)) {
    if (!isMapping(play)) continue;
    for (const entry of asArray(play.roles)) {
      if (typeof entry === 'string') roles.push(entry);
      else if (isMapping(entry) && typeof entry.role === 'string') roles.push(entry.role);
      else if (isMapping(entry) && typeof entry.name === 'string') roles.push(entry.name);
    }
  }
  return roles;
}

/** The module a task runs, or `undefined` when no module key is present. */
export function taskModule(task: AnsibleTask): string | undefined {
  for (const key of Object.keys(task)) {
    if (!TASK_DIRECTIVES.has(key)) return key;
  }
  // `action: copy src=… dest=…` is the legacy spelling; the module is its head.
  const action = task.action;
  if (typeof action === 'string') return action.trim().split(/\s+/)[0];
  if (isMapping(action) && typeof action.module === 'string') return action.module;
  return undefined;
}

/**
 * Do two module references name the same module?
 *
 * Compared on the final segment, so `copy`, `ansible.builtin.copy` and
 * `ansible.legacy.copy` all match — they are the same module, and a lab that
 * insisted on one spelling would be grading typing, not understanding.
 */
export function moduleMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const tail = (value: string) => value.split('.').pop()?.toLowerCase() ?? value.toLowerCase();
  return tail(actual) === tail(expected);
}

export function taskName(task: AnsibleTask): string {
  return typeof task.name === 'string' ? task.name : '';
}

export function taskHasWhen(task: AnsibleTask): boolean {
  return task.when !== undefined;
}

export function taskHasLoop(task: AnsibleTask): boolean {
  return LOOP_KEYS.some((key) => task[key] !== undefined);
}

/** Handler names a task notifies. `notify:` may be a string or a list. */
export function taskNotifies(task: AnsibleTask): string[] {
  const notify = task.notify;
  if (typeof notify === 'string') return [notify];
  if (Array.isArray(notify)) return notify.filter((value): value is string => typeof value === 'string');
  return [];
}

/**
 * Names a handler answers to.
 *
 * Ansible matches a `notify:` against a handler's `name:` *or* any of its
 * `listen:` topics, so both count here.
 */
export function handlerNames(handler: AnsibleTask): string[] {
  const names: string[] = [];
  if (typeof handler.name === 'string') names.push(handler.name);
  const listen = handler.listen;
  if (typeof listen === 'string') names.push(listen);
  else if (Array.isArray(listen)) {
    names.push(...listen.filter((value): value is string => typeof value === 'string'));
  }
  return names;
}

/** Case-insensitive, whitespace-tolerant name comparison. */
export function namesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Does a task name contain the fragment a lab is looking for? */
export function nameContains(task: AnsibleTask, fragment: string): boolean {
  return taskName(task).toLowerCase().includes(fragment.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** The parsed output of `ansible-inventory --list`. */
export interface ParsedInventory {
  /** Group name → the hosts in it, with `children` resolved recursively. */
  groups: Map<string, Set<string>>;
  /** Every host the inventory knows about. */
  hosts: Set<string>;
}

/**
 * Resolve `ansible-inventory --list` JSON into flat group membership.
 *
 * Children are followed so that a host in `web` is also reported as a member of
 * `all` and of any parent group — which is how Ansible targets it, and
 * therefore the only membership answer that would not mislead a student.
 */
export function parseInventoryJson(json: unknown): ParsedInventory {
  const groups = new Map<string, Set<string>>();
  const hosts = new Set<string>();
  if (!isMapping(json)) return { groups, hosts };

  const raw = new Map<string, { hosts: string[]; children: string[] }>();
  for (const [name, value] of Object.entries(json)) {
    if (name === '_meta' || !isMapping(value)) continue;
    raw.set(name, {
      hosts: asArray(value.hosts).filter((h): h is string => typeof h === 'string'),
      children: asArray(value.children).filter((c): c is string => typeof c === 'string'),
    });
  }

  const resolve = (name: string, seen: Set<string>): Set<string> => {
    const cached = groups.get(name);
    if (cached) return cached;
    if (seen.has(name)) return new Set();
    seen.add(name);

    const entry = raw.get(name);
    const members = new Set<string>(entry?.hosts ?? []);
    for (const child of entry?.children ?? []) {
      for (const host of resolve(child, seen)) members.add(host);
    }
    groups.set(name, members);
    return members;
  };

  for (const name of raw.keys()) {
    for (const host of resolve(name, new Set())) hosts.add(host);
  }

  // Hosts that appear only in _meta.hostvars still exist as far as Ansible is
  // concerned, so they must not vanish from the "does this host exist" answer.
  const meta = (json as { _meta?: unknown })._meta;
  if (isMapping(meta) && isMapping(meta.hostvars)) {
    for (const host of Object.keys(meta.hostvars)) hosts.add(host);
  }

  return { groups, hosts };
}
