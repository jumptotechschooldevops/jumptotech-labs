/**
 * How much a student's socket may type into a shell.
 *
 * Output has been bounded since SEC-EXH-1; input was not. Every `input` frame
 * went straight to the PTY — node-pty's local queue here, or over the broker
 * socket to sandboxd's — and a PTY whose reader has stopped (`sleep 1000`, a
 * container that is no longer reading) accepts nothing, so node-pty keeps the
 * bytes in an unbounded queue and retries every tick. A few thousand frames
 * from devtools held 150 MiB in either process; sandboxd's limit is 512 MiB,
 * and when it goes every container-track student's shell, Start, Reset and
 * Check go with it.
 *
 * A token bucket per socket: a paste of up to `burstBytes` is accepted at
 * once, and typing — or a script pasting line by line — never comes near the
 * sustained rate. What exceeds it is a flood, and the socket is closed, which
 * kills the shell and with it whatever it had queued.
 */
export interface InputBudgetOptions {
  burstBytes: number;
  bytesPerSecond: number;
  now?: () => number;
}

export const DEFAULT_INPUT_BUDGET: Readonly<InputBudgetOptions> = {
  burstBytes: 256 * 1024,
  bytesPerSecond: 8 * 1024,
};

export class InputBudget {
  readonly #burst: number;
  readonly #rate: number;
  readonly #now: () => number;
  #tokens: number;
  #at: number;

  constructor(options: InputBudgetOptions = DEFAULT_INPUT_BUDGET) {
    this.#burst = options.burstBytes;
    this.#rate = options.bytesPerSecond;
    this.#now = options.now ?? (() => Date.now());
    this.#tokens = this.#burst;
    this.#at = this.#now();
  }

  /** Spend `bytes`; false when the socket has typed more than its budget. */
  spend(bytes: number): boolean {
    const now = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#rate);
    this.#at = now;
    if (bytes > this.#tokens) return false;
    this.#tokens -= bytes;
    return true;
  }
}
