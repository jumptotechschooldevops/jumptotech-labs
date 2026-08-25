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
  };
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
