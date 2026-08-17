/**
 * Automatic sandbox cleanup.
 *
 * Students are never responsible for cleanup. Three things get a namespace
 * deleted:
 *
 *   expired   — the session passed its absolute deadline (`expires_at`)
 *   idle      — nobody has interacted with it for the idle budget
 *   orphaned  — the cluster has a managed sandbox namespace the store has no
 *               record of (an API restart, or a start that failed midway)
 *
 * The orphan rule is what makes this safe across restarts: the in-memory store
 * is lost on restart, but the namespace labels are not, so each sandbox's
 * expiry survives in the cluster itself.
 *
 * Expiry and idle cleanup are routed through `SessionManager.expire()` rather
 * than deleting namespaces directly, so a reaped session goes through the same
 * state machine a student-initiated End Lab does:
 *
 * ```text
 *   EXPIRING ──► terminate terminal ──► delete namespace ──► verify gone ──► EXPIRED
 * ```
 *
 * **Idempotence.** Every step is safe to repeat. A session already in a
 * terminal state short-circuits; a namespace already gone counts as deleted;
 * and a sweep that finds nothing to do reports zero removals rather than
 * failing. Running two sweeps back to back produces the same end state as one.
 *
 * **Blast radius.** The reaper never passes a caller-supplied string to a
 * delete. Session namespaces come from the store (derived server-side from the
 * session id), orphans come from a label selector, and the provider re-checks
 * both the `lab-` name shape and the live ownership labels immediately before
 * every delete. `default`, `kube-system`, `kube-public`, `kube-node-lease`, and
 * any unlabelled namespace cannot be reached from here — not by a bug, and not
 * by an operator hand-labelling a system namespace, because the name check
 * would still refuse it.
 */
import type { LabProvider, ManagedSandbox } from '../types.js';
import { ProviderRegistry, singleProviderRegistry } from '../providers/registry.js';
import type { SessionManager } from './manager.js';
import { isExpired, isIdle } from './store.js';
import { isTerminalStatus } from './types.js';

export type SweepReason = 'expired' | 'idle' | 'orphaned';

export interface ReaperOptions {
  sessions: SessionManager;
  /**
   * Every provider whose sandboxes must be reclaimed.
   *
   * The orphan sweep asks each in turn, so a deployment running Kubernetes and
   * container sandboxes side by side reclaims both. Defaults to the session
   * manager's own registry, which is the right answer in production.
   */
  providers?: ProviderRegistry;
  /** A single provider, for callers that only have one. */
  provider?: LabProvider;
  /** How often to sweep. */
  intervalMs: number;
  /**
   * Grace period before an unknown sandbox is treated as orphaned, so a
   * namespace created moments ago by an in-flight start is not reclaimed
   * mid-provisioning.
   */
  orphanGraceMs?: number;
  /**
   * How long a finished session record is kept for the UI to read before it is
   * dropped from the store. Zero keeps them forever.
   */
  retentionMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export interface SweepResult {
  /** Namespaces confirmed gone during this sweep. */
  removed: string[];
  reasons: Record<string, SweepReason>;
  /** Teardowns started but not yet confirmed; the next sweep re-enters them. */
  pending: string[];
  errors: string[];
  /** Live sessions inspected and deliberately left alone. */
  retained: number;
  /** Finished session records dropped by the retention sweep. */
  forgotten: string[];
}

export class SessionReaper {
  #timer: NodeJS.Timeout | undefined;
  #sweeping = false;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #orphanGraceMs: number;
  readonly #retentionMs: number;
  readonly #providers: ProviderRegistry;

  constructor(private readonly options: ReaperOptions) {
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? ((message) => console.log(`[reaper] ${message}`));
    this.#orphanGraceMs = options.orphanGraceMs ?? 60_000;
    this.#retentionMs = options.retentionMs ?? 15 * 60_000;
    this.#providers =
      options.providers ??
      (options.provider ? singleProviderRegistry(options.provider) : options.sessions.providers);
  }

