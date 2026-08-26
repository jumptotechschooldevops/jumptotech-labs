/**
 * Handlers that ask Ansible about the inventory, and that make Ansible use it.
 *
 * Every check here runs a real command in the student's sandbox:
 * `ansible-inventory --list` for structure, `ansible <pattern> -m ping` for
 * connectivity. Nothing is simulated and nothing is inferred from a file we
 * parsed ourselves — an inventory that Ansible cannot read is not a valid
 * inventory, whatever it looks like to a YAML or INI parser.
 */
import type { AnsibleVerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';
import { firstMeaningfulLine, type AnsibleVerifyReader, type InventoryReading } from '../ansible-reader.js';

export const ansibleInventoryValid: AnsibleVerifierHandler<'ansible_inventory_valid'> = {
  type: 'ansible_inventory_valid',
  label: () => 'Ansible can parse the inventory',
  async run(_requirement, reader) {
    const reading = await reader.inventory();
    if (reading.error) return fail(reading.error);
    if (!reading.inventory) return fail('ansible-inventory returned nothing to read');
    if (reading.inventory.hosts.size === 0) {
      return fail('the inventory parses, but it contains no hosts');
    }
    return pass();
  },
};

export const ansibleGroupExists: AnsibleVerifierHandler<'ansible_group_exists'> = {
  type: 'ansible_group_exists',
  label: (r) => `Inventory group '${r.group}' exists`,
  async run(requirement, reader) {
    const reading = await reader.inventory();
    const unreadable = inventoryProblem(reading);
    if (unreadable) return fail(unreadable);

    const members = reading.inventory!.groups.get(requirement.group);
    if (!members) {
      const known = [...reading.inventory!.groups.keys()].filter((g) => g !== 'all' && g !== 'ungrouped');
      return fail(
        known.length > 0
          ? `the inventory has no group '${requirement.group}' (groups found: ${known.join(', ')})`
          : `the inventory has no group '${requirement.group}'`,
      );
    }

    if (requirement.hosts) {
      const missing = requirement.hosts.filter((host) => !members.has(host));
      if (missing.length > 0) {
        return fail(`group '${requirement.group}' does not contain: ${missing.join(', ')}`);
      }
    }
    if (requirement.min_hosts !== undefined && members.size < requirement.min_hosts) {
      return fail(
        `group '${requirement.group}' has ${members.size} host(s); at least ${requirement.min_hosts} required`,
      );
    }
    return pass();
  },
};

export const ansibleHostExists: AnsibleVerifierHandler<'ansible_host_exists'> = {
  type: 'ansible_host_exists',
  label: (r) => (r.group ? `Host ${r.host} is in group '${r.group}'` : `Host ${r.host} is in the inventory`),
  async run(requirement, reader) {
    const reading = await reader.inventory();
    const unreadable = inventoryProblem(reading);
    if (unreadable) return fail(unreadable);

    const inventory = reading.inventory!;
    if (!inventory.hosts.has(requirement.host)) {
      const known = [...inventory.hosts];
      return fail(
        known.length > 0
          ? `the inventory does not contain host '${requirement.host}' (hosts found: ${known.join(', ')})`
          : `the inventory contains no hosts at all`,
      );
    }

    if (requirement.group) {
      const members = inventory.groups.get(requirement.group);
      if (!members) return fail(`the inventory has no group '${requirement.group}'`);
      if (!members.has(requirement.host)) {
        return fail(`host '${requirement.host}' exists but is not a member of '${requirement.group}'`);
      }
    }
    return pass();
  },
};

/**
 * Real connectivity: Ansible opened an SSH session to every matched host.
 *
 * The pass condition is deliberately strict — zero unreachable hosts, zero
 * failures, and at least `min_hosts` answers. A partially reachable inventory
 * is exactly the state this check exists to catch.
 */
export const ansibleConnectivity: AnsibleVerifierHandler<'ansible_connectivity'> = {
  type: 'ansible_connectivity',
  label: (r) => `Ansible can reach '${r.pattern}'`,
  async run(requirement, reader) {
    const result = await reader.ping(requirement.pattern);
    if (result.timedOut) return fail(`'ansible ${requirement.pattern} -m ping' timed out`);

    const outcomes = parsePingOutput(result.stdout);
    if (result.exitCode !== 0 && outcomes.success.length === 0) {
      const detail = firstMeaningfulLine(result.stderr) || firstMeaningfulLine(result.stdout);
      return fail(
        detail
          ? `'ansible ${requirement.pattern} -m ping' failed: ${detail.slice(0, 240)}`
          : `'ansible ${requirement.pattern} -m ping' reached no hosts`,
      );
    }

    if (outcomes.unreachable.length > 0) {
      return fail(`unreachable: ${outcomes.unreachable.join(', ')}`);
    }
    if (outcomes.failed.length > 0) {
      return fail(`ping failed on: ${outcomes.failed.join(', ')}`);
    }
    if (outcomes.success.length < requirement.min_hosts) {
      return fail(
        `${outcomes.success.length} host(s) answered; at least ${requirement.min_hosts} required`,
      );
    }
    return pass(`${outcomes.success.length} host(s) answered pong`);
  },
};

/**
 * Read per-host outcomes from `ansible -m ping`.
 *
 * The ad-hoc `ansible` command has no structured-output mode that ansible-core
 * ships on its own, so this reads the per-host status token that begins each
 * result block — `node1 | SUCCESS => {…}`. That token is a fixed part of the
 * output contract, not prose, and the check never depends on the JSON body.
 */
export function parsePingOutput(stdout: string): {
  success: string[];
  unreachable: string[];
  failed: string[];
} {
  const success: string[] = [];
  const unreachable: string[] = [];
  const failed: string[] = [];

  for (const line of stdout.split('\n')) {
    const match = /^([A-Za-z0-9_.-]+)\s*\|\s*([A-Z_]+)/.exec(line.trim());
    if (!match) continue;
    const [, host = '', status = ''] = match;
    if (status === 'SUCCESS') success.push(host);
    else if (status === 'UNREACHABLE') unreachable.push(host);
    else if (status === 'FAILED' || status === 'ERROR') failed.push(host);
  }

  return { success, unreachable, failed };
}

function inventoryProblem(reading: InventoryReading): string | null {
  if (reading.error) return reading.error;
  if (!reading.inventory) return 'ansible-inventory returned nothing to read';
  return null;
}

export const ansibleInventoryHandlers = {
  ansibleInventoryValid,
  ansibleGroupExists,
  ansibleHostExists,
  ansibleConnectivity,
} as const;

export type { AnsibleVerifyReader };
