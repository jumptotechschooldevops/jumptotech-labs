/**
 * The Ansible provider — a control node and the machines it configures.
 *
 * Every other container track gives a session one box. An Ansible lab cannot
 * be taught that way: the whole subject is *managing other machines*, so a
 * session is a small topology rather than a sandbox.
 *
 * ```text
 *   Student session
 *        ↓
 *   AnsibleLabProvider
 *        ↓
 *   jtt-net-<hex>            per-session bridge, --internal (no route off it)
 *        ├── jtt-lab-<hex>    control node — the student's shell, ansible-core
 *        ├── jtt-node1-<hex>  managed node, answers to `node1` on this bridge
 *        └── jtt-node2-<hex>  managed node, answers to `node2` on this bridge
 * ```
 *
 * ## What this provider does *not* do
 *
 * It publishes no host port. An earlier design reached the control node over
 * SSH on `127.0.0.1::22`, which meant every session put a listening socket on
 * the host. The platform already has a way to attach a shell to a container —
 * `container-exec`, the same one Linux and Terraform use — so the control node
 * needs no sshd, holds no capability at all, and nothing about an Ansible
 * session is reachable from the host.
 *
 * SSH exists only *between* the containers, on the session's own bridge, which
 * is what the labs are about.
 *
 * ## Capabilities
 *
 * The control node runs with `--cap-drop ALL` and nothing added back: it holds
 * an empty capability bounding set, which is the strongest posture any sandbox
 * on this platform has.
 *
 * The managed nodes run sshd, and sshd cannot start without one capability the
 * rest of the platform does not use — see `ANSIBLE_MANAGED_NODE_CAPABILITIES`.
 * The runtime refuses to grant it to any provider but this one.
 */
import {
  ANSIBLE_MANAGED_USER,
  ANSIBLE_SHELL_USER,
  ANSIBLE_WORKSPACE_DIR,
} from '../ansible/topology.js';
import { networkRefForSandbox, nodeRefForSandbox } from '../session/identifiers.js';
import {
  sandboxRefOf,
  type CreateResult,
  type DestroyResult,
  type LabSessionContext,
  type ResetResult,
} from '../types.js';
import type { ContainerRuntimePort } from './container/runtime.js';
import { ContainerLabProvider } from './container/sandbox-provider.js';

export const DEFAULT_ANSIBLE_SANDBOX_IMAGE = 'jumptotech/lab-ansible:latest';

/** The port sshd listens on inside a managed node. */
export const ANSIBLE_SSH_PORT = 2222;

/** How many managed nodes a session gets. */
export const ANSIBLE_MANAGED_NODE_COUNT = 2;

/**
 * What a managed node keeps after `--cap-drop ALL`.
 *
 * Every entry was established by running the thing and reading the failure,
 * not by copying a default set:
 *
 *   · `SYS_CHROOT` — OpenSSH privilege separation chroots to `/var/empty`
 *     before authentication, and privsep has been mandatory since OpenSSH 7.5
 *     removed `UsePrivilegeSeparation`. Without it sshd starts, listens, and
 *     then closes every connection with
 *     `chroot("/var/empty"): Operation not permitted [preauth]` — so a student
 *     sees a listening port that refuses them, which is worse than no port.
 *     This is the only capability on this platform that no other provider
 *     uses, and `PROVIDER_RESTRICTED_CAPABILITIES` refuses it to all of them.
 *   · `SETUID` / `SETGID` — the same privsep step drops to the `sshd` user;
 *     without them the pre-auth child dies on `setgroups`.
 *   · `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID` — what Ansible's `file`,
 *     `copy` and `template` modules need to own and mode a file on a target,
 *     and what nginx needs for its own runtime directories. Already grantable
 *     to other providers; nothing new is opened by listing them here.
 *
 * Deliberately absent: `NET_BIND_SERVICE`, because sshd listens on 2222 rather
 * than 22 and nothing here binds a privileged port — so this set does not
 * depend on Docker's `ip_unprivileged_port_start=0` default holding true on
 * whatever runtime the platform is deployed to. Also absent, and not by
 * oversight: `NET_ADMIN`, `NET_RAW`, `SYS_ADMIN`, `SYS_PTRACE`, `MKNOD`.
 */
export const ANSIBLE_MANAGED_NODE_CAPABILITIES: readonly string[] = [
  'SYS_CHROOT',
  'SETUID',
  'SETGID',
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
];

export interface AnsibleProviderOptions {
  runtime: ContainerRuntimePort;
  image?: string;
  home?: string;
  now?: () => number;
  runtimeOwner?: string;
}

export class AnsibleLabProvider extends ContainerLabProvider {
  readonly #runtime: ContainerRuntimePort;
  readonly #image: string;