  /** Begin sweeping. The timer is unref'd so it never holds the process open. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#log(`sweep failed: ${describe(error)}`);
      });
    }, this.options.intervalMs);
    this.#timer.unref?.();
    this.#log(`started (every ${Math.round(this.options.intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One reconciliation pass. Exposed directly so tests can drive it
   * deterministically rather than waiting on a timer.
   */
  async sweep(): Promise<SweepResult> {
    const result: SweepResult = {
      removed: [],
      reasons: {},
      pending: [],
      errors: [],
      retained: 0,
      forgotten: [],
    };

    // Overlapping sweeps would double-drive the same teardown. Skipping is
    // correct: the next tick picks up whatever this one did not finish.
    if (this.#sweeping) return result;
    this.#sweeping = true;
    try {
      await this.#sweepSessions(result);
      await this.#sweepOrphans(result);
      await this.#sweepRetention(result);
    } finally {
      this.#sweeping = false;
    }
    return result;
  }

  // --- sessions the store knows about --------------------------------------

  async #sweepSessions(result: SweepResult): Promise<void> {
    const now = this.#now();
    let sessions;
    try {
      sessions = await this.options.sessions.list();
    } catch (error) {
      result.errors.push(`listing sessions: ${describe(error)}`);
      return;
    }

    for (const session of sessions) {
      if (isTerminalStatus(session.status)) continue;

      // A teardown already in flight is re-entered every pass until the
      // namespace is verifiably gone — that is the idempotence guarantee.
      const inFlight = session.status === 'EXPIRING' || session.status === 'ENDING';
      const expired = isExpired(session, now);
      const idle = isIdle(session, now);

      if (!inFlight && !expired && !idle) {
        result.retained += 1;
        continue;
      }

      const reason: SweepReason = expired ? 'expired' : 'idle';
      const detail = inFlight
        ? (session.statusReason ?? 'resuming an interrupted teardown')
        : expired
          ? 'absolute session lifetime reached'
          : `idle for more than ${session.idleTimeoutSeconds}s`;

      // Teardown runs through `SessionManager.expire`, which dispatches to the
      // provider recorded on the session — so a Kubernetes namespace and a
      // Linux container both reach EXPIRED through the same state machine.
      const ref = session.sandboxRef ?? session.namespace;
      try {
        const outcome = await this.options.sessions.expire(session.sessionId, detail);
        if (outcome.destroy.namespaceGone) {
          result.removed.push(ref);
          result.reasons[ref] = reason;
          this.#log(`removed ${ref} (${reason}, provider=${session.provider}, lab=${session.labId})`);
        } else {
          result.pending.push(ref);
          if (outcome.destroy.error) {
            result.errors.push(`${ref}: ${outcome.destroy.error.message}`);
          }
        }
      } catch (error) {
        result.errors.push(`${ref}: ${describe(error)}`);
      }
    }
  }

  // --- sandboxes the cluster has but the store does not ---------------------

  async #sweepOrphans(result: SweepResult): Promise<void> {
    const now = this.#now();

    let known: Set<string>;
    try {
      known = new Set(
        (await this.options.sessions.list()).flatMap((s) => [s.sandboxRef ?? s.namespace, s.namespace]),
      );
    } catch (error) {
      result.errors.push(`listing sessions: ${describe(error)}`);
      return;
    }

    // Ask every registered provider for the sandboxes it owns. A provider whose
    // backend is unreachable reports the error and the sweep continues — one
    // sick backend must not stop another's cleanup.
    for (const provider of this.#providers.all()) {
      let managed: ManagedSandbox[];
      try {
        managed = await provider.listManagedSandboxes();
      } catch (error) {
        result.errors.push(`listing ${provider.id} sandboxes: ${describe(error)}`);
        continue;
      }

      for (const sandbox of managed) {
        if (known.has(sandbox.sandboxRef)) continue;
        // Already going away on its own.
        if (sandbox.phase === 'Terminating' || sandbox.phase === 'removing') continue;

        // An unlabelled expiry is left for an operator: the platform will not
        // guess a deadline for a sandbox it cannot date.
        if (sandbox.expiresAtMs === 0) {
          this.#log(`leaving ${sandbox.sandboxRef} alone (managed but carries no expiry label)`);
          continue;
        }
        if (now < sandbox.expiresAtMs + this.#orphanGraceMs) continue;

        const outcome = await provider.destroySandbox(sandbox.sandboxRef);
        if (outcome.namespaceGone) {
          result.removed.push(sandbox.sandboxRef);
          result.reasons[sandbox.sandboxRef] = 'orphaned';
          this.#log(
            `removed ${sandbox.sandboxRef} (orphaned, provider=${provider.id}, lab=${sandbox.labId || 'unknown'})`,
          );
        } else if (outcome.ok) {
          result.pending.push(sandbox.sandboxRef);
        } else {
          result.errors.push(
            `${sandbox.sandboxRef}: ${outcome.error?.message ?? 'unknown error'}`,
          );
        }
      }
    }
  }

  // --- finished records ------------------------------------------------------

  async #sweepRetention(result: SweepResult): Promise<void> {
    if (this.#retentionMs <= 0) return;
    const now = this.#now();

    for (const session of await this.options.sessions.list()) {
      if (!isTerminalStatus(session.status)) continue;
      const endedAt = session.endedAt ? Date.parse(session.endedAt) : 0;
      if (endedAt === 0 || now - endedAt < this.#retentionMs) continue;
      await this.options.sessions.forget(session.sessionId);
      result.forgotten.push(session.sessionId);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
