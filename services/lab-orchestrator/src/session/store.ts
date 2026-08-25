/**
 * Lab session bookkeeping.
 *
 * No database is in scope for PLATFORM-002, so this ships an in-memory
 * implementation behind an interface. Swapping in a PostgreSQL-backed store
 * later means implementing `SessionStore` and changing one line in the
 * composition root — no route, service, or provider code moves. The record
 * shape is deliberately relational-friendly: flat, serialisable, timestamped.
 *
 * The store is bookkeeping only. It is never the authority on whether a sandbox
 * exists — the cluster is. The reaper reconciles the two, which is what makes
 * an API restart survivable even though this store is not.
 */
import { occupiesCapacity, type LabSession, type SessionStatus } from './types.js';

export interface SessionStore {
  create(session: LabSession): Promise<void>;
  get(sessionId: string): Promise<LabSession | null>;
  /** Apply a partial update. Returns the new record, or null if unknown. */
  update(sessionId: string, patch: Partial<LabSession>): Promise<LabSession | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<LabSession[]>;
  /** Sessions holding a live sandbox — the ones that count towards capacity. */
  listOccupying(): Promise<LabSession[]>;
  /** Guards against ever handing two sessions the same sandbox. */
  findBySandboxRef(sandboxRef: string): Promise<LabSession | null>;
  /** Kubernetes-specific alias of `findBySandboxRef`. */
  findByNamespace(namespace: string): Promise<LabSession | null>;

  /**
   * Move a session to `to`, but only from one of `from`.
   *
   * The concurrency primitive, and the reason `update` is not enough. Two API
   * instances can act on one session at the same time — a student pressing End
   * while a reaper expires the same row — and a read-then-write cannot make
   * that safe: both read ACTIVE, both write, and the later one silently wins.
   *
   * A transition is a single conditional write instead. Exactly one caller
   * observes the row it asked for; every other gets `null` and can see it lost
   * rather than assume it won. That is what stops ENDED being resurrected to
   * ACTIVE by an in-flight request, and what makes two reapers finding the same
   * expired session harmless.
   *
   * Returns the new record, or `null` when the session is unknown or was in
   * none of the `from` states.
   */
  transition(
    sessionId: string,
    from: readonly SessionStatus[],
    to: SessionStatus,
    patch?: Partial<LabSession>,
  ): Promise<LabSession | null>;

  /**
   * Record that a student is still working, without touching the deadline.
   *
   * Separate from `update` because it must never revive a finished session: an
   * activity ping that arrives after End must not move ENDED back to ACTIVE.
   * Returns `null` when the session is not in an occupying state.
   */
  touchActivity(sessionId: string, at: string): Promise<LabSession | null>;

  /**
   * Sessions whose absolute deadline has passed, or which have been idle too
   * long, as of `now`.
   *
   * The reaper's candidate scan. Asking the store rather than filtering
   * `list()` in the process is what makes expiry survive a restart: the rows
   * outlive the process that created them, so a fresh instance finds them.
   */
  listExpirable(nowIso: string): Promise<LabSession[]>;

  /**
   * Insert a session only if the deployment is below `maxOccupying`.
   *
   * Check-and-insert has to be one indivisible step. Reading the count and then
   * inserting leaves a gap — an `await` is enough, even single-threaded — in
   * which another start can pass the same check, and two instances sharing a
   * database can both see the last free slot. Returns `false` when at capacity,
   * so no sandbox is ever created for a session that will not be admitted.
   */
  createWithinCapacity(session: LabSession, maxOccupying: number): Promise<boolean>;

  /**
   * How many sessions currently hold a sandbox.
   *
   * Capacity has to be counted from durable state, not from a field on one
   * process: three API instances each keeping their own tally would admit three
   * times the configured limit between them.
   */
  countOccupying(): Promise<number>;
}

export class InMemorySessionStore implements SessionStore {
  readonly #bySessionId = new Map<string, LabSession>();

  async create(session: LabSession): Promise<void> {
    this.#assertInsertable(session);
    this.#bySessionId.set(session.sessionId, { ...session });
  }

