/**
 * `LabProvider` backed by one throwaway container per session.
 *
 * This is the engine behind the Linux and Terraform providers (and, when its
 * sandbox is genuinely safe, the Docker one). The three differ only in image,
 * provider id, and the label on the terminal — everything about the lifecycle,
 * the guardrails, the reset, the cleanup and the verification reads is here.
 *
 * ```text
 *   Student session
 *        ↓
 *   ContainerLabProvider
 *        ↓
 *   docker run --network none --cap-drop ALL --user student
 *              --cpus … --memory … --pids-limit …
 *        ↓
 *   jtt-lab-3f9c1a7b2d40      one container, one session, no host mounts
 *        ↓
 *   bash (docker exec, as student)      ← the browser terminal attaches here
 *        ↓
 *   verifier reads files back through the same runtime
 * ```
 *
 * ## What bounds a sandbox
 *
 * | Concern | Control |
 * |---|---|
 * | host filesystem | no bind mounts at all, and the Docker socket is never passed in |
 * | privilege | `--user student`, `--cap-drop ALL`, `--security-opt no-new-privileges` |
 * | network | `--network none` by default — a Linux or Terraform lab needs none |
 * | CPU / memory | `--cpus`, `--memory`, `--memory-swap` from `SessionPolicy.sandbox` |
 * | fork bombs | `--pids-limit` |
 * | lifetime | the session's own deadlines, plus the reaper |
 *
 * ## What this is *not*
 *
 * A container is not a virtual machine. Everything shares one kernel, and a
 * kernel or runtime escape crosses every boundary above. This is stated in the
 * README too, and it is why the AWS provider does not hand out real
 * credentials: the isolation here is good enough for a single-tenant teaching
 * laptop, not for hostile multi-tenancy.
 */
import {
  ProviderUnavailableError,
  sandboxRefOf,
  type CreateResult,
  type DestroyResult,
  type EnvironmentInfo,
  type ExecRequest,
  type ExecResult,
  type LabError,
  type LabProvider,
  type LabProviderId,
  type LabSessionContext,
  type ManagedSandbox,
  type ProvisionStep,
  type ResetResult,
  type SandboxPathRead,
  type TerminalContext,
} from '../../types.js';
import {
  assertValidContainerSandboxRef,
  isContainerSandboxRef,
  networkRefForSandbox,
  sandboxRefForNetwork,
  isContainerNetworkRef,
} from '../../session/identifiers.js';
import { resolveSandboxPath, sandboxParent } from '../../session/sandbox-paths.js';
import { loadSetupFiles, type LoadedSetupFile } from '../../session/setup-files.js';
import { loadSeedScripts, type LoadedSeedScript } from '../../session/seed-scripts.js';
import { AVAILABLE, unavailable, type ProviderAvailability } from '../catalog.js';
import {
  CONTAINER_EXPIRES_LABEL,
  CONTAINER_LAB_LABEL,
  CONTAINER_PROVIDER_LABEL,
  CONTAINER_SESSION_LABEL,
  MANAGED_CONTAINER_LABEL,
  MANAGED_CONTAINER_SELECTOR,
  MAX_SANDBOX_READ_BYTES,
  type ContainerInfo,
  type ContainerRuntimePort,
  type NetworkInfo,
} from './runtime.js';
import {
  DEFAULT_RUNTIME_OWNER,
  RUNTIME_OWNER_LABEL,
  ownedByRuntime,
} from '../../k8s/labels.js';

/** Binaries the provider itself may run inside a sandbox, for reads and setup. */
const INTERNAL_EXEC_ALLOWLIST = new Set([
  '/usr/bin/stat',
  '/bin/cat',
  '/usr/bin/tee',
  '/bin/mkdir',
  '/bin/chmod',
  '/bin/rm',
  '/usr/bin/id',
  '/usr/bin/env',
  '/bin/sh',
]);

/**
 * Where a lab's seed scripts land inside the sandbox.
 *
 * Root-owned and mode 0700, and emptied again the moment seeding finishes —
 * successfully or not. The deletion is not tidiness: a troubleshooting lab's
 * seed script *describes the fault it injects*, and a student with `sudo` in
 * their own container would otherwise be able to read the answer key.
 */
const SEED_DIR = '/opt/jumptotech/seed';

/** Cap on what one inspection command may return to the verifier. */
const MAX_INSPECT_OUTPUT_BYTES = 256 * 1024;

/** How long one seed script may take before the sandbox is declared broken. */
const SEED_TIMEOUT_MS = 120_000;

