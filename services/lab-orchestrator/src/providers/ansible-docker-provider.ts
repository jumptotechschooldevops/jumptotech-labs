/**
 * `LabProvider` backed by per-session Docker containers — the Ansible track.
 *
 * ```text
 *   session ──► sandbox lab-…
 *                 ├── network  lab-…-net       private bridge, no other session on it
 *                 ├── control  lab-…-control   ansible-core; the student's shell
 *                 ├── node1    lab-…-node1     managed node
 *                 └── node2    lab-…-node2     managed node
 * ```
 *
 * **Why containers and not VMs.** A managed node needs sshd and python3 and
 * nothing else. One container per node costs tens of megabytes and starts in
 * about a second, so five concurrent students cost fifteen small containers —
 * not fifteen virtual machines, not a cluster each, and not a database each.
 *
 * **Where isolation comes from.** Each session gets its own user-defined bridge
 * network. Docker's embedded DNS is per-network, so `node1` resolves inside one
 * session and nowhere else, and containers on different bridges have no route
 * to one another. Session A cannot name, resolve, or reach session B's nodes.
 *
 * **What a student is given.** One SSH keypair, generated for their session,
 * authorised only on their own containers, destroyed with them. No Docker
 * socket, no host mount, no host SSH key, no cloud credential — the sandbox
 * containers have no access to any of those, and neither does the shell.
 *
 * **What this provider is given.** A `DockerPort`. It is held by the
 * orchestrator process alone: it is not mounted into the terminal service, the
 * web app, or any sandbox container. See README → Ansible track security.
 */
import type {
  CreateResult,
  DestroyResult,
  EnvironmentInfo,
  ExecRequest,
  ExecResult,
  LabError,
  LabProvider,
  LabSessionContext,
  ManagedNamespace,
  NodeInfo,
  ProvisionStep,
  ResetResult,
  StudentCredentials,
} from '../types.js';
import {
  DockerUnavailableError,
  type DockerPort,
  type DockerRunSpec,
} from '../ansible/docker-port.js';
import { generateSessionKeyPair, type SessionKeyPair } from '../ansible/keys.js';
import {
  ANSIBLE_MANAGED_USER,
  ANSIBLE_SHELL_USER,
  ANSIBLE_WORKSPACE_DIR,
  DEFAULT_MANAGED_NODE_COUNT,
  assertValidSandboxId,
  isSandboxId,
  topologyFor,
  type AnsibleNode,
  type AnsibleTopology,
} from '../ansible/topology.js';
import { loadLabWorkspace, workspaceDirectories, type WorkspaceFile } from '../ansible/workspace.js';
import {
  LAB_LABEL,
  MANAGED_LABEL,
  MANAGED_SELECTOR,
  SESSION_LABEL,
  assertDeletable,
  expiryFromLabels,
  ownershipLabels,
} from '../k8s/labels.js';
import type { Requirement } from '../requirements.js';
import type { RequirementWaiter } from './kind-provider.js';

/** Only these binaries may ever be invoked by `execute()`. */
const EXEC_ALLOWLIST = new Set(['ansible', 'ansible-playbook', 'ansible-inventory']);

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/**
 * Capabilities a sandbox container keeps. Everything else is dropped.
 *
 * This is the classic Docker default set minus the ones nothing here needs
 * (NET_RAW, NET_ADMIN, MKNOD, AUDIT_WRITE, SETPCAP, SETFCAP). What remains is
 * what sshd needs to bind :22 and drop privileges into the login user, plus
 * what Ansible's file/copy/template modules need to own and mode a file.
 * No container is privileged, and `no-new-privileges` is set unconditionally.
 */
export const SANDBOX_CAPABILITIES: readonly string[] = [
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'SETGID',
  'SETUID',
  'SYS_CHROOT',
  'NET_BIND_SERVICE',
];

/** Per-container resource ceilings. Configuration, not literals in logic. */
export interface AnsibleSandboxLimits {
  controlCpus: number;
  controlMemory: string;
  nodeCpus: number;
  nodeMemory: string;
  pidsLimit: number;
}

export const DEFAULT_ANSIBLE_SANDBOX_LIMITS: AnsibleSandboxLimits = {
  controlCpus: 1,
  controlMemory: '512m',
  nodeCpus: 0.5,
  nodeMemory: '256m',
  pidsLimit: 256,
};

