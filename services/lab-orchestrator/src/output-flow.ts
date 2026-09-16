/**
 * Output flow control for a shell streamed over a WebSocket.
 *
 * A PTY produces output as fast as the process inside it writes, and
 * `WebSocket#send` never refuses: whatever the peer has not yet read is queued
 * in this process' memory. A browser that stops reading — a slow link, a
 * suspended laptop, or a student's own client that simply never reads its
 * socket — therefore turns `yes` into unbounded growth of one shared service,
 * and every other student's shell goes down with it when that service is
 * killed for memory.
 *
 * ```text
 *   pty ──onData──► socket.send ──► peer
 *    ▲                   │
 *    └── pause/resume ◄──┘ bufferedAmount above high water / back under low water
 * ```
 *
 * So the source is paused once the socket holds more than `highWaterBytes`
 * that the peer has not taken, and resumed once it has drained below
 * `lowWaterBytes`. Pausing a PTY stops reading its master side, so the process
 * inside blocks on its next write — exactly what a real terminal does when
 * nobody is reading it. Pausing a relayed socket stops reading from the peer
 * that is streaming, which pushes the same backpressure one hop upstream.
 *
 * `hardLimitBytes` is the backstop, not the mechanism. Data already read
 * before a pause still arrives, and a source that cannot be paused cannot be
 * slowed at all; when the queue passes the hard limit anyway, `onOverflow`
 * runs and the caller ends that one connection rather than the whole service.
 *
 * Shared by the terminal service and `sandboxd`, the two processes that relay
 * a PTY to a socket.
 */

/** The part of a WebSocket this needs: how much it is still holding. */
export interface BufferedSocket {
  readonly bufferedAmount: number;
}

/** Something that can stop producing output for a while. */
export interface PausableSource {
  pause(): void;
  resume(): void;
}

export interface OutputFlowOptions {
  /** Pause the source once the socket holds more than this. */
  highWaterBytes: number;
  /** Resume it once the socket holds this much or less. */
  lowWaterBytes: number;
  /** End the connection if the socket holds more than this regardless. */
  hardLimitBytes: number;
  /** How often a paused flow checks whether the socket has drained. */
  pollIntervalMs: number;
}

export const DEFAULT_OUTPUT_FLOW: Readonly<OutputFlowOptions> = Object.freeze({
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  hardLimitBytes: 16 * 1024 * 1024,
  pollIntervalMs: 50,
});

export interface OutputFlow {
  /** Call after every send. Pauses, or reports an overflow, as needed. */
  afterSend(): void;
  /** True while the source is paused. */
  readonly paused: boolean;
  /** Stop polling. Does not resume the source. Idempotent. */
  dispose(): void;
}

export function createOutputFlow(
  socket: BufferedSocket,
  source: PausableSource,
  onOverflow: () => void,
  overrides: Partial<OutputFlowOptions> = {},
): OutputFlow {
  const options = resolveOutputFlowOptions(overrides);
  let paused = false;
  let disposed = false;
  let overflowed = false;
  let timer: NodeJS.Timeout | undefined;

  const stopPolling = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const overflow = (): void => {
    if (overflowed) return;
    overflowed = true;
    stopPolling();
    onOverflow();
  };

  const poll = (): void => {
    if (disposed) return stopPolling();
    if (socket.bufferedAmount > options.hardLimitBytes) return overflow();
    if (socket.bufferedAmount > options.lowWaterBytes) return;
    stopPolling();
    paused = false;
    try {
      source.resume();
    } catch {
      /* the source is already gone; nothing is left to resume */
    }
  };

  return {
    afterSend(): void {
      if (disposed || overflowed) return;
      const buffered = socket.bufferedAmount;
      if (buffered > options.hardLimitBytes) return overflow();
      if (paused || buffered <= options.highWaterBytes) return;
      paused = true;
      try {
        source.pause();
      } catch {
        /* a source that cannot pause is bounded by the hard limit instead */
      }
      timer = setInterval(poll, options.pollIntervalMs);
      // A paused flow must never be the only thing keeping a process alive.
      timer.unref?.();
    },
    get paused(): boolean {
      return paused;
    },
    dispose(): void {
      disposed = true;
      stopPolling();
    },
  };
}

/** Merge overrides onto the defaults, refusing an ordering that cannot work. */
export function resolveOutputFlowOptions(overrides: Partial<OutputFlowOptions> = {}): OutputFlowOptions {
  const options = { ...DEFAULT_OUTPUT_FLOW, ...overrides };
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  if (
    !positive(options.highWaterBytes) ||
    !positive(options.lowWaterBytes) ||
    !positive(options.hardLimitBytes) ||
    !positive(options.pollIntervalMs) ||
    options.lowWaterBytes > options.highWaterBytes ||
    options.highWaterBytes >= options.hardLimitBytes
  ) {
    throw new RangeError(
      'output flow limits must be positive with lowWaterBytes <= highWaterBytes < hardLimitBytes',
    );
  }
  return options;
}
