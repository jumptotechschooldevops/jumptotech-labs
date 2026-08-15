/**
 * WebSocket → PTY gateway.
 *
 * This is the ONLY place in the platform that runs a shell, and it is a
 * separate process from the REST API on purpose (see README → Security).
 * Every connection must present a valid, unexpired session token minted by
 * the API before a PTY is spawned.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import * as pty from 'node-pty';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  InvalidSessionTokenError,
  verifySessionToken,
  type TerminalSessionClaims,
} from '@jumptotech/lab-orchestrator/session-token';
import type { TerminalConfig } from './config.js';
import {
  MAX_FRAME_BYTES,
  ProtocolError,
  clampCols,
  clampRows,
  parseClientMessage,
  type ServerMessage,
} from './protocol.js';

const AUTH_GRACE_MS = 5_000;

interface Session {
  claims: TerminalSessionClaims;
  term: pty.IPty;
  idleTimer: NodeJS.Timeout;
  maxTimer: NodeJS.Timeout;
}

export function createTerminalServer(config: TerminalConfig): Server {
  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          data: { service: 'terminal', status: 'ok', activeSessions: sessions.size },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/terminal',
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: ({ origin }, done) => {
      // Browsers always send Origin; reject anything not on the allow-list.
      if (origin && !config.allowedOrigins.includes(origin)) {
        log(`rejected connection from disallowed origin '${origin}'`);
        done(false, 403, 'Forbidden origin');
        return;
      }
      done(true);
    },
  });

  const sessions = new Map<WebSocket, Session>();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (sessions.size >= config.maxSessions) {
      send(ws, { type: 'error', code: 'CAPACITY', message: 'Too many active terminal sessions.' });
      ws.close(1013, 'capacity');
      return;
    }

    let authenticated = false;

    // A socket that never authenticates is dropped quickly.
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        send(ws, { type: 'error', code: 'AUTH_TIMEOUT', message: 'No session token received.' });
        ws.close(4401, 'auth timeout');
      }
    }, AUTH_GRACE_MS);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        send(ws, { type: 'error', code: 'MALFORMED_FRAME', message: 'Binary frames are not accepted.' });
        return;
      }

      let message;
      try {
        message = parseClientMessage(raw.toString());
      } catch (error) {
        const code = error instanceof ProtocolError ? error.code : 'MALFORMED_FRAME';
        send(ws, { type: 'error', code, message: (error as Error).message });
        return;
      }

      if (!authenticated) {
        if (message.type !== 'auth') {
          send(ws, {
            type: 'error',
            code: 'UNAUTHENTICATED',
            message: 'First message must be an auth frame.',
          });
          ws.close(4401, 'unauthenticated');
          return;
        }

        let claims: TerminalSessionClaims;
        try {
          claims = verifySessionToken(message.token, config.sessionSecret);
        } catch (error) {
          const msg =
            error instanceof InvalidSessionTokenError ? error.message : 'Session token rejected';
          log(`auth failed from ${req.socket.remoteAddress ?? 'unknown'}: ${msg}`);
          send(ws, { type: 'error', code: 'UNAUTHORIZED', message: msg });
          ws.close(4401, 'unauthorized');
          return;
        }

        authenticated = true;
        clearTimeout(authTimer);
        startSession(ws, claims, message.cols ?? 80, message.rows ?? 24);
        return;
      }

      const session = sessions.get(ws);
      if (!session) return;

      switch (message.type) {
        case 'input':
          touch(session);
          session.term.write(message.data);
          break;
        case 'resize':
          touch(session);
          try {
            session.term.resize(message.cols, message.rows);
          } catch {
            /* the PTY may have already exited; harmless */
          }
          break;
        case 'ping':
          touch(session);
          send(ws, { type: 'pong' });
          break;
        case 'auth':
          send(ws, {
            type: 'error',
            code: 'ALREADY_AUTHENTICATED',
            message: 'Session is already authenticated.',
          });
          break;
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      endSession(ws);
    });

    ws.on('error', () => {
      clearTimeout(authTimer);
      endSession(ws);
    });
  });

  function startSession(
    ws: WebSocket,
    claims: TerminalSessionClaims,
    cols: number,
    rows: number,
  ): void {
    const env: Record<string, string> = {
      // A deliberately minimal environment: nothing from the host process
      // leaks into the student shell except what is listed here.
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: config.workDir,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      SHELL: config.shell,
      USER: config.promptUser,
      HOSTNAME: config.promptHost,
      PS1: `\\[\\e[32m\\]${config.promptUser}@${config.promptHost}\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ `,
      // Scope the student to their lab namespace by default.
      JTT_LAB_ID: claims.labId,
      JTT_NAMESPACE: claims.namespace,
    };
    if (config.kubeconfigPath) env.KUBECONFIG = config.kubeconfigPath;

    let term: pty.IPty;
    try {
      term = pty.spawn(config.shell, ['--norc', '--noprofile'], {
        name: 'xterm-256color',
        cols: clampCols(cols),
        rows: clampRows(rows),
        cwd: config.workDir,
        env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`failed to spawn PTY: ${message}`);
      send(ws, {
        type: 'error',
        code: 'PTY_SPAWN_FAILED',
        message: `Could not start a shell: ${message}`,
      });
      ws.close(1011, 'pty spawn failed');
      return;
    }

    const session: Session = {
      claims,
      term,
      idleTimer: setTimeout(() => closeFor(ws, 'IDLE_TIMEOUT', 'Terminal closed after inactivity.'), config.idleTimeoutMs),
      maxTimer: setTimeout(
        () => closeFor(ws, 'SESSION_EXPIRED', 'Terminal session reached its maximum duration.'),
        config.maxSessionMs,
      ),
    };
    sessions.set(ws, session);

    term.onData((data) => send(ws, { type: 'output', data }));
    term.onExit(({ exitCode, signal }) => {
      send(ws, { type: 'exit', exitCode, ...(signal !== undefined ? { signal } : {}) });
      endSession(ws);
      if (ws.readyState === ws.OPEN) ws.close(1000, 'shell exited');
    });

    send(ws, {
      type: 'ready',
      sessionId: claims.sid,
      labId: claims.labId,
      namespace: claims.namespace,
    });
    log(`session ${claims.sid} started (lab=${claims.labId} ns=${claims.namespace})`);
  }

  function touch(session: Session): void {
    session.idleTimer.refresh();
  }

  function closeFor(ws: WebSocket, code: string, message: string): void {
    send(ws, { type: 'error', code, message });
    endSession(ws);
    if (ws.readyState === ws.OPEN) ws.close(4408, code);
  }

  function endSession(ws: WebSocket): void {
    const session = sessions.get(ws);
    if (!session) return;
    sessions.delete(ws);
    clearTimeout(session.idleTimer);
    clearTimeout(session.maxTimer);
    try {
      session.term.kill();
    } catch {
      /* already dead */
    }
    log(`session ${session.claims.sid} ended (${sessions.size} active)`);
  }

  httpServer.on('close', () => {
    for (const ws of [...sessions.keys()]) endSession(ws);
  });

  return httpServer;
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
}

function log(message: string): void {
  console.log(`[terminal] ${message}`);
}
