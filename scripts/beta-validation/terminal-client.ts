/**
 * BETA-P0-019 — a student's terminal, over the real WebSocket protocol.
 *
 * The same frames the browser's LabTerminal sends (services/terminal/src/protocol.ts):
 * `auth` first, then `input`; the server answers `ready`, `output`, `reattached`,
 * `error`, `exit`. It presents the configured browser Origin, because the
 * terminal service refuses any other.
 *
 * Commands complete deterministically, never by sleeping: each is followed by
 * `echo __P0019_<nonce>_$?__`. The shell's echo of the *typed* line still
 * contains a literal `$?`, so only the expanded output — the command having
 * finished — can match `__P0019_<nonce>_<digits>__`.
 */
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

export interface Frame {
  type: string;
  [key: string]: unknown;
}

export interface CommandResult {
  exitCode: number;
  /** Output between the command being typed and its completion marker. */
  output: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[ -/]*[@-~]|\][^]*|\r/g;

export class TerminalClient {
  readonly frames: Frame[] = [];
  closeCode: number | undefined;
  closeReason = '';
  #ws: WebSocket;
  #buffer = '';
  #listeners = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString()) as Frame;
      } catch {
        return;
      }
      this.frames.push(frame);
      if (frame.type === 'output') this.#buffer += String(frame.data);
      for (const notify of this.#listeners) notify();
    });
    ws.on('close', (code, reason) => {
      this.closeCode = code;
      this.closeReason = reason.toString();
      for (const notify of this.#listeners) notify();
    });
  }

  /** Open a socket and send the auth frame. Resolves once the socket is open. */
  static async connect(url: string, token: string, origin: string, timeoutMs = 15_000): Promise<TerminalClient> {
    const ws = new WebSocket(`${url.replace(/\/$/, '')}/terminal`, { headers: { Origin: origin } });
    const client = new TerminalClient(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('terminal socket did not open')), timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    ws.send(JSON.stringify({ type: 'auth', token, cols: 200, rows: 50 }));
    return client;
  }

  get open(): boolean {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  get output(): string {
    return this.#buffer.replace(ANSI, '');
  }

  #until<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      // A probe that throws (the socket closed) must reject this promise. It
      // runs inside the socket's event listeners, where a throw would escape
      // as an uncaught exception and kill the process before cleanup.
      const attempt = () => {
        let value: T | undefined;
        try {
          value = probe();
        } catch (error) {
          cleanup();
          reject(error);
          return true;
        }
        if (value !== undefined) {
          cleanup();
          resolve(value);
          return true;
        }
        return false;
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
      };
      const listener = () => {
        attempt();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`));
      }, timeoutMs);
      this.#listeners.add(listener);
      attempt();
    });
  }

  /** The first frame of `type` at or after index `from`. Fails fast if the socket closes. */
  waitForFrame(type: string, timeoutMs = 60_000, from = 0): Promise<Frame> {
    return this.#until(
      () => {
        const frame = this.frames.slice(from).find((f) => f.type === type);
        if (frame) return frame;
        if (this.closeCode !== undefined) {
          throw new Error(`socket closed (${this.closeCode} ${this.closeReason}) before a '${type}' frame`);
        }
        return undefined;
      },
      timeoutMs,
      `a '${type}' frame`,
    );
  }

  /** Resolve with the close code, however the server ended the socket. */
  waitForClose(timeoutMs = 30_000): Promise<number> {
    return this.#until(() => this.closeCode, timeoutMs, 'the socket to close');
  }

  /** Type a command, wait for its completion marker, return its exit code and output. */
  async run(command: string, timeoutMs = 120_000): Promise<CommandResult> {
    if (!this.open) throw new Error(`terminal is closed (${this.closeCode ?? 'never opened'})`);
    const nonce = randomBytes(4).toString('hex');
    const start = this.#buffer.length;
    this.#ws.send(JSON.stringify({ type: 'input', data: `${command}; echo __P0019_${nonce}_$?__\n` }));
    const pattern = new RegExp(`__P0019_${nonce}_(\\d+)__`);
    const exitCode = await this.#until(
      () => {
        const match = pattern.exec(this.#buffer.slice(start).replace(ANSI, ''));
        if (match) return Number(match[1]);
        if (this.closeCode !== undefined) {
          throw new Error(`socket closed (${this.closeCode} ${this.closeReason}) while running a command`);
        }
        return undefined;
      },
      timeoutMs,
      'a command to finish',
    );
    return { exitCode, output: this.#buffer.slice(start).replace(ANSI, '') };
  }

  dispose(): void {
    try {
      this.#ws.terminate();
    } catch {
      /* already gone */
    }
  }
}
