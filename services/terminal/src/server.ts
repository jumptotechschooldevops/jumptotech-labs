/**
 * WebSocket → PTY gateway.
 *
 * This is the ONLY place in the platform that runs a shell, and it is a
 * separate process from the REST API on purpose (see README → Security).
 *
 * PLATFORM-002 changed what a shell is given. Previously every PTY inherited
 * the process-wide `KUBECONFIG`, which was the cluster-admin one. Now:
 *
 * ```text
 *   auth frame ──► verify HMAC token ──► claims.sid
 *                                        └─► API: credentials for THAT session
 *                                            └─► kubeconfig, 1 namespace, 0600
 *                                                └─► spawn PTY with KUBECONFIG
 * ```
 *
 * Two consequences worth stating plainly:
 *
 *   - **No cluster-admin credential exists in this process.** There is nothing
 *     for a shell to inherit, so a bug in the spawn path cannot leak one.
 *   - **A socket cannot change which session it is.** The session id comes from
 *     the signed token and is read exactly once, at authentication. No later
 *     frame — and no field in the auth frame — can name a session, a namespace,
 *     or a kubeconfig path. A second `auth` frame is rejected outright.
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
  CredentialsUnavailableError,
  fetchTerminalContext,
  removeSessionKubeconfig,
  writeSessionKubeconfig,
} from './credentials.js';
import {
  containerSpawnPlan,
  kubernetesSpawnPlan,
  TerminalContextError,
  type SpawnPlan,
} from './spawn-plan.js';
import {
  MAX_FRAME_BYTES,
  ProtocolError,
  clampCols,
  clampRows,
  parseClientMessage,
  type ServerMessage,
} from './protocol.js';

const AUTH_GRACE_MS = 10_000;

interface Session {
  claims: TerminalSessionClaims;
  /** The sandbox this PTY is attached to: namespace name or container name. */
  sandboxRef: string;
  sandboxKind: 'namespace' | 'container';
  /** Present only for Kubernetes sessions; deleted when the shell dies. */
  kubeconfigPath: string | undefined;
  term: pty.IPty;
  idleTimer: NodeJS.Timeout;
  maxTimer: NodeJS.Timeout;
}

