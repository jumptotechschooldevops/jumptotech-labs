/**
 * The broker wire protocol (JSON over WebSocket), spoken between the terminal
 * service and `sandboxd`.
 *
 * Deliberately *narrower* than the browser-facing terminal protocol it sits
 * behind. The browser protocol carries a token and negotiates a session; this
 * one carries a session id that the terminal has already authenticated, and
 * nothing else that could select anything.
 *
 * The one rule: the first frame must be `attach`. Anything else closes the
 * socket, so a caller cannot send input at a shell that does not exist yet.
 */

export type BrokerClientMessage =
  | { type: 'attach'; sessionId: string; cols?: number; rows?: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type BrokerServerMessage =
  | { type: 'attached'; sandboxRef: string; user: string; workdir: string }
  | { type: 'output'; data: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'pong' };

export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_INPUT_CHARS = 8 * 1024;
export const MIN_COLS = 20;
export const MAX_COLS = 500;
export const MIN_ROWS = 5;
export const MAX_ROWS = 200;

export function clampCols(value: unknown): number {
  return clampInt(value, MIN_COLS, MAX_COLS, 80);
}

export function clampRows(value: unknown): number {
  return clampInt(value, MIN_ROWS, MAX_ROWS, 24);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class BrokerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerProtocolError';
  }
}

/** Parse and bound one client frame. Throws `BrokerProtocolError` on anything else. */
export function parseBrokerClientMessage(raw: string): BrokerClientMessage {
  if (raw.length > MAX_FRAME_BYTES) throw new BrokerProtocolError('frame too large');

  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    throw new BrokerProtocolError('frame is not valid JSON');
  }
  if (typeof msg !== 'object' || msg === null) throw new BrokerProtocolError('frame is not an object');

  const type = (msg as { type?: unknown }).type;
  switch (type) {
    case 'attach': {
      const sessionId = (msg as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== 'string') throw new BrokerProtocolError('attach requires a sessionId');
      const m = msg as { cols?: unknown; rows?: unknown };
      return {
        type: 'attach',
        sessionId,
        cols: clampCols(m.cols),
        rows: clampRows(m.rows),
      };
    }
    case 'input': {
      const data = (msg as { data?: unknown }).data;
      if (typeof data !== 'string') throw new BrokerProtocolError('input requires string data');
      if (data.length > MAX_INPUT_CHARS) throw new BrokerProtocolError('input too large');
      return { type: 'input', data };
    }
    case 'resize': {
      const m = msg as { cols?: unknown; rows?: unknown };
      return { type: 'resize', cols: clampCols(m.cols), rows: clampRows(m.rows) };
    }
    case 'ping':
      return { type: 'ping' };
    default:
      throw new BrokerProtocolError(`unknown message type '${String(type)}'`);
  }
}
