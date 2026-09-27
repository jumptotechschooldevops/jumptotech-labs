/**
 * Automatic sandbox cleanup.
 *
 * Students are never responsible for cleanup. Four things get a namespace
 * deleted:
 *
 *   expired   — the session passed its absolute deadline (`expires_at`)
 *   idle      — nobody has interacted with it for the idle budget
 *   abandoned — a student's End is still `ENDING` after `abandonedEndGraceMs`:
 *               its process died, or its destroy did not complete. It is
 *               finished as the End it was, never relabelled EXPIRED.
 *               Or a start is still `CREATING` after `abandonedStartGraceMs`:
 *               the process building it died (a restart mid-Start), or lost
 *               the database before it could record ACTIVE or FAILED.
 *   orphaned  — the cluster has a managed sandbox namespace the store has no
 *               record of (an API restart, or a start that failed midway), or
 *               one whose session already finished (a start or reset that lost
 *               its session to a teardown and could not discard what it built)
 *
 * And one interrupted operation is recovered without deleting anything: a
 * session still `RESETTING` after `resetRecoveryGraceMs` becomes `DEGRADED`,
 * which the student can reset again or end, and which idle and absolute expiry
 * still reclaim.
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
import type { DestroyResult, LabProvider, ManagedSandbox } from '../types.js';
import { ProviderRegistry, singleProviderRegistry } from '../providers/registry.js';
import { ABANDONED_START_REASON, type SessionManager, type TeardownResult } from './manager.js';
import { isExpired, isIdle } from './store.js';
import { isTerminalStatus, type LabSession } from './types.js';

export type SweepReason = 'expired' | 'idle' | 'abandoned' | 'orphaned';

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
   * How long a session may stay `RESETTING` before its reset is presumed dead
   * and the session is moved to `DEGRADED`.
   *
   * Longer than any healthy reset: the Docker track waits up to three minutes
   * for a sandbox daemon on its own. Presuming a live reset dead is safe — its
   * fenced release fails and it leaves the sandbox alone — but it turns a slow
   * success into a "reset again", so this errs long.
   */
  resetRecoveryGraceMs?: number;
  /**
   * How long a session may stay `ENDING` before the reaper finishes that End
   * itself.
   *
   * Resuming a live End is harmless — destroy is idempotent and only one
   * teardown records the ending — so this only avoids doubling the work of a
   * normal End, which takes seconds, or of a namespace still terminating.
   */
  abandonedEndGraceMs?: number;
  /**
   * How long a session may stay `CREATING` before its start is presumed dead
   * and the session is torn down.
   *
   * Nothing else ever moves such a row. Only the start that inserted it can
   * make it ACTIVE or FAILED, and a process that died mid-Start — a deploy, a
   * crash, a database blip on the final write — leaves it CREATING, holding a
   * capacity slot and the student's own (the private beta allows one), behind
   * a "Preparing…" screen that offers no action, until idle expiry.
   *
   * Longer than any healthy start, for the reason `resetRecoveryGraceMs` is:
   * provisioning is measured up to 300 s and the proxy gives Start 330 s.
   * Tearing down a start that is alive but slow is safe — it loses its claim,
   * discards what it built and reports the lab closed — but it turns a slow
   * success into "start again", so this errs long.
   */
  abandonedStartGraceMs?: number;
  /**
   * How long a finished session record is kept for the UI to read before it is
   * dropped from the store. Zero keeps them forever.
   */
  retentionMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /**
   * Observability hooks — PLATFORM-003. Plain callbacks; see
   * `SessionManagerOptions.metrics` for why this package takes no metric type.
   */
  metrics?: ReaperMetricsHooks;
}

/** See `ReaperOptions.metrics`. */
export interface ReaperMetricsHooks {
  onSweep?(event: {
    /** `ok` or `failed`. */
    outcome: string;
    durationMs: number;
    /**
     * Managed sandboxes this pass found that the store had no record of.
     *
     * Reported as a gauge per provider rather than a counter, because the
     * question is "how many are unaccounted for right now", not "how many have
     * ever been". A steady non-zero value is a leak; a brief spike during a
     * start is normal.
     */
    orphansByProvider: Record<string, number>;
    /**
     * Errors this pass recorded and survived: a listing or a teardown that
     * failed. The pass still counts as `ok` (see `sweep`), so without this a
     * teardown failing on every sweep is visible only in the log.
     */
    errors?: number;
  }): void;
  onReclaimed?(reason: string, provider: string): void;
  /**
   * An operation whose owner is gone, made safe or finished by the reaper:
   * `interrupted_reset` (now DEGRADED), `abandoned_end` (the End completed) or
   * `abandoned_start` (a start that never finished, torn down).
   */
  onRecovered?(reason: RecoveryReason, provider: string): void;
  /** A session teardown this sweep drove that was not confirmed gone. */
  onTeardownIncomplete?(reason: SweepReason, provider: string): void;
  /**
   * A refusal to delete: `no_expiry_label` or `within_grace_period`. Discovery
   * is owner-scoped, so a sandbox another deployment owns is never seen here.
   */
  onSkipped?(reason: string): void;
  onDeleteFailed?(provider: string, reason: string): void;
}