  /**
   * The same two uniqueness rules the durable schema enforces.
   *
   * The sandbox check used to be missing here, so this double was weaker than
   * production: a test could store two sessions pointing at one sandbox and
   * pass, while PostgreSQL's UNIQUE constraint would have refused it. A double
   * that accepts what production rejects proves nothing.
   */
  #assertInsertable(session: LabSession): void {
    if (this.#bySessionId.has(session.sessionId)) {
      throw new Error(`session ${session.sessionId} already exists`);
    }
    for (const existing of this.#bySessionId.values()) {
      if (existing.sandboxRef === session.sandboxRef) {
        throw new Error(
          `sandbox ${session.sandboxRef} is already held by session ${existing.sessionId}`,
        );
      }
    }
  }

  async get(sessionId: string): Promise<LabSession | null> {
    const found = this.#bySessionId.get(sessionId);
    return found ? { ...found } : null;
  }

  async update(sessionId: string, patch: Partial<LabSession>): Promise<LabSession | null> {
    const current = this.#bySessionId.get(sessionId);
    if (!current) return null;
    /*
     * Identity is not state.
     *
     * The session id, its provider, its sandbox kind, and its sandbox handle
     * are fixed at creation. Dropping them here is what makes "a live session
     * cannot be moved to another sandbox, or to another provider" true by
     * construction rather than by every caller remembering not to.
     */
    const {
      sessionId: _ignoredId,
      namespace: _ignoredNs,
      sandboxRef: _ignoredRef,
      provider: _ignoredProvider,
      sandboxKind: _ignoredKind,
      ...safe
    } = patch;
    const next: LabSession = { ...current, ...safe };
    this.#bySessionId.set(sessionId, next);
    return { ...next };
  }

  async delete(sessionId: string): Promise<void> {
    this.#bySessionId.delete(sessionId);
  }

  async list(): Promise<LabSession[]> {
    return [...this.#bySessionId.values()].map((s) => ({ ...s }));
  }

  async listOccupying(): Promise<LabSession[]> {
    return (await this.list()).filter((s) => occupiesCapacity(s.status));
  }

  async findBySandboxRef(sandboxRef: string): Promise<LabSession | null> {
    for (const session of this.#bySessionId.values()) {
      if (session.sandboxRef === sandboxRef || session.namespace === sandboxRef) {
        return { ...session };
      }
    }
    return null;
  }

  async findByNamespace(namespace: string): Promise<LabSession | null> {
    return this.findBySandboxRef(namespace);
  }

  /**
   * Same semantics as the durable store's conditional write.
   *
   * Single-threaded here, so there is no race to lose — but the *contract* must
   * match, or a test passing against this store would prove nothing about the
   * one production runs. A caller that transitions from a state the session is
   * no longer in gets `null` in both.
   */
  async transition(
    sessionId: string,
    from: readonly SessionStatus[],
    to: SessionStatus,
    patch: Partial<LabSession> = {},
  ): Promise<LabSession | null> {
    const current = this.#bySessionId.get(sessionId);
    if (!current || !from.includes(current.status)) return null;
    return this.update(sessionId, { ...patch, status: to });
  }

  async touchActivity(sessionId: string, at: string): Promise<LabSession | null> {
    const current = this.#bySessionId.get(sessionId);
    // An activity ping for a finished session is ignored rather than reviving
    // it: the deadline has already been acted on.
    if (!current || !occupiesCapacity(current.status)) return null;
    return this.update(sessionId, { lastActivityAt: at });
  }

  async listExpirable(nowIso: string): Promise<LabSession[]> {
    const now = Date.parse(nowIso);
    return [...this.#bySessionId.values()].filter((session) => {
      if (!occupiesCapacity(session.status)) return false;
      if (Date.parse(session.expiresAt) <= now) return true;
      const idleDeadline =
        Date.parse(session.lastActivityAt) + session.idleTimeoutSeconds * 1_000;
      return idleDeadline <= now;
    });
  }

  async countOccupying(): Promise<number> {
    return (await this.listOccupying()).length;
  }

  /**
   * Atomic here by being synchronous: no `await` separates the count from the
   * insert, so nothing can interleave between them. The durable store reaches
   * the same guarantee with a transaction and an advisory lock.
   */
  async createWithinCapacity(session: LabSession, maxOccupying: number): Promise<boolean> {
    let occupied = 0;
    for (const existing of this.#bySessionId.values()) {
      if (occupiesCapacity(existing.status)) occupied += 1;
    }
    if (occupiesCapacity(session.status) && occupied >= maxOccupying) return false;
    this.#assertInsertable(session);
    this.#bySessionId.set(session.sessionId, { ...session });
    return true;
  }
}

/** Has this session passed its hard, absolute deadline? */
export function isExpired(session: LabSession, nowMs: number): boolean {
  return Date.parse(session.expiresAt) <= nowMs;
}

/**
 * Has this session been untouched for longer than its idle budget?
 *
 * The budget is read from the session record rather than from live config, so
 * changing `IDLE_TIMEOUT_MINUTES` never retroactively kills a running lab.
 */
export function isIdle(session: LabSession, nowMs: number): boolean {
  return nowMs - Date.parse(session.lastActivityAt) >= session.idleTimeoutSeconds * 1000;
}
