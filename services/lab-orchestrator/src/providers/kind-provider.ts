/**
 * `LabProvider` backed by a local kind cluster.
 *
 * Scope of this provider in PLATFORM-001:
 *   - The kind cluster itself is the *substrate*. It is provisioned once on
 *     the host by `scripts/cluster-up.sh`, deliberately NOT by this process:
 *     creating a kind cluster needs the Docker socket, and a web-facing
 *     service must not hold that capability.
 *   - A *sandbox* is the lab's namespace inside that substrate. `create()`
 *     initialises it to the lab baseline, which is real work and is fully
 *     idempotent.
 *
 * A future `EksLabProvider` / `FirecrackerLabProvider` can own the whole
 * lifecycle including substrate creation without any caller changing.
 */
import { execFile } from 'node:child_process';
import type {
  CreateResult,
  EnvironmentInfo,
  ExecRequest,
  ExecResult,
  LabContext,
  LabError,
  LabProvider,
  ProvisionStep,
  ResetResult,
} from '../types.js';
import { KubernetesUnreachableError, type KubernetesPort } from '../k8s/port.js';

/** Only these binaries may ever be invoked by `execute()`. */
const EXEC_ALLOWLIST = new Set(['kubectl']);

const DEFAULT_EXEC_TIMEOUT_MS = 15_000;

export interface KindProviderOptions {
  k8s: KubernetesPort;
  clusterName: string;
  /** Kubeconfig handed to allow-listed CLI health checks. */
  kubeconfigPath?: string;
  /** Max time to wait for student pods to finish terminating during reset. */
  resetDrainTimeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
}

export class KindLabProvider implements LabProvider {
  readonly name = 'kind';

