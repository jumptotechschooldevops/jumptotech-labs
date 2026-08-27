/**
 * What a student's shell *is*, from this service's point of view.
 *
 * Two things can be behind a browser terminal, and until now only one of them
 * could be:
 *
 * ```text
 *   LocalShell   node-pty in THIS process        Kubernetes + Docker tracks
 *   BrokerShell  a PTY inside sandboxd           every container-backed track
 * ```
 *
 * The distinction matters because of who holds a container runtime. A
 * Kubernetes shell is `bash` here with a namespace-scoped kubeconfig, and a
 * Docker shell is `bash` here with a sandbox-scoped client certificate — both
 * are local processes holding a *narrow* credential. A container-backed shell
 * is different in kind: it is `docker exec` into the student's sandbox, which
 * needs a container runtime, and giving one to the process a student types into
 * is the single thing this deployment must never do.
 *
 * So `BrokerShell` moves that PTY to `sandboxd` and keeps only the bytes here.
 * This service still cannot name a container: it sends a session id it has
 * already authenticated, and the broker derives everything else.
 *
 * Both implementations expose the same five operations, deliberately fewer than
 * `node-pty` offers. `onData` and `onExit` *replace* their listener rather than
 * appending one — `reattachSession` detaches a dead shell by clearing them, and
 * an append-only registration would have left the old shell's exit still wired
 * to the live session.
 */
import { currentRequestId, REQUEST_ID_HEADER } from '@jumptotech/observability';
import * as pty from 'node-pty';
import WebSocket from 'ws';

export interface ShellExit {
  exitCode: number;
  signal?: number;
}

export interface Shell {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Replaces any previous listener. */
  onData(listener: (data: string) => void): void;
  /** Replaces any previous listener. */
  onExit(listener: (event: ShellExit) => void): void;
}

export class ShellStartError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ShellStartError';
  }
}

/** A PTY in this process. The Kubernetes and Docker tracks' shell. */
export function localShell(
  spec: { command: string; args: string[]; cwd: string; env: Record<string, string> },
  size: { cols: number; rows: number },
): Shell {
  const term = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: spec.cwd,
    env: spec.env,
  });

  let onData: (data: string) => void = () => undefined;
  let onExit: (event: ShellExit) => void = () => undefined;
  term.onData((data) => onData(data));
  term.onExit(({ exitCode, signal }) =>
    onExit({ exitCode, ...(signal !== undefined ? { signal } : {}) }),
  );

  return {
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: () => term.kill(),
    onData: (listener) => {
      onData = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
  };
}

export interface BrokerShellOptions {
  /** `http://sandboxd:4002` — configuration, never a value from a request. */
  brokerUrl: string;
  /** Authenticates this service to the broker. */
  secret: string;
  /** From the token this service verified. The socket never supplied it. */
  sessionId: string;
  cols: number;
  rows: number;
  connectTimeoutMs?: number;
}

/** What the broker reported about the sandbox it attached to. */
export interface BrokerAttachment {
  shell: Shell;
  sandboxRef: string;
  user: string;
  workdir: string;
}

/**
 * A PTY inside `sandboxd`, bridged over an authenticated WebSocket.
 *
 * Resolves once the broker has confirmed the attach, so a caller that gets a
 * `Shell` back knows a real shell exists in a real sandbox — the refusals
 * (no sandbox, wrong owner, wrong session) all arrive before this promise
 * settles, as a `ShellStartError` carrying the broker's own code.
 *
 * Note what is sent: a session id, and a terminal size. No container name, no
 * user, no working directory, no command. Those are the broker's to decide,
 * and it decides them from the sandbox rather than from this message.
 */
export function brokerShell(options: BrokerShellOptions): Promise<BrokerAttachment> {
  const url = `${options.brokerUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/v1/attach`;

  return new Promise<BrokerAttachment>((resolve, reject) => {
    let settled = false;
    let onData: (data: string) => void = () => undefined;
    let onExit: (event: ShellExit) => void = () => undefined;

    const ws = new WebSocket(url, {
      headers: {
        'x-internal-secret': options.secret,
        // Correlation only. The broker's attach authorization is the `attach`
        // scope secret above and the ownership gates behind it.
        ...(currentRequestId() ? { [REQUEST_ID_HEADER]: currentRequestId()! } : {}),
      },
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new ShellStartError('BROKER_UNREACHABLE', 'The runtime broker did not respond.'));
    }, options.connectTimeoutMs ?? 15_000);

    const fail = (code: string, message: string): void => {
      if (settled) {
        // Already attached: a later failure is the shell dying, not a start
        // failure, so it travels the exit path the browser is listening on.
        onExit({ exitCode: 1 });
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      reject(new ShellStartError(code, message));
    };

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'attach',
          sessionId: options.sessionId,
          cols: options.cols,
          rows: options.rows,
        }),
      );
    });

    ws.on('message', (raw) => {
      let message: { type?: string; [key: string]: unknown };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        fail('BROKER_PROTOCOL', 'The runtime broker sent an unreadable frame.');
        return;
      }

      switch (message.type) {
        case 'attached': {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            shell: {
              write: (data) => sendIfOpen(ws, { type: 'input', data }),
              resize: (cols, rows) => sendIfOpen(ws, { type: 'resize', cols, rows }),
              kill: () => {
                try {
                  ws.close(1000, 'shell closed');
                } catch {
                  /* already closing */
                }
              },
              onData: (listener) => {
                onData = listener;
              },
              onExit: (listener) => {
                onExit = listener;
              },
            },
            sandboxRef: String(message.sandboxRef ?? ''),
            user: String(message.user ?? ''),
            workdir: String(message.workdir ?? ''),
          });
          return;
        }
        case 'output':
          if (typeof message.data === 'string') onData(message.data);
          return;
        case 'exit':
          onExit({
            exitCode: typeof message.exitCode === 'number' ? message.exitCode : 0,
            ...(typeof message.signal === 'number' ? { signal: message.signal } : {}),
          });
          return;
        case 'error':
          fail(
            typeof message.code === 'string' ? message.code : 'BROKER_ERROR',
            typeof message.message === 'string'
              ? message.message
              : 'The runtime broker refused this shell.',
          );
          return;
        default:
          return;
      }
    });

    ws.on('error', (error: Error) => {
      fail('BROKER_UNREACHABLE', `Could not reach the runtime broker: ${error.message}`);
    });

    ws.on('close', () => {
      if (!settled) {
        fail('BROKER_CLOSED', 'The runtime broker closed the connection before attaching.');
        return;
      }
      onExit({ exitCode: 0 });
    });
  });
}

function sendIfOpen(ws: WebSocket, message: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}
