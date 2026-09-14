/**
 * Ownership labels.
 *
 * Every object the orchestrator creates carries these. The cleanup service
 * refuses to delete a namespace that does not — so a bug, a stale record, or a
 * hostile input can never turn cleanup into "delete an arbitrary namespace".
 *
 * The safety property this module exists to provide:
 *
 * ```text
 *   delete(namespace) is permitted  ⟺  the name is a lab-* sandbox name
 *                                   ∧  the name is not a protected namespace
 *                                   ∧  the live object carries jumptotech.io/managed=true
 *                                   ∧  its session-id label matches the caller's session
 *                                   ∧  its runtime-owner label is this deployment's
 *                                      (see `runtimeOwnerPermits`)
 * ```
 *
 * All four are checked against the object *as it currently exists in the
 * cluster*, immediately before the delete call — never against a name a caller
 * passed in, and never against a cached record.
 */
import { isProtectedNamespace } from '../session/identifiers.js';

export const MANAGED_LABEL = 'jumptotech.io/managed';
export const SESSION_LABEL = 'jumptotech.io/session-id';
export const LAB_LABEL = 'jumptotech.io/lab-id';
export const EXPIRES_AT_LABEL = 'jumptotech.io/expires-at';
export const COMPONENT_LABEL = 'jumptotech.io/component';
/**
 * Which provider owns this resource.
 *
 * One daemon can host sandboxes from several providers at once, and each
 * provider must reap only its own. The container providers have always stamped
 * and filtered on this; the Docker provider proved the same thing a second way,
 * through `COMPONENT_LABEL`. Two mechanisms answering one question is how they
 * drift, so ownership is stated here once and both use it.
 */
export const PROVIDER_LABEL = 'jumptotech.io/provider';

/**
 * Which *runtime* created this resource — the level above a session.
 *
 * A session says which student, a provider says which substrate; neither says
 * which running platform. Production has exactly one, so the distinction is
 * invisible there. A developer laptop has seven: the worktrees share one Docker
 * daemon, and their sandboxes are identical in every other respect — managed,
 * same provider, each with its own session id.
 *
 * That matters because of one deliberate asymmetry in the reaper. Orphan
 * reclamation calls `destroySandbox` with *no* session, because an orphan is by
 * definition a sandbox the store has no record of. With only `managed` and
 * `provider` left to authorise the delete, one worktree's reaper would reclaim
 * another's expired sandbox. This label is the missing discriminator.
 *
 * A resource carrying no owner belongs to nobody provably. Discovery and every
 * session-less delete refuse it; only a teardown naming the session the live
 * object is labelled with may still remove it (see `runtimeOwnerPermits`).
 */
export const RUNTIME_OWNER_LABEL = 'jumptotech.io/runtime-owner';

/**
 * The owner a *development* process uses when `RUNTIME_OWNER_ID` is unset.
 *
 * Never a production value: `resolveRuntimeOwner` refuses to fall back to it
 * under `NODE_ENV=production`. It exists so `npm run dev:*` and the hermetic
 * suites work without configuration, and it is one constant so the API and
 * sandboxd cannot drift onto two different development defaults.
 */
export const DEFAULT_RUNTIME_OWNER = 'jumptotech';

/**
 * What a runtime owner may look like.
 *
 * The value is written as a Kubernetes label value and a Docker label, and
 * compared byte for byte, so it must be valid as the stricter of the two: at
 * most 63 characters, alphanumeric at both ends, `-`, `_` and `.` inside. No
 * trimming — a value with stray whitespace is a different owner, and silently
 * normalising it would make two services agree only by accident.
 */
const RUNTIME_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

export function isValidRuntimeOwner(value: string): boolean {
  return RUNTIME_OWNER_PATTERN.test(value);
}

export type RuntimeOwnerSource = 'configured' | 'development-default';

export interface ResolvedRuntimeOwner {
  owner: string;
  source: RuntimeOwnerSource;
}

/**
 * The one place a process decides which runtime owner it is.
 *
 * Every service that creates, discovers or deletes sandboxes — the API and
 * sandboxd today — resolves its owner here, from the same variable, so a
 * deployment has one identity rather than one per service.
 *
 *   · set and valid          → that value, in every environment
 *   · set and invalid        → refuse to start, in every environment
 *   · unset, production      → refuse to start
 *   · unset, anything else   → `DEFAULT_RUNTIME_OWNER`, reported as a default
 *
 * The error never echoes the rejected value: an operator who pasted a secret
 * into the wrong variable should not find it in a crash log.
 */
export function resolveRuntimeOwner(env: NodeJS.ProcessEnv): ResolvedRuntimeOwner {
  const raw = env.RUNTIME_OWNER_ID ?? '';
  if (raw !== '') {
    if (!isValidRuntimeOwner(raw)) {
      throw new Error(
        `RUNTIME_OWNER_ID is not a valid runtime owner (${raw.length} characters). It must be 1-63 characters of letters, digits, '-', '_' or '.', starting and ending with a letter or digit.`,
      );
    }
    return { owner: raw, source: 'configured' };
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'RUNTIME_OWNER_ID must be set when NODE_ENV=production. Every service that manages sandboxes for this deployment (api, sandboxd) must be given the same value; cleanup refuses resources labelled with any other owner.',
    );
  }
  return { owner: DEFAULT_RUNTIME_OWNER, source: 'development-default' };
}

