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
import { brokerTlsOptions, ptyPendingInputBytes } from '@jumptotech/lab-orchestrator';
import * as pty from 'node-pty';
import WebSocket from 'ws';

export interface ShellExit {
  exitCode: number;
  signal?: number;
  /**
   * Set when the shell was not seen to exit: the runtime broker closed it for
   * the stated reason (its own idle or time limit), or the connection to the
   * broker was lost (`BROKER_LOST`: restarted, crashed, killed for memory).
   * Absent for a real exit, which the broker reports as one.
   */
  endedBy?: string;
}

export interface Shell {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /**
   * Stop producing output until `resume`.
   *
   * The server calls these when the browser falls behind, so a student's
   * output cannot pile up in this process (see `output-flow.ts` in the
   * orchestrator). For a local PTY that stops reading the master side; for a
   * broker shell it stops reading the broker socket, which pushes the same
   * backpressure on to `sandboxd`.
   */
  pause(): void;
  resume(): void;
  /**
   * Input written and not yet taken by the shell, in bytes.
   *
   * The server stops reading the browser while this is high (see "student
   * input" in `output-flow.ts`), so a client that keeps typing at a shell that
   * is not reading cannot pile its input up in this process. For a local PTY
   * it is node-pty's own write queue; for a broker shell, what the broker
   * socket has not yet sent — which grows once `sandboxd` stops reading.
   */
  pendingInputBytes(): number;
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
    pause: () => term.pause(),
    resume: () => term.resume(),
    pendingInputBytes: () => ptyPendingInputBytes(term),
    onData: (listener) => {
      onData = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
  };
}

export interface BrokerShellOptions {
  /** `https://sandboxd.runtime:4002` — configuration, never a value from a request. */
  brokerUrl: string;
  /** Authenticates this service to the broker. Sent only in a header, never the URL. */
  secret: string;
  /** Trust anchors for a `wss://` broker (BETA-P0-011). Absent ⇒ the system store. */
  ca?: string;
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

/** How long a killed broker shell waits for the broker to acknowledge the close. */
const BROKER_CLOSE_TIMEOUT_MS = 2_000;

/** `closeTimeout` is a client option of ws 8.21, not yet in `@types/ws`. */
type BrokerClientOptions = WebSocket.ClientOptions & { closeTimeout: number };

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

    const clientOptions: BrokerClientOptions = {
      // Over wss, certificate and hostname verification are always on, whatever
      // NODE_TLS_REJECT_UNAUTHORIZED says; the CA, when given, is this socket's only.
      ...(url.startsWith('wss:') ? brokerTlsOptions(options.ca ? { ca: options.ca } : {}) : {}),
      /*
       * `kill` closes this socket, and ws then waits this long for the broker's
       * reply before destroying it (30 s by default). A broker that has paused
       * this socket for input pressure never reads the close, so for all that
       * time it kept the PTY; destroyed, its peer probe notices within seconds.
       */
      closeTimeout: BROKER_CLOSE_TIMEOUT_MS,
      headers: {
        'x-internal-secret': options.secret,
        // Correlation only. The broker's attach authorization is the `attach`
        // scope secret above and the ownership gates behind it.
        ...(currentRequestId() ? { [REQUEST_ID_HEADER]: currentRequestId()! } : {}),
      },
    };
    const ws = new WebSocket(url, clientOptions);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new ShellStartError('BROKER_UNREACHABLE', 'The runtime broker did not respond.'));
    }, options.connectTimeoutMs ?? 15_000);

    /** Whether the broker reported the shell's exit; anything else ending it is not one. */
    let exited = false;
    const fail = (code: string, message: string): void => {
      if (settled) {
        // Already attached: a later failure ends the shell rather than failing
        // a start, so it travels the exit path the browser is listening on —
        // saying why, so it is not told the shell exited.
        if (!exited) onExit({ exitCode: 1, endedBy: code });
        exited = true;
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
              pause: () => ws.pause(),
              resume: () => ws.resume(),
              pendingInputBytes: () => ws.bufferedAmount,
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
          if (exited) return;
          exited = true;
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
      fail(settled ? 'BROKER_LOST' : 'BROKER_UNREACHABLE', `Could not reach the runtime broker: ${error.message}`);
    });

    ws.on('close', () => {
      if (!settled) {
        fail('BROKER_CLOSED', 'The runtime broker closed the connection before attaching.');
        return;
      }
      // A close with no `exit` before it is the broker going away, not the shell.
      fail('BROKER_LOST', 'The connection to the runtime broker was lost.');
    });
  });
}

function sendIfOpen(ws: WebSocket, message: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}
