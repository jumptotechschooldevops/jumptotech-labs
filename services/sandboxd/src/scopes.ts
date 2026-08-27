/**
 * Scoped internal authorization.
 *
 * `sandboxd` has three capabilities and three very different blast radii:
 *
 * ```text
 *   attach    open a PTY in one session's sandbox        the terminal needs it
 *   runtime   create/inspect/destroy container sandboxes the API needs it
 *   docker    drive the Docker track's daemons           the API needs it
 * ```
 *
 * They used to share one credential — `INTERNAL_SERVICE_SECRET`, the same value
 * the terminal already held to talk to the API. So the terminal, the one
 * process a student types into, could call `/v1/docker` and drive the container
 * runtime. It never did; nothing stopped it. That is the whole reason this
 * module exists: "the terminal holds nothing" was a claim about which requests
 * the terminal chose to make, not about which ones it could make.
 *
 * ## The design
 *
 * One secret per scope, distinct values, and the endpoint decides which one it
 * requires. A caller is given only the scopes it needs, so the terminal
 * physically cannot authenticate to `/v1/docker` — not because it declines to,
 * but because it does not hold the credential.
 *
 * Deliberately **not** a token format. There is no payload to parse, no
 * expiry to check, no signature scheme to get wrong, and no way for a caller to
 * assert its own scope — the scope is a property of *which secret matched*,
 * decided here, from configuration. A bearer token carrying `{"scope":"docker"}`
 * would put the claim in the caller's hands and the verification in ours; this
 * puts both here.
 *
 * ## Fail-closed properties
 *
 *   - An unconfigured scope denies everything. A deployment that forgets one
 *     loses a capability loudly rather than accepting anything for it.
 *   - Two scopes sharing a value is refused at startup (see `config.ts`).
 *     Equal secrets silently collapse the boundary back to where it started,
 *     which is exactly the bug this module was written to remove.
 *   - Comparison is constant-time, and length-checked first so a mismatched
 *     length cannot throw.
 */
import { timingSafeEqual } from 'node:crypto';

/** Every capability this service offers. */
export const SANDBOXD_SCOPES = ['attach', 'runtime', 'docker'] as const;

export type SandboxdScope = (typeof SANDBOXD_SCOPES)[number];

/**
 * Which scope each endpoint requires.
 *
 * The single source of truth: `server.ts` reads this rather than repeating a
 * scope name at each handler, so an endpoint added without an entry here has
 * no scope, and `scopeForEndpoint` returns null, and the request is refused.
 * Forgetting to authorize a new endpoint therefore closes it rather than
 * opening it.
 */
export const ENDPOINT_SCOPES: Readonly<Record<string, SandboxdScope>> = {
  '/v1/attach': 'attach',
  '/v1/runtime': 'runtime',
  '/v1/docker': 'docker',
};

/** The scope an endpoint needs, or `null` when the path is not an endpoint. */
export function scopeForEndpoint(url: string | undefined): SandboxdScope | null {
  if (typeof url !== 'string') return null;
  // Exact match only. No prefix matching, so `/v1/attach/../docker` and
  // `/v1/dockerX` are not endpoints rather than being some endpoint's cousin.
  return ENDPOINT_SCOPES[url] ?? null;
}

/** The secret that proves each scope. Empty means the scope is switched off. */
export type ScopeSecrets = Readonly<Record<SandboxdScope, string>>;

export type ScopeDenial =
  | 'missing-credential'
  | 'scope-not-configured'
  | 'credential-not-valid-for-scope';

export interface ScopeDecision {
  ok: boolean;
  denial?: ScopeDenial;
  /** Operator-facing. Deliberately never says which scope *would* have worked. */
  message?: string;
}

const ALLOWED: ScopeDecision = { ok: true };

function constantTimeEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * May this credential exercise this scope?
 *
 * The message a caller gets back is the same whether the credential was
 * unrecognised or was a perfectly good credential for a different scope. A
 * caller learns only that *its* credential does not open *this* endpoint —
 * never that it holds something valid elsewhere, which would turn a wrong-scope
 * refusal into a hint about what to try next.
 */
export function authorizeScope(
  presented: unknown,
  scope: SandboxdScope,
  secrets: ScopeSecrets,
): ScopeDecision {
  if (typeof presented !== 'string' || presented.length === 0) {
    return {
      ok: false,
      denial: 'missing-credential',
      message: 'an internal service credential is required',
    };
  }

  const expected = secrets[scope];
  if (!expected) {
    return {
      ok: false,
      denial: 'scope-not-configured',
      message: `the '${scope}' capability is not configured on this broker`,
    };
  }

  if (!constantTimeEquals(presented, expected)) {
    return {
      ok: false,
      denial: 'credential-not-valid-for-scope',
      message: `that credential does not carry the '${scope}' capability`,
    };
  }

  return ALLOWED;
}