  constructor(options: AnsibleProviderOptions) {
    super({
      id: 'ansible',
      name: 'docker-ansible',
      runtime: options.runtime,
      image: options.image ?? DEFAULT_ANSIBLE_SANDBOX_IMAGE,
      // The control node administers nothing: it edits files in the student's
      // own project and talks SSH. An empty capability set is correct, and is
      // what makes `SYS_CHROOT` below a managed-node grant rather than a
      // session-wide one.
      capabilities: [],
      home: options.home ?? ANSIBLE_WORKSPACE_DIR,
      requiredBinaries: ['ansible', 'ssh'],
      ...(options.now ? { now: options.now } : {}),
      ...(options.runtimeOwner ? { runtimeOwner: options.runtimeOwner } : {}),
    });
    this.#runtime = options.runtime;
    this.#image = options.image ?? DEFAULT_ANSIBLE_SANDBOX_IMAGE;
  }

  /** `node1`, `node2` — what a student writes in an inventory. */
  static nodeAlias(index: number): string {
    return `node${index}`;
  }

  /**
   * Create the control node, then the machines it manages.
   *
   * The base class owns the network and the control node, including the
   * ownership labels and the rollback that takes the network back when the
   * container fails to start. Managed nodes are added afterwards, on the
   * network that already exists, and are torn down the same way.
   */
  override async create(context: LabSessionContext): Promise<CreateResult> {
    const base = await super.create(context);
    if (!base.ok) return base;

    const sandboxRef = sandboxRefOf(context);
    const network = networkRefForSandbox(sandboxRef);
    const steps = [...base.steps];

    for (let index = 1; index <= ANSIBLE_MANAGED_NODE_COUNT; index += 1) {
      const ref = nodeRefForSandbox(sandboxRef, index);
      const alias = AnsibleLabProvider.nodeAlias(index);
      try {
        // Re-entrant, exactly as the control node's create is: a retried Start
        // Lab replaces the node rather than failing on the name.
        await this.#runtime.remove(ref).catch(() => undefined);
        await this.#runtime.create({
          name: ref,
          image: this.#image,
          hostname: alias,
          aliases: [alias],
          user: 'root',
          workdir: '/root',
          cpus: context.policy.sandbox.cpus,
          memory: context.policy.sandbox.memory,
          pidsLimit: context.policy.sandbox.pidsLimit,
          network,
          capAdd: [...ANSIBLE_MANAGED_NODE_CAPABILITIES],
          provider: this.id,
          noNewPrivileges: true,
          labels: { ...this.ownershipLabels(context), 'jumptotech.io/component': 'ansible-node' },
          env: { JTT_ROLE: 'node', JTT_SSH_PORT: String(ANSIBLE_SSH_PORT) },
          command: ['/usr/local/bin/jtt-entrypoint'],
        });
        steps.push({
          id: `managed-node-${index}`,
          label: `Managed node ${alias} created`,
          status: 'ok',
          detail: `${ref} on ${network}, sshd on ${ANSIBLE_SSH_PORT}`,
        });
      } catch (error) {
        // A half-built topology is not a lab. Take the whole session back
        // rather than handing a student one node out of two.
        await this.destroy(context).catch(() => undefined);
        return {
          ok: false,
          environment: base.environment,
          steps: [
            ...steps,
            {
              id: `managed-node-${index}`,
              label: `Managed node ${alias} created`,
              status: 'failed',
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
          error: {
            code: 'PROVISION_FAILED',
            message: `could not create managed node ${alias}`,
            remediation: 'Check that Docker is running and the Ansible sandbox image is built.',
          },
        };
      }
    }

    return { ...base, steps };
  }

  /**
   * Remove the managed nodes, then hand the rest to the base class.
   *
   * Ordered deliberately: Docker refuses to remove a network that still has
   * containers on it, and the base class removes the network. Each node goes
   * through the same ownership check as every other container the platform
   * deletes — name shape first, then the live labels read back from the
   * daemon — so a node belonging to another session is left alone.
   */
  override async destroy(context: LabSessionContext): Promise<DestroyResult> {
    const sandboxRef = sandboxRefOf(context);
    for (let index = 1; index <= ANSIBLE_MANAGED_NODE_COUNT; index += 1) {
      await this.removeOwnedContainer(nodeRefForSandbox(sandboxRef, index), context.sessionId);
    }
    return super.destroy(context);
  }

  /**
   * Reset rebuilds the whole topology, not just the control node.
   *
   * A managed node holds state — the files a playbook wrote, the daemon it
   * started — so restoring only the student's project would leave the previous
   * run's effects on the machines and make "reset" a lie in exactly the labs
   * where it matters most (a second run of an idempotent playbook).
   */
  override async reset(context: LabSessionContext): Promise<ResetResult> {
    await this.destroy(context).catch(() => undefined);
    const created = await this.create(context);
    return {
      ok: created.ok,
      environment: created.environment,
      removed: ['control node', 'managed nodes'],
      restored: created.steps.filter((step) => step.status === 'ok').map((step) => step.label),
      steps: created.steps,
      ...(created.error ? { error: created.error } : {}),
    };
  }
}

export { ANSIBLE_MANAGED_USER, ANSIBLE_SHELL_USER };
