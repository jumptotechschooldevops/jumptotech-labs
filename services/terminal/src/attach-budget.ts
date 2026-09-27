/**
 * How often one student may open a terminal.
 *
 * Every attach is expensive work somewhere else. The credentials exchange asks
 * the API for a binding, which for a Kubernetes lab mints a ServiceAccount
 * token and for a Docker lab reads the client certificates with three
 * `docker exec`s on the shared daemon; then the shell itself is a `kubectl` or
 * broker `docker exec`. Attaches for one session are taken in turn
 * (`attachInTurn`), which bounds how many run *at once* — not how many run.
 * One valid token on a connect-authenticate-close loop drove about 60 of them a
 * second, each doing all of that, against infrastructure every other student
 * shares.
 *
 * The browser never needs more than a handful: a reload, a reset's reconnect,
 * and the workspace's automatic retries (six over about a minute, see
 * `AUTO_RECONNECTS` in apps/web). So a token bucket per *student* — the `uid`
 * in the verified token, not the socket and not the session, so neither a new
 * socket nor a second session is a fresh budget: a burst far above anything a
 * person does, and a sustained rate a loop cannot turn into a storm. An attach
 * over budget is refused before the credentials exchange, and before it can
 * replace the attach that is waiting for the session.
 */
export interface AttachBudgetOptions {
  /** Attaches a student may make at once. */
  burst: number;
  /** Attaches a student regains per minute. */
  perMinute: number;
  now?: () => number;
}

export const DEFAULT_ATTACH_BUDGET: Readonly<Pick<AttachBudgetOptions, 'burst' | 'perMinute'>> = {
  burst: 30,
  perMinute: 30,
};

interface Bucket {
  tokens: number;
  at: number;
}

export class AttachBudget {
  readonly #burst: number;
  readonly #perMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: AttachBudgetOptions) {
    this.#burst = options.burst;
    this.#perMs = options.perMinute / 60_000;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Spend one attach for `studentId`; false when they are over budget. */
  spend(studentId: string): boolean {
    const now = this.#now();
    this.#forgetRefilled(now);
    const bucket = this.#buckets.get(studentId) ?? { tokens: this.#burst, at: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + (now - bucket.at) * this.#perMs);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.#buckets.set(studentId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.#buckets.set(studentId, bucket);
    return true;
  }

  /** Students with a partly spent budget; a full one is not remembered. */
  get size(): number {
    return this.#buckets.size;
  }

  /*
   * A bucket that has refilled is the same as no bucket, so it is dropped: the
   * map holds only students who attached recently, never everyone who ever did.
   */
  #forgetRefilled(now: number): void {
    for (const [studentId, bucket] of this.#buckets) {
      if (bucket.tokens + (now - bucket.at) * this.#perMs >= this.#burst) this.#buckets.delete(studentId);
    }
  }
}
