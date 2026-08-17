/**
 * Handlers that read the managed nodes.
 *
 * This is where an Ansible lab is actually graded. A student may reach the
 * desired state with an ad-hoc command, a playbook, a role, or three attempts
 * and a typo in between; all that is checked is whether the nodes ended up the
 * way the lab said they should.
 *
 * Multi-node checks are all-or-nothing by design. "Configure both web servers"
 * is not half-done when one of them is configured, and a check that passed on a
 * partial rollout would teach exactly the wrong lesson.
 */
import type { RequirementOf } from '@jumptotech/lab-orchestrator';
import type { AnsibleVerifierHandler, HandlerOutcome } from '../contract.js';
import { fail, pass } from '../contract.js';
import type { AnsibleVerifyReader } from '../ansible-reader.js';

export const managedFileExists: AnsibleVerifierHandler<'managed_file_exists'> = {
  type: 'managed_file_exists',
  label: (r) =>
    r.state === 'absent'
      ? `${r.path} is absent on ${describeHosts(r.hosts)}`
      : `${r.path} exists on ${describeHosts(r.hosts)}`,
  async run(requirement, reader) {
    return everyHost(requirement.hosts, reader, async (node) => {
      const info = await reader.managedPath(node, requirement.path);

      if (requirement.state === 'absent') {
        return info.exists ? `${node}: '${requirement.path}' should not exist, but it does` : null;
      }
      if (!info.exists) return `${node}: '${requirement.path}' does not exist`;

      if (requirement.kind === 'directory' && info.kind !== 'directory') {
        return `${node}: '${requirement.path}' is a ${info.kind}, not a directory`;
      }
      if (requirement.kind === 'file' && info.kind === 'directory') {
        return `${node}: '${requirement.path}' is a directory, not a file`;
      }
      if (requirement.mode) {
        const expected = normaliseMode(requirement.mode);
        const actual = normaliseMode(info.mode ?? '');
        if (expected !== actual) {
          return `${node}: '${requirement.path}' has mode ${actual || 'unknown'}, expected ${expected}`;
        }
      }
      return null;
    });
  },
};

export const managedFileContent: AnsibleVerifierHandler<'managed_file_content'> = {
  type: 'managed_file_content',
  label: (r) => `${r.path} has the expected content on ${describeHosts(r.hosts)}`,
  async run(requirement, reader) {
    return everyHost(requirement.hosts, reader, async (node) => {
      const content = await reader.managedFile(node, requirement.path);
      if (content === null) return `${node}: '${requirement.path}' does not exist`;

      if (requirement.equals !== undefined) {
        if (trimTrailing(content) !== trimTrailing(requirement.equals)) {
          return `${node}: '${requirement.path}' does not match the expected content`;
        }
      }

      const missing = requirement.contains.filter((fragment) => !content.includes(fragment));
      if (missing.length > 0) {
        return `${node}: '${requirement.path}' is missing ${missing.map(quote).join(', ')}`;
      }

      const present = requirement.not_contains.filter((fragment) => content.includes(fragment));
      if (present.length > 0) {
        return `${node}: '${requirement.path}' still contains ${present.map(quote).join(', ')}`;
      }
      return null;
    });
  },
};

/**
 * A daemon is (or is not) running on the managed nodes.
 *
 * Sandbox nodes are containers with no init system, so "running" is read as a
 * live process with this name — real observed state on the node, and stated
 * plainly rather than presented as a systemd unit query that could not be
 * answered here.
 */
export const managedServiceState: AnsibleVerifierHandler<'managed_service_state'> = {
  type: 'managed_service_state',
  label: (r) => `${r.service} is ${r.expected} on ${describeHosts(r.hosts)}`,
  async run(requirement, reader) {
    return everyHost(requirement.hosts, reader, async (node) => {
      const running = await reader.processRunning(node, requirement.service);
      if (requirement.expected === 'running' && !running) {
        return `${node}: no '${requirement.service}' process is running`;
      }
      if (requirement.expected === 'stopped' && running) {
        return `${node}: '${requirement.service}' is still running`;
      }
      return null;
    });
  },
};

/**
 * Run a per-node check across the selected hosts.
 *
 * The callback returns `null` for a node that is in the desired state, or a
 * student-facing reason it is not. Every node is inspected even after the first
 * failure, so the report says which nodes are wrong rather than only the first.
 */
async function everyHost(
  selection: RequirementOf<'managed_file_exists'>['hosts'],
  reader: AnsibleVerifyReader,
  check: (node: string) => Promise<string | null>,
): Promise<HandlerOutcome> {
  const nodes = reader.resolveHosts(selection);
  if (nodes.length === 0) return fail('this check selected no managed nodes');

  const problems: string[] = [];
  for (const node of nodes) {
    const problem = await check(node);
    if (problem) problems.push(problem);
  }

  if (problems.length > 0) return fail(problems.join('; '));
  return pass(nodes.length > 1 ? `verified on ${nodes.join(', ')}` : undefined);
}

function describeHosts(selection: RequirementOf<'managed_file_exists'>['hosts']): string {
  return selection === 'all' ? 'every managed node' : selection.join(', ');
}

/** `644` and `0644` are the same permissions; compare them as such. */
function normaliseMode(mode: string): string {
  const digits = mode.replace(/^0+/, '');
  return digits.length === 0 ? '' : digits.padStart(4, '0');
}

function trimTrailing(value: string): string {
  return value.replace(/\s+$/, '');
}

function quote(value: string): string {
  return `'${value.length > 60 ? `${value.slice(0, 57)}…` : value}'`;
}

export const ansibleManagedHandlers = {
  managedFileExists,
  managedFileContent,
  managedServiceState,
} as const;
