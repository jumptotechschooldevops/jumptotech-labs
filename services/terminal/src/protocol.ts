/**
 * Terminal wire protocol (JSON over WebSocket).
 *
 * The first frame a client sends MUST be `auth`. Anything else closes the
 * socket. Tokens travel in the message body rather than the URL so they do
 * not end up in proxy/access logs.
 */

export type ClientMessage =
  | { type: 'auth'; token: string; cols?: number; rows?: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type ServerMessage =
  | {
      type: 'ready';
      sessionId: string;
      labId: string;
      /** What the sandbox is: a Kubernetes namespace or a sandbox container. */
      sandboxKind?: 'namespace' | 'container';
      /** The sandbox's handle. Possessing it grants nothing — see README. */
      sandboxRef?: string;
      /** Historical name for `sandboxRef`. */
      namespace: string;
    }
  /**
   * The shell was replaced under a live socket.
   *
   * Sent after a container-backed `Reset Lab`, which recreates the sandbox and
   * therefore kills the shell inside it. A distinct type rather than a second
   * `ready`: the browser has already wired up its input handler and its
   * keep-alive, and must not do either twice.
   */
  | { type: 'reattached'; sessionId: string; sandboxRef: string; namespace: string }
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

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Parse and shape-check an inbound frame. Throws `ProtocolError` on junk. */
export function parseClientMessage(raw: string): ClientMessage {
  if (raw.length > MAX_FRAME_BYTES) {
    throw new ProtocolError('FRAME_TOO_LARGE', 'Message exceeds the maximum frame size');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError('MALFORMED_FRAME', 'Message is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolError('MALFORMED_FRAME', 'Message must be a JSON object');
  }

  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case 'auth':
      if (typeof msg.token !== 'string') {
        throw new ProtocolError('MALFORMED_FRAME', 'auth requires a string token');
      }
      return {
        type: 'auth',
        token: msg.token,
        cols: clampCols(msg.cols),
        rows: clampRows(msg.rows),
      };

    case 'input':
      if (typeof msg.data !== 'string') {
        throw new ProtocolError('MALFORMED_FRAME', 'input requires string data');
      }
      if (msg.data.length > MAX_INPUT_CHARS) {
        throw new ProtocolError('FRAME_TOO_LARGE', 'input payload is too large');
      }
      return { type: 'input', data: msg.data };

    case 'resize':
      return { type: 'resize', cols: clampCols(msg.cols), rows: clampRows(msg.rows) };

    case 'ping':
      return { type: 'ping' };

    default:
      throw new ProtocolError('UNKNOWN_MESSAGE', `Unsupported message type '${String(msg.type)}'`);
  }
}
