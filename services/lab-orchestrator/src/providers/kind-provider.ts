/**
 * `LabProvider` backed by a shared kind cluster, one namespace per session.
 *
 * Division of responsibility:
 *   - The kind cluster is the *substrate*. It is provisioned once on the host
 *     by `scripts/cluster-up.sh`, deliberately NOT by this process: creating a
 *     kind cluster needs the Docker socket, and a web-facing service must not
 *     hold that capability.
 *   - A *sandbox* is one namespace inside that substrate, created per session,
 *     wrapped in a ResourceQuota, LimitRange, NetworkPolicy, and namespace-
 *     scoped RBAC, then seeded with the lab's declared initial state.
 *
 * Cost model: starting a lab creates one namespace and a handful of tiny API
 * objects. It never creates a cluster, a node, a load balancer, a public
 * address, or a database. Browsing the catalog creates nothing at all — no
 * method on this class runs until a student clicks Start Lab.
 *
 * A future `EksLabProvider` / `FirecrackerLabProvider` can own the whole
 * lifecycle, including substrate creation, without any caller changing.
 */
import { execFile } from 'node:child_process';
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
  ProvisionStep,
  ResetResult,
  StudentCredentials,
} from '../types.js';
import {
  KubernetesUnreachableError,
  ManifestApplyError,
  type KubernetesPort,
} from '../k8s/port.js';
import { loadSetupManifests } from '../session/manifests.js';
import { protectedResources, sessionGuardrailManifests } from '../session/isolation.js';
import {
  LAB_LABEL,
  MANAGED_SELECTOR,
  SESSION_LABEL,
  assertDeletable,
  expiryFromLabels,
  ownershipLabels,
} from '../k8s/labels.js';
import { assertValidLabNamespace, isLabNamespace } from '../session/identifiers.js';
import { buildStudentKubeconfig } from '../k8s/student-kubeconfig.js';
import type { Requirement } from '../requirements.js';

/** Only these binaries may ever be invoked by `execute()`. */
const EXEC_ALLOWLIST = new Set(['kubectl']);

const DEFAULT_EXEC_TIMEOUT_MS = 15_000;

/**
 * Injected setup verification.
 *
 * The verifier package depends on this one, so the provider cannot import it
 * without a cycle. The composition root supplies this function instead, which
 * also makes setup verification trivially fakeable in tests.
 */
export type RequirementWaiter = (input: {
  namespace: string;
  requirements: readonly Requirement[];
  timeoutMs: number;
}) => Promise<{ ok: boolean; checks: Array<{ label: string; status: string; detail?: string }> }>;

export interface KindProviderOptions {
  k8s: KubernetesPort;
  clusterName: string;
  /** Kubeconfig handed to allow-listed CLI health checks. */
  kubeconfigPath?: string;
  /** Max time to wait for student pods to finish terminating during reset. */
  resetDrainTimeoutMs?: number;
  /** Max time `destroy()` waits for the namespace to actually disappear. */
  destroyTimeoutMs?: number;
  /** Confirms a lab's declared initial state actually materialised. */
  waitForRequirements?: RequirementWaiter;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class KindLabProvider implements LabProvider {
  readonly name = 'kind';

  readonly #k8s: KubernetesPort;
  readonly #clusterName: string;
  readonly #kubeconfigPath: string | undefined;
  readonly #resetDrainTimeoutMs: number;
  readonly #destroyTimeoutMs: number;
  readonly #wait: RequirementWaiter | undefined;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: KindProviderOptions) {
    this.#k8s = options.k8s;
    this.#clusterName = options.clusterName;
    this.#kubeconfigPath = options.kubeconfigPath;
    this.#resetDrainTimeoutMs = options.resetDrainTimeoutMs ?? 60_000;
    this.#destroyTimeoutMs = options.destroyTimeoutMs ?? 90_000;
    this.#wait = options.waitForRequirements;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? sleep;
  }