  readonly #k8s: KubernetesPort;
  readonly #clusterName: string;
  readonly #kubeconfigPath: string | undefined;
  readonly #resetDrainTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: KindProviderOptions) {
    this.#k8s = options.k8s;
    this.#clusterName = options.clusterName;
    this.#kubeconfigPath = options.kubeconfigPath;
    this.#resetDrainTimeoutMs = options.resetDrainTimeoutMs ?? 60_000;
    this.#now = options.now ?? (() => Date.now());
  }

  environmentId(context: LabContext): string {
    return `${this.name}:${this.#clusterName}/${context.namespace}#${context.labId}`;
  }

  // ---------------------------------------------------------------- create

  async create(context: LabContext): Promise<CreateResult> {
    const steps: ProvisionStep[] = [];
    const started = this.#now();

    const environment = (phase: EnvironmentInfo['phase'], extra: Partial<EnvironmentInfo> = {}) =>
      ({
        environmentId: this.environmentId(context),
        provider: this.name,
        phase,
        namespace: context.namespace,
        ...extra,
      }) satisfies EnvironmentInfo;

    // Step 1 — sandbox exists and is initialised to the lab baseline.
    const createStep = await this.#runStep(steps, 'environment-created', 'Environment created', async () => {
      const exists = await this.#k8s.namespaceExists(context.namespace);
      if (!exists) {
        throw new Error(
          `Namespace '${context.namespace}' does not exist in cluster '${this.#clusterName}'.`,
        );
      }
      const purge = await this.#purgeNamespace(context);
      if (purge.length > 0) {
        // Deletion is asynchronous. Wait for it, otherwise the student's very
        // first `kubectl run` races a terminating Pod and fails with
        // "object is being deleted".
        const remaining = await this.#waitForPodsGone(context.namespace);
        if (remaining > 0) {
          throw new Error(
            `${remaining} leftover pod(s) are still terminating in namespace '${context.namespace}'`,
          );
        }
        return `namespace ${context.namespace} initialised (cleared ${purge.length} leftover resource${purge.length === 1 ? '' : 's'})`;
      }
      return `namespace ${context.namespace} initialised`;
    });
    if (!createStep.ok) {
      return {
        ok: false,
        environment: environment('error', { message: createStep.detail }),
        steps,
        error: this.#toLabError('PROVISION_FAILED', createStep.error, {
          remediation: `Ensure the kind cluster is running: npm run cluster:up`,
        }),
      };
    }

    // Step 2 — Kubernetes API reachable, with real version/node data.
    let nodes: EnvironmentInfo['nodes'];
    let kubernetesVersion: string | undefined;
    const apiStep = await this.#runStep(steps, 'kubernetes-api', 'Kubernetes API available', async () => {
      await this.#k8s.ping();
      const version = await this.#k8s.version();
      kubernetesVersion = version.gitVersion;
      nodes = await this.#k8s.listNodes();
      const notReady = nodes.filter((n) => !n.ready);
      if (nodes.length === 0) throw new Error('cluster reports zero nodes');
      if (notReady.length > 0) {
        throw new Error(`node(s) not Ready: ${notReady.map((n) => n.name).join(', ')}`);
      }
      return `${version.gitVersion} — ${nodes.length} node${nodes.length === 1 ? '' : 's'} Ready`;
    });
    if (!apiStep.ok) {
      return {
        ok: false,
        environment: environment('error', { message: apiStep.detail }),
        steps,
        error: this.#toLabError('ENVIRONMENT_UNREACHABLE', apiStep.error, {
          remediation:
            'Check that the kind cluster is running (`kind get clusters`) and that the api container is attached to the `kind` Docker network.',
        }),
      };
    }

    // Step 3 — kubectl genuinely works against this cluster.
    const kubectlStep = await this.#runStep(steps, 'kubectl', 'kubectl ready', async () => {
      const result = await this.execute(context, {
        command: 'kubectl',
        args: ['version', '--output=json'],
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `kubectl exited with code ${result.exitCode}`);
      }
      let clientVersion = 'unknown';
      try {
        const parsed = JSON.parse(result.stdout) as { clientVersion?: { gitVersion?: string } };
        clientVersion = parsed.clientVersion?.gitVersion ?? 'unknown';
      } catch {
        /* version output was not JSON; the exit code already proved kubectl works */
      }
      return `client ${clientVersion}`;
    });
    if (!kubectlStep.ok) {
      return {
        ok: false,
        environment: environment('degraded', { kubernetesVersion, nodes, message: kubectlStep.detail }),
        steps,
        error: this.#toLabError('KUBECTL_UNAVAILABLE', kubectlStep.error, {
          remediation: 'kubectl must be installed in the api/terminal images and KUBECONFIG must be readable.',
        }),
      };
    }

    void started;
    return {
      ok: true,
      environment: environment('ready', { kubernetesVersion, nodes }),
      steps,
    };
  }

  // ---------------------------------------------------------------- status

  async status(context: LabContext): Promise<EnvironmentInfo> {
    const base: EnvironmentInfo = {
      environmentId: this.environmentId(context),
      provider: this.name,
      phase: 'not_created',
      namespace: context.namespace,
    };

    try {
      await this.#k8s.ping();
    } catch (error) {
      return {
        ...base,
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const [version, nodes, nsExists] = await Promise.all([
        this.#k8s.version(),
        this.#k8s.listNodes(),
        this.#k8s.namespaceExists(context.namespace),
      ]);
      if (!nsExists) {
        return { ...base, phase: 'not_created', message: `namespace ${context.namespace} is missing` };
      }
      const notReady = nodes.filter((n) => !n.ready);
      return {
        ...base,
        phase: notReady.length === 0 && nodes.length > 0 ? 'ready' : 'degraded',
        kubernetesVersion: version.gitVersion,
        nodes,
        ...(notReady.length > 0
          ? { message: `node(s) not Ready: ${notReady.map((n) => n.name).join(', ')}` }
          : {}),
      };
    } catch (error) {
      return {
        ...base,
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ----------------------------------------------------------------- reset

  async reset(context: LabContext): Promise<ResetResult> {
    const steps: ProvisionStep[] = [];
    let removed: string[] = [];

    const purgeStep = await this.#runStep(steps, 'purge', 'Student resources removed', async () => {
      removed = await this.#purgeNamespace(context);
      return removed.length > 0 ? removed.join(', ') : 'nothing to remove';
    });
    if (!purgeStep.ok) {
      return {
        ok: false,
        removed,
        steps,
        environment: await this.status(context),
        error: this.#toLabError('RESET_FAILED', purgeStep.error),
      };
    }

    const drainStep = await this.#runStep(steps, 'drain', 'Namespace drained', async () => {
      const remaining = await this.#waitForPodsGone(context.namespace);
      if (remaining > 0) {
        throw new Error(
          `${remaining} pod(s) still terminating after ${Math.round(this.#resetDrainTimeoutMs / 1000)}s`,
        );
      }
      return `namespace ${context.namespace} is empty`;
    });
    if (!drainStep.ok) {
      return {
        ok: false,
        removed,
        steps,
        environment: await this.status(context),
        error: this.#toLabError('RESET_FAILED', drainStep.error),
      };
    }

    const healthStep = await this.#runStep(steps, 'health', 'Kubernetes healthy', async () => {
      const info = await this.status(context);
      if (info.phase !== 'ready') {
        throw new Error(info.message ?? `environment phase is '${info.phase}'`);
      }
      return `${info.kubernetesVersion ?? 'cluster'} — ${info.nodes?.length ?? 0} node(s) Ready`;
    });

    const environment = await this.status(context);
    if (!healthStep.ok) {
      return {
        ok: false,
        removed,
        steps,
        environment,
        error: this.#toLabError('RESET_FAILED', healthStep.error),
      };
    }

    return { ok: true, removed, steps, environment };
  }

  // --------------------------------------------------------------- destroy

  /**
   * Releases the sandbox. For the kind provider this reverts the namespace to
   * baseline rather than deleting the shared local cluster — deleting the
   * substrate would require the Docker socket, which this process does not
   * have by design. `scripts/cluster-down.sh` tears down the substrate.
   */
  async destroy(context: LabContext): Promise<{ ok: boolean; error?: LabError }> {
    try {
      await this.#purgeNamespace(context);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: this.#toLabError('DESTROY_FAILED', error) };
    }
  }

  // --------------------------------------------------------------- execute

  /**
   * Runs one allow-listed binary with an explicit argv array.
   *
   * There is no shell: the command is never string-interpolated, so argument
   * content cannot become syntax. Only `kubectl` is permitted, and this method
   * is reachable only from internal health checks — never from a REST route.
   */
  async execute(context: LabContext, request: ExecRequest): Promise<ExecResult> {
    if (!EXEC_ALLOWLIST.has(request.command)) {
      throw new Error(
        `Command '${request.command}' is not allow-listed for provider execution (allowed: ${[...EXEC_ALLOWLIST].join(', ')})`,
      );
    }
    if (!Array.isArray(request.args) || request.args.some((a) => typeof a !== 'string')) {
      throw new Error('execute() requires args to be an array of strings');
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
    };
    if (this.#kubeconfigPath) env.KUBECONFIG = this.#kubeconfigPath;

    return new Promise<ExecResult>((resolve) => {
      execFile(
        request.command,
        [...request.args, '--namespace', context.namespace],
        { timeout: timeoutMs, env, maxBuffer: 1024 * 1024, shell: false },
        (error, stdout, stderr) => {
          const timedOut = Boolean(
            error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
          );
          let exitCode = 0;
          if (error) {
            const code = (error as { code?: unknown }).code;
            exitCode = typeof code === 'number' ? code : 1;
          }
          resolve({
            exitCode,
            stdout: String(stdout),
            stderr: String(stderr) || (error && exitCode !== 0 ? error.message : ''),
            timedOut,
          });
        },
      );
    });
  }

  // --------------------------------------------------------------- helpers

  /**
   * Delete every purgeable resource in the namespace except protected ones.
   * Returns the `resource/name` pairs that were actually deleted.
   */
  async #purgeNamespace(context: LabContext): Promise<string[]> {
    const protectedSet = new Set(context.protectedResources);
    const removed: string[] = [];

    for (const resource of context.purgeResources) {
      const refs = await this.#k8s.listNamespacedResources(context.namespace, resource);
      for (const ref of refs) {
        const key = `${ref.resource}/${ref.name}`;
        if (protectedSet.has(key)) continue;
        await this.#k8s.deleteNamespacedResource(context.namespace, ref.resource, ref.name);
        removed.push(key);
      }
    }
    return removed;
  }

  async #waitForPodsGone(namespace: string): Promise<number> {
    const deadline = this.#now() + this.#resetDrainTimeoutMs;
    let count = await this.#k8s.countPods(namespace);
    while (count > 0 && this.#now() < deadline) {
      await sleep(500);
      count = await this.#k8s.countPods(namespace);
    }
    return count;
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
      const detail = error instanceof Error ? error.message : String(error);
      steps.push({
        id,
        label,
        status: 'failed',
        detail,
        durationMs: this.#now() - startedAt,
      });
      return { ok: false, detail, error };
    }
  }

  #toLabError(
    code: LabError['code'],
    error: unknown,
    extra: { remediation?: string } = {},
  ): LabError {
    const message =
      error instanceof KubernetesUnreachableError || error instanceof Error
        ? error.message
        : String(error);
    return { code, message, ...extra };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
