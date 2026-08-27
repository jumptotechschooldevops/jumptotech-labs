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
import { generateSessionKeyPair, type SessionKeyPair } from '../ansible/keys.js';
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

/** How many times a managed node is probed before provisioning gives up. */
export const ANSIBLE_NODE_READY_ATTEMPTS = 20;
/** Gap between probes. 20 × 500ms ≈ 10s, well past a node's start time. */
export const ANSIBLE_NODE_READY_INTERVAL_MS = 500;

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
  /** Injected in tests so a readiness wait does not spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

export class AnsibleLabProvider extends ContainerLabProvider {
  readonly #runtime: ContainerRuntimePort;
  readonly #image: string;
  readonly #sleep: (ms: number) => Promise<void>;

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
      // An Ansible session is a control node plus two managed nodes that have
      // to be able to reach each other. That is a property of this provider's
      // topology, not something a lab author should have to remember — see
      // `requiresLabNetwork`.
      requiresLabNetwork: true,
      ...(options.now ? { now: options.now } : {}),
      ...(options.runtimeOwner ? { runtimeOwner: options.runtimeOwner } : {}),
    });
    this.#runtime = options.runtime;
    this.#image = options.image ?? DEFAULT_ANSIBLE_SANDBOX_IMAGE;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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

    /*
     * The session's own SSH identity.
     *
     * `ansible/keys.ts` has always described this exactly — public half onto
     * every managed node, private half streamed into the control node, both
     * halves ceasing to exist when the containers do — and nothing called it.
     * The nodes' entrypoint requires `JTT_AUTHORIZED_KEY` and exits 1 without
     * it, so every managed node in the track died on start: the topology
     * reported itself created and then had no machines in it.
     *
     * Generated per session and never stored. The public half travels as an
     * environment variable, which is fine — it is public. The private half
     * never does: `docker inspect` would show it. It goes in over an exec
     * stream below.
     */
    let keys: SessionKeyPair;
    try {
      keys = await generateSessionKeyPair(sandboxRef);
    } catch (error) {
      await this.destroy(context).catch(() => undefined);
      return {
        ok: false,
        environment: base.environment,
        steps: [
          ...steps,
          {
            id: 'session-keypair',
            label: 'Session SSH keypair generated',
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
        error: {
          code: 'PROVISION_FAILED',
          message: 'could not generate the session SSH keypair',
        },
      };
    }
    steps.push({
      id: 'session-keypair',
      label: 'Session SSH keypair generated',
      status: 'ok',
      detail: `${keys.comment} (private half never leaves the control node)`,
    });

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
          env: {
            JTT_ROLE: 'node',
            JTT_SSH_PORT: String(ANSIBLE_SSH_PORT),
            // The *public* half only. See the keypair comment above.
            JTT_AUTHORIZED_KEY: keys.publicKey,
          },
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

    /*
     * The control node's half of the credential.
     *
     * Written after the nodes exist so a failure here tears down a whole
     * topology rather than leaving a student a set of machines they cannot
     * reach. The key travels on stdin, so it never appears in a command line,
     * in `docker inspect`, or in a log.
     */
    try {
      /*
       * The *account's* home, not this provider's `homeDir`.
       *
       * They are different here and nowhere else: an Ansible session's
       * `homeDir` is the student's project directory, `/home/student/lab`,
       * while the account's home is `/home/student`. `ssh` reads
       * `$HOME/.ssh/config` — so writing the identity under the workspace put
       * it somewhere `ssh node1` would never look, and every connection fell
       * back to port 22 and was refused.
       */
      const accountHome = context.policy.sandbox.home;
      await this.#seedControlNodeSsh(sandboxRef, keys, accountHome);
      /*
       * And then wait until the machines actually answer.
       *
       * A managed node generates its host keys at start, so `sshd` is listening
       * a second or two after `docker run` returns. Reporting the topology
       * ready before that is the difference between a student's first
       * `ansible all -m ping` printing `pong` and printing
       * `UNREACHABLE ... Connection refused` — on a lab whose entire first task
       * is to prove the inventory works. Start Lab should mean startable.
       */
      const reachable = await this.#waitForNodes(sandboxRef, accountHome);
      steps.push({
        id: 'control-node-ssh',
        label: 'Control node SSH configured',
        status: 'ok',
        detail: `identity written 0600; ${reachable.join(', ')} answering on ${ANSIBLE_SSH_PORT}`,
      });
    } catch (error) {
      await this.destroy(context).catch(() => undefined);
      return {
        ok: false,
        environment: base.environment,
        steps: [
          ...steps,
          {
            id: 'control-node-ssh',
            label: 'Control node SSH configured',
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
        error: {
          code: 'PROVISION_FAILED',
          message: 'could not configure SSH on the control node',
          remediation: 'Check that the Ansible sandbox image is built and current.',
        },
      };
    }

    return { ...base, steps };
  }

  /**
   * Block until every managed node answers SSH, or give up loudly.
   *
   * Probed from the control node with the session's own identity, which is the
   * same path a student's `ansible` takes — so a pass here means the thing the
   * student is about to do works, not merely that a port is open.
   */
  async #waitForNodes(sandboxRef: string, accountHome: string): Promise<string[]> {
    const names = Array.from({ length: ANSIBLE_MANAGED_NODE_COUNT }, (_, i) =>
      AnsibleLabProvider.nodeAlias(i + 1),
    );

    for (const name of names) {
      let lastError = 'no attempt was made';
      let ready = false;
      for (let attempt = 0; attempt < ANSIBLE_NODE_READY_ATTEMPTS; attempt += 1) {
        const probe = await this.execInSandbox(sandboxRef, {
          argv: [
            '/usr/bin/ssh',
            // Named explicitly rather than left to `$HOME`. A `docker exec`
            // does not run a login shell, so relying on the environment to
            // find this file is how the probe ends up asking for port 22.
            '-F',
            `${accountHome}/.ssh/config`,
            '-o',
            'ConnectTimeout=3',
            '-o',
            'BatchMode=yes',
            name,
            'true',
          ],
          user: ANSIBLE_SHELL_USER,
          timeoutMs: 15_000,
        });
        if (probe.exitCode === 0) {
          ready = true;
          break;
        }
        lastError = probe.stderr.trim() || `exit ${probe.exitCode}`;
        await this.#sleep(ANSIBLE_NODE_READY_INTERVAL_MS);
      }
      if (!ready) {
        throw new Error(`managed node ${name} never answered SSH: ${lastError}`);
      }
    }
    return names;
  }

  /**
   * Give the control node the private key and the config to use it.
   *
   * Three files, and each earns its place:
   *
   *   · `id_rsa` (0600) — the half that is never an environment variable.
   *   · `config` — port 2222 and `root`, so a student writes `ssh node1` and a
   *     playbook needs no `ansible_port`/`ansible_user` boilerplate that is not
   *     what these labs teach.
   *   · `known_hosts` handling — the nodes mint fresh host keys on every start,
   *     so strict checking would fail every first connection and every reset.
   *     `StrictHostKeyChecking no` is scoped to *these* names on a bridge with
   *     no route off it, holding only this session's own containers.
   */
  async #seedControlNodeSsh(
    sandboxRef: string,
    keys: SessionKeyPair,
    accountHome: string,
  ): Promise<void> {
    const sshDir = `${accountHome}/.ssh`;
    const nodeNames = Array.from({ length: ANSIBLE_MANAGED_NODE_COUNT }, (_, i) =>
      AnsibleLabProvider.nodeAlias(i + 1),
    );

    const config =
      `${nodeNames
        .map((name) => `Host ${name}\n  HostName ${name}\n`)
        .join('')}Host ${nodeNames.join(' ')}\n` +
      `  User ${ANSIBLE_MANAGED_USER}\n` +
      `  Port ${ANSIBLE_SSH_PORT}\n` +
      `  IdentityFile ${sshDir}/id_rsa\n` +
      `  IdentitiesOnly yes\n` +
      `  StrictHostKeyChecking no\n` +
      `  UserKnownHostsFile /dev/null\n` +
      `  LogLevel ERROR\n`;

    /*
     * Ansible reads its own defaults, not `~/.ssh/config`, for the port and
     * the user — so both are stated here as well. Written to the workspace the
     * student's shell opens in, which is where `ansible` looks first.
     */
    const ansibleCfg =
      `[defaults]\n` +
      `host_key_checking = False\n` +
      `remote_user = ${ANSIBLE_MANAGED_USER}\n` +
      `private_key_file = ${sshDir}/id_rsa\n` +
      `interpreter_python = auto_silent\n` +
      `\n[ssh_connection]\n` +
      `ssh_args = -o ControlMaster=auto -o ControlPersist=60s -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o Port=${ANSIBLE_SSH_PORT}\n`;

    await this.execInSandbox(sandboxRef, {
      argv: ['/bin/mkdir', '-p', '--', sshDir],
      user: ANSIBLE_SHELL_USER,
    });

    for (const [path, content, mode] of [
      [`${sshDir}/id_rsa`, keys.privateKey, '0600'],
      [`${sshDir}/id_rsa.pub`, `${keys.publicKey}\n`, '0644'],
      [`${sshDir}/config`, config, '0600'],
      [`${this.homeDir}/ansible.cfg`, ansibleCfg, '0644'],
    ] as const) {
      // stdin, so no key material is ever part of a command line.
      const write = await this.execInSandbox(sandboxRef, {
        argv: ['/usr/bin/tee', '--', path],
        user: ANSIBLE_SHELL_USER,
        stdin: content,
      });
      if (write.exitCode !== 0) {
        throw new Error(`could not write ${path}: ${write.stderr.trim()}`);
      }
      const chmod = await this.execInSandbox(sandboxRef, {
        argv: ['/bin/chmod', mode, '--', path],
        user: ANSIBLE_SHELL_USER,
      });
      if (chmod.exitCode !== 0) {
        throw new Error(`could not chmod ${path}: ${chmod.stderr.trim()}`);
      }
    }

    await this.execInSandbox(sandboxRef, {
      argv: ['/bin/chmod', '0700', '--', sshDir],
      user: ANSIBLE_SHELL_USER,
    });
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