  environmentId(context: LabSessionContext): string {
    return `${this.name}:${this.#clusterName}/${context.namespace}#${context.labId}`;
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
    const steps: ProvisionStep[] = [];
    assertValidLabNamespace(context.namespace);

    // Step 1 — the private sandbox exists and is fenced in.
    const createStep = await this.#runStep(
      steps,
      'environment-created',
      'Environment created',
      async () => {
        await this.#k8s.createNamespace(
          context.namespace,
          ownershipLabels({
            sessionId: context.sessionId,
            labId: context.labId,
            expiresAtMs: context.expiresAtMs,
          }),
        );
        await this.#applyGuardrails(context);
        return `namespace ${context.namespace} created with quota, limits, network policy and namespace-scoped RBAC`;
      },
    );
    if (!createStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'error', { message: createStep.detail }),
        steps,
        error: this.#toLabError(createStep.error, 'PROVISION_FAILED', {
          remediation: 'Ensure the kind cluster is running: npm run cluster:up',
        }),
      };
    }

    // Step 2 — Kubernetes API reachable, with real version/node data.
    let nodes: EnvironmentInfo['nodes'];
    let kubernetesVersion: string | undefined;
    let summary: string | undefined;
    const apiStep = await this.#runStep(steps, 'kubernetes-api', 'Kubernetes API available', async () => {
      await this.#k8s.ping();
      const version = await this.#k8s.version();
      kubernetesVersion = version.gitVersion;
      nodes = await this.#k8s.listNodes();
      if (nodes.length === 0) throw new Error('cluster reports zero nodes');
      const notReady = nodes.filter((n) => !n.ready);
      if (notReady.length > 0) {
        throw new Error(`node(s) not Ready: ${notReady.map((n) => n.name).join(', ')}`);
      }
      summary = `${version.gitVersion} — ${nodes.length} node${nodes.length === 1 ? '' : 's'} Ready`;
      return summary;
    });
    if (!apiStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'error', { message: apiStep.detail }),
        steps,
        error: this.#toLabError(apiStep.error, 'ENVIRONMENT_UNREACHABLE', {
          remediation:
            'Check that the kind cluster is running (`kind get clusters`) and that the api container is attached to the `kind` Docker network.',
        }),
      };
    }

    // Step 3 — the lab's declared starting condition, for labs that have one.
    if (context.lab.setup.manifests.length > 0) {
      const setupStep = await this.#runStep(
        steps,
        'lab-initial-state',
        'Lab initial state ready',
        async () => this.#applySetup(context),
      );
      if (!setupStep.ok) {
        return {
          ok: false,
          environment: this.#environment(context, 'degraded', {
            kubernetesVersion,
            nodes,
            message: setupStep.detail,
          }),
          steps,
          error: this.#toLabError(setupStep.error, 'SETUP_FAILED', {
            remediation: `Check the setup manifests declared by ${context.labId}.`,
          }),
        };
      }
    }

    // Step 4 — kubectl genuinely works against this cluster.
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
        environment: this.#environment(context, 'degraded', {
          kubernetesVersion,
          nodes,
          message: kubectlStep.detail,
        }),
        steps,
        error: this.#toLabError(kubectlStep.error, 'KUBECTL_UNAVAILABLE', {
          remediation:
            'kubectl must be installed in the api image and KUBECONFIG must be readable.',
        }),
      };
    }

    return {
      ok: true,
      environment: this.#environment(context, 'ready', {
        kubernetesVersion,
        nodes,
        ...(summary ? { summary } : {}),
      }),
      steps,
    };
  }

  // ---------------------------------------------------------------- status

  async status(context: LabSessionContext): Promise<EnvironmentInfo> {
    try {
      await this.#k8s.ping();
    } catch (error) {
      return this.#environment(context, 'error', { message: describe(error) });
    }

    try {
      const [version, nodes, namespace] = await Promise.all([
        this.#k8s.version(),
        this.#k8s.listNodes(),
        this.#k8s.getNamespace(context.namespace),
      ]);

      if (!namespace) {
        return this.#environment(context, 'not_created', {
          message: `namespace ${context.namespace} does not exist`,
        });
      }
      if (namespace.phase === 'Terminating') {
        return this.#environment(context, 'degraded', {
          kubernetesVersion: version.gitVersion,
          nodes,
          message: `namespace ${context.namespace} is terminating`,
        });
      }

      const notReady = nodes.filter((n) => !n.ready);
      return this.#environment(context, notReady.length === 0 && nodes.length > 0 ? 'ready' : 'degraded', {
        kubernetesVersion: version.gitVersion,
        nodes,
        ...(notReady.length > 0
          ? { message: `node(s) not Ready: ${notReady.map((n) => n.name).join(', ')}` }
          : {}),
      });
    } catch (error) {
      return this.#environment(context, 'error', { message: describe(error) });
    }
  }

  // ----------------------------------------------------------------- reset

  /**
   * Restore the lab's starting condition.
   *
   * Purge student resources → wait for Pods to actually go → re-apply the
   * initial manifests → confirm the environment. The namespace itself, and the
   * guardrails inside it, survive: the student keeps their terminal and their
   * session, and a troubleshooting lab gets its injected fault back.
   */
  async reset(context: LabSessionContext): Promise<ResetResult> {
    assertValidLabNamespace(context.namespace);
    const steps: ProvisionStep[] = [];
    let removed: string[] = [];
    let restored: string[] = [];

    const purgeStep = await this.#runStep(steps, 'purge', 'Student resources removed', async () => {
      removed = await this.#purgeNamespace(context);
      return removed.length > 0 ? removed.join(', ') : 'nothing to remove';
    });
    if (!purgeStep.ok) {
      return this.#failedReset(context, steps, removed, restored, purgeStep.error);
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
      return this.#failedReset(context, steps, removed, restored, drainStep.error);
    }

    if (context.lab.setup.manifests.length > 0) {
      const restoreStep = await this.#runStep(
        steps,
        'restore',
        'Lab initial state restored',
        async () => {
          const detail = await this.#applySetup(context);
          restored = [...context.lab.setup.manifests];
          return detail;
        },
      );
      if (!restoreStep.ok) {
        return this.#failedReset(context, steps, removed, restored, restoreStep.error, 'SETUP_FAILED');
      }
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
        restored,
        steps,
        environment,
        error: this.#toLabError(healthStep.error, 'RESET_FAILED'),
      };
    }

    return { ok: true, removed, restored, steps, environment };
  }

  // --------------------------------------------------------------- destroy

  /**
   * Delete the sandbox.
   *
   * Deleting the namespace removes every object inside it in one operation,
   * which is precisely the blast radius we want: one session, nothing else.
   * The name is re-validated against the sandbox prefix immediately before the
   * call, so this path cannot reach `default` or a system namespace.
   */
  async destroy(context: LabSessionContext): Promise<DestroyResult> {
    return this.destroyNamespace(context.namespace, context.sessionId);
  }

  /**
   * Delete a sandbox namespace, and confirm it is gone.
   *
   * Four gates stand between this call and `deleteNamespace`, in order:
   *
   *   1. the name must parse as a `lab-…` sandbox name;
   *   2. it must not be a protected cluster namespace;
   *   3. the *live* object must carry `jumptotech.io/managed=true`;
   *   4. when a session id is supplied, the namespace's session label must match.
   *
   * Gates 3 and 4 are re-read from the API server on every call, so a stale
   * store record cannot authorise a delete. A namespace that is already absent
   * is reported as `namespaceGone`, which is what makes repeat calls harmless.
   */
  async destroyNamespace(namespace: string, expectedSessionId?: string): Promise<DestroyResult> {
    const steps: ProvisionStep[] = [];

    if (!isLabNamespace(namespace)) {
      return this.#refuseDestroy(
        steps,
        namespace,
        `'${namespace}' is not a JumpToTech lab sandbox name`,
      );
    }

    let snapshot;
    try {
      snapshot = await this.#k8s.getNamespace(namespace);
    } catch (error) {
      steps.push({ id: 'verify-managed', label: 'Namespace ownership verified', status: 'failed', detail: describe(error) });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    // Already gone is success: teardown is re-entrant by design.
    if (snapshot === null) {
      steps.push({ id: 'delete-namespace', label: 'Namespace deleted', status: 'ok', detail: 'already absent' });
      return { ok: true, namespaceGone: true, steps };
    }

    const check = assertDeletable(namespace, snapshot.labels, expectedSessionId);
    if (!check.managed) {
      return this.#refuseDestroy(steps, namespace, check.reason ?? 'not managed by JumpToTech');
    }
    steps.push({ id: 'verify-managed', label: 'Namespace ownership verified', status: 'ok' });

    try {
      await this.#k8s.deleteNamespace(namespace);
    } catch (error) {
      steps.push({ id: 'delete-namespace', label: 'Namespace deleted', status: 'failed', detail: describe(error) });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    const gone = await this.#waitForNamespaceGone(namespace);
    steps.push({
      id: 'delete-namespace',
      label: 'Namespace deleted',
      status: gone ? 'ok' : 'pending',
      detail: gone ? namespace : `${namespace} is still terminating`,
    });

    return {
      ok: true,
      namespaceGone: gone,
      steps,
      ...(gone
        ? {}
        : {
            error: {
              code: 'DESTROY_FAILED' as const,
              message: `namespace ${namespace} is still terminating`,
            },
          }),
    };
  }

  /** A refused delete is not an error the caller retries — it is a hard no. */
  #refuseDestroy(steps: ProvisionStep[], namespace: string, reason: string): DestroyResult {
    const message = `Refusing to delete namespace: ${reason}`;
    steps.push({ id: 'verify-managed', label: 'Namespace ownership verified', status: 'failed', detail: message });
    return {
      ok: false,
      namespaceGone: false,
      steps,
      error: {
        code: 'DESTROY_FAILED',
        message,
        remediation:
          'Cleanup only ever removes namespaces this platform created and labelled. Remove other namespaces by hand.',
      },
    };
  }

  async #waitForNamespaceGone(namespace: string): Promise<boolean> {
    const deadline = this.#now() + this.#destroyTimeoutMs;
    for (;;) {
      if ((await this.#k8s.getNamespace(namespace)) === null) return true;
      if (this.#now() >= deadline) return false;
      await this.#sleep(500);
    }
  }

  // ----------------------------------------------------------- credentials

  /**
   * Mint namespace-scoped credentials for the student's shell.
   *
   * The returned kubeconfig authenticates as the session's ServiceAccount,
   * whose rights stop at its own namespace. No cluster-admin credential is
   * ever produced here, and this is the only credential the terminal service
   * is given — see README → Security.
   */
  async issueCredentials(context: LabSessionContext): Promise<StudentCredentials> {
    assertValidLabNamespace(context.namespace);

    const remainingMs = context.expiresAtMs - this.#now();
    // Never outlive the session, and never exceed the configured TTL. The
    // Kubernetes TokenRequest API enforces a 10-minute floor of its own.
    const ttlSeconds = Math.max(
      600,
      Math.min(context.policy.credentialTtlSeconds, Math.ceil(remainingMs / 1000)),
    );

    const { token, expirationTimestamp } = await this.#k8s.requestServiceAccountToken(
      context.namespace,
      context.serviceAccountName,
      ttlSeconds,
    );

    const kubeconfig = buildStudentKubeconfig({
      endpoint: this.#k8s.clusterEndpoint(),
      namespace: context.namespace,
      token,
      clusterName: this.#clusterName,
      userName: context.serviceAccountName,
    });

    const expiresAt =
      expirationTimestamp && !Number.isNaN(Date.parse(expirationTimestamp))
        ? new Date(expirationTimestamp).toISOString()
        : new Date(this.#now() + ttlSeconds * 1000).toISOString();

    return {
      kind: 'kubeconfig',
      kubeconfig,
      namespace: context.namespace,
      serviceAccountName: context.serviceAccountName,
      expiresAt,
    };
  }

  // --------------------------------------------------------------- cleanup

  /**
   * Every sandbox this platform owns, as recorded in namespace labels.
   *
   * Filtered by the managed label *and* by the sandbox name shape, so a
   * hand-labelled system namespace never enters the reaper's work list.
   */
  async listManagedNamespaces(): Promise<ManagedNamespace[]> {
    const namespaces = await this.#k8s.listNamespaces(MANAGED_SELECTOR);
    return namespaces
      .filter((ns) => isLabNamespace(ns.name))
      .map((ns) => ({
        namespace: ns.name,
        sessionId: ns.labels[SESSION_LABEL] ?? '',
        labId: ns.labels[LAB_LABEL] ?? '',
        expiresAtMs: expiryFromLabels(ns.labels),
        phase: ns.phase,
      }));
  }

  // --------------------------------------------------------------- execute

  /**
   * Runs one allow-listed binary with an explicit argv array.
   *
   * There is no shell: the command is never string-interpolated, so argument
   * content cannot become syntax. Only `kubectl` is permitted, and this method
   * is reachable only from internal health checks — never from a REST route.
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
          const timedOut = Boolean(error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
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
   * Apply the session's guardrails.
   *
   * Everything here is namespaced. No ClusterRole and no ClusterRoleBinding is
   * created, which is both a security property (the student identity cannot
   * reach cluster scope) and an operational one (deleting the namespace
   * genuinely removes every object the session owns — there is no
   * cluster-scoped residue to garbage-collect separately).
   */
  async #applyGuardrails(context: LabSessionContext): Promise<void> {
    await this.#k8s.applyObjects(context.namespace, sessionGuardrailManifests(context.policy));
  }

  /** Apply the lab's initial manifests, then confirm they took effect. */
  async #applySetup(context: LabSessionContext): Promise<string> {
    const objects = await loadSetupManifests(context.lab);
    const applied = await this.#k8s.applyObjects(context.namespace, objects);

    const requirements = context.lab.setup.verify as readonly Requirement[];
    if (requirements.length === 0 || !this.#wait) {
      return `applied ${applied.length} resource${applied.length === 1 ? '' : 's'}`;
    }

    const result = await this.#wait({
      namespace: context.namespace,
      requirements,
      timeoutMs: context.lab.setup.verify_timeout_seconds * 1000,
    });
    if (!result.ok) {
      const failed = result.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ''}`)
        .join('; ');
      throw new Error(`lab initial state did not become ready — ${failed}`);
    }

    return `applied and verified ${applied.length} resource${applied.length === 1 ? '' : 's'}`;
  }

  /**
   * Delete every purgeable resource in the namespace except protected ones.
   * Returns the `resource/name` pairs that were actually deleted.
   */
  async #purgeNamespace(context: LabSessionContext): Promise<string[]> {
    // The platform's own guardrails are always protected, whatever the lab says:
    // a reset must not be able to strip a session of its quota or its RBAC.
    const protectedSet = new Set([
      ...protectedResources(context.policy),
      ...context.lab.reset.protected_resources,
    ]);
    const removed: string[] = [];

    for (const resource of context.lab.reset.purge_namespaced_resources) {
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
   * A connectivity failure is reported as `ENVIRONMENT_UNREACHABLE` wherever it
   * surfaces, so the UI can distinguish "the cluster is down" from "this lab's
   * setup is broken" no matter which step noticed first.
   */
  #toLabError(
    error: unknown,
    fallback: LabError['code'],
    extra: { remediation?: string } = {},
  ): LabError {
    const code: LabError['code'] =
      error instanceof KubernetesUnreachableError
        ? 'ENVIRONMENT_UNREACHABLE'
        : error instanceof ManifestApplyError
          ? 'SETUP_FAILED'
          : fallback;
    return { code, message: describe(error), ...extra };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
