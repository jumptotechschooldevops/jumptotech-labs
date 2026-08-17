/**
 * The provider registry.
 *
 * ```text
 *   lab.yaml: environment.provider ─► ProviderRegistry ─► LabProvider
 *                                          │
 *          ┌───────────────┬───────────────┼──────────────┬──────────────┐
 *     kubernetes         linux          docker        terraform         aws
 *   KindLabProvider  LinuxLabProvider  Docker…      Terraform…      AwsLabProvider
 *        namespace      container      container     container       (skeleton)
 * ```
 *
 * The point of this file is that it is the *only* place that maps a provider id
 * to an implementation. There is no `switch (provider)` in the API routes, the
 * session manager, the reaper, the verifier or React: they all ask the registry.
 * Adding `ansible` later is one registration here plus one class.
 *
 * **Availability is data, not an exception.** A provider that cannot run on
 * this machine (no container runtime, sandbox image not built, architecture-only)
 * is registered and reports why. The catalog then marks its labs unavailable
 * with a real reason instead of offering a Start Lab button that was always
 * going to fail. `resolve()` is the one call that refuses: it throws
 * `ProviderUnavailableError` so no session is ever created against a provider
 * that cannot honour it.
 */
import {
  ProviderUnavailableError,
  type LabProvider,
  type LabProviderId,
  type ProviderAvailability,
} from '../types.js';
import { LAB_PROVIDERS, isLabProviderId } from './catalog.js';

export interface ProviderRegistration {
  provider: LabProvider;
  /**
   * Operator override. `false` keeps the provider registered but reports it as
   * disabled — used for `aws`, and for `docker` until its sandbox is genuinely
   * safe (see README → Docker sandbox strategy).
   */
  enabled?: boolean;
  /** Why it is disabled, when `enabled` is false. */
  disabledReason?: string;
  remediation?: string;
}

export interface ProviderStatus extends ProviderAvailability {
  providerId: LabProviderId;
  /** Implementation backing this provider id, e.g. `kind`, `docker`. */
  implementation: string;
  sandboxKind: string;
  /** True when the provider is registered at all. */
  registered: boolean;
}

/** How long a probe result is trusted before the registry re-checks. */
const DEFAULT_AVAILABILITY_TTL_MS = 30_000;

export class ProviderRegistry {
  readonly #providers = new Map<LabProviderId, ProviderRegistration>();
  readonly #cache = new Map<LabProviderId, { at: number; status: ProviderStatus }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { availabilityTtlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  register(registration: ProviderRegistration): this {
    const id = registration.provider.id;
    if (!isLabProviderId(id)) {
      throw new Error(
        `Provider implementation reports id '${String(id)}', which is not a supported provider (${LAB_PROVIDERS.join(', ')})`,
      );
    }
    this.#providers.set(id, registration);
    this.#cache.delete(id);
    return this;
  }

  has(providerId: string): boolean {
    return isLabProviderId(providerId) && this.#providers.has(providerId);
  }

  get registeredIds(): LabProviderId[] {
    return [...this.#providers.keys()];
  }

  /**
   * The provider for a lab, or a hard refusal.
   *
   * Refuses for the three *structural* reasons — the provider id is not in the
   * vocabulary, nothing is registered for it, or it is switched off — and each
   * carries its own explanation so an operator can tell "you forgot to register
   * this" from "this is deliberately not enabled".
   *
   * It deliberately does **not** probe the backend. A cluster that is down or a
   * Docker daemon that is not running is a transient failure, and the student is
   * better served by provisioning attempting it and reporting the real error
   * against the real step ("✗ Environment created — connect ECONNREFUSED …")
   * than by a generic refusal. The catalog still probes, through `status()`, so
   * a lab whose backend is down is marked unavailable *before* it is clicked.
   */
  async resolve(providerId: string): Promise<LabProvider> {
    if (!isLabProviderId(providerId)) {
      throw new ProviderUnavailableError(
        String(providerId),
        `unknown provider (supported: ${LAB_PROVIDERS.join(', ')})`,
      );
    }
    const registration = this.#providers.get(providerId);
    if (!registration) {
      throw new ProviderUnavailableError(
        providerId,
        'no implementation is registered for this provider',
        'Register the provider in the API composition root (apps/api/src/providers.ts).',
      );
    }
    if (registration.enabled === false) {
      throw new ProviderUnavailableError(
        providerId,
        registration.disabledReason ?? 'disabled by configuration',
        registration.remediation,
      );
    }
    return registration.provider;
  }

  /**
   * The provider for a lab *without* an availability probe.
   *
   * Cleanup needs this: an expired session must be torn down through the
   * provider that created it even while that provider is reporting unhealthy,
   * or a transient Docker hiccup would leak sandboxes.
   */
  peek(providerId: string): LabProvider | null {
    if (!isLabProviderId(providerId)) return null;
    return this.#providers.get(providerId)?.provider ?? null;
  }

  /** Every registered provider, whatever its availability. */
  all(): LabProvider[] {
    return [...this.#providers.values()].map((r) => r.provider);
  }

  /** Availability for one provider, memoised for `availabilityTtlMs`. */
  async status(providerId: string): Promise<ProviderStatus> {
    if (!isLabProviderId(providerId)) {
      return {
        providerId: providerId as LabProviderId,
        implementation: 'none',
        sandboxKind: 'none',
        registered: false,
        available: false,
        reason: `unknown provider '${String(providerId)}'`,
      };
    }

    const registration = this.#providers.get(providerId);
    if (!registration) {
      return {
        providerId,
        implementation: 'none',
        sandboxKind: 'none',
        registered: false,
        available: false,
        reason: 'no implementation is registered for this provider',
      };
    }

    const cached = this.#cache.get(providerId);
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.status;

    const base = {
      providerId,
      implementation: registration.provider.name,
      sandboxKind: registration.provider.sandboxKind,
      registered: true,
    };

    let status: ProviderStatus;
    if (registration.enabled === false) {
      status = {
        ...base,
        available: false,
        reason: registration.disabledReason ?? 'disabled by configuration',
        ...(registration.remediation ? { remediation: registration.remediation } : {}),
      };
    } else {
      try {
        const probed = await registration.provider.availability();
        status = { ...base, ...probed };
      } catch (error) {
        status = {
          ...base,
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    this.#cache.set(providerId, { at: this.#now(), status });
    return status;
  }

  /** Availability for every provider in the vocabulary, registered or not. */
  async statuses(): Promise<ProviderStatus[]> {
    return Promise.all(LAB_PROVIDERS.map((id) => this.status(id)));
  }

  /** Drop memoised availability, e.g. after an operator starts Docker. */
  invalidate(providerId?: string): void {
    if (providerId && isLabProviderId(providerId)) this.#cache.delete(providerId);
    else this.#cache.clear();
  }
}

/**
 * A registry backed by a single provider.
 *
 * Used by tests and by any caller that already holds the one provider it cares
 * about. The provider answers only for its own id, so a lab declaring a
 * different provider still fails loudly rather than silently landing in the
 * wrong sandbox.
 */
export function singleProviderRegistry(provider: LabProvider): ProviderRegistry {
  return new ProviderRegistry().register({ provider });
}