export interface AnsibleDockerProviderOptions {
  docker: DockerPort;
  /** Sandbox node image, e.g. `jumptotech/ansible-lab:local`. */
  image: string;
  managedNodeCount?: number;
  limits?: AnsibleSandboxLimits;
  /**
   * Host the terminal service reaches a control node on.
   *
   * SSH is published on the loopback interface only, so this is `127.0.0.1`
   * when the terminal runs on the same host and `host.docker.internal` when it
   * runs in a container beside it. It is never a routable address.
   */
  sshHost?: string;
  /** Confirms a lab's declared initial state actually materialised. */
  waitForRequirements?: RequirementWaiter;
  readyTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class AnsibleDockerProvider implements LabProvider {
  readonly name = 'ansible-docker';

  readonly #docker: DockerPort;
  readonly #image: string;
  readonly #managedNodeCount: number;
  readonly #limits: AnsibleSandboxLimits;
  readonly #sshHost: string;
  readonly #wait: RequirementWaiter | undefined;
  readonly #readyTimeoutMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  /**
   * Session private keys, held in memory only.
   *
   * Deliberately never written to the host filesystem and never persisted: the
   * key exists to open one sandbox, and when that sandbox is destroyed there is
   * nothing left to revoke. An API restart therefore loses the ability to issue
   * new shells for in-flight sessions — the reaper collects those sandboxes as
   * orphans, which is the correct outcome and is documented as a limitation.
   */
  readonly #keys = new Map<string, SessionKeyPair>();

  constructor(options: AnsibleDockerProviderOptions) {
    this.#docker = options.docker;
    this.#image = options.image;
    this.#managedNodeCount = options.managedNodeCount ?? DEFAULT_MANAGED_NODE_COUNT;
    this.#limits = options.limits ?? DEFAULT_ANSIBLE_SANDBOX_LIMITS;
    this.#sshHost = options.sshHost ?? '127.0.0.1';
    this.#wait = options.waitForRequirements;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? sleep;
  }

  topology(sandboxId: string): AnsibleTopology {
    return topologyFor(sandboxId, this.#managedNodeCount);
  }

  environmentId(context: LabSessionContext): string {
    return `${this.name}:${context.namespace}#${context.labId}`;
  }

  #environment(
    context: LabSessionContext,
    phase: EnvironmentInfo['phase'],
    extra: Partial<EnvironmentInfo> = {},
  ): EnvironmentInfo {
    return {
      environmentId: this.environmentId(context),
      provider: this.name,
      phase,
      namespace: context.namespace,
      sessionId: context.sessionId,
      ...extra,
    };
  }

  // ---------------------------------------------------------------- create

  async create(context: LabSessionContext): Promise<CreateResult> {
    const sandboxId = assertValidSandboxId(context.namespace);
    const topology = this.topology(sandboxId);
    const steps: ProvisionStep[] = [];

    // Step 1 — Docker is reachable and the sandbox image is present.
    const engineStep = await this.#runStep(steps, 'container-engine', 'Container engine available', async () => {
      await this.#docker.ping();
      const version = await this.#docker.version();
      if (!(await this.#docker.imageExists(this.#image))) {
        throw new Error(
          `sandbox image '${this.#image}' is not present — build it with: bash scripts/ansible-image-build.sh`,
        );
      }
      return `Docker ${version} — image ${this.#image}`;
    });
    if (!engineStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'error', { message: engineStep.detail }),
        steps,
        error: this.#toLabError(engineStep.error, 'PROVISION_FAILED', {
          remediation:
            'Start Docker and build the sandbox image: bash scripts/ansible-image-build.sh',
        }),
      };
    }

    // Step 2 — the private topology exists: one network, one control node,
    // N managed nodes, all labelled as owned by this session.
    const labels = ownershipLabels({
      sessionId: context.sessionId,
      labId: context.labId,
      expiresAtMs: context.expiresAtMs,
    });

    const topologyStep = await this.#runStep(
      steps,
      'environment-created',
      'Isolated environment created',
      async () => {
        // Re-creating an existing sandbox must initialise it, not fail.
        await this.#removeSandboxObjects(topology);
        await this.#docker.createNetwork(topology.network, labels);

        const keys = await generateSessionKeyPair(sandboxId);
        this.#keys.set(sandboxId, keys);

        await this.#docker.runContainer(this.#controlSpec(topology, labels, keys));
        for (const node of topology.managed) {
          await this.#docker.runContainer(this.#nodeSpec(topology, node, labels, keys));
        }

        return `${topology.nodes.length} containers on a private network (${topology.network})`;
      },
    );
    if (!topologyStep.ok) {
      await this.#removeSandboxObjects(topology).catch(() => undefined);
      return {
        ok: false,
        environment: this.#environment(context, 'error', { message: topologyStep.detail }),
        steps,
        error: this.#toLabError(topologyStep.error, 'PROVISION_FAILED'),
      };
    }

    // Step 3 — SSH is genuinely up everywhere, and the session key opens it.
    const sshStep = await this.#runStep(steps, 'ssh-ready', 'Managed nodes reachable', async () => {
      // sshd is the last thing each container's entrypoint starts, so waiting
      // for it is also how we know the shell user and its home directory exist
      // — which the key install needs.
      await this.#waitForSshd(topology);
      await this.#installPrivateKey(topology, this.#keys.get(sandboxId)!);
      const unreachable = await this.#unreachableNodes(topology);
      if (unreachable.length > 0) {
        throw new Error(`control node cannot reach: ${unreachable.join(', ')}`);
      }
      return `${topology.managed.length} managed node(s) answering over SSH`;
    });
    if (!sshStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'degraded', { message: sshStep.detail }),
        steps,
        error: this.#toLabError(sshStep.error, 'PROVISION_FAILED', {
          remediation: 'Check `docker logs` for the session control container.',
        }),
      };
    }

    // Step 4 — the lab's starting project, for labs that ship one.
    const workspaceStep = await this.#runStep(
      steps,
      'lab-initial-state',
      'Lab initial state ready',
      async () => this.#seedWorkspace(context, topology),
    );
    if (!workspaceStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'degraded', { message: workspaceStep.detail }),
        steps,
        error: this.#toLabError(workspaceStep.error, 'SETUP_FAILED', {
          remediation: `Check the workspace declared by ${context.labId}.`,
        }),
      };
    }

    // Step 5 — ansible genuinely works in this sandbox.
    let ansibleVersion = 'unknown';
    const ansibleStep = await this.#runStep(steps, 'ansible', 'Ansible ready', async () => {
      const result = await this.execute(context, { command: 'ansible', args: ['--version'] });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `ansible exited with code ${result.exitCode}`);
      }
      ansibleVersion = result.stdout.split('\n')[0]?.trim() ?? 'unknown';
      return ansibleVersion;
    });
    if (!ansibleStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'degraded', { message: ansibleStep.detail }),
        steps,
        error: this.#toLabError(ansibleStep.error, 'PROVISION_FAILED'),
      };
    }

    return {
      ok: true,
      environment: this.#environment(context, 'ready', {
        nodes: await this.#nodeInfo(topology, ansibleVersion),
      }),
      steps,
    };
  }

  // ---------------------------------------------------------------- status

  async status(context: LabSessionContext): Promise<EnvironmentInfo> {
    if (!isSandboxId(context.namespace)) {
      return this.#environment(context, 'error', { message: 'invalid sandbox id' });
    }
    const topology = this.topology(context.namespace);

    try {
      await this.#docker.ping();
    } catch (error) {
      return this.#environment(context, 'error', { message: describe(error) });
    }

    try {
      const states = await Promise.all(
        topology.nodes.map(async (node) => ({
          node,
          info: await this.#docker.inspectContainer(node.container),
        })),
      );

      if (states.every(({ info }) => info === null)) {
        return this.#environment(context, 'not_created', {
          message: `no containers exist for sandbox ${topology.sandboxId}`,
        });
      }

      const notRunning = states.filter(({ info }) => info?.state !== 'running');
      return this.#environment(context, notRunning.length === 0 ? 'ready' : 'degraded', {
        nodes: states.map(({ node, info }) => ({
          name: node.name,
          ready: info?.state === 'running',
          roles: [node.role],
          version: info?.state ?? 'absent',
        })),
        ...(notRunning.length > 0
          ? { message: `node(s) not running: ${notRunning.map(({ node }) => node.name).join(', ')}` }
          : {}),
      });
    } catch (error) {
      return this.#environment(context, 'error', { message: describe(error) });
    }
  }

  // ----------------------------------------------------------------- reset

  /**
   * Restore the lab's starting condition without ending the session.
   *
   * The managed nodes are replaced outright — a fresh container is the most
   * complete "undo" available and costs about a second — while the control node
   * survives so the student's terminal stays connected. Its project directory
   * is emptied and re-seeded from the lab's workspace on disk, which is what
   * makes the baseline a repository artefact rather than remembered state.
   */
  async reset(context: LabSessionContext): Promise<ResetResult> {
    const sandboxId = assertValidSandboxId(context.namespace);
    const topology = this.topology(sandboxId);
    const steps: ProvisionStep[] = [];
    const removed: string[] = [];
    let restored: string[] = [];

    const keys = this.#keys.get(sandboxId);
    if (!keys) {
      return {
        ok: false,
        removed,
        restored,
        steps,
        environment: await this.status(context),
        error: {
          code: 'RESET_FAILED',
          message: 'This session has no credentials on record; it cannot be reset.',
          remediation: 'End the lab and start it again to get a fresh environment.',
        },
      };
    }

    const labels = ownershipLabels({
      sessionId: context.sessionId,
      labId: context.labId,
      expiresAtMs: context.expiresAtMs,
    });

    const nodeStep = await this.#runStep(steps, 'nodes-recreated', 'Managed nodes rebuilt', async () => {
      for (const node of topology.managed) {
        await this.#docker.removeContainer(node.container);
        removed.push(`container/${node.name}`);
        await this.#docker.runContainer(this.#nodeSpec(topology, node, labels, keys));
      }
      await this.#waitForSshd(topology);
      const unreachable = await this.#unreachableNodes(topology);
      if (unreachable.length > 0) {
        throw new Error(`control node cannot reach: ${unreachable.join(', ')}`);
      }
      return `${topology.managed.length} managed node(s) restored to a clean state`;
    });
    if (!nodeStep.ok) {
      return this.#failedReset(context, steps, removed, restored, nodeStep.error);
    }

    const workspaceStep = await this.#runStep(
      steps,
      'workspace-restored',
      'Lab project restored',
      async () => {
        await this.#clearWorkspace(topology);
        removed.push(`workspace/${ANSIBLE_WORKSPACE_DIR}`);
        const detail = await this.#seedWorkspace(context, topology);
        restored = context.lab.setup.workspace_dir ? [context.lab.setup.workspace_dir] : [];
        return detail;
      },
    );
    if (!workspaceStep.ok) {
      return this.#failedReset(context, steps, removed, restored, workspaceStep.error, 'SETUP_FAILED');
    }

    const healthStep = await this.#runStep(steps, 'health', 'Environment healthy', async () => {
      const info = await this.status(context);
      if (info.phase !== 'ready') throw new Error(info.message ?? `environment phase is '${info.phase}'`);
      return `${info.nodes?.length ?? 0} container(s) running`;
    });

    const environment = await this.status(context);
    if (!healthStep.ok) {
      return {
        ok: false,
        removed,
        restored,
        steps,
        environment,
        error: this.#toLabError(healthStep.error, 'RESET_FAILED'),
      };
    }

    return { ok: true, removed, restored, steps, environment };
  }

  // --------------------------------------------------------------- destroy

  async destroy(context: LabSessionContext): Promise<DestroyResult> {
    return this.destroyNamespace(context.namespace, context.sessionId);
  }

  /**
   * Tear one sandbox down, and confirm it is gone.
   *
   * The same four gates the Kubernetes provider applies, in the same order:
   * the name must parse as a sandbox name, it must not be protected, the *live*
   * objects must carry `jumptotech.io/managed=true`, and when a session id is
   * supplied the ownership label must match. Gates three and four are re-read
   * from Docker on every call, so a stale record cannot authorise a delete.
   *
   * Already-absent counts as success, which is what makes the reaper safe to
   * re-enter.
   */
  async destroyNamespace(namespace: string, expectedSessionId?: string): Promise<DestroyResult> {
    const steps: ProvisionStep[] = [];

    if (!isSandboxId(namespace)) {
      return this.#refuseDestroy(steps, namespace, `'${namespace}' is not a JumpToTech lab sandbox name`);
    }
    const topology = this.topology(namespace);

    let ownershipLabels: Record<string, string> | null = null;
    let anythingExists = false;
    try {
      /*
       * Presence and ownership are two separate questions, asked separately on
       * purpose. `networkExists` sees a network whatever its labels say; the
       * managed listing sees only ours. A sandbox-shaped network that exists
       * but is not in the managed listing is therefore reported as present and
       * unowned — which is refused, not silently reported as already gone.
       */
      const networkPresent = await this.#docker.networkExists(topology.network);
      if (networkPresent) {
        anythingExists = true;
        const managed = (await this.#docker.listNetworks(MANAGED_SELECTOR)).find(
          (candidate) => candidate.name === topology.network,
        );
        ownershipLabels = managed?.labels ?? {};
      }

      for (const node of topology.nodes) {
        const info = await this.#docker.inspectContainer(node.container);
        if (!info) continue;
        anythingExists = true;
        if (ownershipLabels === null) ownershipLabels = info.labels;
      }
    } catch (error) {
      steps.push({
        id: 'verify-managed',
        label: 'Sandbox ownership verified',
        status: 'failed',
        detail: describe(error),
      });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    if (!anythingExists) {
      steps.push({ id: 'delete-sandbox', label: 'Sandbox deleted', status: 'ok', detail: 'already absent' });
      this.#keys.delete(namespace);
      return { ok: true, namespaceGone: true, steps };
    }

    const check = assertDeletable(namespace, ownershipLabels, expectedSessionId);
    if (!check.managed) {
      return this.#refuseDestroy(steps, namespace, check.reason ?? 'not managed by JumpToTech');
    }
    steps.push({ id: 'verify-managed', label: 'Sandbox ownership verified', status: 'ok' });

    try {
      await this.#removeSandboxObjects(topology);
    } catch (error) {
      steps.push({ id: 'delete-sandbox', label: 'Sandbox deleted', status: 'failed', detail: describe(error) });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    // The session key dies with the sandbox: there is no copy anywhere else.
    this.#keys.delete(namespace);

    const gone = await this.#sandboxGone(topology);
    steps.push({
      id: 'delete-sandbox',
      label: 'Sandbox deleted',
      status: gone ? 'ok' : 'pending',
      detail: gone ? `${topology.nodes.length} container(s) and 1 network removed` : 'still terminating',
    });

    return {
      ok: true,
      namespaceGone: gone,
      steps,
      ...(gone
        ? {}
        : { error: { code: 'DESTROY_FAILED' as const, message: `sandbox ${namespace} is still terminating` } }),
    };
  }

  #refuseDestroy(steps: ProvisionStep[], namespace: string, reason: string): DestroyResult {
    const message = `Refusing to delete sandbox: ${reason}`;
    steps.push({ id: 'verify-managed', label: 'Sandbox ownership verified', status: 'failed', detail: message });
    return {
      ok: false,
      namespaceGone: false,
      steps,
      error: {
        code: 'DESTROY_FAILED',
        message,
        remediation:
          'Cleanup only ever removes containers and networks this platform created and labelled.',
      },
    };
  }

  // ----------------------------------------------------------- credentials

  /**
   * Mint the shell credential for one session.
   *
   * The student's terminal reaches the control node over SSH on the loopback
   * interface with the session's own key. There is no ambient credential
   * anywhere in the path: the terminal service holds no key of its own, and the
   * key it is handed opens exactly one sandbox and expires with the session.
   */
  async issueCredentials(context: LabSessionContext): Promise<StudentCredentials> {
    const sandboxId = assertValidSandboxId(context.namespace);
    const topology = this.topology(sandboxId);

    const keys = this.#keys.get(sandboxId);
    if (!keys) {
      throw new Error(
        'no session key is on record for this sandbox; end the lab and start it again',
      );
    }

    const bindings = await this.#docker.publishedPorts(topology.control.container, 22);
    const binding = bindings[0];
    if (!binding) {
      throw new Error(`control node ${topology.control.container} has no published SSH port`);
    }

    const remainingMs = Math.max(0, context.expiresAtMs - this.#now());
    const ttlSeconds = Math.max(
      60,
      Math.min(context.policy.credentialTtlSeconds, Math.ceil(remainingMs / 1000)),
    );

    return {
      // No Kubernetes credential exists for an Ansible sandbox, and the field
      // is left empty rather than filled with something meaningless.
      kubeconfig: '',
      namespace: context.namespace,
      serviceAccountName: ANSIBLE_SHELL_USER,
      expiresAt: new Date(this.#now() + ttlSeconds * 1000).toISOString(),
      shell: 'ssh',
      ssh: {
        host: this.#sshHost,
        port: binding.hostPort,
        user: ANSIBLE_SHELL_USER,
        privateKey: keys.privateKey,
        workdir: ANSIBLE_WORKSPACE_DIR,
      },
    };
  }

  // --------------------------------------------------------------- cleanup

  /**
   * Every sandbox this provider owns, read from the network labels.
   *
   * The network is the anchor rather than a container: it is created first and
   * removed last, so a half-provisioned sandbox is still discoverable by the
   * reaper.
   */
  async listManagedNamespaces(): Promise<ManagedNamespace[]> {
    const networks = await this.#docker.listNetworks(MANAGED_SELECTOR);
    return networks
      .filter((network) => network.name.endsWith('-net'))
      .map((network) => network.name.slice(0, -'-net'.length))
      .filter((sandboxId) => isSandboxId(sandboxId))
      .map((sandboxId) => {
        const labels =
          networks.find((network) => network.name === `${sandboxId}-net`)?.labels ?? {};
        return {
          namespace: sandboxId,
          sessionId: labels[SESSION_LABEL] ?? '',
          labId: labels[LAB_LABEL] ?? '',
          expiresAtMs: expiryFromLabels(labels),
          phase: labels[MANAGED_LABEL] === 'true' ? 'Active' : 'Unknown',
        };
      });
  }

  // --------------------------------------------------------------- execute

  /**
   * Run one allow-listed binary on the control node with an explicit argv.
   *
   * There is no shell: arguments are passed as array elements, so their content
   * cannot become syntax. Only the three `ansible*` binaries are permitted, and
   * this method is reachable from internal health checks only — student
   * commands travel over SSH into the sandbox and never through this process.
   */
  async execute(context: LabSessionContext, request: ExecRequest): Promise<ExecResult> {
    if (!EXEC_ALLOWLIST.has(request.command)) {
      throw new Error(
        `Command '${request.command}' is not allow-listed for provider execution (allowed: ${[...EXEC_ALLOWLIST].join(', ')})`,
      );
    }
    if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string')) {
      throw new Error('execute() requires args to be an array of strings');
    }

    const topology = this.topology(assertValidSandboxId(context.namespace));
    const result = await this.#docker.exec({
      container: topology.control.container,
      argv: [request.command, ...request.args],
      user: ANSIBLE_SHELL_USER,
      workdir: ANSIBLE_WORKSPACE_DIR,
      env: {
        HOME: '/home/student',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        ANSIBLE_HOST_KEY_CHECKING: 'False',
        ANSIBLE_FORCE_COLOR: '0',
      },
      timeoutMs: request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  // ---------------------------------------------------------------- private

  #controlSpec(
    topology: AnsibleTopology,
    labels: Record<string, string>,
    keys: SessionKeyPair,
  ): DockerRunSpec {
    return {
      name: topology.control.container,
      image: this.#image,
      network: topology.network,
      aliases: ['control'],
      hostname: 'control',
      labels: { ...labels, 'jumptotech.io/component': 'ansible-control' },
      env: { JTT_ROLE: 'control', JTT_AUTHORIZED_KEY: keys.publicKey },
      cpus: this.#limits.controlCpus,
      memory: this.#limits.controlMemory,
      pidsLimit: this.#limits.pidsLimit,
      capAdd: [...SANDBOX_CAPABILITIES],
      // Loopback only. The sandbox is reachable from this host and nowhere
      // else; the port is ephemeral and dies with the container.
      publish: ['127.0.0.1::22'],
    };
  }

  #nodeSpec(
    topology: AnsibleTopology,
    node: AnsibleNode,
    labels: Record<string, string>,
    keys: SessionKeyPair,
  ): DockerRunSpec {
    return {
      name: node.container,
      image: this.#image,
      network: topology.network,
      aliases: [node.name],
      hostname: node.name,
      labels: { ...labels, 'jumptotech.io/component': 'ansible-node' },
      env: { JTT_ROLE: 'node', JTT_AUTHORIZED_KEY: keys.publicKey },
      cpus: this.#limits.nodeCpus,
      memory: this.#limits.nodeMemory,
      pidsLimit: this.#limits.pidsLimit,
      capAdd: [...SANDBOX_CAPABILITIES],
      // Managed nodes publish nothing. They are reachable from their own
      // session's control node and from nowhere else at all.
    };
  }

  /** Stream the private key into the control node over stdin. */
  async #installPrivateKey(topology: AnsibleTopology, keys: SessionKeyPair): Promise<void> {
    const result = await this.#docker.exec({
      container: topology.control.container,
      argv: ['/usr/local/bin/jtt-install-key'],
      user: 'root',
      input: keys.privateKey,
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`could not install the session key: ${result.stderr.trim() || 'unknown error'}`);
    }
  }

  async #waitForSshd(topology: AnsibleTopology): Promise<void> {
    const deadline = this.#now() + this.#readyTimeoutMs;
    const pending = new Set(topology.nodes.map((node) => node.container));

    for (;;) {
      for (const container of [...pending]) {
        const result = await this.#docker.exec({
          container,
          argv: ['pgrep', '-x', 'sshd'],
          user: 'root',
          timeoutMs: 10_000,
        });
        if (result.exitCode === 0) pending.delete(container);
      }
      if (pending.size === 0) return;
      if (this.#now() >= deadline) {
        throw new Error(`sshd did not start in: ${[...pending].join(', ')}`);
      }
      await this.#sleep(500);
    }
  }

  /**
   * Which managed nodes the control node cannot open an SSH session to.
   *
   * This is a real connection with the session key, not a ping: it is the same
   * path Ansible will take, so a sandbox that passes here cannot hand the
   * student a broken `ansible all -m ping` on their first command.
   */
  async #unreachableNodes(topology: AnsibleTopology): Promise<string[]> {
    const deadline = this.#now() + this.#readyTimeoutMs;
    let pending = topology.managed.map((node) => node.name);

    for (;;) {
      const stillPending: string[] = [];
      for (const name of pending) {
        const result = await this.#docker.exec({
          container: topology.control.container,
          argv: [
            'ssh',
            '-o',
            'BatchMode=yes',
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            '-o',
            'ConnectTimeout=5',
            '-o',
            'LogLevel=ERROR',
            '-i',
            '/home/student/.ssh/id_lab',
            `${ANSIBLE_MANAGED_USER}@${name}`,
            'true',
          ],
          user: ANSIBLE_SHELL_USER,
          env: { HOME: '/home/student' },
          timeoutMs: 20_000,
        });
        if (result.exitCode !== 0) stillPending.push(name);
      }
      if (stillPending.length === 0) return [];
      if (this.#now() >= deadline) return stillPending;
      pending = stillPending;
      await this.#sleep(1_000);
    }
  }

  /** Write the lab's starting project into the control node. */
  async #seedWorkspace(context: LabSessionContext, topology: AnsibleTopology): Promise<string> {
    const files = await loadLabWorkspace(context.lab);

    await this.#controlExec(topology, ['mkdir', '-p', ANSIBLE_WORKSPACE_DIR]);
    for (const directory of workspaceDirectories(files)) {
      await this.#controlExec(topology, ['mkdir', '-p', `${ANSIBLE_WORKSPACE_DIR}/${directory}`]);
    }
    for (const file of files) {
      await this.#writeWorkspaceFile(topology, file);
    }

    if (files.length === 0) {
      return 'empty project directory created';
    }

    const requirements = context.lab.setup.verify as readonly Requirement[];
    if (requirements.length === 0 || !this.#wait) {
      return `seeded ${files.length} project file${files.length === 1 ? '' : 's'}`;
    }

    const result = await this.#wait({
      namespace: context.namespace,
      requirements,
      timeoutMs: context.lab.setup.verify_timeout_seconds * 1000,
    });
    if (!result.ok) {
      const failed = result.checks
        .filter((check) => check.status !== 'pass')
        .map((check) => `${check.label}${check.detail ? ` (${check.detail})` : ''}`)
        .join('; ');
      throw new Error(`lab initial state did not become ready — ${failed}`);
    }

    return `seeded and verified ${files.length} project file${files.length === 1 ? '' : 's'}`;
  }

  async #writeWorkspaceFile(topology: AnsibleTopology, file: WorkspaceFile): Promise<void> {
    const target = `${ANSIBLE_WORKSPACE_DIR}/${file.relativePath}`;
    const write = await this.#docker.exec({
      container: topology.control.container,
      argv: ['tee', target],
      user: ANSIBLE_SHELL_USER,
      input: file.content,
      timeoutMs: 20_000,
    });
    if (write.exitCode !== 0) {
      throw new Error(`could not write ${file.relativePath}: ${write.stderr.trim() || 'tee failed'}`);
    }
    await this.#controlExec(topology, ['chmod', file.mode, target]);
  }

  /** Empty the project directory without removing it (the student is cd'd into it). */
  async #clearWorkspace(topology: AnsibleTopology): Promise<void> {
    const listing = await this.#docker.exec({
      container: topology.control.container,
      argv: ['ls', '-1A', ANSIBLE_WORKSPACE_DIR],
      user: ANSIBLE_SHELL_USER,
      timeoutMs: 20_000,
    });
    if (listing.exitCode !== 0) return;

    for (const entry of listing.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      await this.#docker.exec({
        container: topology.control.container,
        argv: ['rm', '-rf', `${ANSIBLE_WORKSPACE_DIR}/${entry}`],
        user: ANSIBLE_SHELL_USER,
        timeoutMs: 20_000,
      });
    }
  }

  async #controlExec(topology: AnsibleTopology, argv: string[]): Promise<void> {
    const result = await this.#docker.exec({
      container: topology.control.container,
      argv,
      user: ANSIBLE_SHELL_USER,
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`${argv[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
  }

  async #removeSandboxObjects(topology: AnsibleTopology): Promise<void> {
    for (const node of topology.nodes) {
      await this.#docker.removeContainer(node.container);
    }
    await this.#docker.removeNetwork(topology.network);
  }

  async #sandboxGone(topology: AnsibleTopology): Promise<boolean> {
    for (const node of topology.nodes) {
      if (await this.#docker.inspectContainer(node.container)) return false;
    }
    return !(await this.#docker.networkExists(topology.network));
  }

  async #nodeInfo(topology: AnsibleTopology, ansibleVersion: string): Promise<NodeInfo[]> {
    const nodes: NodeInfo[] = [];
    for (const node of topology.nodes) {
      const info = await this.#docker.inspectContainer(node.container);
      nodes.push({
        name: node.name,
        ready: info?.state === 'running',
        roles: [node.role],
        version: node.role === 'control' ? ansibleVersion : 'managed node',
      });
    }
    return nodes;
  }

  async #failedReset(
    context: LabSessionContext,
    steps: ProvisionStep[],
    removed: string[],
    restored: string[],
    error: unknown,
    code: LabError['code'] = 'RESET_FAILED',
  ): Promise<ResetResult> {
    return {
      ok: false,
      removed,
      restored,
      steps,
      environment: await this.status(context),
      error: this.#toLabError(error, code),
    };
  }

  async #runStep(
    steps: ProvisionStep[],
    id: string,
    label: string,
    fn: () => Promise<string | undefined>,
  ): Promise<{ ok: boolean; detail?: string; error?: unknown }> {
    const startedAt = this.#now();
    try {
      const detail = await fn();
      const step: ProvisionStep = { id, label, status: 'ok', durationMs: this.#now() - startedAt };
      if (detail) step.detail = detail;
      steps.push(step);
      return { ok: true, ...(detail ? { detail } : {}) };
    } catch (error) {
      const detail = describe(error);
      steps.push({ id, label, status: 'failed', detail, durationMs: this.#now() - startedAt });
      return { ok: false, detail, error };
    }
  }

  #toLabError(
    error: unknown,
    fallback: LabError['code'],
    extra: { remediation?: string } = {},
  ): LabError {
    const code: LabError['code'] =
      error instanceof DockerUnavailableError ? 'ENVIRONMENT_UNREACHABLE' : fallback;
    return { code, message: describe(error), ...extra };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
