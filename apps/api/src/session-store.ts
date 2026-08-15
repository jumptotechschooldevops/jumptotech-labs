/**
 * Lab session bookkeeping.
 *
 * Story 1 requires no database, so this ships an in-memory implementation
 * behind an interface. Swapping in a PostgreSQL-backed store later means
 * implementing `LabSessionStore` and changing one line in `index.ts` — no
 * route or service code moves. The record shape below is deliberately
 * relational-friendly (flat, serialisable, timestamped).
 */

export interface LabSession {
  sessionId: string;
  labId: string;
  namespace: string;
  environmentId: string;
  startedAt: string;
  expiresAt: string;
  durationSeconds: number;
}

export interface LabSessionStore {
  put(session: LabSession): Promise<void>;
  getByLabId(labId: string): Promise<LabSession | null>;
  delete(labId: string): Promise<void>;
}

export class InMemoryLabSessionStore implements LabSessionStore {
  #byLabId = new Map<string, LabSession>();

  async put(session: LabSession): Promise<void> {
    this.#byLabId.set(session.labId, session);
  }

  async getByLabId(labId: string): Promise<LabSession | null> {
    return this.#byLabId.get(labId) ?? null;
  }

  async delete(labId: string): Promise<void> {
    this.#byLabId.delete(labId);
  }
}