export type RecoveryReason = 'interrupted_reset' | 'abandoned_end' | 'abandoned_start';

export interface SweepResult {
  /** Namespaces confirmed gone during this sweep. */
  removed: string[];
  reasons: Record<string, SweepReason>;
  /** Teardowns started but not yet confirmed; the next sweep re-enters them. */
  pending: string[];
  errors: string[];
  /** Live sessions inspected and deliberately left alone. */
  retained: number;
  /** Sessions whose abandoned reset was moved to DEGRADED during this sweep. */
  recovered: string[];
  /** Finished session records dropped by the retention sweep. */
  forgotten: string[];
}

export class SessionReaper {
  #timer: NodeJS.Timeout | undefined;
  #sweeping = false;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #orphanGraceMs: number;
  readonly #resetRecoveryGraceMs: number;
  readonly #abandonedEndGraceMs: number;
  readonly #abandonedStartGraceMs: number;
  readonly #retentionMs: number;
  readonly #providers: ProviderRegistry;
  readonly #metrics: ReaperMetricsHooks;

  constructor(private readonly options: ReaperOptions) {
    this.#metrics = options.metrics ?? {};
    this.#now = options.now ?? (() => Date.now());
    /*
     * Silent by default, matching `SessionManager`. A library writing to stdout
     * on its own initiative is how unstructured lines survive a migration to
     * structured logging; the composition root always injects one.
     */
    this.#log = options.log ?? (() => undefined);
    this.#orphanGraceMs = options.orphanGraceMs ?? 60_000;
    // Never zero: a reset's claim is fenced on its status timestamp, and a grace
    // period is what guarantees a later claim of the same session carries a
    // later one than the claim that was recovered.
    this.#resetRecoveryGraceMs = Math.max(1, options.resetRecoveryGraceMs ?? 10 * 60_000);
    this.#abandonedEndGraceMs = options.abandonedEndGraceMs ?? 5 * 60_000;
    this.#abandonedStartGraceMs = options.abandonedStartGraceMs ?? 10 * 60_000;
    this.#retentionMs = options.retentionMs ?? 15 * 60_000;
    this.#providers =
      options.providers ??
      (options.provider ? singleProviderRegistry(options.provider) : options.sessions.providers);
  }

  /** An instrumentation failure must never stop cleanup. */
  #emit(call: (hooks: ReaperMetricsHooks) => void): void {
    try {
      call(this.#metrics);
    } catch {
      /* cleanup is more important than counting it */
    }
  }

  /** Begin sweeping. The timer is unref'd so it never holds the process open. */
  start(): void {
    if (this.#timer) return;

    /*
     * Seed the last-success timestamp at start.
     *
     * `jtt_reaper_last_success_timestamp_seconds` defaults to 0, and the alert
     * is `time() - <gauge> > 300`. Unseeded, that evaluates to the current Unix
     * time on a freshly started process — so `ReaperStalled` fires immediately
     * and permanently on every deploy, which is both wrong and the fastest way
     * to get the most important reliability alert in the platform silenced.
     *
     * Seeding says "cleanup is up to date as of now", which at start is true in
     * the only sense that matters: nothing has had time to leak, and the first
     * sweep is one interval away. If the sweep then never runs, the alert still
     * fires 300s later — which is exactly the case it exists for.
     */
    this.#emit((m) =>
      m.onSweep?.({ outcome: 'started', durationMs: 0, orphansByProvider: {} }),
    );
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
      recovered: [],
      forgotten: [],
    };

    // Overlapping sweeps would double-drive the same teardown. Skipping is
    // correct: the next tick picks up whatever this one did not finish.
    if (this.#sweeping) return result;
    this.#sweeping = true;
    const startedAt = this.#now();
    this.#orphansThisSweep = {};
    let failed = false;
    try {
      await this.#sweepSessions(result);
      await this.#sweepOrphans(result);
      await this.#sweepRetention(result);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.#sweeping = false;
      /*
       * `errors` non-empty still counts as a completed sweep.
       *
       * One unreachable provider must not make the whole pass look failed —
       * the other providers' sandboxes really were reclaimed, and marking the
       * sweep failed would fire the "cleanup has stopped" alert while cleanup
       * is in fact running. A thrown error is a different matter: nothing
       * after it ran.
       */
      this.#emit((m) =>
        m.onSweep?.({
          outcome: failed ? 'failed' : 'ok',
          durationMs: Math.max(0, this.#now() - startedAt),
          orphansByProvider: this.#orphansThisSweep,
          errors: result.errors.length,
        }),
      );
    }
    return result;
  }

