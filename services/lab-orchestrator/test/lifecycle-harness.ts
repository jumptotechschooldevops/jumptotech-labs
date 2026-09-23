/**
 * Staging tools for lifecycle races and recovery (BETA-P0-006, BETA-P0-007).
 *
 * Not a test file: shared by `session-lifecycle-races.test.ts` and
 * `session-recovery.test.ts`, each of which the PostgreSQL integration suite
 * also imports. Every pause point opens when a test says so — no timers.
 */
import {
  LinuxLabProvider,
  type CapacityLimits,
  type CreateResult,
  type DestroyResult,
  type LabSession,
  type LabSessionContext,
  type SessionTeardownContext,
  type ResetResult,
  type SessionStatus,
  type SessionStore,
  type TransitionGuard,
} from '../src/index.js';

/** A one-shot pause point: whoever reaches it parks until the test releases it. */
export interface Gate {
  /** Resolves once something has reached the gate. */
  entered: Promise<void>;
  release(): void;
}

export function gate(): Gate & { reach(): Promise<void> } {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    entered: reached,
    release,
    async reach() {
      entered();
      await released;
    },
  };
}

/** Resolves when `count` calls have been made. */
export class CallCounter {
  #calls = 0;
  #waiters: Array<{ count: number; resolve: () => void }> = [];

  get calls(): number {
    return this.#calls;
  }

  record(): void {
    this.#calls += 1;
    this.#waiters = this.#waiters.filter((w) => {
      if (this.#calls < w.count) return true;
      w.resolve();
      return false;
    });
  }

  reached(count: number): Promise<void> {
    if (this.#calls >= count) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ count, resolve }));
  }
}

/**
 * One API instance's view of the shared store.
 *
 * Delegates everything, and can park the next `get` *after* it has read — the
 * gap in which another instance's write lands on a row this one still believes
 * is ACTIVE.
 */
export class PausableStore implements SessionStore {
  #pause: (Gate & { reach(): Promise<void> }) | undefined;
  #failTransitionTo: SessionStatus | undefined;

  constructor(private readonly inner: SessionStore) {}

  /**
   * Make the next transition *to* `status` fail without writing, as a
   * connection lost mid-statement does: the caller sees an error, and the row
   * stays where it was.
   */
  failNextTransitionTo(status: SessionStatus): void {
    this.#failTransitionTo = status;
  }

  pauseNextGet(): Gate {
    this.#pause = gate();
    return this.#pause;
  }

  async get(sessionId: string): Promise<LabSession | null> {
    const found = await this.inner.get(sessionId);
    const pause = this.#pause;
    if (pause) {
      this.#pause = undefined;
      await pause.reach();
    }
    return found;
  }

  create(session: LabSession) { return this.inner.create(session); }
  update(sessionId: string, patch: Partial<LabSession>) { return this.inner.update(sessionId, patch); }
  delete(sessionId: string) { return this.inner.delete(sessionId); }
  list() { return this.inner.list(); }
  listOccupying() { return this.inner.listOccupying(); }
  findBySandboxRef(ref: string) { return this.inner.findBySandboxRef(ref); }
  findByNamespace(ns: string) { return this.inner.findByNamespace(ns); }
  transition(
    id: string,
    from: readonly SessionStatus[],
    to: SessionStatus,
    patch?: Partial<LabSession>,
    guard?: TransitionGuard,
  ) {
    if (this.#failTransitionTo === to) {
      this.#failTransitionTo = undefined;
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    }
    return this.inner.transition(id, from, to, patch, guard);
  }
  touchActivity(sessionId: string, at: string) { return this.inner.touchActivity(sessionId, at); }
  listExpirable(nowIso: string) { return this.inner.listExpirable(nowIso); }
  createWithinCapacity(session: LabSession, max: number) { return this.inner.createWithinCapacity(session, max); }
  createWithinLimits(session: LabSession, limits: CapacityLimits) { return this.inner.createWithinLimits(session, limits); }
  countOccupying() { return this.inner.countOccupying(); }
}

/** The real Linux provider over a fake runtime, with its runtime work observable and pausable. */
export class GatedLinuxProvider extends LinuxLabProvider {
  readonly creates = new CallCounter();
  readonly resets = new CallCounter();
  readonly destroys = new CallCounter();
  #resetGate: (Gate & { reach(): Promise<void> }) | undefined;
  #destroyGate: (Gate & { reach(): Promise<void> }) | undefined;
  #nextCreate: (Gate & { reach(): Promise<void> }) | undefined;
  #nextReset: (Gate & { reach(): Promise<void> }) | undefined;
  #nextDestroy: (Gate & { reach(): Promise<void> }) | undefined;

  /**
   * Park only the next start's provisioning, before it touches the runtime.
   *
   * One-shot, unlike the `hold…` gates: a reset recreates its container through
   * `create` too, and must not be caught by a gate meant for a start.
   */
  holdNextCreate(): Gate {
    this.#nextCreate = gate();
    return this.#nextCreate;
  }

  /** Park only the next reset — one whose process then "dies" — and let later ones run. */
  holdNextReset(): Gate {
    this.#nextReset = gate();
    return this.#nextReset;
  }

  /** Park only the next destroy, and let later ones run. */
  holdNextDestroy(): Gate {
    this.#nextDestroy = gate();
    return this.#nextDestroy;
  }

  override async create(context: LabSessionContext): Promise<CreateResult> {
    this.creates.record();
    const next = this.#nextCreate;
    this.#nextCreate = undefined;
    await next?.reach();
    return super.create(context);
  }

  /** Park every reset that reaches the runtime until released. */
  holdResets(): Gate {
    this.#resetGate = gate();
    return this.#resetGate;
  }

  /** Park every destroy that reaches the runtime until released. */
  holdDestroys(): Gate {
    this.#destroyGate = gate();
    return this.#destroyGate;
  }

  override async reset(context: LabSessionContext): Promise<ResetResult> {
    this.resets.record();
    const next = this.#nextReset;
    this.#nextReset = undefined;
    await next?.reach();
    await this.#resetGate?.reach();
    return super.reset(context);
  }

  override async destroy(context: SessionTeardownContext): Promise<DestroyResult> {
    this.destroys.record();
    const next = this.#nextDestroy;
    this.#nextDestroy = undefined;
    await next?.reach();
    await this.#destroyGate?.reach();
    return super.destroy(context);
  }
}
