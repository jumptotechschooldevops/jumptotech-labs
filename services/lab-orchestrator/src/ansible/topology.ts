/**
 * The shape of one Ansible sandbox.
 *
 * ```text
 *   session ──► sandbox id (the session's derived `lab-…` name)
 *                 ├── network   lab-…-net          (private bridge)
 *                 ├── control   lab-…-control      ansible-core + student shell
 *                 ├── node      lab-…-node1        managed node, alias `node1`
 *                 └── node      lab-…-node2        managed node, alias `node2`
 * ```
 *
 * Two properties this module exists to guarantee:
 *
 *   1. **Every name is derived, never supplied.** Container and network names
 *      come from the sandbox id, which the session manager derives from the
 *      session id through an HMAC. No lab definition and no request body can
 *      influence any of them, so a lab cannot name — let alone reach — another
 *      session's containers.
 *   2. **Aliases are session-local.** Managed nodes answer to `node1` / `node2`
 *      only on their own session network. Docker's embedded DNS is per-network,
 *      so `ansible node1 -m ping` from session A can only ever resolve to
 *      session A's node.
 */
import { isLabNamespace } from '../session/identifiers.js';

/** Where a lab's project files live on the control node. */
export const ANSIBLE_WORKSPACE_DIR = '/home/student/lab';

/** The shell user the terminal logs in as on the control node. */
export const ANSIBLE_SHELL_USER = 'student';

/** The user Ansible connects to managed nodes as. */
export const ANSIBLE_MANAGED_USER = 'root';

/** Where the platform's own callback plugin lives inside the sandbox image. */
export const ANSIBLE_CALLBACK_DIR = '/opt/jumptotech/callbacks';
export const ANSIBLE_CALLBACK_NAME = 'jtt_stats';

export type AnsibleNodeRole = 'control' | 'managed';

export interface AnsibleNode {
  /** `control`, `node1`, `node2` — the name the student sees in an inventory. */
  readonly name: string;
  readonly role: AnsibleNodeRole;
  /** Full container name on the Docker host. Derived from the sandbox id. */
  readonly container: string;
}

export interface AnsibleTopology {
  readonly sandboxId: string;
  readonly network: string;
  readonly control: AnsibleNode;
  readonly managed: readonly AnsibleNode[];
  /** Control node first, then managed nodes. */
  readonly nodes: readonly AnsibleNode[];
}

export class InvalidSandboxIdError extends Error {
  readonly code = 'INVALID_SANDBOX_ID';
  constructor(received: string) {
    super(`'${received}' is not a JumpToTech lab sandbox id`);
    this.name = 'InvalidSandboxIdError';
  }
}

/**
 * A sandbox id is exactly a session's derived namespace name.
 *
 * Reusing that value rather than inventing a second identifier is what keeps
 * the Ansible track inside the existing session lifecycle: the store, the
 * reaper, the session view, and the terminal token all continue to speak in
 * terms of one opaque, server-derived id.
 */
export function assertValidSandboxId(value: unknown): string {
  if (!isLabNamespace(value)) throw new InvalidSandboxIdError(String(value));
  return value;
}

export function isSandboxId(value: unknown): value is string {
  return isLabNamespace(value);
}

/** Default number of managed nodes. Labs never choose this; policy does. */
export const DEFAULT_MANAGED_NODE_COUNT = 2;

export const MAX_MANAGED_NODE_COUNT = 4;

/** Managed node names, in order: `node1`, `node2`, … */
export function managedNodeNames(count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_MANAGED_NODE_COUNT) {
    throw new Error(`managed node count must be an integer between 1 and ${MAX_MANAGED_NODE_COUNT}`);
  }
  return Array.from({ length: count }, (_, index) => `node${index + 1}`);
}

/** Every derived name for one sandbox. */
export function topologyFor(
  sandboxId: string,
  managedNodeCount = DEFAULT_MANAGED_NODE_COUNT,
): AnsibleTopology {
  const id = assertValidSandboxId(sandboxId);
  const control: AnsibleNode = { name: 'control', role: 'control', container: `${id}-control` };
  const managed = managedNodeNames(managedNodeCount).map<AnsibleNode>((name) => ({
    name,
    role: 'managed',
    container: `${id}-${name}`,
  }));

  return {
    sandboxId: id,
    network: `${id}-net`,
    control,
    managed,
    nodes: [control, ...managed],
  };
}

/** Resolve a node name to its place in the topology. Returns null when unknown. */
export function nodeByName(topology: AnsibleTopology, name: string): AnsibleNode | null {
  return topology.nodes.find((node) => node.name === name) ?? null;
}

/**
 * Is this Docker object one of ours?
 *
 * Used as the first gate before any delete, exactly like `isLabNamespace` is
 * for the Kubernetes provider. Name shape alone never authorises a delete —
 * the provider additionally requires the ownership labels.
 */
export function isSandboxObjectName(name: string): boolean {
  const match = /^(lab-[a-z0-9]+)-(net|control|node[1-9])$/.exec(name);
  return match !== null && isLabNamespace(match[1]);
}