export interface ContainerProviderOptions {
  id: LabProviderId;
  /** Implementation name shown to operators, e.g. `docker-linux`. */
  name: string;
  runtime: ContainerRuntimePort;
  /** Sandbox image. Built on the host by `npm run sandbox:build`. */
  image: string;
  /** Where the student lands, and the root every verifier path resolves under. */
  home?: string;
  /** Binaries a lab's own environment must contain for this provider to be usable. */
  requiredBinaries?: string[];
  /**
   * Capabilities added back after `--cap-drop ALL`, from the closed list in
   * `runtime.ts`. Empty for every provider whose labs do not administer the
   * sandbox itself.
   */
  capabilities?: string[];
  /**
   * Whether `--security-opt no-new-privileges` is applied. Only a provider
   * whose labs teach `sudo` turns it off, and only for its own sandboxes.
   */
  noNewPrivileges?: boolean;
  /**
   * Which runtime owns the sandboxes this provider creates.
   *
   * Production leaves it unset and gets the single default owner. Concurrent
   * runtimes — a second worktree, a parallel test process — set their own, and
   * thereafter neither can discover or delete the other's sandboxes.
   */
  runtimeOwner?: string;
  /**
   * The account the container's **foreground process** runs as.
   *
   * Defaults to the same unprivileged user the student gets, which is right for
   * a sandbox whose foreground process is `sleep infinity`. The Linux sandbox
   * runs a real process supervisor instead, which has to be root to supervise
   * services that drop to their own accounts — so it overrides this.
   *
   * It does **not** change who the student is. Shells, verifier reads and
   * provider health checks all attach with `--user <policy.sandbox.user>`
   * regardless; this is only the init process.
   */
  containerUser?: string;
  /**
   * The sandbox's hostname.
   *
   * Student-visible — it is in the prompt, and a scripting lab may legitimately
   * grade what `hostname` reports — so it is a provider decision rather than a
   * literal buried in the lifecycle.
   */
  hostname?: string;
  /**
   * The container's long-running foreground process.
   *
   * `sleep infinity` is right for a sandbox that is only ever a filesystem with
   * shells exec'd into it. The Linux sandbox runs a real process supervisor
   * instead, because LINUX-005 teaches services and a supervisor that is not
   * actually running is not a service manager.
   */
  foregroundCommand?: string[];
  /**
   * Inspection binaries the verifier may run inside this provider's sandboxes.
   *
   * Empty by default: a provider whose labs verify by reading files needs no
   * exec at all, and `verifyCommand` refuses everything until a provider opts
   * in. `LinuxLabProvider` passes `VERIFIER_COMMANDS`.
   */
  inspectionCommands?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ContainerLabProvider implements LabProvider {
  readonly id: LabProviderId;
  readonly name: string;
  readonly sandboxKind = 'container' as const;

  readonly #runtime: ContainerRuntimePort;
  readonly #image: string;
  readonly #home: string;
  readonly #requiredBinaries: string[];
  readonly #capabilities: string[];
  readonly #containerUser: string | undefined;
  readonly #hostname: string;
  readonly #foregroundCommand: string[];
  readonly #noNewPrivileges: boolean;
  readonly #runtimeOwner: string;
  readonly #inspectionCommands: ReadonlySet<string>;
  readonly #now: () => number;

  constructor(options: ContainerProviderOptions) {
    this.id = options.id;
    this.name = options.name;
    this.#runtime = options.runtime;
    this.#image = options.image;
    this.#home = options.home ?? '/home/student';
    this.#requiredBinaries = options.requiredBinaries ?? [];
    this.#capabilities = options.capabilities ?? [];
    this.#containerUser = options.containerUser;
    this.#hostname = options.hostname ?? 'lab';
    this.#foregroundCommand = options.foregroundCommand ?? ['sleep', 'infinity'];
    this.#noNewPrivileges = options.noNewPrivileges ?? true;
    this.#runtimeOwner = options.runtimeOwner ?? DEFAULT_RUNTIME_OWNER;
    this.#inspectionCommands = new Set(options.inspectionCommands ?? []);
    this.#now = options.now ?? (() => Date.now());
  }

  get image(): string {
    return this.#image;
  }

  get home(): string {
    return this.#home;
  }

  // ---------------------------------------------------------- availability

  /**
   * Two questions, answered separately because the fixes differ: can we reach a
   * container runtime at all, and has the sandbox image been built?
   */
  async availability(): Promise<ProviderAvailability> {
    try {
      await this.#runtime.ping();
    } catch (error) {
      return unavailable(
        `no container runtime is reachable (${describe(error)})`,
        'Start Docker Desktop (or your container runtime) and reload the catalog.',
      );
    }

    try {
      if (!(await this.#runtime.imageExists(this.#image))) {
        return unavailable(
          `the sandbox image '${this.#image}' has not been built on this machine`,
          'Build the sandbox images once with: npm run sandbox:build',
        );
      }
    } catch (error) {
      return unavailable(`could not inspect '${this.#image}' (${describe(error)})`);
    }

    return AVAILABLE;
  }

  // ---------------------------------------------------------------- create

  async create(context: LabSessionContext): Promise<CreateResult> {
    const steps: ProvisionStep[] = [];
    const ref = this.#ref(context);

    // One session, one private bridge. Created before the container that joins
    // it, so the sandbox never briefly exists on the wrong network.
    const labNetwork = this.#labNetwork(context);
    const ownership = {
      [MANAGED_CONTAINER_LABEL]: 'true',
      [CONTAINER_SESSION_LABEL]: context.sessionId,
      [CONTAINER_LAB_LABEL]: context.labId,
      [CONTAINER_EXPIRES_LABEL]: String(context.expiresAtMs),
      [CONTAINER_PROVIDER_LABEL]: this.id,
    };

    if (labNetwork) {
      const networkStep = await this.#runStep(
        steps,
        'network-created',
        'Lab network created',
        async () => {
          await this.#runtime.networkCreate({ name: labNetwork, labels: ownership });
          return `private lab network ${labNetwork} created (internal: no route off it)`;
        },
      );
      if (!networkStep.ok) {
        return {
          ok: false,
          environment: this.#environment(context, 'error', { message: networkStep.detail }),
          steps,
          error: this.#toLabError(networkStep.error, 'PROVISION_FAILED', {
            remediation: 'Check that Docker is running and can create a bridge network.',
          }),
        };
      }
    }