export function createTerminalServer(config: TerminalConfig): Server {
  const sessions = new Map<WebSocket, Session>();
  /** sessionId → socket, so the API can close one specific student's shell. */
  const bySessionId = new Map<string, WebSocket>();

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

    // Internal control: the API closes a shell when its session ends.
    if (req.url === '/internal/terminate' && req.method === 'POST') {
      handleTerminate(req, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));
  });

  function handleTerminate(req: IncomingMessage, res: import('node:http').ServerResponse): void {
    if (req.headers['x-internal-secret'] !== config.internalServiceSecret) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Internal use only.' } }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      let sessionId: unknown;
      try {
        sessionId = (JSON.parse(body) as { sessionId?: unknown }).sessionId;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'MALFORMED', message: 'Expected JSON.' } }));
        return;
      }

      const closed = typeof sessionId === 'string' ? closeSession(sessionId) : false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { terminated: closed } }));
    });
  }

  /** Close the shell belonging to one session. Idempotent. */
  function closeSession(sessionId: string): boolean {
    const ws = bySessionId.get(sessionId);
    if (!ws) return false;
    send(ws, {
      type: 'error',
      code: 'SESSION_ENDED',
      message: 'This lab session has ended. The environment has been released.',
    });
    endSession(ws);
    if (ws.readyState === ws.OPEN) ws.close(4410, 'session ended');
    return true;
  }

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

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (sessions.size >= config.maxSessions) {
      send(ws, { type: 'error', code: 'CAPACITY', message: 'Too many active terminal sessions.' });
      ws.close(1013, 'capacity');
      return;
    }

    let authenticated = false;
    let authenticating = false;

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
        // Credential fetch is asynchronous; ignore duplicate auth frames that
        // arrive while it is in flight rather than starting a second PTY.
        if (authenticating) return;

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

        authenticating = true;
        const cols = message.cols ?? 80;
        const rows = message.rows ?? 24;
        void startSession(ws, claims, cols, rows)
          .then((started) => {
            if (started) {
              authenticated = true;
              clearTimeout(authTimer);
            }
          })
          .finally(() => {
            authenticating = false;
          });
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
          // Re-authenticating would be the only way to move a live socket to a
          // different session. It is refused unconditionally.
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

  async function startSession(
    ws: WebSocket,
    claims: TerminalSessionClaims,
    cols: number,
    rows: number,
  ): Promise<boolean> {
    // One shell per session. A second connection for the same session replaces
    // the first rather than running two shells against one sandbox.
    closeSession(claims.sid);

    /*
     * Resolve *what this socket attaches to* from the API, keyed by the session
     * id inside the signed token. The client contributed the token and nothing
     * else: no container id, no namespace, no kubeconfig path, no command.
     */
    let plan: SpawnPlan;
    let kubeconfigPath: string | undefined;
    try {
      const context = await fetchTerminalContext({
        apiInternalUrl: config.apiInternalUrl,
        secret: config.internalServiceSecret,
        sessionId: claims.sid,
      });

      const planOptions = {
        shell: config.shell,
        containerBinary: config.containerBinary,
        workDir: config.workDir,
        promptUser: config.promptUser,
        promptHost: config.promptHost,
        labId: claims.labId,
      };

      if (context.kind === 'container-exec') {
        if (!config.containerExecEnabled) {
          throw new CredentialsUnavailableError(
            'CONTAINER_EXEC_DISABLED',
            'This terminal service is not configured to attach to sandbox containers.',
          );
        }
        plan = containerSpawnPlan(context, planOptions);
        log(
          `session ${claims.sid}: attaching to sandbox container ${plan.sandboxRef} as ${context.user}`,
        );
      } else {
        kubeconfigPath = await writeSessionKubeconfig(
          config.credentialsDir,
          claims.sid,
          context.kubeconfig,
        );
        plan = kubernetesSpawnPlan(context, kubeconfigPath, planOptions);
        log(
          `session ${claims.sid}: issued namespace-scoped credentials (ns=${context.namespace} sa=${context.serviceAccountName} expires=${context.expiresAt})`,
        );
      }
    } catch (error) {
      const code =
        error instanceof CredentialsUnavailableError
          ? error.code
          : error instanceof TerminalContextError
            ? error.code
            : 'CREDENTIALS_UNAVAILABLE';
      const msg = error instanceof Error ? error.message : String(error);
      log(`session ${claims.sid}: terminal binding failed — ${msg}`);
      await removeSessionKubeconfig(kubeconfigPath);
      send(ws, { type: 'error', code, message: msg });
      ws.close(4403, 'no credentials');
      return false;
    }

    if (ws.readyState !== ws.OPEN) {
      await removeSessionKubeconfig(kubeconfigPath);
      return false;
    }

    let term: pty.IPty;
    try {
      term = pty.spawn(plan.command, plan.args, {
        name: 'xterm-256color',
        cols: clampCols(cols),
        rows: clampRows(rows),
        cwd: plan.cwd,
        env: plan.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`failed to spawn PTY: ${message}`);
      await removeSessionKubeconfig(kubeconfigPath);
      send(ws, {
        type: 'error',
        code: 'PTY_SPAWN_FAILED',
        message: `Could not start a shell: ${message}`,
      });
      ws.close(1011, 'pty spawn failed');
      return false;
    }

    const session: Session = {
      claims,
      sandboxRef: plan.sandboxRef,
      sandboxKind: plan.sandboxKind,
      kubeconfigPath,
      term,
      idleTimer: setTimeout(
        () => closeFor(ws, 'IDLE_TIMEOUT', 'Terminal closed after inactivity.'),
        config.idleTimeoutMs,
      ),
      maxTimer: setTimeout(
        () => closeFor(ws, 'SESSION_EXPIRED', 'Terminal session reached its maximum duration.'),
        config.maxSessionMs,
      ),
    };
    sessions.set(ws, session);
    bySessionId.set(claims.sid, ws);

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
      sandboxKind: plan.sandboxKind,
      sandboxRef: plan.sandboxRef,
      // Kept for clients that read it; for a container sandbox it is the same
      // handle under its historical name.
      namespace: plan.sandboxRef,
    });
    log(
      `session ${claims.sid} started (lab=${claims.labId} ${plan.sandboxKind}=${plan.sandboxRef})`,
    );
    return true;
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
    if (bySessionId.get(session.claims.sid) === ws) bySessionId.delete(session.claims.sid);
    clearTimeout(session.idleTimer);
    clearTimeout(session.maxTimer);
    try {
      session.term.kill();
    } catch {
      /* already dead */
    }
    // The credential file dies with the shell that used it.
    void removeSessionKubeconfig(session.kubeconfigPath);
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