/** Label selector matching every namespace this platform owns. */
export const MANAGED_SELECTOR = `${MANAGED_LABEL}=true`;

export interface OwnershipLabelInput {
  sessionId: string;
  labId: string;
  /** Epoch ms. Written to the namespace so expiry survives an API restart. */
  expiresAtMs?: number;
  component?: string;
  /** The provider that owns this resource, so each reaps only its own. */
  provider?: string;
  /** The runtime that created it, so concurrent runtimes never collide. */
  runtimeOwner?: string;
}

/**
 * Labels stamped onto a session namespace.
 *
 * `expires-at` is deliberately stored in the cluster rather than only in the
 * in-memory session store: if the API restarts, the store is empty but the
 * namespaces are not, and the reaper still needs to know when each one dies.
 */
export function ownershipLabels(input: OwnershipLabelInput): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [SESSION_LABEL]: input.sessionId,
    [LAB_LABEL]: input.labId,
    ...(input.expiresAtMs !== undefined ? { [EXPIRES_AT_LABEL]: String(input.expiresAtMs) } : {}),
    ...(input.component ? { [COMPONENT_LABEL]: input.component } : {}),
    ...(input.provider ? { [PROVIDER_LABEL]: input.provider } : {}),
    ...(input.runtimeOwner ? { [RUNTIME_OWNER_LABEL]: input.runtimeOwner } : {}),
  };
}

/**
 * Whether a resource provably belongs to the runtime asking.
 *
 * Exact match only. This is the rule for discovery and for any delete that
 * names no session — the reaper's orphan sweep above all — because there the
 * label is the *only* evidence of ownership. A missing owner is not evidence:
 * on a shared daemon or cluster it is just as likely a neighbour's resource
 * from an older build as one of ours.
 */
export function ownedByRuntime(
  labels: Record<string, string>,
  runtimeOwner: string,
): boolean {
  return labels[RUNTIME_OWNER_LABEL] === runtimeOwner;
}

/**
 * Whether a delete may proceed as far as the runtime owner is concerned.
 *
 * A present owner must match, always. A *missing* owner is accepted only when
 * the caller named a session (`expectedSessionId`), because then the session
 * store is the authority — this deployment's own record says the session is
 * its — and the caller's session-label check must still pass as well. That
 * keeps an upgrade from stranding a live session created before the label
 * existed, without letting an unlabelled orphan be adopted by whoever finds it.
 */
export function runtimeOwnerPermits(
  labels: Record<string, string>,
  runtimeOwner: string,
  expectedSessionId: string | undefined,
): boolean {
  const stamped = labels[RUNTIME_OWNER_LABEL];
  if (stamped === undefined) return expectedSessionId !== undefined;
  return stamped === runtimeOwner;
}

/** Why `runtimeOwnerPermits` said no, for a refusal message. */
export function runtimeOwnerRefusal(
  resource: string,
  labels: Record<string, string>,
  runtimeOwner: string,
): string {
  const stamped = labels[RUNTIME_OWNER_LABEL];
  return stamped === undefined
    ? `${resource} carries no ${RUNTIME_OWNER_LABEL} label, and no session was named to vouch for it`
    : `${resource} belongs to runtime owner '${stamped}', not '${runtimeOwner}'`;
}

/** Labels stamped onto platform-owned objects *inside* a session namespace. */
export function componentLabels(component: string): Record<string, string> {
  return { [MANAGED_LABEL]: 'true', [COMPONENT_LABEL]: component };
}

export interface ManagedCheckResult {
  managed: boolean;
  /** Why the namespace was rejected. Absent when `managed` is true. */
  reason?: string;
}

/**
 * Decide whether a namespace may be deleted by the cleanup service.
 *
 * `expectedSessionId` is optional: the reaper's orphan sweep legitimately
 * deletes namespaces whose session it has no record of, but it still requires
 * the managed label and a non-protected name. Missing labels always mean "not
 * ours" — the safe answer is no.
 */
export function assertDeletable(
  namespace: string,
  labels: Record<string, string> | null,
  expectedSessionId?: string,
): ManagedCheckResult {
  if (isProtectedNamespace(namespace)) {
    return { managed: false, reason: `'${namespace}' is a protected cluster namespace` };
  }
  if (labels === null) {
    return { managed: false, reason: `namespace '${namespace}' does not exist` };
  }
  if (labels[MANAGED_LABEL] !== 'true') {
    return {
      managed: false,
      reason: `namespace '${namespace}' is not labelled ${MANAGED_LABEL}=true`,
    };
  }
  if (expectedSessionId !== undefined) {
    const owner = labels[SESSION_LABEL];
    if (owner !== expectedSessionId) {
      return {
        managed: false,
        reason: `namespace '${namespace}' belongs to ${owner ?? '<unlabelled>'}, not ${expectedSessionId}`,
      };
    }
  }
  return { managed: true };
}

/** Epoch ms this namespace expires at, or 0 when the label is absent/invalid. */
export function expiryFromLabels(labels: Record<string, string>): number {
  const raw = labels[EXPIRES_AT_LABEL];
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