    const capAdd = this.#capabilitiesFor(context);

    const createStep = await this.#runStep(steps, 'environment-created', 'Environment created', async () => {
      // Re-entrant by design: a create over an existing sandbox replaces it
      // rather than failing, which is what makes a retried Start Lab safe.
      await this.#runtime.remove(ref).catch(() => undefined);
      await this.#runtime.create({
        name: ref,
        image: this.#image,
        hostname: this.#hostname,
        user: this.#containerUser ?? context.policy.sandbox.user,
        workdir: this.#home,
        cpus: context.policy.sandbox.cpus,
        memory: context.policy.sandbox.memory,
        pidsLimit: context.policy.sandbox.pidsLimit,
        network: labNetwork ?? context.policy.sandbox.network,
        ...(capAdd.length > 0 ? { capAdd } : {}),
        noNewPrivileges: this.#noNewPrivileges,
        labels: {
          [MANAGED_CONTAINER_LABEL]: 'true',
          [CONTAINER_SESSION_LABEL]: context.sessionId,
          [CONTAINER_LAB_LABEL]: context.labId,
          [CONTAINER_EXPIRES_LABEL]: String(context.expiresAtMs),
          [CONTAINER_PROVIDER_LABEL]: this.id,
          [RUNTIME_OWNER_LABEL]: this.#runtimeOwner,
        },
        env: {
          JTT_LAB_ID: context.labId,
          HOME: this.#home,
        },
        // A container needs a foreground process to stay alive; the student's
        // shells are `docker exec` children of it.
        command: [...this.#foregroundCommand],
      });
      return `sandbox container ${ref} created (cpus=${context.policy.sandbox.cpus} memory=${context.policy.sandbox.memory} pids=${context.policy.sandbox.pidsLimit} network=${labNetwork ?? context.policy.sandbox.network})`;
    });
    if (!createStep.ok) {
      // The network outlived the container that was meant to join it. Take it
      // back rather than leaving an orphan behind on a shared daemon.
      if (labNetwork) {
        await this.#removeLabNetwork(labNetwork, context.sessionId, steps);
      }
      return {
        ok: false,
        environment: this.#environment(context, 'error', { message: createStep.detail }),
        steps,
        error: this.#toLabError(createStep.error, 'PROVISION_FAILED', {
          remediation: `Check that Docker is running and that '${this.#image}' exists: npm run sandbox:build`,
        }),
      };
    }

    const toolingStep = await this.#runStep(steps, 'sandbox-tooling', 'Sandbox tooling ready', async () =>
      this.#checkTooling(ref, context),
    );
    if (!toolingStep.ok) {
      await this.#runtime.remove(ref).catch(() => undefined);
      return {
        ok: false,
        environment: this.#environment(context, 'degraded', { message: toolingStep.detail }),
        steps,
        error: this.#toLabError(toolingStep.error, 'PROVISION_FAILED', {
          remediation: `Rebuild the sandbox image: npm run sandbox:build`,
        }),
      };
    }

    if (context.lab.setup.files.length > 0 || context.lab.setup.seed_scripts.length > 0) {
      const setupStep = await this.#runStep(steps, 'lab-initial-state', 'Lab initial state ready', async () =>
        this.#applySetup(context),
      );
      if (!setupStep.ok) {
        await this.#runtime.remove(ref).catch(() => undefined);
        return {
          ok: false,
          environment: this.#environment(context, 'degraded', { message: setupStep.detail }),
          steps,
          error: this.#toLabError(setupStep.error, 'SETUP_FAILED', {
            remediation: `Check the setup files declared by ${context.labId}.`,
          }),
        };
      }
    }

    return { ok: true, environment: this.#environment(context, 'ready'), steps };
  }

  // ---------------------------------------------------------------- status

  async status(context: LabSessionContext): Promise<EnvironmentInfo> {
    const ref = this.#ref(context);
    let info: ContainerInfo | null;
    try {
      info = await this.#runtime.inspect(ref);
    } catch (error) {
      return this.#environment(context, 'error', { message: describe(error) });
    }

    if (!info) {
      return this.#environment(context, 'not_created', {
        message: `sandbox container ${ref} does not exist`,
      });
    }
    if (info.state !== 'running') {
      return this.#environment(context, 'degraded', {
        message: `sandbox container ${ref} is ${info.state}`,
      });
    }
    return this.#environment(context, 'ready');
  }

  // ----------------------------------------------------------------- reset

  /**
   * Restore the lab's starting condition by replacing the sandbox.
   *
   * A Kubernetes reset can purge objects and keep the namespace, because the
   * namespace is not where the student's state lives. A container *is* where it
   * lives: files, background processes, shell history and installed packages
   * are all inside it. Deleting selected files back to a baseline would leave
   * whatever else the student changed, so "reset" here means a genuinely fresh
   * container from the same image, re-seeded with the lab's starter files.
   *
   * The cost is that the student's shell is a `docker exec` into the old
   * container and therefore dies. The reset response asks the UI to reconnect
   * the terminal, which reattaches to the new sandbox with the same session.
   */
  async reset(context: LabSessionContext): Promise<ResetResult> {
    const steps: ProvisionStep[] = [];
    const ref = this.#ref(context);
    const removed: string[] = [];
    let restored: string[] = [];

    const destroyStep = await this.#runStep(steps, 'purge', 'Sandbox contents discarded', async () => {
      const existing = await this.#runtime.inspect(ref);
      if (existing) {
        this.#assertOwned(ref, existing, context.sessionId);
        await this.#runtime.remove(ref);
        removed.push(`container/${ref}`);
        return `discarded the previous sandbox container`;
      }
      return 'no sandbox container to discard';
    });
    if (!destroyStep.ok) {
      return this.#failedReset(context, steps, removed, restored, destroyStep.error);
    }

    const recreated = await this.create(context);
    steps.push(...recreated.steps.map((step) => ({ ...step, id: `recreate-${step.id}` })));
    if (!recreated.ok) {
      return {
        ok: false,
        removed,
        restored,
        steps,
        environment: recreated.environment,
        ...(recreated.error ? { error: recreated.error } : {}),
      };
    }
    restored = [
      ...context.lab.setup.files.map((file) => file.path),
      ...context.lab.setup.seed_scripts,
    ];

    return {
      ok: true,
      removed,
      restored,
      steps,
      environment: await this.status(context),
    };
  }

  // --------------------------------------------------------------- destroy

  async destroy(context: LabSessionContext): Promise<DestroyResult> {
    return this.destroySandbox(this.#ref(context), context.sessionId);
  }

  /**
   * Delete one sandbox container, and confirm it is gone.
   *
   * The same four gates the Kubernetes provider applies, in the same order:
   * name shape, then the *live* ownership label, then the session label when a
   * session was named. Labels are re-read from the runtime immediately before
   * the delete, so a stale record cannot authorise one.
   */
  async destroySandbox(sandboxRef: string, expectedSessionId?: string): Promise<DestroyResult> {
    const steps: ProvisionStep[] = [];

    if (!isContainerSandboxRef(sandboxRef)) {
      return refuse(steps, `'${sandboxRef}' is not a JumpToTech sandbox container name`);
    }

    let info: ContainerInfo | null;
    try {
      info = await this.#runtime.inspect(sandboxRef);
    } catch (error) {
      steps.push({
        id: 'verify-managed',
        label: 'Sandbox ownership verified',
        status: 'failed',
        detail: describe(error),
      });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    if (info === null) {
      steps.push({ id: 'delete-sandbox', label: 'Sandbox deleted', status: 'ok', detail: 'already absent' });
      // The container may be gone while its network is not — a hand-removed
      // sandbox, or a create that failed halfway. Teardown is idempotent, so
      // reclaim whatever is left rather than leaving an orphan.
      await this.#removeLabNetwork(networkRefForSandbox(sandboxRef), expectedSessionId, steps);
      return { ok: true, namespaceGone: true, steps };
    }

    try {
      this.#assertOwned(sandboxRef, info, expectedSessionId);
    } catch (error) {
      return refuse(steps, describe(error));
    }
    steps.push({ id: 'verify-managed', label: 'Sandbox ownership verified', status: 'ok' });

    try {
      await this.#runtime.remove(sandboxRef);
    } catch (error) {
      steps.push({ id: 'delete-sandbox', label: 'Sandbox deleted', status: 'failed', detail: describe(error) });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    const gone = (await this.#runtime.inspect(sandboxRef).catch(() => null)) === null;
    steps.push({
      id: 'delete-sandbox',
      label: 'Sandbox deleted',
      status: gone ? 'ok' : 'pending',
      detail: gone ? sandboxRef : `${sandboxRef} is still shutting down`,
    });

    // The network goes with the sandbox it belonged to. Ordered after the
    // container, because Docker refuses to remove a network still in use.
    await this.#removeLabNetwork(networkRefForSandbox(sandboxRef), expectedSessionId, steps);

    return {
      ok: true,
      namespaceGone: gone,
      steps,
      ...(gone
        ? {}
        : { error: { code: 'DESTROY_FAILED' as const, message: `${sandboxRef} is still shutting down` } }),
    };
  }

  // --------------------------------------------------------- lab network

  /**
   * The private network this session's sandbox joins, or `undefined`.
   *
   * `undefined` is the default and the historical behaviour: the container is
   * created with whatever the policy says, which is `--network none`. Only a
   * lab that declared `environment.network: link` gets a name here, and the
   * name is derived from the session's own sandbox reference — trusted platform
   * output, never a string from a lab definition or a browser.
   */
  /**
   * The capabilities this container is created with.
   *
   * The provider's own unconditional set, plus anything the *lab* declared —
   * merged here rather than at construction because a capability like
   * `NET_RAW` belongs to one lab, not to every lab the provider ever runs.
   *
   * Three gates stand between a lab definition and `--cap-add`, and this is the
   * middle one. The schema refuses `sandbox_capabilities` to any provider but
   * `linux` and to any lab that has not also asked for its own segment; this
   * method refuses to honour it for any provider but `linux` even if the schema
   * were somehow bypassed; and the runtime checks every name against
   * `GRANTABLE_CAPABILITIES` before it reaches an argv. `--cap-drop ALL` is
   * applied unconditionally by the runtime regardless of any of this.
   */
  #capabilitiesFor(context: LabSessionContext): string[] {
    const declared = context.lab.environment.sandbox_capabilities ?? [];
    if (declared.length === 0 || this.id !== 'linux') return [...this.#capabilities];
    return [...new Set([...this.#capabilities, ...declared])];
  }

  #labNetwork(context: LabSessionContext): string | undefined {
    if (context.lab.environment.network !== 'link') return undefined;
    return networkRefForSandbox(this.#ref(context));
  }

  /**
   * Delete one session's lab network, having proved it is ours and theirs.
   *
   * The same gates the container teardown applies, in the same order: the name
   * shape first, then the *live* ownership labels re-read from the daemon, then
   * the session label when a session was named. A network that fails any of
   * them is left alone rather than deleted — which is what stops a stale record
   * or a wrong argument from taking out `bridge`, `host`, `none`, or another
   * session's topology.
   */
  async #removeLabNetwork(
    networkRef: string,
    expectedSessionId: string | undefined,
    steps: ProvisionStep[],
  ): Promise<void> {
    if (!isContainerNetworkRef(networkRef)) {
      steps.push({
        id: 'delete-network',
        label: 'Lab network deleted',
        status: 'failed',
        detail: `'${networkRef}' is not a JumpToTech lab network name`,
      });
      return;
    }

    let info;
    try {
      info = await this.#runtime.networkInspect(networkRef);
    } catch (error) {
      steps.push({
        id: 'delete-network',
        label: 'Lab network deleted',
        status: 'failed',
        detail: describe(error),
      });
      return;
    }

    if (!info) {
      steps.push({
        id: 'delete-network',
        label: 'Lab network deleted',
        status: 'ok',
        detail: 'already absent',
      });
      return;
    }

    if (info.labels[MANAGED_CONTAINER_LABEL] !== 'true') {
      steps.push({
        id: 'delete-network',
        label: 'Lab network deleted',
        status: 'failed',
        detail: `${networkRef} is not managed by JumpToTech — left alone`,
      });
      return;
    }

    const owner = info.labels[CONTAINER_SESSION_LABEL];
    if (expectedSessionId && owner && owner !== expectedSessionId) {
      steps.push({
        id: 'delete-network',
        label: 'Lab network deleted',
        status: 'failed',
        detail: `${networkRef} belongs to another session — left alone`,
      });
      return;
    }

    try {
      await this.#runtime.networkRemove(networkRef);
      steps.push({
        id: 'delete-network',
        label: 'Lab network deleted',
        status: 'ok',
        detail: networkRef,
      });
    } catch (error) {
      steps.push({
        id: 'delete-network',
        label: 'Lab network deleted',
        status: 'failed',
        detail: describe(error),
      });
    }
  }

  // --------------------------------------------------------------- cleanup

  async listManagedSandboxes(): Promise<ManagedSandbox[]> {
    const containers = await this.#runtime.list(MANAGED_CONTAINER_SELECTOR);
    const sandboxes = containers
      .filter((c) => isContainerSandboxRef(c.name))
      // A shared daemon may host several providers' sandboxes; each reaps its own.
      .filter((c) => (c.labels[CONTAINER_PROVIDER_LABEL] ?? this.id) === this.id)
      // …and only this runtime's. Two worktrees run the same provider, so this
      // is the only thing that separates their sandboxes.
      .filter((c) => ownedByRuntime(c.labels, this.#runtimeOwner))
      .map((c) => ({
        providerId: this.id,
        sandboxRef: c.name,
        sandboxKind: this.sandboxKind,
        sessionId: c.labels[CONTAINER_SESSION_LABEL] ?? '',
        labId: c.labels[CONTAINER_LAB_LABEL] ?? '',
        expiresAtMs: parseExpiry(c.labels[CONTAINER_EXPIRES_LABEL]),
        phase: c.state,
      }));

    // A lab network whose container has already gone is an orphan in its own
    // right: nothing else would ever name it, and on a shared daemon it would
    // sit there forever. Surfacing it as a sandbox lets the reaper reclaim it
    // through the same ownership-checked teardown, with no reaper changes.
    const known = new Set(sandboxes.map((s) => s.sandboxRef));
    let networks: NetworkInfo[] = [];
    try {
      networks = await this.#runtime.networkList(MANAGED_CONTAINER_SELECTOR);
    } catch {
      // A daemon that cannot list networks still reports its containers.
      return sandboxes;
    }

    for (const network of networks) {
      if (!isContainerNetworkRef(network.name)) continue;
      if ((network.labels[CONTAINER_PROVIDER_LABEL] ?? this.id) !== this.id) continue;
      const sandboxRef = sandboxRefForNetwork(network.name);
      if (known.has(sandboxRef)) continue;
      sandboxes.push({
        providerId: this.id,
        sandboxRef,
        sandboxKind: this.sandboxKind,
        sessionId: network.labels[CONTAINER_SESSION_LABEL] ?? '',
        labId: network.labels[CONTAINER_LAB_LABEL] ?? '',
        expiresAtMs: parseExpiry(network.labels[CONTAINER_EXPIRES_LABEL]),
        phase: 'exited',
      });
    }

    return sandboxes;
  }

  // -------------------------------------------------------------- terminal

  /**
   * The terminal binding: attach a PTY to this session's container.
   *
   * The container name is derived from the session id here, server-side. The
   * browser never sends one, and the terminal service re-validates the name
   * shape before it builds an argv — so even a compromised API cannot talk the
   * terminal into exec'ing an arbitrary container.
   */
  async getTerminalContext(context: LabSessionContext): Promise<TerminalContext> {
    const ref = this.#ref(context);
    const info = await this.#runtime.inspect(ref);
    if (!info) {
      throw new ProviderUnavailableError(this.id, `sandbox container ${ref} does not exist`);
    }
    this.#assertOwned(ref, info, context.sessionId);

    return {
      kind: 'container-exec',
      runtime: 'docker',
      containerRef: ref,
      user: context.policy.sandbox.user,
      workdir: this.#home,
      env: { JTT_LAB_ID: context.labId },
      expiresAt: new Date(context.expiresAtMs).toISOString(),
    };
  }

  // --------------------------------------------------------------- execute

  /**
   * Run one allow-listed binary inside the sandbox.
   *
   * Internal health checks and verifier reads only. As with the Kubernetes
   * provider this is deliberately not wired to any REST route: student commands
   * travel through the terminal service, over an authenticated WebSocket.
   */
  async execute(context: LabSessionContext, request: ExecRequest): Promise<ExecResult> {
    if (!INTERNAL_EXEC_ALLOWLIST.has(request.command)) {
      throw new Error(
        `Command '${request.command}' is not allow-listed for provider execution (allowed: ${[...INTERNAL_EXEC_ALLOWLIST].join(', ')})`,
      );
    }
    if (!Array.isArray(request.args) || request.args.some((a) => typeof a !== 'string')) {
      throw new Error('execute() requires args to be an array of strings');
    }

    const result = await this.#runtime.exec(this.#ref(context), {
      argv: [request.command, ...request.args],
      user: context.policy.sandbox.user,
      workdir: this.#home,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });
    return result;
  }

  // ------------------------------------------------------- verifier reads

  /**
   * Read one path back out of the sandbox, for state-based verification.
   *
   * `stat` is run *without* `-L`, so a symlink reports as a symlink rather than
   * as whatever it points at. That is what stops a student satisfying a
   * `file_content` check by linking the expected path at some other file, and
   * it is why `file_content` additionally requires a regular file.
   *
   * The read runs as the unprivileged student user, so it can see exactly what
   * the student can see — no privileged bypass of the permissions the lab is
   * teaching.
   */
  async readSandboxPath(
    context: LabSessionContext,
    relativePath: string,
    options: { maxBytes?: number } = {},
  ): Promise<SandboxPathRead | null> {
    const ref = this.#ref(context);
    const absolute = resolveSandboxPath(this.#home, relativePath);
    const user = context.policy.sandbox.user;

    const stat = await this.#runtime.exec(ref, {
      argv: ['/usr/bin/stat', '-c', '%F|%a|%U|%G|%s', '--', absolute],
      user,
      workdir: this.#home,
      timeoutMs: 10_000,
    });
    if (stat.exitCode !== 0) return null;

    const [rawType, mode, owner, group, size] = stat.stdout.trim().split('|');
    const type = normalisePathType(rawType);
    const read: SandboxPathRead = {
      type,
      mode: (mode ?? '').padStart(3, '0'),
      owner: owner ?? '',
      group: group ?? '',
      sizeBytes: Number.parseInt(size ?? '0', 10) || 0,
    };

    if (type !== 'file') return read;

    const maxBytes = Math.min(options.maxBytes ?? MAX_SANDBOX_READ_BYTES, MAX_SANDBOX_READ_BYTES);
    const cat = await this.#runtime.exec(ref, {
      argv: ['/bin/cat', '--', absolute],
      user,
      workdir: this.#home,
      timeoutMs: 10_000,
      maxBufferBytes: maxBytes,
    });
    if (cat.exitCode !== 0) return read;

    read.content = cat.stdout.slice(0, maxBytes);
    if (cat.stdout.length > maxBytes) read.truncated = true;
    return read;
  }

  // --------------------------------------------------------------- helpers

  #ref(context: LabSessionContext): string {
    return assertValidContainerSandboxRef(sandboxRefOf(context));
  }

  #environment(
    context: LabSessionContext,
    phase: EnvironmentInfo['phase'],
    extra: Partial<EnvironmentInfo> = {},
  ): EnvironmentInfo {
    const ref = sandboxRefOf(context);
    return {
      environmentId: `${this.name}:${this.#image}/${ref}#${context.labId}`,
      provider: this.name,
      providerId: this.id,
      phase,
      sandboxRef: ref,
      sandboxKind: this.sandboxKind,
      namespace: ref,
      sessionId: context.sessionId,
      image: this.#image,
      ...extra,
    };
  }

  /** Confirm the tools this provider's labs assume are genuinely present. */
  async #checkTooling(ref: string, context: LabSessionContext): Promise<string> {
    const identity = await this.#runtime.exec(ref, {
      argv: ['/usr/bin/id', '-un'],
      user: context.policy.sandbox.user,
      workdir: this.#home,
      timeoutMs: 15_000,
    });
    if (identity.exitCode !== 0) {
      throw new Error(identity.stderr.trim() || 'could not run a command inside the sandbox');
    }
    const who = identity.stdout.trim();
    if (who !== context.policy.sandbox.user) {
      throw new Error(`sandbox shell would run as '${who}', expected '${context.policy.sandbox.user}'`);
    }

    const found: string[] = [];
    for (const binary of this.#requiredBinaries) {
      const probe = await this.#runtime.exec(ref, {
        argv: ['/usr/bin/env', binary, '--version'],
        user: context.policy.sandbox.user,
        workdir: this.#home,
        timeoutMs: 30_000,
      });
      if (probe.exitCode !== 0) {
        throw new Error(
          `'${binary}' is not usable inside ${this.#image}: ${probe.stderr.trim() || `exit ${probe.exitCode}`}`,
        );
      }
      found.push(`${binary} ${firstLine(probe.stdout)}`);
    }

    return found.length > 0 ? `${who}; ${found.join('; ')}` : `unprivileged user '${who}'`;
  }

  /**
   * Put the lab's declared starting condition into the sandbox.
   *
   * Two mechanisms, in a deliberate order. Starter files land first, as the
   * unprivileged student, so they carry exactly the ownership a student's own
   * work would. Seed scripts run second, as the sandbox's root, because that is
   * the only way to stage the system state an administration lab is *about* —
   * an account that already exists, a service already supervised, a log
   * directory populated by something other than the student.
   */
  async #applySetup(context: LabSessionContext): Promise<string> {
    const ref = this.#ref(context);
    const done: string[] = [];

    const files = await loadSetupFiles(context.lab);
    for (const file of files) {
      await this.#writeFile(ref, context.policy.sandbox.user, file);
    }
    if (files.length > 0) {
      done.push(`seeded ${files.length} starter file${files.length === 1 ? '' : 's'}`);
    }

    const scripts = await loadSeedScripts(context.lab);
    if (scripts.length > 0) {
      await this.#runSeedScripts(ref, scripts);
      done.push(`ran ${scripts.length} seed script${scripts.length === 1 ? '' : 's'}`);
    }

    return done.join('; ');
  }

  /**
   * Install, run, and remove a lab's baseline scripts.
   *
   * Each script is written into a root-only directory, marked executable, run
   * once, and deleted immediately — and the directory is emptied again in a
   * `finally`, so a script survives neither success nor failure. Content
   * travels on stdin rather than in a command line, so there is nothing to
   * quote; the only strings that reach an argv are the platform's own fixed
   * paths and a basename this loader produced.
   */
  async #runSeedScripts(ref: string, scripts: readonly LoadedSeedScript[]): Promise<void> {
    try {
      const prepare = await this.#runtime.exec(ref, {
        argv: ['/bin/mkdir', '-p', '--', SEED_DIR],
        user: 'root',
        workdir: '/',
      });
      if (prepare.exitCode !== 0) {
        throw new Error(`could not prepare the seed directory: ${prepare.stderr.trim()}`);
      }

      for (const script of scripts) {
        const target = `${SEED_DIR}/${script.name}`;

        const write = await this.#runtime.exec(ref, {
          argv: ['/usr/bin/tee', '--', target],
          user: 'root',
          workdir: SEED_DIR,
          stdin: script.content,
        });
        if (write.exitCode !== 0) {
          throw new Error(`could not install '${script.source}': ${write.stderr.trim()}`);
        }

        const chmod = await this.#runtime.exec(ref, {
          argv: ['/bin/chmod', '0700', '--', target],
          user: 'root',
          workdir: SEED_DIR,
        });
        if (chmod.exitCode !== 0) {
          throw new Error(`could not make '${script.source}' executable: ${chmod.stderr.trim()}`);
        }

        const run = await this.#runtime.exec(ref, {
          argv: ['/bin/sh', '-c', 'exec "$0"', target],
          user: 'root',
          workdir: '/',
          timeoutMs: SEED_TIMEOUT_MS,
        });
        if (run.timedOut) {
          throw new Error(`seed script '${script.source}' did not finish within ${SEED_TIMEOUT_MS / 1000}s`);
        }
        if (run.exitCode !== 0) {
          throw new Error(
            `seed script '${script.source}' exited with ${run.exitCode}: ${run.stderr.trim().slice(0, 400)}`,
          );
        }
      }
    } finally {
      // Whatever happened above, nothing a lab shipped stays on disk where a
      // student could read it.
      await this.#runtime
        .exec(ref, {
          argv: ['/bin/rm', '-rf', '--', SEED_DIR],
          user: 'root',
          workdir: '/',
        })
        .catch(() => undefined);
    }
  }

  /**
   * Run one allow-listed inspection command for the verifier.
   *
   * The `linux` requirement family needs answers a file read cannot give: is
   * this process running, is this port listening, is this account in that
   * group. They are read-only questions, and this is the only way to ask them —
   * `command` must be one of the provider's declared `inspectionCommands`,
   * arguments are an argv array with no shell anywhere, and output is capped.
   *
   * A provider that declares no inspection commands (Terraform, Docker) refuses
   * every call, so the capability is opt-in per provider rather than implied by
   * having a container.
   */
  async inspectSandbox(
    context: LabSessionContext,
    command: string,
    args: readonly string[],
    options: { asRoot?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    if (!this.#inspectionCommands.has(command)) {
      throw new Error(
        `'${command}' is not an inspection command the '${this.id}' provider offers the verifier`,
      );
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new Error('inspectSandbox() requires args to be an array of strings');
    }

    return this.#runtime.exec(this.#ref(context), {
      argv: [command, ...args],
      // `root` only where the lab explicitly asked for it — reading
      // `/etc/shadow`-adjacent state such as a service directory. Everything
      // else observes exactly what the student can see.
      user: options.asRoot ? 'root' : context.policy.sandbox.user,
      workdir: this.#home,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxBufferBytes: MAX_INSPECT_OUTPUT_BYTES,
    });
  }

  /**
   * Run a script the *student* wrote, inside their own sandbox, as themselves.
   *
   * A separate capability from `inspectSandbox` on purpose. That one runs a
   * fixed set of platform binaries; this one runs student code, which is a
   * different thing to reason about and therefore a different thing to grant.
   * Only `script_runs` uses it, and only a provider that declared inspection
   * commands offers it at all.
   *
   * The path is resolved through the same two-gate rule as every verifier read,
   * so a lab cannot name something outside the sandbox — and there is nothing
   * outside the sandbox to name, because the exec happens inside the container.
   * `sh -c 'exec "$0"'` is used rather than bare argv so that a script without
   * a `#!` line still runs the way a shell would run it; the path arrives as
   * `$0`, never as command text.
   */
  async runSandboxScript(
    context: LabSessionContext,
    scriptPath: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    if (this.#inspectionCommands.size === 0) {
      throw new Error(`the '${this.id}' provider does not run scripts for the verifier`);
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new Error('runSandboxScript() requires args to be an array of strings');
    }

    const absolute = resolveSandboxPath(this.#home, scriptPath);
    return this.#runtime.exec(this.#ref(context), {
      argv: ['/bin/sh', '-c', 'exec "$0" "$@"', absolute, ...args],
      user: context.policy.sandbox.user,
      workdir: this.#home,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxBufferBytes: MAX_INSPECT_OUTPUT_BYTES,
    });
  }

  async #writeFile(ref: string, user: string, file: LoadedSetupFile): Promise<void> {
    const absolute = resolveSandboxPath(this.#home, file.path);
    const parent = sandboxParent(absolute);

    const mkdir = await this.#runtime.exec(ref, {
      argv: ['/bin/mkdir', '-p', '--', parent],
      user,
      workdir: this.#home,
    });
    if (mkdir.exitCode !== 0) {
      throw new Error(`could not create '${parent}': ${mkdir.stderr.trim()}`);
    }

    // `tee` reads the body from stdin, so file content never becomes part of a
    // command line — there is nothing to quote and nothing to escape.
    const write = await this.#runtime.exec(ref, {
      argv: ['/usr/bin/tee', '--', absolute],
      user,
      workdir: this.#home,
      stdin: file.content,
    });
    if (write.exitCode !== 0) {
      throw new Error(`could not write '${file.path}': ${write.stderr.trim()}`);
    }

    const chmod = await this.#runtime.exec(ref, {
      argv: ['/bin/chmod', file.mode, '--', absolute],
      user,
      workdir: this.#home,
    });
    if (chmod.exitCode !== 0) {
      throw new Error(`could not set mode on '${file.path}': ${chmod.stderr.trim()}`);
    }
  }

  /**
   * The ownership gate: managed, then *this provider's*, then this session's.
   *
   * The provider check is the one that is easy to leave out and expensive to
   * omit. One daemon carries every provider's sandboxes, and a Docker sandbox
   * is as managed and as validly labelled as a Linux one — so without it, this
   * provider would delete another provider's sandbox on request. Discovery
   * already filtered on the provider, which hid the hole: the reaper never
   * offered such a sandbox, but `destroySandbox` is public and the reaper is
   * not its only caller.
   *
   * A sandbox created before the label existed carries no provider and is
   * treated as this one's, matching how discovery defaults it — otherwise an
   * upgrade would strand every running sandbox as undeletable.
   */
  #assertOwned(ref: string, info: ContainerInfo, expectedSessionId?: string): void {
    if (info.labels[MANAGED_CONTAINER_LABEL] !== 'true') {
      throw new Error(`container '${ref}' is not labelled ${MANAGED_CONTAINER_LABEL}=true`);
    }
    const owningProvider = info.labels[CONTAINER_PROVIDER_LABEL] ?? this.id;
    if (owningProvider !== this.id) {
      throw new Error(
        `container '${ref}' belongs to the '${owningProvider}' provider, not '${this.id}'`,
      );
    }
    if (!ownedByRuntime(info.labels, this.#runtimeOwner)) {
      throw new Error(
        `container '${ref}' belongs to runtime owner '${
          info.labels[RUNTIME_OWNER_LABEL] ?? '<unset>'
        }', not '${this.#runtimeOwner}'`,
      );
    }
    if (expectedSessionId !== undefined) {
      const owner = info.labels[CONTAINER_SESSION_LABEL];
      if (owner !== expectedSessionId) {
        throw new Error(
          `container '${ref}' belongs to ${owner ?? '<unlabelled>'}, not ${expectedSessionId}`,
        );
      }
    }
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
      error instanceof ProviderUnavailableError ? 'PROVIDER_UNAVAILABLE' : fallback;
    return { code, message: describe(error), ...extra };
  }
}

function refuse(steps: ProvisionStep[], reason: string): DestroyResult {
  const message = `Refusing to delete sandbox: ${reason}`;
  steps.push({
    id: 'verify-managed',
    label: 'Sandbox ownership verified',
    status: 'failed',
    detail: message,
  });
  return {
    ok: false,
    namespaceGone: false,
    steps,
    error: {
      code: 'DESTROY_FAILED',
      message,
      remediation:
        'Cleanup only ever removes sandboxes this platform created and labelled. Remove other containers by hand.',
    },
  };
}

function normalisePathType(raw: string | undefined): SandboxPathRead['type'] {
  switch (raw) {
    case 'regular file':
    case 'regular empty file':
      return 'file';
    case 'directory':
      return 'directory';
    case 'symbolic link':
      return 'symlink';
    default:
      return 'other';
  }
}

function parseExpiry(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
