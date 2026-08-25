/**
 * The provider vocabulary.
 *
 * PLATFORM-004 turns "the platform runs Kubernetes labs" into "the platform
 * runs *sandboxes*, and Kubernetes is one kind of sandbox". This module is the
 * closed list of sandbox kinds a lab may ask for, kept separate from the
 * provider implementations so that the lab schema, the registry, the session
 * layer and the API can all agree on the vocabulary without importing any
 * provider code (which would drag Kubernetes clients into the schema).
 *
 * Adding a track later — `jenkins`, `ansible`, `argocd` — is an entry here plus
 * one `LabProvider` implementation plus one line in the registry. Nothing else
 * in the platform enumerates providers.
 */

/** Every sandbox provider the lab schema may name. */
export const LAB_PROVIDERS = ['kubernetes', 'linux', 'docker', 'terraform', 'aws'] as const;

export type LabProviderId = (typeof LAB_PROVIDERS)[number];

export function isLabProviderId(value: unknown): value is LabProviderId {
  return typeof value === 'string' && (LAB_PROVIDERS as readonly string[]).includes(value);
}

/**
 * What one session's sandbox physically *is*.
 *
 * The session record stores this alongside the sandbox reference so that
 * generic code (cleanup, the API payload, the terminal binding) can describe a
 * sandbox honestly without knowing which provider produced it.
 */
export const SANDBOX_KINDS = ['namespace', 'container', 'cloud-session', 'none'] as const;

export type SandboxKind = (typeof SANDBOX_KINDS)[number];

/** How the isolation is described in `lab.yaml`, per provider. */
export const ISOLATION_MODES = ['namespace', 'container', 'none'] as const;

export type IsolationMode = (typeof ISOLATION_MODES)[number];

/**
 * The network a lab may ask its sandbox for.
 *
 * Deliberately two values, not a Docker network description. `none` is the
 * default and the historical behaviour: the sandbox is created with
 * `--network none` and has no interface but loopback. `link` gives that session
 * — and only that session — a private bridge with no route off itself, so a
 * networking lab has a link, an address and a neighbour to resolve.
 *
 * What is *not* here is the point. There is no `host`, no `bridge`, no shared
 * network and no way to name one: a lab cannot ask for host networking because
 * the vocabulary cannot express it, and a value outside this list fails schema
 * validation before it reaches a provider.
 */
export const LAB_NETWORK_MODES = ['none', 'link'] as const;

export type LabNetworkMode = (typeof LAB_NETWORK_MODES)[number];

/**
 * Linux kernel capabilities a lab may ask its sandbox for.
 *
 * Deliberately separate from `environment.capabilities`, which means something
 * else entirely: that field carries *session* capabilities such as
 * `rbac_authoring`, and is read by the Kubernetes provider to decide which
 * guardrail manifests a namespace gets. A kernel capability has nothing to do
 * with a Role, and mixing the two would put `NET_RAW` into Kubernetes manifest
 * generation. One field, one meaning, so a reviewer auditing kernel grants has
 * exactly one place to look.
 *
 * `NET_RAW` is the only member and it buys one thing: `AF_PACKET` and raw
 * sockets, so a lab can teach packet capture. It is safe *because of where it
 * is allowed*, not because the capability is mild — a student who can capture
 * sees every frame on their link, so the link must contain nothing but their
 * own traffic. That is why the schema refuses it unless the lab also declares
 * `network: link`, which is the per-session bridge holding exactly one
 * container.
 *
 * `NET_ADMIN` is deliberately absent. It is not capture but *mutation* —
 * interfaces, routes, firewall rules, and the neighbour table that
 * `neighbour_state` grades — and it needs its own security review.
 */
export const SANDBOX_CAPABILITIES = ['NET_RAW'] as const;

export type SandboxCapability = (typeof SANDBOX_CAPABILITIES)[number];

/**
 * The isolation a provider actually implements.
 *
 * A lab may omit `environment.isolation`; the loader fills in the provider's
 * mode from here, so a lab author cannot claim an isolation the provider does
 * not give them.
 */
export const PROVIDER_ISOLATION: Record<LabProviderId, IsolationMode> = {
  kubernetes: 'namespace',
  linux: 'container',
  docker: 'container',
  terraform: 'container',
  // No sandbox is created for AWS labs yet — see AwsLabProvider.
  aws: 'none',
};

/** The sandbox kind each provider produces. */
export const PROVIDER_SANDBOX_KIND: Record<LabProviderId, SandboxKind> = {
  kubernetes: 'namespace',
  linux: 'container',
  docker: 'container',
  terraform: 'container',
  aws: 'cloud-session',
};

/**
 * The noun the UI uses for a provider's sandbox reference.
 *
 * Shown as a developer detail ("namespace: lab-3f9c…", "container: lab-3f9c…").
 * It is not a capability: no endpoint anywhere accepts one as input.
 */
export const SANDBOX_REFERENCE_LABEL: Record<SandboxKind, string> = {
  namespace: 'namespace',
  container: 'container',
  'cloud-session': 'session scope',
  none: 'sandbox',
};

/**
 * Why a provider is not currently usable.
 *
 * `unavailable` is a first-class, *reported* state rather than an error thrown
 * at startup: a laptop without Docker should still serve the Kubernetes
 * catalog, and the Linux/Terraform cards should say plainly that they cannot be
 * started here rather than failing at the click.
 */
export interface ProviderAvailability {
  available: boolean;
  /** Present when `available` is false. Operator/student-facing. */
  reason?: string;
  /** What an operator can do about it. */
  remediation?: string;
}

export const AVAILABLE: ProviderAvailability = { available: true };

export function unavailable(reason: string, remediation?: string): ProviderAvailability {
  return { available: false, reason, ...(remediation ? { remediation } : {}) };
}
