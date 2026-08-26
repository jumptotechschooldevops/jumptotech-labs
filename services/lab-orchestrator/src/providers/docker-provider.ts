/**
 * `LabProvider` backed by one isolated Docker daemon per session.
 *
 * ```text
 *   browser terminal ──mTLS──► sandbox lab-a1b2  ──► daemon A ──► student containers A
 *   browser terminal ──mTLS──► sandbox lab-c3d4  ──► daemon B ──► student containers B
 * ```
 *
 * **What a sandbox is.** One container, created by this provider on the
 * platform's host daemon, running `docker:dind`. Inside it runs a complete,
 * private Docker daemon with its own image store, container list, volume set,
 * and networks. `docker ps` in session A cannot show session B's containers,
 * not because a filter hides them but because they are registered with a
 * different daemon process entirely.
 *
 * **How a student reaches it.** The dind image generates a fresh certificate
 * authority per container at startup. The student's shell is handed that
 * sandbox's client certificate and `DOCKER_HOST=tcp://lab-…:2376`. Pointing
 * that shell at another session's sandbox fails TLS verification in both
 * directions — see `docker/port.ts` and the isolation tests. Network
 * reachability is therefore not the security boundary; mutual TLS is.
 *
 * **How the platform reaches it.** Not over TLS at all: the provider runs
 * `docker exec <sandbox> docker …` on the host daemon (see `cli-client.ts`), so
 * it never holds a session's private key and cannot leak one.
 *
 * **The one privileged component.** The sandbox container runs `--privileged`,
 * which Docker-in-Docker requires. It is created by the platform, it runs no
 * student process, and it exists precisely so the *host* Docker socket never
 * has to be exposed to anything a student can reach. Its limitations are
 * documented in README → Docker sandbox security.
 *
 * Cost model: starting a Docker lab creates one container, one volume, and
 * (once, shared) one bridge network. It never creates a VM, a cluster, a
 * registry, or a public address. Browsing the catalog creates nothing at all.
 *
 * ## Why this is not `-v /var/run/docker.sock`
 *
 * ```text
 *   ✗ -v /var/run/docker.sock:/var/run/docker.sock
 * ```
 *
 * Mounting the host socket into a student sandbox is equivalent to giving the
 * student root on the host: they could start a privileged container, bind-mount
 * `/`, and read or replace anything — including every other student's sandbox
 * and the platform's own secrets. No amount of RBAC above it would matter. This
 * provider never does that, and no configuration flag enables it.
 *
 * PLATFORM-004 shipped this provider as architecture only, because neither
 * candidate design was safe enough at the time. This is the first of those two
 * designs — one rootless-ish daemon per session — made shippable by moving the
 * boundary onto mutual TLS: the student never holds a credential for the host
 * daemon, only for their own. The residual privilege is the single
 * platform-created `--privileged` sandbox container, which runs no student
 * process; see README → Docker sandbox security for what that does and does not
 * buy, and `sandboxDaemonAvailable` below for the gate that keeps it off on a
 * host that cannot host it.
 */
import type {
  CreateResult,
  DestroyResult,
  EnvironmentInfo,
  ExecRequest,
  ExecResult,
  LabError,
  LabProvider,
  LabProviderId,
  LabSessionContext,
  ManagedSandbox,
  ProvisionStep,
  ResetResult,
  SandboxKind,
  TerminalContext,
} from '../types.js';
import { sandboxRefOf } from '../types.js';
import type { ProviderAvailability } from './catalog.js';
import { AVAILABLE, unavailable } from './catalog.js';
import {
  DockerCommandError,
  DockerSetupError,
  DockerUnreachableError,
  type DockerContainerSummary,
  type DockerEngineFactory,
  type DockerEnginePort,
  type RunContainerSpec,
} from '../docker/port.js';
import {
  describeDockerSetup,
  isEmptyDockerSetup,
  requiredImages,
  type DockerSetupPlan,
} from '../docker/setup.js';
import { noopWorkspace, type WorkspaceFile, type WorkspacePort } from '../docker/workspace.js';
import {
  COMPONENT_LABEL,
  EXPIRES_AT_LABEL,
  LAB_LABEL,
  MANAGED_LABEL,
  MANAGED_SELECTOR,
  SESSION_LABEL,
  assertDeletable,
  expiryFromLabels,
  ownershipLabels,
  PROVIDER_LABEL,
  DEFAULT_RUNTIME_OWNER,
  RUNTIME_OWNER_LABEL,
  ownedByRuntime,
} from '../k8s/labels.js';
import {
  assertValidContainerSandboxRef,
  isContainerSandboxRef,
} from '../session/identifiers.js';
import type { Requirement } from '../requirements.js';
import type { RequirementWaiter } from './kind-provider.js';

/**
 * Where the dind image writes the TLS material it generates for itself.
 *
 * A constant, not configuration: it is fixed by `DOCKER_TLS_CERTDIR`, which
 * this provider sets when it creates the sandbox.
 */
const CERT_DIR = '/certs';

/** Reading a PEM file out of the sandbox is a local exec; it should be instant. */
const CERT_READ_TIMEOUT_MS = 10_000;

