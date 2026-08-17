/**
 * Test doubles shared with the API suite.
 *
 * Exported through `@jumptotech/progress/testing`, mirroring how the
 * orchestrator publishes its Kubernetes and container fakes.
 */
import { InMemoryProgressRepository } from '../src/memory-repository.js';
import { ProgressService } from '../src/service.js';
import type { ProgressRepository } from '../src/repository.js';
import type { ProgressStoreHealth } from '../src/types.js';

/** A service backed by the in-memory store, with an optional fixed clock. */
export function createTestProgressService(options: { now?: () => number } = {}): {
  service: ProgressService;
  repository: InMemoryProgressRepository;
} {
  const repository = new InMemoryProgressRepository();
  const service = new ProgressService({
    repository,
    ...(options.now ? { now: options.now } : {}),
  });
  return { service, repository };
}

/**
 * A store that is down.
 *
 * Used to prove the property that matters when the database misbehaves: a
 * student can still start, check, reset and end a lab. Bookkeeping failing is
 * not allowed to take the classroom with it.
 */
export class BrokenProgressRepository implements ProgressRepository {
  constructor(private readonly message = 'connection refused') {}

  #fail(): never {
    throw new Error(this.message);
  }

  async ensureStudent(): Promise<never> {
    this.#fail();
  }
  async createAttempt(): Promise<never> {
    this.#fail();
  }
  async bindSession(): Promise<never> {
    this.#fail();
  }
  async findAttempt(): Promise<never> {
    this.#fail();
  }
  async findAttemptBySession(): Promise<never> {
    this.#fail();
  }
  async recordCheck(): Promise<never> {
    this.#fail();
  }
  async recordReset(): Promise<never> {
    this.#fail();
  }
  async finishAttempt(): Promise<never> {
    this.#fail();
  }
  async recordHint(): Promise<never> {
    this.#fail();
  }
  async expireStaleAttempts(): Promise<never> {
    this.#fail();
  }
  async listAttempts(): Promise<never> {
    this.#fail();
  }
  async getAttempt(): Promise<never> {
    this.#fail();
  }
  async listHintUsage(): Promise<never> {
    this.#fail();
  }
  async listProgress(): Promise<never> {
    this.#fail();
  }

  async health(): Promise<ProgressStoreHealth> {
    return { ok: false, store: 'postgres', detail: this.message };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
