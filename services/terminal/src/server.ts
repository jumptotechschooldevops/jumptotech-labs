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
import { timingSafeEqual } from 'node:crypto';
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
  removeSessionDockerCerts,
  removeSessionKubeconfig,
  writeSessionDockerCerts,
  writeSessionKubeconfig,
} from './credentials.js';
import { SessionWorkspaces, WorkspacePathError } from './workspace.js';
import { brokerShell, localShell, ShellStartError, type Shell } from './shell.js';
import {
  containerSpawnPlan,
  dockerSpawnPlan,
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
  /** Present only for Docker sessions: the `DOCKER_CERT_PATH` directory. */
  dockerCertDir: string | undefined;
  term: Shell;
  /** Last negotiated size, so a replacement shell opens at the same one. */
  cols: number;
  rows: number;
  idleTimer: NodeJS.Timeout;
  maxTimer: NodeJS.Timeout;
}

export function createTerminalServer(config: TerminalConfig): Server {
  /**
   * Constant-time comparison of the shared internal secret.
   *
   * `!==` on a secret leaks its prefix length through timing. The API side
   * already used `timingSafeEqual`; this brings the terminal side into line so
   * the two ends of one trust boundary are checked the same way.
   */
  const internalSecretMatches = (presented: unknown): boolean => {
    if (typeof presented !== 'string' || presented.length === 0) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(config.internalServiceSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const sessions = new Map<WebSocket, Session>();
  /** sessionId → socket, so the API can close one specific student's shell. */
  const bySessionId = new Map<string, WebSocket>();
  const workspaces = new SessionWorkspaces({
    root: config.workspaceRoot,
    secret: config.sessionSecret,
  });

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

    // Internal control: the API closes a shell when its session ends, and
    // replaces one when a container reset recreates the sandbox underneath it.
    if (req.url === '/internal/terminate' && req.method === 'POST') {
      handleControl(req, res, (sessionId) => Promise.resolve({ terminated: closeSession(sessionId) }));
      return;
    }
    if (req.url === '/internal/reattach' && req.method === 'POST') {
      handleControl(req, res, async (sessionId) => ({ reattached: await reattachSession(sessionId) }));
      return;
    }

    /*
     * Workspace access for the verifier.
     *
     * `file_exists` and `dockerfile_valid` grade a file the student authored,
     * and that file lives in this container. Rather than share a filesystem
     * with the API, the API asks for one named file over this endpoint.
     *
     * Three properties, all enforced below:
     *   - it requires the shared service secret, exactly like the API's own
     *     internal router, so no browser can reach it;
     *   - it takes a session id and a *relative* path, and resolves that path
     *     inside that session's own workspace — there is no way to name
     *     another session's directory or to escape one;
     *   - reads are size-capped, and this endpoint never writes.
     */
    if (req.url === '/internal/workspace/read' && req.method === 'POST') {
      handleWorkspaceRead(req, res);
      return;
    }

    /** Lab reset restores the workspace to the baseline the lab declares. */
    if (req.url === '/internal/workspace/seed' && req.method === 'POST') {
      handleWorkspaceSeed(req, res);
      return;
    }

    if (req.url === '/internal/workspace/destroy' && req.method === 'POST') {
      handleWorkspaceDestroy(req, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));
  });

  function handleControl(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
    act: (sessionId: string) => Promise<Record<string, boolean>>,
  ): void {
    if (!internalSecretMatches(req.headers['x-internal-secret'])) {
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

      if (typeof sessionId !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: { code: 'MALFORMED', message: 'Expected a sessionId.' } }),
        );
        return;
      }

      void act(sessionId).then(
        (data) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data }));
        },
        (error: unknown) => {
          log(`control action for ${sessionId} failed — ${describeError(error)}`);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ ok: false, error: { code: 'CONTROL_FAILED', message: 'Action failed.' } }),
          );
        },
      );
    });
  }

  type ServerResponse = import('node:http').ServerResponse;

  function reply(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  /**
   * Read a JSON body from an authenticated internal request.
   *
   * Returns `null` — having already replied — when the caller is not the API or
   * the body is not usable, so each handler can bail out on a falsy result.
   */
  function readInternalJson(
    req: IncomingMessage,
    res: ServerResponse,
    onBody: (body: Record<string, unknown>) => void,
  ): void {
    if (!internalSecretMatches(req.headers['x-internal-secret'])) {
      reply(res, 401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Internal use only.' },
      });
      return;
    }

    let raw = '';
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
      // A workspace seed carries file contents, so the cap is larger than the
      // terminate endpoint's — but it is still a cap.
      if (raw.length > 256 * 1024) {
        aborted = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        reply(res, 400, { ok: false, error: { code: 'MALFORMED', message: 'Expected JSON.' } });
        return;
      }
      if (typeof body !== 'object' || body === null) {
        reply(res, 400, { ok: false, error: { code: 'MALFORMED', message: 'Expected an object.' } });
        return;
      }
      onBody(body as Record<string, unknown>);
    });
  }

  function handleWorkspaceRead(req: IncomingMessage, res: ServerResponse): void {
    readInternalJson(req, res, (body) => {
      const sessionId = body.sessionId;
      const filePath = body.path;
      if (typeof sessionId !== 'string' || typeof filePath !== 'string') {
        reply(res, 400, {
          ok: false,
          error: { code: 'MALFORMED', message: 'Expected sessionId and path.' },
        });
        return;
      }

      void workspaces
        .read(sessionId, filePath)
        .then((content) => {
          reply(res, 200, {
            ok: true,
            data: { exists: content !== null, content: content ?? null },
          });
        })
        .catch((error: unknown) => {
          const invalid = error instanceof WorkspacePathError;
          reply(res, invalid ? 400 : 500, {
            ok: false,
            error: {
              code: invalid ? 'INVALID_WORKSPACE_PATH' : 'WORKSPACE_READ_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
    });
  }

  function handleWorkspaceSeed(req: IncomingMessage, res: ServerResponse): void {
    readInternalJson(req, res, (body) => {
      const sessionId = body.sessionId;
      const files = body.files;
      if (typeof sessionId !== 'string' || !Array.isArray(files)) {
        reply(res, 400, {
          ok: false,
          error: { code: 'MALFORMED', message: 'Expected sessionId and files[].' },
        });
        return;
      }

      const specs = files.filter(
        (file): file is { path: string; content: string } =>
          typeof file === 'object' &&
          file !== null &&
          typeof (file as { path?: unknown }).path === 'string' &&
          typeof (file as { content?: unknown }).content === 'string',
      );

      void workspaces
        .seed(sessionId, specs)
        .then(() => reply(res, 200, { ok: true, data: { seeded: specs.length } }))
        .catch((error: unknown) => {
          const invalid = error instanceof WorkspacePathError;
          reply(res, invalid ? 400 : 500, {
            ok: false,
            error: {
              code: invalid ? 'INVALID_WORKSPACE_PATH' : 'WORKSPACE_SEED_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
    });
  }

  function handleWorkspaceDestroy(req: IncomingMessage, res: ServerResponse): void {
    readInternalJson(req, res, (body) => {
      const sessionId = body.sessionId;
      if (typeof sessionId !== 'string') {
        reply(res, 400, {
          ok: false,
          error: { code: 'MALFORMED', message: 'Expected sessionId.' },
        });
        return;
      }
      void workspaces
        .destroy(sessionId)
        .then(() => reply(res, 200, { ok: true, data: { destroyed: true } }))
        .catch(() => reply(res, 200, { ok: true, data: { destroyed: false } }));
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

  /**
   * Replace a live socket's shell without dropping the socket.
   *
   * A container-backed reset recreates the sandbox, which kills the `docker
   * exec` shell inside it. Rather than leaving the student staring at a dead
   * terminal, the API calls this and the same browser socket gets a fresh shell
   * in the fresh container — the session, the token and the scrollback survive.
   *
   * The new binding is re-resolved from the API exactly as the first one was.
   * The client contributes nothing to it here either, and a Kubernetes session
   * never reaches this path: its reset leaves the namespace, and its shell, in
   * place.
   */
  async function reattachSession(sessionId: string): Promise<boolean> {
    const ws = bySessionId.get(sessionId);
    const session = ws ? sessions.get(ws) : undefined;
    if (!ws || !session || ws.readyState !== ws.OPEN) return false;
    if (session.sandboxKind !== 'container') return false;

    let plan: SpawnPlan;
    try {
      const context = await fetchTerminalContext({
        apiInternalUrl: config.apiInternalUrl,
        secret: config.internalServiceSecret,
        sessionId: session.claims.sid,
        // Re-proved on every fetch, not cached from the original attach: a
        // reattach after a container reset must be as authorised as the first
        // connection was.
        ownerUserId: session.claims.uid,
      });
      if (context.kind !== 'container-exec') return false;
      if (!config.sandboxBrokerEnabled && !config.containerExecEnabled) return false;
      plan = containerSpawnPlan(context, planOptionsFor(session.claims.labId));
    } catch (error) {
      log(`session ${sessionId}: reattach could not resolve a binding — ${describeError(error)}`);
      return false;
    }

    // Detach the old shell quietly: its exit is expected, not a session end.
    const previous = session.term;
    previous.onData(() => undefined);
    previous.onExit(() => undefined);
    try {
      previous.kill();
    } catch {
      /* already gone */
    }

    let term: Shell;
    try {
      if (config.sandboxBrokerEnabled) {
        const attachment = await brokerShell({
          brokerUrl: config.sandboxBrokerUrl,
          secret: config.internalServiceSecret,
          sessionId: session.claims.sid,
          cols: session.cols,
          rows: session.rows,
        });
        // Same cross-check as the first attach: a reset recreates the sandbox
        // under the same derived name, so a disagreement here is as wrong as it
        // was there.
        if (attachment.sandboxRef !== plan.sandboxRef) {
          attachment.shell.kill();
          throw new ShellStartError(
            'SANDBOX_REF_MISMATCH',
            'The runtime broker resolved a different sandbox for this session.',
          );
        }
        term = attachment.shell;
      } else {
        term = localShell(
          { command: plan.command, args: plan.args, cwd: plan.cwd, env: plan.env },
          { cols: session.cols, rows: session.rows },
        );
      }
    } catch (error) {
      log(`session ${sessionId}: reattach failed — ${describeError(error)}`);
      send(ws, {
        type: 'error',
        code: 'SANDBOX_UNAVAILABLE',
        message: 'The lab environment was reset, but the terminal could not reconnect.',
      });
      return false;
    }

    session.term = term;
    session.sandboxRef = plan.sandboxRef;
    wireShell(ws, term);
    send(ws, {
      type: 'reattached',
      sessionId: session.claims.sid,
      sandboxRef: plan.sandboxRef,
      namespace: plan.sandboxRef,
    });
    log(`session ${sessionId}: reattached to ${plan.sandboxRef}`);
    return true;
  }

  /** Options every spawn plan is built with. Never client-supplied. */
  function planOptionsFor(labId: string) {
    return {
      shell: config.shell,
      containerBinary: config.containerBinary,
      workDir: config.workDir,
      promptUser: config.promptUser,
      promptHost: config.promptHost,
      labId,
    };
  }

  /**
   * Attach output and exit plumbing to a session's current shell.
   *
   * Shared by the first spawn and by `reattachSession`, so a replaced shell is
   * wired exactly like an original one — and a shell that `reattachSession`
   * detached has had its listeners cleared, so its exit never ends the session.
   */
  function wireShell(ws: WebSocket, term: Shell): void {
    term.onData((data) => send(ws, { type: 'output', data }));
    term.onExit(({ exitCode, signal }) => {
      send(ws, { type: 'exit', exitCode, ...(signal !== undefined ? { signal } : {}) });
      endSession(ws);
      if (ws.readyState === ws.OPEN) ws.close(1000, 'shell exited');
    });
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
          // Remembered as well as applied, so a shell replaced by
          // `reattachSession` opens at the size the browser is actually showing.
          session.cols = message.cols;
          session.rows = message.rows;
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
    let dockerCertDir: string | undefined;
    /** True when the PTY lives in `sandboxd` rather than in this process. */
    let viaBroker = false;

    /** Undo whatever this attempt wrote, on any path that does not start a shell. */
    const discardCredentials = async (): Promise<void> => {
      await removeSessionKubeconfig(kubeconfigPath);
      await removeSessionDockerCerts(dockerCertDir);
    };

    try {
      const context = await fetchTerminalContext({
        apiInternalUrl: config.apiInternalUrl,
        secret: config.internalServiceSecret,
        sessionId: claims.sid,
        // From the token this service just verified. The socket never supplied
        // it and cannot influence it.
        ownerUserId: claims.uid,
      });

      const planOptions = planOptionsFor(claims.labId);

      if (context.kind === 'container-exec') {
        /*
         * Two ways to reach a sandbox container, and the order is deliberate.
         *
         * The broker wins whenever it is configured, because a deployment that
         * has one must never silently fall back to running `docker exec` in
         * this process — that fallback is exactly the privilege this service is
         * built not to hold. The local path remains for a developer running
         * the services directly on a laptop.
         */
        if (config.sandboxBrokerEnabled) {
          viaBroker = true;
        } else if (!config.containerExecEnabled) {
          throw new CredentialsUnavailableError(
            'CONTAINER_EXEC_DISABLED',
            'This terminal service is not configured to attach to sandbox containers.',
          );
        }
        // Built either way: it re-validates every field of the context against
        // this service's own patterns, and it carries the sandbox handle the
        // `ready` frame reports. Only the local path spawns from it.
        plan = containerSpawnPlan(context, planOptions);
        log(
          `session ${claims.sid}: attaching to sandbox container ${plan.sandboxRef} as ${context.user}` +
            (viaBroker ? ' via the runtime broker' : ''),
        );
      } else if (context.kind === 'docker-daemon') {
        dockerCertDir = await writeSessionDockerCerts(config.credentialsDir, claims.sid, context);
        // The workspace is where `docker build` finds its context, so it has to
        // exist — and hold the lab's baseline files — before the shell opens.
        const workspaceDir = await workspaces.seed(claims.sid, context.workspaceFiles ?? []);
        plan = dockerSpawnPlan(context, dockerCertDir, workspaceDir, planOptions);
        log(
          `session ${claims.sid}: issued sandbox-scoped Docker credentials (sandbox=${context.sandboxRef} host=${context.dockerHost} expires=${context.expiresAt})`,
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
          : error instanceof TerminalContextError || error instanceof WorkspacePathError
            ? error.code
            : 'CREDENTIALS_UNAVAILABLE';
      const msg = error instanceof Error ? error.message : String(error);
      log(`session ${claims.sid}: terminal binding failed — ${msg}`);
      await discardCredentials();
      send(ws, { type: 'error', code, message: msg });
      ws.close(4403, 'no credentials');
      return false;
    }

    if (ws.readyState !== ws.OPEN) {
      await discardCredentials();
      return false;
    }

    let term: Shell;
    try {
      if (viaBroker) {
        const attachment = await brokerShell({
          brokerUrl: config.sandboxBrokerUrl,
          secret: config.internalServiceSecret,
          // From the token this service verified at `auth`. The socket never
          // supplied it, and nothing else about the sandbox is sent at all.
          sessionId: claims.sid,
          cols: clampCols(cols),
          rows: clampRows(rows),
        });
        /*
         * Cross-check, cheap and worth having. The API said this session's
         * sandbox is `plan.sandboxRef`; the broker independently derived a name
         * from the same session id and attached to that. They must agree. If
         * they ever did not, one of the two derivation secrets is wrong and the
         * student is about to be given somebody else's container — so this
         * refuses rather than reconciling.
         */
        if (attachment.sandboxRef !== plan.sandboxRef) {
          attachment.shell.kill();
          throw new ShellStartError(
            'SANDBOX_REF_MISMATCH',
            'The runtime broker resolved a different sandbox for this session.',
          );
        }
        term = attachment.shell;
      } else {
        term = localShell(
          { command: plan.command, args: plan.args, cwd: plan.cwd, env: plan.env },
          { cols: clampCols(cols), rows: clampRows(rows) },
        );
      }
    } catch (error) {
      const code = error instanceof ShellStartError ? error.code : 'PTY_SPAWN_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      log(`failed to start shell for ${claims.sid}: ${code} — ${message}`);
      await discardCredentials();
      send(ws, {
        type: 'error',
        code,
        message: `Could not start a shell: ${message}`,
      });
      ws.close(1011, 'shell start failed');
      return false;
    }

    const session: Session = {
      claims,
      sandboxRef: plan.sandboxRef,
      sandboxKind: plan.sandboxKind,
      kubeconfigPath,
      dockerCertDir,
      term,
      cols: clampCols(cols),
      rows: clampRows(rows),
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

    wireShell(ws, term);

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
    // Credential material dies with the shell that used it. The workspace does
    // not: it holds the student's own work, and it is removed when the *session*
    // ends, not when a socket drops — a reconnect must not lose their Dockerfile.
    void removeSessionKubeconfig(session.kubeconfigPath);
    void removeSessionDockerCerts(session.dockerCertDir);
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

/** Message text for a thrown value, for logs only. Never sent to a browser. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