/** Only these binaries may ever be invoked by `execute()`. */
const EXEC_ALLOWLIST = new Set(['docker']);

/**
 * The `jumptotech.io/component` value a Docker sandbox carries.
 *
 * The managed label and the `lab-…` name shape are not sufficient on their own:
 * they are shared vocabulary across the whole platform, so *any* managed object
 * with a lab-shaped name would otherwise satisfy them. A per-session Kubernetes
 * node container named `lab-<hash>-control`, for instance, is a well-formed
 * `lab-…` DNS label carrying `managed=true` — and deleting one would take out a
 * running cluster. Requiring the component makes this provider's cleanup
 * strictly about the containers *it* created.
 */
const SANDBOX_COMPONENT = 'docker-sandbox';

function isSandboxComponent(labels: Record<string, string>): boolean {
  return labels[COMPONENT_LABEL] === SANDBOX_COMPONENT;
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/** Default image providing the per-session daemon. Overridden from config. */
export const DEFAULT_DOCKER_SANDBOX_IMAGE = 'docker:27-dind';

export const DOCKER_PROVIDER_DISABLED_REASON =
  'Docker labs need a per-session Docker daemon, which this deployment has not enabled (DOCKER_TRACK_ENABLED=false).';

export const DOCKER_PROVIDER_REMEDIATION =
  'Set DOCKER_TRACK_ENABLED=true on a host with a reachable Docker daemon that permits a privileged sandbox container. See README → Docker sandbox security for what that grants.';

export interface DockerProviderOptions {
  engines: DockerEngineFactory;
  /** Names the environment handle, e.g. `docker:local/lab-a1b2#DOCKER-001`. */
  hostName?: string;
  /** Where a student's authored files live. Defaults to a no-op workspace. */
  workspace?: WorkspacePort;
  /** Confirms a lab's declared initial state actually materialised. */
  waitForRequirements?: RequirementWaiter;
  /** Max time `destroy()` waits for the sandbox to actually disappear. */
  destroyTimeoutMs?: number;
  /**
   * Confirms this host can actually run a per-session daemon.
   *
   * Defaults to `false`. PLATFORM-004 shipped the Docker provider disabled
   * because a per-session daemon needs a `--privileged` sandbox container, and
   * a host that cannot offer one must not pretend to. The composition root
   * turns this on from `DOCKER_TRACK_ENABLED`, so the failure mode is a lab
   * marked unavailable in the catalog rather than one that fails on click.
   */
  sandboxDaemonAvailable?: boolean;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Which runtime owns these sandboxes; see RUNTIME_OWNER_LABEL. */
  runtimeOwner?: string;
}

export class DockerLabProvider implements LabProvider {
  /** The lab-facing provider id, as declared by `environment.provider`. */
  readonly id: LabProviderId = 'docker';
  /** Implementation name, shown to operators only. */
  readonly name = 'docker-sandbox';
  /** A Docker sandbox is one container running this session's own daemon. */
  readonly sandboxKind: SandboxKind = 'container';

  readonly #engines: DockerEngineFactory;
  readonly #runtimeOwner: string;
  readonly #sandboxDaemonAvailable: boolean;
  readonly #hostName: string;
  readonly #workspace: WorkspacePort;
  readonly #wait: RequirementWaiter | undefined;
  readonly #destroyTimeoutMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: DockerProviderOptions) {
    this.#engines = options.engines;
    this.#runtimeOwner = options.runtimeOwner ?? DEFAULT_RUNTIME_OWNER;
    this.#sandboxDaemonAvailable = options.sandboxDaemonAvailable ?? false;
    this.#hostName = options.hostName ?? 'local';
    this.#workspace = options.workspace ?? noopWorkspace;
    this.#wait = options.waitForRequirements;
    this.#destroyTimeoutMs = options.destroyTimeoutMs ?? 90_000;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? sleep;
  }

  /**
   * Can this deployment actually run a Docker lab right now?
   *
   * Two independent gates, in order: the operator must have enabled the track,
   * *and* a host daemon must actually answer. Reported rather than thrown, so a
   * laptop without Docker still serves the rest of the catalog and the Docker
   * cards say plainly why they cannot start here.
   */
  async availability(): Promise<ProviderAvailability> {
    if (!this.#sandboxDaemonAvailable) {
      return unavailable(
        DOCKER_PROVIDER_DISABLED_REASON,
        DOCKER_PROVIDER_REMEDIATION,
      );
    }
    try {
      await this.#engines.host.version();
      return AVAILABLE;
    } catch (error) {
      return unavailable(
        error instanceof Error ? error.message : String(error),
        'Start the Docker daemon on the host running the API, then reload the catalog.',
      );
    }
  }

  environmentId(context: LabSessionContext): string {
    return `${this.name}:${this.#hostName}/${sandboxRefOf(context)}#${context.labId}`;
  }

  /** The Docker volume backing one sandbox's `/var/lib/docker`. */
  static dataVolume(sandbox: string): string {
    return `${sandbox}-data`;
  }

  #environment(
    context: LabSessionContext,
    phase: EnvironmentInfo['phase'],
    extra: Partial<EnvironmentInfo> = {},
  ): EnvironmentInfo {
    return {
      environmentId: this.environmentId(context),
      provider: this.name,
      providerId: this.id,
      phase,
      sandboxRef: sandboxRefOf(context),
      sandboxKind: this.sandboxKind,
      // Kubernetes' view of the same handle. Meaningless for this provider, but
      // the shared payload shape keeps generic callers from branching on track.
      namespace: sandboxRefOf(context),
      sessionId: context.sessionId,
      image: context.policy.docker.image,
      ...extra,
    };
  }

  /** The lab's declared initial state, or an empty plan. */
  #plan(context: LabSessionContext): DockerSetupPlan {
    return (
      context.lab.setup.docker ?? {
        images: [],
        networks: [],
        volumes: [],
        files: [],
        containers: [],
      }
    );
  }

  // ---------------------------------------------------------------- create

  async create(context: LabSessionContext): Promise<CreateResult> {
    const steps: ProvisionStep[] = [];
    assertValidContainerSandboxRef(sandboxRefOf(context));
    const policy = context.policy.docker;

    // Step 1 — the shared bridge the terminal reaches sandboxes over.
    const networkStep = await this.#runStep(
      steps,
      'sandbox-network',
      'Sandbox network ready',
      async () => {
        await this.#engines.host.createNetwork({
          name: policy.network,
          driver: 'bridge',
          labels: { [MANAGED_LABEL]: 'true' },
        });
        return policy.network;
      },
    );
    if (!networkStep.ok) {
      return this.#failedCreate(context, steps, networkStep, 'PROVISION_FAILED', {
        remediation: 'Check that the Docker daemon is running and can create bridge networks.',
      });
    }

    // Step 2 — the sandbox container, with the session's resource controls on it.
    const sandboxStep = await this.#runStep(
      steps,
      'environment-created',
      'Environment created',
      async () => {
        await this.#createSandbox(context);
        return `sandbox ${sandboxRefOf(context)} created (memory ${policy.memory}, cpus ${policy.cpus}, pids ${policy.pidsLimit})`;
      },
    );
    if (!sandboxStep.ok) {
      return this.#failedCreate(context, steps, sandboxStep, 'PROVISION_FAILED', {
        remediation:
          'Docker-in-Docker needs a Docker daemon that permits privileged containers. See README → Docker sandbox security.',
      });
    }

    // Step 3 — the isolated daemon inside it is genuinely serving.
    let serverVersion: string | undefined;
    const daemonStep = await this.#runStep(steps, 'docker-daemon', 'Docker daemon available', async () => {
      serverVersion = await this.#waitForDaemon(context);
      return `Docker Engine ${serverVersion} — private daemon, ${policy.maxContainers} container budget`;
    });
    if (!daemonStep.ok) {
      return this.#failedCreate(context, steps, daemonStep, 'ENVIRONMENT_UNREACHABLE', {
        remediation:
          "The sandbox daemon did not start in time. On a loaded host, dockerd can miss containerd's startup window; the sandbox retries automatically, so raising DOCKER_SANDBOX_READY_TIMEOUT_SECONDS usually resolves it.",
      });
    }

    // Step 4 — the lab's declared starting condition, for labs that have one.
    const plan = this.#plan(context);
    if (!isEmptyDockerSetup(plan)) {
      const setupStep = await this.#runStep(
        steps,
        'lab-initial-state',
        'Lab initial state ready',
        async () => this.#applySetup(context, plan),
      );
      if (!setupStep.ok) {
        return this.#failedCreate(context, steps, setupStep, 'SETUP_FAILED', {
          phase: 'degraded',
          remediation: `Check the setup.docker block declared by ${context.labId}.`,
          extra: { dockerVersion: serverVersion },
        });
      }
    }

    // Step 5 — the student's CLI genuinely works against this daemon.
    const cliStep = await this.#runStep(steps, 'docker-cli', 'docker CLI ready', async () => {
      const result = await this.execute(context, {
        command: 'docker',
        args: ['version', '--format', '{{.Client.Version}}'],
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `docker exited with code ${result.exitCode}`);
      }
      return `client ${result.stdout.trim() || 'unknown'}`;
    });
    if (!cliStep.ok) {
      return this.#failedCreate(context, steps, cliStep, 'EXEC_FAILED', {
        phase: 'degraded',
        remediation: 'The docker CLI must be present inside the sandbox image.',
        extra: { dockerVersion: serverVersion },
      });
    }

    return {
      ok: true,
      environment: this.#environment(context, 'ready', {
        ...(serverVersion ? { kubernetesVersion: serverVersion } : {}),
      }),
      steps,
    };
  }

  /**
   * Create the sandbox container.
   *
   * Three details carry weight:
   *
   *   - `/var/lib/docker` is a dedicated volume. Without it the inner daemon
   *     writes its image store through two stacked overlay filesystems, which
   *     is slow enough that containerd routinely misses dockerd's fixed 15s
   *     startup window and the sandbox never comes up. This is the single
   *     change that makes Docker-in-Docker reliable here.
   *   - `DOCKER_TLS_CERTDIR` makes the image mint its own CA, which is what
   *     gives every session a distinct trust root.
   *   - a restart policy turns a transient containerd timeout into a retry
   *     rather than a failed lab start.
   */
  async #createSandbox(context: LabSessionContext): Promise<void> {
    const policy = context.policy.docker;
    const sandbox = sandboxRefOf(context);

    // Re-creating an existing sandbox re-initialises it, matching the
    // idempotence the LabProvider contract requires.
    await this.#engines.host.removeContainer(sandbox, { force: true, volumes: true });
    await this.#engines.host.createVolume(DockerLabProvider.dataVolume(sandbox), {
      [MANAGED_LABEL]: 'true',
      [SESSION_LABEL]: context.sessionId,
    });

    const daemonArgs = ['--storage-driver', 'overlay2'];
    if (policy.registryMirror) {
      daemonArgs.push('--registry-mirror', policy.registryMirror);
      // A mirror served over plain HTTP has to be named as insecure, or the
      // daemon refuses to use it at all.
      if (policy.registryMirror.startsWith('http://')) {
        daemonArgs.push('--insecure-registry', policy.registryMirror.replace(/^http:\/\//, ''));
      }
    }

    const spec: RunContainerSpec = {
      name: sandbox,
      image: policy.image,
      detach: true,
      // The hostname lands in the daemon's server certificate SANs, which is
      // what lets the student connect to `tcp://lab-…:2376` and verify it.
      hostname: sandbox,
      network: policy.network,
      privileged: policy.privileged,
      restartPolicy: `on-failure:${policy.restartAttempts}`,
      memory: policy.memory,
      cpus: policy.cpus,
      pidsLimit: policy.pidsLimit,
      env: { DOCKER_TLS_CERTDIR: CERT_DIR },
      volumes: [
        { volume: DockerLabProvider.dataVolume(sandbox), destination: '/var/lib/docker' },
      ],
      labels: ownershipLabels({
        sessionId: context.sessionId,
        labId: context.labId,
        expiresAtMs: context.expiresAtMs,
        component: SANDBOX_COMPONENT,
        provider: this.id,
        runtimeOwner: this.#runtimeOwner,
      }),
      args: daemonArgs,
    };

    await this.#engines.host.runContainer(spec);
  }

  /** Poll the sandbox's own daemon until it answers, or the budget runs out. */
  async #waitForDaemon(context: LabSessionContext): Promise<string> {
    const deadline = this.#now() + context.policy.docker.readyTimeoutSeconds * 1000;
    const session = this.#engines.session(sandboxRefOf(context));
    let lastError = 'daemon did not respond';

    for (;;) {
      try {
        const version = await session.version();
        if (version.serverVersion && version.serverVersion !== 'unknown') {
          return version.serverVersion;
        }
        lastError = 'daemon reported no server version';
      } catch (error) {
        lastError = describe(error);
      }
      if (this.#now() >= deadline) {
        throw new DockerUnreachableError(
          `sandbox daemon not ready after ${context.policy.docker.readyTimeoutSeconds}s — ${lastError}`,
        );
      }
      await this.#sleep(1_000);
    }
  }

  // ---------------------------------------------------------------- status

  async status(context: LabSessionContext): Promise<EnvironmentInfo> {
    let sandbox;
    try {
      sandbox = await this.#engines.host.inspectContainer(sandboxRefOf(context));
    } catch (error) {
      return this.#environment(context, 'error', { message: describe(error) });
    }

    if (!sandbox) {
      return this.#environment(context, 'not_created', {
        message: `sandbox ${sandboxRefOf(context)} does not exist`,
      });
    }
    if (!sandbox.running) {
      return this.#environment(context, 'degraded', {
        message: `sandbox ${sandboxRefOf(context)} is ${sandbox.state}`,
      });
    }

    // The container being up is not the same as its daemon serving; a sandbox
    // mid-restart is running but cannot answer, and the UI must say so.
    try {
      const version = await this.#engines.session(sandboxRefOf(context)).version();
      return this.#environment(context, 'ready', { kubernetesVersion: version.serverVersion });
    } catch (error) {
      return this.#environment(context, 'degraded', {
        message: `sandbox daemon not answering: ${describe(error)}`,
      });
    }
  }

  // ----------------------------------------------------------------- reset

  /**
   * Restore the lab's starting condition.
   *
   * Purge what the student made → restore the workspace → re-apply the lab's
   * initial state. The sandbox container itself survives, so the student keeps
   * their session, their terminal, and their credentials; only the contents of
   * their private daemon go back to the baseline.
   */
  async reset(context: LabSessionContext): Promise<ResetResult> {
    assertValidContainerSandboxRef(sandboxRefOf(context));
    const steps: ProvisionStep[] = [];
    const removed: string[] = [];
    let restored: string[] = [];
    const plan = this.#plan(context);

    const purgeStep = await this.#runStep(steps, 'purge', 'Student resources removed', async () => {
      removed.push(...(await this.#purgeSandbox(context, plan)));
      return removed.length > 0 ? removed.join(', ') : 'nothing to remove';
    });
    if (!purgeStep.ok) {
      return this.#failedReset(context, steps, removed, restored, purgeStep.error);
    }

    if (context.lab.reset.docker.workspace && plan.files.length > 0) {
      const workspaceStep = await this.#runStep(
        steps,
        'workspace',
        'Workspace restored',
        async () => {
          await this.#workspace.seed(context.sessionId, plan.files);
          return `${plan.files.length} file(s) restored`;
        },
      );
      if (!workspaceStep.ok) {
        return this.#failedReset(context, steps, removed, restored, workspaceStep.error);
      }
    }

    if (!isEmptyDockerSetup(plan)) {
      const restoreStep = await this.#runStep(
        steps,
        'restore',
        'Lab initial state restored',
        async () => {
          const detail = await this.#applySetup(context, plan);
          restored = plan.containers.map((c) => `container/${c.name}`);
          return detail;
        },
      );
      if (!restoreStep.ok) {
        return this.#failedReset(context, steps, removed, restored, restoreStep.error, 'SETUP_FAILED');
      }
    }

    const healthStep = await this.#runStep(steps, 'health', 'Docker healthy', async () => {
      const info = await this.status(context);
      if (info.phase !== 'ready') throw new Error(info.message ?? `environment is '${info.phase}'`);
      return `Docker Engine ${info.kubernetesVersion ?? 'unknown'} ready`;
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

  /**
   * Empty the session's daemon of everything the student created.
   *
   * Scoped to that one daemon by construction — the session client can only
   * reach the sandbox's own socket — so a reset cannot touch another session
   * or the platform's host daemon, whatever the lab's reset policy says.
   */
  async #purgeSandbox(context: LabSessionContext, plan: DockerSetupPlan): Promise<string[]> {
    const policy = context.lab.reset.docker;
    const session = this.#engines.session(sandboxRefOf(context));
    const removed: string[] = [];

    if (policy.containers) {
      for (const container of await session.listContainers({ all: true })) {
        await session.removeContainer(container.name, { force: true, volumes: false });
        removed.push(`container/${container.name}`);
      }
    }

    if (policy.volumes) {
      for (const volume of await session.listVolumes()) {
        await session.removeVolume(volume.name, true);
        removed.push(`volume/${volume.name}`);
      }
    }

    if (policy.networks) {
      for (const network of await session.listNetworks()) {
        // Docker's three predefined networks cannot be removed and are not the
        // student's to remove; only user-defined networks are in scope.
        if (PREDEFINED_NETWORKS.has(network.name)) continue;
        await session.removeNetwork(network.name);
        removed.push(`network/${network.name}`);
      }
    }

    if (policy.images) {
      // The lab's own images are kept: re-pulling them on every reset would
      // turn a two-second reset into a two-minute one.
      const keep = new Set(requiredImages(plan));
      for (const image of await session.listImages()) {
        if (image.tags.some((tag) => keep.has(tag))) continue;
        const reference = image.tags[0] ?? image.id;
        await session.removeImage(reference, true);
        removed.push(`image/${reference}`);
      }
    }

    return removed;
  }

  // --------------------------------------------------------------- destroy

  async destroy(context: LabSessionContext): Promise<DestroyResult> {
    // The workspace is the student's, and it dies with the session.
    await this.#workspace.destroy(context.sessionId).catch(() => undefined);
    return this.destroySandbox(sandboxRefOf(context), context.sessionId);
  }

  /**
   * Delete a sandbox, and confirm it is gone.
   *
   * The four gates the Kubernetes provider applies, plus one this substrate
   * needs that a namespace does not:
   *
   *   1. the name must parse as a `lab-…` sandbox name;
   *   2. it must not be a protected name;
   *   3. the *live* container must carry `jumptotech.io/managed=true`;
   *   4. it must carry `jumptotech.io/component=docker-sandbox`;
   *   5. when a session id is supplied, the container's session label must match.
   *
   * Gate 4 exists because a Docker daemon is a flat namespace shared with every
   * other component the platform runs on that host, unlike a Kubernetes
   * namespace which only ever holds one session's objects. Without it, any
   * managed container with a lab-shaped name — a per-session cluster node, a
   * future sidecar — would satisfy every other gate.
   *
   * Gates 3–5 are re-read from the daemon on every call, so a stale store
   * record cannot authorise a delete. A sandbox that is already absent is
   * reported as gone, which is what makes repeat calls harmless — and repeat
   * calls happen, because the reaper re-enters teardown until it succeeds.
   */
  async destroySandbox(sandbox: string, expectedSessionId?: string): Promise<DestroyResult> {
    const steps: ProvisionStep[] = [];

    if (!isContainerSandboxRef(sandbox)) {
      return this.#refuseDestroy(steps, sandbox, `'${sandbox}' is not a JumpToTech lab sandbox name`);
    }

    let snapshot;
    try {
      snapshot = await this.#engines.host.inspectContainer(sandbox);
    } catch (error) {
      steps.push({
        id: 'verify-managed',
        label: 'Sandbox ownership verified',
        status: 'failed',
        detail: describe(error),
      });
      return {
        ok: false,
        namespaceGone: false,
        steps,
        error: this.#toLabError(error, 'DESTROY_FAILED'),
      };
    }

    if (snapshot === null) {
      // Already gone. Still sweep the data volume: a crash between container
      // removal and volume removal would otherwise leak disk forever.
      await this.#removeDataVolume(sandbox);
      steps.push({
        id: 'delete-sandbox',
        label: 'Sandbox deleted',
        status: 'ok',
        detail: 'already absent',
      });
      return { ok: true, namespaceGone: true, steps };
    }

    const check = assertDeletable(sandbox, snapshot.labels, expectedSessionId);
    if (!check.managed) {
      return this.#refuseDestroy(steps, sandbox, check.reason ?? 'not managed by JumpToTech');
    }
    if (!ownedByRuntime(snapshot.labels, this.#runtimeOwner)) {
      return this.#refuseDestroy(
        steps,
        sandbox,
        `container '${sandbox}' belongs to runtime owner '${
          snapshot.labels[RUNTIME_OWNER_LABEL] ?? '<unset>'
        }', not '${this.#runtimeOwner}'`,
      );
    }
    if (!isSandboxComponent(snapshot.labels)) {
      return this.#refuseDestroy(
        steps,
        sandbox,
        `container '${sandbox}' is labelled ${COMPONENT_LABEL}='${
          snapshot.labels[COMPONENT_LABEL] ?? '<unset>'
        }', not '${SANDBOX_COMPONENT}'`,
      );
    }
    steps.push({ id: 'verify-managed', label: 'Sandbox ownership verified', status: 'ok' });

    try {
      // `volumes: true` removes anonymous volumes the inner daemon created;
      // the named data volume is removed explicitly below.
      await this.#engines.host.removeContainer(sandbox, { force: true, volumes: true });
    } catch (error) {
      steps.push({
        id: 'delete-sandbox',
        label: 'Sandbox deleted',
        status: 'failed',
        detail: describe(error),
      });
      return {
        ok: false,
        namespaceGone: false,
        steps,
        error: this.#toLabError(error, 'DESTROY_FAILED'),
      };
    }

    const gone = await this.#waitForSandboxGone(sandbox);
    if (gone) await this.#removeDataVolume(sandbox);

    steps.push({
      id: 'delete-sandbox',
      label: 'Sandbox deleted',
      status: gone ? 'ok' : 'pending',
      detail: gone ? sandbox : `${sandbox} is still terminating`,
    });

    return {
      ok: true,
      namespaceGone: gone,
      steps,
      ...(gone
        ? {}
        : { error: { code: 'DESTROY_FAILED' as const, message: `sandbox ${sandbox} is still present` } }),
    };
  }

  /** Remove a sandbox's data volume. Best effort: never fails a teardown. */
  async #removeDataVolume(sandbox: string): Promise<void> {
    await this.#engines.host
      .removeVolume(DockerLabProvider.dataVolume(sandbox), true)
      .catch(() => undefined);
  }

  #refuseDestroy(steps: ProvisionStep[], sandbox: string, reason: string): DestroyResult {
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
          'Cleanup only ever removes containers this platform created and labelled. Remove other containers by hand.',
      },
    };
  }

  async #waitForSandboxGone(sandbox: string): Promise<boolean> {
    const deadline = this.#now() + this.#destroyTimeoutMs;
    for (;;) {
      if ((await this.#engines.host.inspectContainer(sandbox)) === null) return true;
      if (this.#now() >= deadline) return false;
      await this.#sleep(500);
    }
  }

  // ----------------------------------------------------------- credentials

  /**
   * Hand the terminal the client certificate for this session's daemon.
   *
   * The material is read straight out of the sandbox that generated it and is
   * never persisted by the platform. Because every sandbox mints its own CA,
   * what comes back here is usable against exactly one daemon.
   */
  async getTerminalContext(context: LabSessionContext): Promise<TerminalContext> {
    assertValidContainerSandboxRef(sandboxRefOf(context));

    const [ca, clientCert, clientKey] = await Promise.all([
      this.#readCertificate(sandboxRefOf(context), 'ca.pem'),
      this.#readCertificate(sandboxRefOf(context), 'cert.pem'),
      this.#readCertificate(sandboxRefOf(context), 'key.pem'),
    ]);

    const remainingMs = Math.max(0, context.expiresAtMs - this.#now());
    const ttlSeconds = Math.min(
      context.policy.credentialTtlSeconds,
      Math.ceil(remainingMs / 1000) || context.policy.credentialTtlSeconds,
    );

    return {
      kind: 'docker-daemon',
      dockerHost: `tcp://${sandboxRefOf(context)}:${context.policy.docker.daemonPort}`,
      ca,
      clientCert,
      clientKey,
      sandboxRef: sandboxRefOf(context),
      workspaceFiles: this.#plan(context).files.map((file) => ({
        path: file.path,
        content: file.content,
      })),
      expiresAt: new Date(this.#now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async #readCertificate(sandbox: string, file: string): Promise<string> {
    const result = await this.#engines.host.execInContainer(
      sandbox,
      ['cat', `${CERT_DIR}/client/${file}`],
      { timeoutMs: CERT_READ_TIMEOUT_MS },
    );
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw new DockerCommandError(
        `could not read ${file} from sandbox ${sandbox}: ${result.stderr.trim() || 'empty output'}`,
        result.exitCode,
        result.stderr,
      );
    }
    return result.stdout;
  }

  // --------------------------------------------------------------- cleanup

  /**
   * Every sandbox this platform owns, as recorded in container labels.
   *
   * Filtered by the managed label, by the component label, *and* by the sandbox
   * name shape — the same three facts `destroySandbox` re-checks before it
   * removes anything. A hand-labelled container, or another component's
   * container that happens to be named like a sandbox, never enters the
   * reaper's work list.
   */
  async listManagedSandboxes(): Promise<ManagedSandbox[]> {
    const containers = await this.#engines.host.listContainers({
      all: true,
      labelSelector: MANAGED_SELECTOR,
    });

    return (
      containers
        .filter((c) => isContainerSandboxRef(c.name) && isSandboxComponent(c.labels))
        /*
         * And the provider must match.
         *
         * One daemon hosts every provider's sandboxes, so discovery has to be
         * able to say *whose* a sandbox is, not merely that it is ours-shaped.
         * The container providers have always filtered here; this brings the
         * Docker provider onto the same label rather than leaving two answers
         * to one question. Sandboxes created before the label existed carry no
         * provider and are matched by their component, which is what kept them
         * discoverable then and keeps this change backward compatible.
         */
        .filter((c) => (c.labels[PROVIDER_LABEL] ?? this.id) === this.id)
        // …and only this runtime's, so concurrent runtimes never see each other.
        .filter((c) => ownedByRuntime(c.labels, this.#runtimeOwner))
        .map((c) => this.#toManaged(c))
    );
  }

  #toManaged(container: DockerContainerSummary): ManagedSandbox {
    return {
      providerId: this.id,
      sandboxRef: container.name,
      sandboxKind: this.sandboxKind,
      sessionId: container.labels[SESSION_LABEL] ?? '',
      labId: container.labels[LAB_LABEL] ?? '',
      expiresAtMs: expiryFromLabels(container.labels),
      // The reaper skips namespaces it sees as `Terminating`; a Docker sandbox
      // has no such state, so only a genuinely removing container maps to it.
      phase: container.state === 'removing' ? 'Terminating' : 'Active',
    };
  }

  // --------------------------------------------------------------- execute

  /**
   * Run one allow-listed binary against this session's own daemon.
   *
   * Only `docker` is permitted, the argv is an explicit array, and there is no
   * shell. Reachable only from internal health checks — student commands travel
   * through the terminal service over an authenticated WebSocket, never here.
   */
  async execute(context: LabSessionContext, request: ExecRequest): Promise<ExecResult> {
    if (!EXEC_ALLOWLIST.has(request.command)) {
      throw new Error(
        `Command '${request.command}' is not allow-listed for provider execution (allowed: ${[...EXEC_ALLOWLIST].join(', ')})`,
      );
    }
    if (!Array.isArray(request.args) || request.args.some((a) => typeof a !== 'string')) {
      throw new Error('execute() requires args to be an array of strings');
    }

    return this.#engines.host.execInContainer(sandboxRefOf(context), ['docker', ...request.args], {
      timeoutMs: request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    });
  }

  // --------------------------------------------------------------- helpers

  /**
   * Build the lab's declared starting condition inside the session's daemon.
   *
   * Fixed order — images, networks, volumes, workspace files, containers — so a
   * lab can rely on a network existing before the container that joins it
   * without having to express the dependency itself.
   */
  async #applySetup(context: LabSessionContext, plan: DockerSetupPlan): Promise<string> {
    const session = this.#engines.session(sandboxRefOf(context));

    for (const image of requiredImages(plan)) {
      await this.#ensureImage(context, image);
    }
    for (const network of plan.networks) {
      await session.createNetwork({
        name: network.name,
        driver: network.driver,
        internal: network.internal,
      });
    }
    for (const volume of plan.volumes) {
      await session.createVolume(volume.name);
    }
    if (plan.files.length > 0) {
      await this.#workspace.seed(context.sessionId, plan.files as WorkspaceFile[]);
    }
    for (const container of plan.containers) {
      await this.#createSetupContainer(context, container);
    }

    const requirements = context.lab.setup.verify as readonly Requirement[];
    if (requirements.length === 0 || !this.#wait) return describeDockerSetup(plan);

    const result = await this.#wait({
      namespace: sandboxRefOf(context),
      requirements,
      timeoutMs: context.lab.setup.verify_timeout_seconds * 1000,
      // Workspace checks address the student's files by session, not by
      // sandbox — the two are different names for different things.
      sessionId: context.sessionId,
    });
    if (!result.ok) {
      const failed = result.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ''}`)
        .join('; ');
      throw new DockerSetupError(`lab initial state did not become ready — ${failed}`);
    }

    return `${describeDockerSetup(plan)} and verified`;
  }

  /**
   * Make sure the session's daemon holds an image.
   *
   * A missing image would otherwise trigger an implicit pull at the worst
   * moment — during provisioning, over a connection the platform does not
   * control — and turn a slow network into a failed lab start.
   */
  async #ensureImage(context: LabSessionContext, reference: string): Promise<void> {
    const session = this.#engines.session(sandboxRefOf(context));
    if (await session.inspectImage(reference)) return;
    try {
      await session.pullImage(reference);
    } catch (error) {
      throw new DockerSetupError(
        `could not obtain image '${reference}' for ${context.labId}: ${describe(error)}`,
        error,
      );
    }
  }

  /** Create one container from the lab's plan, and leave it in the declared state. */
  async #createSetupContainer(
    context: LabSessionContext,
    container: DockerSetupPlan['containers'][number],
  ): Promise<void> {
    const session = this.#engines.session(sandboxRefOf(context));
    await session.removeContainer(container.name, { force: true, volumes: false });

    const spec: RunContainerSpec = {
      name: container.name,
      image: container.image,
      // A `created` container must not start, so it is not detached-run.
      detach: container.state !== 'created',
      restartPolicy: container.restart,
      ...(container.command ? { command: container.command } : {}),
      ...(container.entrypoint ? { entrypoint: container.entrypoint } : {}),
      ...(container.env ? { env: container.env } : {}),
      ...(container.labels ? { labels: container.labels } : {}),
      ...(container.workdir ? { workingDir: container.workdir } : {}),
      ...(container.network ? { network: container.network } : {}),
      ...(container.memory ? { memory: container.memory } : {}),
      ...(container.cpus ? { cpus: container.cpus } : {}),
      ...(container.ports
        ? {
            ports: container.ports.map((p) => ({
              containerPort: p.container,
              ...(p.host !== undefined ? { hostPort: p.host } : {}),
              protocol: p.protocol,
            })),
          }
        : {}),
      ...(container.volumes
        ? {
            volumes: container.volumes.map((v) => ({
              volume: v.volume,
              destination: v.destination,
              readOnly: v.read_only,
            })),
          }
        : {}),
    };

    if (container.state === 'created') {
      // `docker create` is `run` without starting; the CLI client only knows
      // how to run, so create-and-stop produces the same observable state.
      await session.runContainer({ ...spec, detach: true });
      await session.stopContainer(container.name, 2);
      return;
    }

    await session.runContainer(spec);

    if (container.state === 'exited') {
      // A lab that wants a stopped container usually wants one that *ran* and
      // stopped — that is what leaves logs and an exit code to investigate. If
      // the command is still running, stop it so the declared state is reached.
      await this.#waitForExit(session, container.name);
    }
  }

  /** Give a short-lived container a moment to finish, then stop it if it has not. */
  async #waitForExit(session: DockerEnginePort, name: string, attempts = 10): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const snapshot = await session.inspectContainer(name);
      if (!snapshot || !snapshot.running) return;
      await this.#sleep(500);
    }
    await session.stopContainer(name, 2).catch(() => undefined);
  }

  async #failedCreate(
    context: LabSessionContext,
    steps: ProvisionStep[],
    step: { detail?: string; error?: unknown },
    code: LabError['code'],
    options: {
      remediation?: string;
      phase?: EnvironmentInfo['phase'];
      extra?: { dockerVersion?: string | undefined };
    } = {},
  ): Promise<CreateResult> {
    return {
      ok: false,
      environment: this.#environment(context, options.phase ?? 'error', {
        ...(step.detail ? { message: step.detail } : {}),
        ...(options.extra?.dockerVersion ? { kubernetesVersion: options.extra.dockerVersion } : {}),
      }),
      steps,
      error: this.#toLabError(step.error, code, {
        ...(options.remediation ? { remediation: options.remediation } : {}),
      }),
    };
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

  /**
   * Classify a failure.
   *
   * A daemon that cannot be reached is reported as `ENVIRONMENT_UNREACHABLE`
   * wherever it surfaces, so the UI can tell "Docker is down" apart from "this
   * lab's setup is broken" no matter which step noticed first.
   */
  #toLabError(
    error: unknown,
    fallback: LabError['code'],
    extra: { remediation?: string } = {},
  ): LabError {
    const code: LabError['code'] =
      error instanceof DockerUnreachableError
        ? 'ENVIRONMENT_UNREACHABLE'
        : error instanceof DockerSetupError
          ? 'SETUP_FAILED'
          : fallback;
    return { code, message: describe(error), ...extra };
  }
}

/** Networks Docker creates itself, which no reset may remove. */
const PREDEFINED_NETWORKS = new Set(['bridge', 'host', 'none']);

/** Labels a sandbox carries, re-exported so tests can assert on them. */
export const SANDBOX_LABELS = {
  managed: MANAGED_LABEL,
  session: SESSION_LABEL,
  lab: LAB_LABEL,
  expiresAt: EXPIRES_AT_LABEL,
  component: COMPONENT_LABEL,
  /** The value `component` must hold for this provider to touch a container. */
  componentValue: SANDBOX_COMPONENT,
} as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
