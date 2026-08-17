/**
 * One `LabProvider` that routes to several.
 *
 * The platform now has two substrates: a Kubernetes namespace and a set of
 * Ansible containers. The session manager, the REST routes, the reaper, and the
 * React app all continue to speak to a single `LabProvider` — this class is
 * what makes that true.
 *
 * ```text
 *   lab.yaml: environment.provider ──► CompositeLabProvider ──► KindLabProvider
 *                                                          └──► AnsibleDockerProvider
 * ```
 *
 * Routing is data-driven: the key is the lab definition's own
 * `environment.provider`, so adding a third substrate means registering a
 * delegate here and nothing else moves.
 *
 * The two cleanup entry points are the interesting cases. `listManagedNamespaces`
 * unions every delegate's view, because the reaper must see *every* sandbox the
 * platform owns regardless of what created it. `destroyNamespace` is offered to
 * each delegate in turn, because an orphan carries no lab id and therefore no
 * hint about which substrate it belongs to; a delegate that does not recognise
 * it refuses, and refusal is not a failure until every delegate has refused.
 */
import type {
  CreateResult,
  DestroyResult,
  EnvironmentInfo,
  ExecRequest,
  ExecResult,
  LabProvider,
  LabSessionContext,
  ManagedNamespace,
  ResetResult,
  StudentCredentials,
} from '../types.js';

export class UnknownLabProviderError extends Error {
  readonly code = 'PROVISION_FAILED';
  constructor(readonly requested: string, available: readonly string[]) {
    super(
      `No sandbox provider is configured for '${requested}'. Available: ${available.join(', ') || 'none'}`,
    );
    this.name = 'UnknownLabProviderError';
  }
}

export class CompositeLabProvider implements LabProvider {
  readonly name = 'composite';

  readonly #delegates: ReadonlyMap<string, LabProvider>;

  /** Keyed by the value labs put in `environment.provider`. */
  constructor(delegates: Record<string, LabProvider>) {
    this.#delegates = new Map(Object.entries(delegates));
  }

  get providerKeys(): string[] {
    return [...this.#delegates.keys()];
  }

  /** The delegate serving one lab. Throws when the lab names an unconfigured one. */
  delegateFor(context: LabSessionContext): LabProvider {
    const key = context.lab.environment.provider;
    const delegate = this.#delegates.get(key);
    if (!delegate) throw new UnknownLabProviderError(key, this.providerKeys);
    return delegate;
  }

  create(context: LabSessionContext): Promise<CreateResult> {
    return this.delegateFor(context).create(context);
  }

  status(context: LabSessionContext): Promise<EnvironmentInfo> {
    return this.delegateFor(context).status(context);
  }

  reset(context: LabSessionContext): Promise<ResetResult> {
    return this.delegateFor(context).reset(context);
  }

  destroy(context: LabSessionContext): Promise<DestroyResult> {
    return this.delegateFor(context).destroy(context);
  }

  execute(context: LabSessionContext, request: ExecRequest): Promise<ExecResult> {
    return this.delegateFor(context).execute(context, request);
  }

  issueCredentials(context: LabSessionContext): Promise<StudentCredentials> {
    return this.delegateFor(context).issueCredentials(context);
  }

  /**
   * Every sandbox every delegate owns.
   *
   * A delegate whose substrate is unavailable (Docker not running while the
   * Kubernetes track is in use, say) must not blind the reaper to the other
   * delegate's sandboxes, so its failure is swallowed here rather than
   * propagated. The consequence is a sweep that reclaims what it can see, which
   * is strictly better than a sweep that reclaims nothing.
   */
  async listManagedNamespaces(): Promise<ManagedNamespace[]> {
    const all: ManagedNamespace[] = [];
    const seen = new Set<string>();

    for (const delegate of this.#delegates.values()) {
      let owned: ManagedNamespace[];
      try {
        owned = await delegate.listManagedNamespaces();
      } catch {
        continue;
      }
      for (const sandbox of owned) {
        if (seen.has(sandbox.namespace)) continue;
        seen.add(sandbox.namespace);
        all.push(sandbox);
      }
    }
    return all;
  }

  /**
   * Delete one sandbox by name, whichever delegate owns it.
   *
   * Each delegate re-checks the name shape and the live ownership labels
   * itself, so offering a name to all of them adds no authority: a delegate
   * that does not own it reports `namespaceGone: false` and nothing is deleted.
   * The first delegate that confirms the sandbox is gone wins.
   */
  async destroyNamespace(namespace: string, expectedSessionId?: string): Promise<DestroyResult> {
    const attempts: DestroyResult[] = [];

    for (const delegate of this.#delegates.values()) {
      const result = await delegate.destroyNamespace(namespace, expectedSessionId);
      if (result.namespaceGone) return result;
      attempts.push(result);
    }

    const failed = attempts.find((attempt) => attempt.ok) ?? attempts[0];
    return (
      failed ?? {
        ok: false,
        namespaceGone: false,
        steps: [],
        error: { code: 'DESTROY_FAILED', message: 'No sandbox provider is configured.' },
      }
    );
  }
}
