/**
 * Routes each session to the provider its lab asked for.
 *
 * The platform is meant to carry many tracks — Kubernetes, CI/CD, Linux,
 * Terraform, Docker, AWS — and they do not all want the same kind of sandbox.
 * Rather than teaching the session manager, the routes, and the reaper about
 * that, one `LabProvider` stands in front of the others and dispatches on
 * `lab.environment.provider`. Everything above this class still sees a single
 * provider with a single lifecycle.
 *
 * ```text
 *   SessionManager ─► CompositeLabProvider ─┬─► KindLabProvider       (kubernetes)
 *                                           └─► WorkspaceLabProvider  (workspace)
 * ```
 *
 * The one method with no lab in scope is `destroyNamespace`, the reaper's
 * orphan path: it is given a name and nothing else. It is offered to every
 * member, and the first that recognises the sandbox as its own removes it — see
 * the method for why "not mine" and "refused" must be told apart there.
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
  VerificationEvidence,
} from '../types.js';

export class UnknownProviderError extends Error {
  readonly code = 'PROVISION_FAILED';
  constructor(
    readonly requested: string,
    available: readonly string[],
  ) {
    super(
      `No lab provider named '${requested}' is configured (available: ${available.join(', ')}). ` +
        'A lab declares its sandbox with environment.provider.',
    );
    this.name = 'UnknownProviderError';
  }
}

export interface CompositeProviderOptions {
  /** Keyed by the value labs write in `environment.provider`. */
  providers: Record<string, LabProvider>;
}

export class CompositeLabProvider implements LabProvider {
  readonly name = 'composite';

  readonly #providers: Record<string, LabProvider>;

  constructor(options: CompositeProviderOptions) {
    const names = Object.keys(options.providers);
    if (names.length === 0) throw new Error('CompositeLabProvider needs at least one provider');
    this.#providers = options.providers;
  }

  /** Provider names this instance can route to. */
  get providerNames(): string[] {
    return Object.keys(this.#providers);
  }

  /** The member that owns a session, chosen by its lab's declaration. */
  providerFor(context: LabSessionContext): LabProvider {
    const requested = context.lab.environment.provider;
    const provider = this.#providers[requested];
    if (!provider) throw new UnknownProviderError(requested, this.providerNames);
    return provider;
  }

  create(context: LabSessionContext): Promise<CreateResult> {
    return this.providerFor(context).create(context);
  }

  status(context: LabSessionContext): Promise<EnvironmentInfo> {
    return this.providerFor(context).status(context);
  }

  reset(context: LabSessionContext): Promise<ResetResult> {
    return this.providerFor(context).reset(context);
  }

  destroy(context: LabSessionContext): Promise<DestroyResult> {
    return this.providerFor(context).destroy(context);
  }

  execute(context: LabSessionContext, request: ExecRequest): Promise<ExecResult> {
    return this.providerFor(context).execute(context, request);
  }

  issueCredentials(context: LabSessionContext): Promise<StudentCredentials> {
    return this.providerFor(context).issueCredentials(context);
  }

  verificationEvidence(context: LabSessionContext): VerificationEvidence {
    const provider = this.providerFor(context);
    return provider.verificationEvidence?.(context) ?? {};
  }

  /** Every sandbox every member owns, for the reaper's orphan sweep. */
  async listManagedNamespaces(): Promise<ManagedNamespace[]> {
    const all: ManagedNamespace[] = [];
    for (const provider of Object.values(this.#providers)) {
      all.push(...(await provider.listManagedNamespaces()));
    }
    return all;
  }

  /**
   * Delete an orphaned sandbox by name.
   *
   * There is no lab here to route on, so every member is asked. Two outcomes
   * have to be told apart, and conflating them would be a real bug:
   *
   *   - **"gone"** — the member removed it, or confirmed it was never there.
   *     A member that does not own the sandbox reports exactly this, because
   *     from where it stands the sandbox genuinely does not exist. So a *sweep*
   *     of all members succeeds only if at least one actively removed it or all
   *     agree it is absent.
   *   - **"refused"** — the member recognises the name but will not delete it
   *     (no ownership record, wrong session). That is a hard no and must be
   *     surfaced, not masked by another member shrugging.
   *
   * A refusal from any member therefore wins over an absence from another.
   */
  async destroyNamespace(namespace: string, expectedSessionId?: string): Promise<DestroyResult> {
    const results: DestroyResult[] = [];
    for (const provider of Object.values(this.#providers)) {
      results.push(await provider.destroyNamespace(namespace, expectedSessionId));
    }

    const refusal = results.find((r) => !r.ok);
    if (refusal) return refusal;

    const gone = results.every((r) => r.namespaceGone);
    return {
      ok: true,
      namespaceGone: gone,
      steps: results.flatMap((r) => r.steps),
      ...(gone
        ? {}
        : {
            error: {
              code: 'DESTROY_FAILED' as const,
              message: `sandbox ${namespace} is not yet fully removed`,
            },
          }),
    };
  }
}