  /** Orphan counts for the sweep in flight, reported as a gauge when it ends. */
  #orphansThisSweep: Record<string, number> = {};

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

      const expired = isExpired(session, now);
      const idle = isIdle(session, now);
      const inStatusMs = now - Date.parse(session.statusChangedAt);
      const ref = session.sandboxRef ?? session.namespace;

      /*
       * A student's End, still unfinished.
       *
       * Only an End claims `ENDING`, so only an End can finish one — and the
       * student already pressed it. Within the grace period it is left to its
       * owner; after it, the reaper resumes it as that End, whatever the
       * absolute deadline says. Waiting for the deadline instead left the slot
       * held and the sandbox standing for up to a whole session lifetime.
       */
      if (session.status === 'ENDING') {
        if (inStatusMs < this.#abandonedEndGraceMs) {
          result.pending.push(ref);
          continue;
        }
        await this.#finish(
          result,
          session,
          'abandoned',
          () => this.options.sessions.resumeAbandonedEnd(session.sessionId),
          'abandoned_end',
        );
        continue;
      }

      /*
       * A start nobody is running any more.
       *
       * Torn down like an expiry — the same fenced teardown, the same
       * session-scoped destroy — and recorded EXPIRED with its own reason, so the
       * student's page shows a finished lab they can start again instead of
       * "Preparing…" for the rest of the idle window. Past its deadline or idle,
       * it is torn down below exactly as before. If the start was alive after
       * all, its CREATING → ACTIVE write now fails and it discards what it built.
       *
       * The claim is fenced on the CREATING stamp this sweep read. The sweep may
       * spend minutes on earlier teardowns first, and a start that reached
       * ACTIVE meanwhile re-stamped the row: `expire` claims from any live
       * status, so unfenced it tore down a lab that had just finished starting.
       */
      if (
        session.status === 'CREATING' &&
        !expired &&
        !idle &&
        inStatusMs >= this.#abandonedStartGraceMs
      ) {
        await this.#finish(
          result,
          session,
          'abandoned',
          () =>
            this.options.sessions.expire(session.sessionId, ABANDONED_START_REASON, {
              statusChangedAt: session.statusChangedAt,
            }),
          'abandoned_start',
        );
        continue;
      }

      /*
       * A reset nobody is running any more.
       *
       * Expiry still wins: a session past its deadline, or idle, is torn down
       * from RESETTING exactly as before. Otherwise it is recovered to DEGRADED
       * — never ACTIVE, because what the dead reset left behind is unknown.
       */
      if (
        session.status === 'RESETTING' &&
        !expired &&
        !idle &&
        inStatusMs >= this.#resetRecoveryGraceMs
      ) {
        try {
          const recovered = await this.options.sessions.recoverInterruptedReset(session);
          if (recovered) {
            result.recovered.push(session.sessionId);
            this.#emit((m) => m.onRecovered?.('interrupted_reset', session.provider));
            this.#log(`recovered ${session.sessionId}: interrupted reset is now DEGRADED (lab=${session.labId})`);
          } else {
            result.retained += 1;
          }
        } catch (error) {
          result.errors.push(`${ref}: ${describe(error)}`);
        }
        continue;
      }

      // A teardown already in flight is re-entered every pass until the
      // namespace is verifiably gone — that is the idempotence guarantee.
      const inFlight = session.status === 'EXPIRING';

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
      // An idle expiry is fenced on the activity it judged: this sweep may
      // spend minutes on earlier teardowns first, and a student who pressed
      // Stay active or typed in the meantime has been told the lab stays.
      const fence = !inFlight && !expired ? { lastActivityAt: session.lastActivityAt } : undefined;
      await this.#finish(result, session, reason, () =>
        this.options.sessions.expire(session.sessionId, detail, fence),
      );
    }
  }

  /** Drive one session teardown and record what it achieved. */
  async #finish(
    result: SweepResult,
    session: LabSession,
    reason: SweepReason,
    teardown: () => Promise<TeardownResult>,
    recovered?: Extract<RecoveryReason, 'abandoned_end' | 'abandoned_start'>,
  ): Promise<void> {
    const ref = session.sandboxRef ?? session.namespace;
    try {
      const outcome = await teardown();
      const { status } = outcome.session;
      if (!outcome.destroy.namespaceGone && !isTerminalStatus(status) && status !== 'EXPIRING' && status !== 'ENDING') {
        // Not claimed, and still live: the student was active after this
        // sweep judged the session idle (the claim is fenced on it). Kept.
        result.retained += 1;
        this.#log(`kept ${ref}: active again since this sweep judged it idle`);
        return;
      }
      if (outcome.destroy.namespaceGone) {
        result.removed.push(ref);
        result.reasons[ref] = reason;
        this.#emit((m) => m.onReclaimed?.(reason, session.provider));
        if (recovered) this.#emit((m) => m.onRecovered?.(recovered, session.provider));
        this.#log(`removed ${ref} (${reason}, provider=${session.provider}, lab=${session.labId})`);
      } else {
        result.pending.push(ref);
        this.#emit((m) => m.onTeardownIncomplete?.(reason, session.provider));
        if (outcome.destroy.error) {
          result.errors.push(`${ref}: ${outcome.destroy.error.message}`);
        }
      }
    } catch (error) {
      this.#emit((m) => m.onTeardownIncomplete?.(reason, session.provider));
      result.errors.push(`${ref}: ${describe(error)}`);
    }
  }

  // --- sandboxes the substrate has but the store does not -------------------

  async #sweepOrphans(result: SweepResult): Promise<void> {
    const now = this.#now();

    /*
     * Only a session that is still running shields its sandbox.
     *
     * A finished row is kept for `retentionMs` so the UI can read it, and it
     * used to count as "known" all that time — with a retention of zero,
     * forever. But a finished session owns no sandbox. One that exists anyway
     * was built by a start or reset that lost its session to a teardown and
     * could not discard it, or survived a failed start's cleanup.
     */
    let live: Set<string>;
    const finished = new Map<string, LabSession>();
    try {
      const sessions = await this.options.sessions.list();
      live = new Set(
        sessions
          .filter((s) => !isTerminalStatus(s.status))
          .flatMap((s) => [s.sandboxRef ?? s.namespace, s.namespace]),
      );
      for (const session of sessions) {
        if (isTerminalStatus(session.status)) finished.set(session.sandboxRef ?? session.namespace, session);
      }
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

      // Counted even when the grace period means nothing is deleted yet: the
      // gauge answers "how many sandboxes is nobody accounting for", and one
      // still inside its grace window is exactly that, briefly.
      let orphans = 0;

      for (const sandbox of managed) {
        if (live.has(sandbox.sandboxRef)) continue;
        // Already going away on its own.
        if (sandbox.phase === 'Terminating' || sandbox.phase === 'removing') continue;

        orphans += 1;

        /*
         * The sandbox of a finished session needs neither an expiry label nor a
         * grace period: the session is over, so nothing in flight can still be
         * building it for a live student. It is removed through the session's
         * own provider destroy, which names the session — so the live resource
         * must carry that session id, as well as this provider and this runtime
         * owner, or the delete is refused. Discovery is already owner-scoped.
         */
        const owner = finished.get(sandbox.sandboxRef);
        if (owner) {
          const outcome = await this.options.sessions.reclaimFinishedSandbox(owner.sessionId);
          this.#recordOrphanOutcome(result, provider.id, sandbox, outcome);
          continue;
        }

        // An unlabelled expiry is left for an operator: the platform will not
        // guess a deadline for a sandbox it cannot date.
        if (sandbox.expiresAtMs === 0) {
          this.#emit((m) => m.onSkipped?.('no_expiry_label'));
          this.#log(`leaving ${sandbox.sandboxRef} alone (managed but carries no expiry label)`);
          continue;
        }
        if (now < sandbox.expiresAtMs + this.#orphanGraceMs) {
          this.#emit((m) => m.onSkipped?.('within_grace_period'));
          continue;
        }

        const outcome = await provider.destroySandbox(sandbox.sandboxRef);
        this.#recordOrphanOutcome(result, provider.id, sandbox, outcome);
      }

      this.#orphansThisSweep[provider.id] = orphans;
    }
  }

  #recordOrphanOutcome(
    result: SweepResult,
    providerId: string,
    sandbox: ManagedSandbox,
    outcome: DestroyResult,
  ): void {
    if (outcome.namespaceGone) {
      result.removed.push(sandbox.sandboxRef);
      result.reasons[sandbox.sandboxRef] = 'orphaned';
      this.#emit((m) => m.onReclaimed?.('orphaned', providerId));
      this.#log(
        `removed ${sandbox.sandboxRef} (orphaned, provider=${providerId}, lab=${sandbox.labId || 'unknown'})`,
      );
    } else if (outcome.ok) {
      result.pending.push(sandbox.sandboxRef);
    } else {
      this.#emit((m) => m.onDeleteFailed?.(providerId, outcome.error?.code ?? 'unknown'));
      result.errors.push(`${sandbox.sandboxRef}: ${outcome.error?.message ?? 'unknown error'}`);
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
