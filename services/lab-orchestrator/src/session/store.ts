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
import { occupiesCapacity, type LabSession } from './types.js';

export interface SessionStore {
  create(session: LabSession): Promise<void>;
  get(sessionId: string): Promise<LabSession | null>;
  /** Apply a partial update. Returns the new record, or null if unknown. */
  update(sessionId: string, patch: Partial<LabSession>): Promise<LabSession | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<LabSession[]>;
  /** Sessions holding a live namespace — the ones that count towards capacity. */
  listOccupying(): Promise<LabSession[]>;
  /** Guards against ever handing two sessions the same namespace. */
  findByNamespace(namespace: string): Promise<LabSession | null>;
}

export class InMemorySessionStore implements SessionStore {
  readonly #bySessionId = new Map<string, LabSession>();

  async create(session: LabSession): Promise<void> {
    if (this.#bySessionId.has(session.sessionId)) {
      throw new Error(`session ${session.sessionId} already exists`);
    }
    this.#bySessionId.set(session.sessionId, { ...session });
  }

  async get(sessionId: string): Promise<LabSession | null> {
    const found = this.#bySessionId.get(sessionId);
    return found ? { ...found } : null;
  }

  async update(sessionId: string, patch: Partial<LabSession>): Promise<LabSession | null> {
    const current = this.#bySessionId.get(sessionId);
    if (!current) return null;
    // sessionId and namespace are identity, not state: never patchable.
    const { sessionId: _ignoredId, namespace: _ignoredNs, ...safe } = patch;
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

  async findByNamespace(namespace: string): Promise<LabSession | null> {
    for (const session of this.#bySessionId.values()) {
      if (session.namespace === namespace) return { ...session };
    }
    return null;
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
