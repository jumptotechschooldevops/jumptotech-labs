/**
 * `sandboxd` — the runtime broker.
 *
 * ## Why this process exists
 *
 * Container-backed labs (Linux, Networking, CS, Terraform, Ansible, CI/CD) need
 * two things the shipped stack could not safely provide from the services it
 * already had:
 *
 *   1. something must *create* the sandbox — that is a container runtime;
 *   2. something must *attach a PTY* to it — that is also a container runtime.
 *
 * Before this service, (2) had exactly one implementation: the terminal service
 * running `docker exec` itself. That requires giving a container runtime to the
 * one process a student types into, which is the single thing the deployment
 * must never do. So the compose stack switched those four providers off, and
 * 81 of 114 labs became undeployable. That is the whole of the gap.
 *
 * ```text
 *   browser ──► web ──► terminal ─────ws + internal secret─────► sandboxd ──► runtime
 *                          │                                        │
 *              PTY bytes only. No runtime,          only process with runtime access.
 *              no socket, no DOCKER_HOST,           No PTY reaches it that it did not
 *              cannot name a container.             itself derive and label-check.
 * ```
 *
 * ## What makes it a boundary rather than a hop
 *
 * A proxy that forwarded whatever it was asked would be strictly worse than the
 * socket — the same privilege, one network hop further from the audit. This
 * service is not a proxy:
 *
 *   · **One verb.** Attach a PTY. There is no create, no remove, no image pull,
 *     no bind mount, no network call, no arbitrary exec. The runtime surface is
 *     `docker inspect` and `docker exec -it`, and nothing else is reachable.
 *   · **The container name is computed, not received** (see `attach.ts`). The
 *     caller sends a session id; this service derives the sandbox reference
 *     from it with the platform's own HMAC.
 *   · **Ownership is re-proved at the privileged end.** Managed label, runtime
 *     owner and session id must all match before a PTY opens.
 *   · **Never browser-reachable.** It requires the internal service secret, it
 *     refuses any upgrade carrying an `Origin` header, and no route in the web
 *     proxy points at it.
 *
 * The honest limitation, stated here and in the deployment docs: this process
 * holds real privilege over its runtime. It is designed to be deployed on a
 * runtime node that is *not* the machine serving the web tier, so that
 * privilege is bounded by that node.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as pty from 'node-pty';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ContainerRuntimePort } from '@jumptotech/lab-orchestrator';
import { AttachDeniedError, attachArgv, resolveAttachTarget, type SandboxInspectorPort } from './attach.js';
import type { SandboxdConfig } from './config.js';
import { authorizeScope, scopeForEndpoint, type SandboxdScope } from './scopes.js';
import { dockerErrorResponse, type DockerOps } from './docker-ops.js';
import {
  readJsonBody,
  runRuntimeOperation,
  runtimeErrorResponse,
  sendJson,
} from './runtime-routes.js';
import {
  BrokerProtocolError,
  MAX_FRAME_BYTES,
  clampCols,
  clampRows,
  parseBrokerClientMessage,
  type BrokerServerMessage,
} from './protocol.js';

export interface SandboxdDeps {
  config: SandboxdConfig;
  inspector: SandboxInspectorPort;
  /**
   * The runtime the control plane drives, for the API's create/inspect/reap
   * calls. Omitted — a broker deployed for attach only — and `/v1/runtime`
   * answers 503 rather than existing in a half-wired state.
   */
  runtime?: ContainerRuntimePort;
  /**
   * The Docker track's typed operations. Omitted — a deployment with the track
   * off — and `/v1/docker` answers 503 rather than existing half-wired.
   */
  docker?: DockerOps;
  /** Injected in tests so no real PTY is spawned. */
  spawn?: PtySpawn;
  log?: (message: string) => void;
}

/** The slice of `node-pty` this service uses. */
export interface BrokerPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

export type PtySpawn = (
  command: string,
  args: string[],
  options: { cols: number; rows: number },
) => BrokerPty;

interface LiveShell {
  sessionId: string;
  sandboxRef: string;
  term: BrokerPty;
  idleTimer: NodeJS.Timeout;
  maxTimer: NodeJS.Timeout;
}

function defaultSpawn(command: string, args: string[], options: { cols: number; rows: number }): BrokerPty {
  const term = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: process.env.HOME ?? '/tmp',
    /*
     * The environment of the `docker exec` *client*, not of the student's
     * shell. Deliberately minimal, and carrying no credential beyond the
     * runtime address this service was configured with — the student's own
     * environment is built in `attachArgv` and passed as `--env` flags.
     */
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'xterm-256color',
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      ...(process.env.DOCKER_CERT_PATH ? { DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH } : {}),
      ...(process.env.DOCKER_TLS_VERIFY ? { DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY } : {}),
    },
  });
  return {
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: () => term.kill(),
    onData: (listener) => {
      term.onData(listener);
    },
    onExit: (listener) => {
      term.onExit(({ exitCode, signal }) =>
        listener({ exitCode, ...(signal !== undefined ? { signal } : {}) }),
      );
    },
  };
}

export function createSandboxd(deps: SandboxdDeps): Server {
  const { config, inspector } = deps;
  const spawn = deps.spawn ?? defaultSpawn;
  const log = deps.log ?? ((m: string) => console.log(`[sandboxd] ${m}`));

  const shells = new Map<WebSocket, LiveShell>();
  /** One shell per session. A second attach replaces the first. */
  const bySessionId = new Map<string, WebSocket>();

  const httpServer = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          shells: shells.size,
          runtime: Boolean(deps.runtime),
          docker: Boolean(deps.docker),
        });
        return;
      }

      /*
       * The runtime control plane. Same two gates as the attach socket: the
       * internal secret, and a refusal of anything a browser sent. The
       * `Origin` check is what keeps this endpoint unreachable from a page even
       * if the secret ever leaked into one.
       */
      if (req.url === '/v1/runtime') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
          return;
        }
        if (!admit(req, res, 'runtime')) return;
        if (!deps.runtime) {
          sendJson(res, 503, {
            ok: false,
            error: {
              code: 'RUNTIME_NOT_CONFIGURED',
              message: 'this broker was started without a container runtime',
            },
          });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const data = await runRuntimeOperation(String(body.op), body, {
            runtime: deps.runtime,
            runtimeOwner: config.runtimeOwner,
          });
          sendJson(res, 200, { ok: true, data });
        } catch (error) {
          const { status, body } = runtimeErrorResponse(error);
          if (status >= 500) log(`runtime operation failed: ${String(error)}`);
          sendJson(res, status, body);
        }
        return;
      }

      /*
       * The Docker track's control plane.
       *
       * Same two gates as everything else here, and the same shape: a closed
       * list of named operations, every one of them keyed on a session id the
       * broker derives the sandbox name from. See `docker-ops.ts` for why this
       * is not a `DockerEnginePort` proxy.
       */
      if (req.url === '/v1/docker') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
          return;
        }
        if (!admit(req, res, 'docker')) return;
        if (!deps.docker) {
          sendJson(res, 503, {
            ok: false,
            error: {
              code: 'DOCKER_TRACK_DISABLED',
              message: 'this broker was started with the Docker track switched off',
            },
          });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const data = await deps.docker.run(String(body.op), body);
          sendJson(res, 200, { ok: true, data });
        } catch (error) {
          const { status, body } = dockerErrorResponse(error);
          if (status >= 500) log(`docker operation failed: ${String(error)}`);
          sendJson(res, status, body);
        }
        return;
      }

      // There is no other HTTP surface. Not a 404 page, not a directory,
      // nothing that could grow into a control API by accident.
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
    })();
  });

  /**
   * The two gates every HTTP endpoint passes, in order.
   *
   * `Origin` first, because it is the cheaper check and the one that makes a
   * browser structurally unable to reach this service. Then the scope: the
   * credential must be the one configured for *this* capability, not merely a
   * credential this deployment recognises.
   *
   * Returns false having already answered, so a handler's whole authorization
   * is one `if (!admit(...)) return;` and cannot be half-written.
   */
  function admit(req: IncomingMessage, res: ServerResponse, scope: SandboxdScope): boolean {
    if (req.headers.origin !== undefined) {
      sendJson(res, 401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'this endpoint is not browser-facing' },
      });
      return false;
    }
    const decision = authorizeScope(req.headers['x-internal-secret'], scope, config.scopeSecrets);
    if (!decision.ok) {
      log(`refused ${String(req.url)}: ${decision.denial}`);
      sendJson(res, 403, {
        ok: false,
        error: { code: 'SCOPE_DENIED', message: decision.message ?? 'not authorized' },
      });
      return false;
    }
    return true;
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  httpServer.on('upgrade', (req, socket, head) => {
    const deny = upgradeRefusal(req, config);
    if (deny) {
      log(`upgrade refused: ${deny}`);
      socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    let attached = false;

    /*
     * A socket that never sends `attach` is not a resource this service will
     * hold open. Short, because the only legitimate caller sends it
     * immediately.
     */
    const handshakeTimer = setTimeout(() => {
      if (!attached) {
        send(ws, { type: 'error', code: 'ATTACH_TIMEOUT', message: 'No attach frame was sent.' });
        ws.close(4408, 'attach timeout');
      }
    }, 10_000);

    ws.on('message', (raw) => {
      void (async () => {
        let message;
        try {
          message = parseBrokerClientMessage(String(raw));
        } catch (error) {
          const msg = error instanceof BrokerProtocolError ? error.message : 'bad frame';
          send(ws, { type: 'error', code: 'BAD_FRAME', message: msg });
          ws.close(4400, 'bad frame');
          return;
        }

        if (message.type === 'ping') {
          send(ws, { type: 'pong' });
          return;
        }

        if (!attached) {
          if (message.type !== 'attach') {
            send(ws, {
              type: 'error',
              code: 'NOT_ATTACHED',
              message: 'The first frame must be an attach.',
            });
            ws.close(4401, 'not attached');
            return;
          }
          attached = true;
          clearTimeout(handshakeTimer);
          await openShell(ws, message.sessionId, clampCols(message.cols), clampRows(message.rows));
          return;
        }

        const shell = shells.get(ws);
        if (!shell) return;
        if (message.type === 'input') {
          shell.term.write(message.data);
          shell.idleTimer.refresh();
        } else if (message.type === 'resize') {
          try {
            shell.term.resize(message.cols, message.rows);
          } catch {
            /* the shell is already gone */
          }
          shell.idleTimer.refresh();
        }
      })();
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      endShell(ws);
    });
    ws.on('error', () => {
      clearTimeout(handshakeTimer);
      endShell(ws);
    });
  });

  async function openShell(
    ws: WebSocket,
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    if (shells.size >= config.maxSessions) {
      send(ws, {
        type: 'error',
        code: 'BROKER_AT_CAPACITY',
        message: 'This runtime is hosting its maximum number of shells.',
      });
      ws.close(4429, 'at capacity');
      return;
    }

    let target;
    try {
      target = await resolveAttachTarget({
        sessionId,
        inspector,
        derivationSecret: config.derivationSecret,
        runtimeOwner: config.runtimeOwner,
        sandboxUser: config.sandboxUser,
        sandboxHome: config.sandboxHome,
      });
    } catch (error) {
      const code = error instanceof AttachDeniedError ? error.code : 'ATTACH_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      log(`attach denied for ${sessionId}: ${code} — ${message}`);
      send(ws, { type: 'error', code, message });
      ws.close(4403, code);
      return;
    }

    // One shell per session: a reconnect replaces rather than doubles.
    const existing = bySessionId.get(sessionId);
    if (existing && existing !== ws) {
      endShell(existing);
      if (existing.readyState === existing.OPEN) existing.close(1000, 'replaced');
    }

    let term: BrokerPty;
    try {
      term = spawn(config.containerBinary, attachArgv(target, { shell: config.shell }), {
        cols,
        rows,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`pty spawn failed for ${sessionId}: ${message}`);
      send(ws, { type: 'error', code: 'PTY_SPAWN_FAILED', message: 'Could not start a shell.' });
      ws.close(1011, 'pty spawn failed');
      return;
    }

    const shell: LiveShell = {
      sessionId,
      sandboxRef: target.ref,
      term,
      idleTimer: setTimeout(() => closeFor(ws, 'IDLE_TIMEOUT'), config.idleTimeoutMs),
      maxTimer: setTimeout(() => closeFor(ws, 'SESSION_EXPIRED'), config.maxSessionMs),
    };
    shells.set(ws, shell);
    bySessionId.set(sessionId, ws);

    term.onData((data) => send(ws, { type: 'output', data }));
    term.onExit(({ exitCode, signal }) => {
      send(ws, { type: 'exit', exitCode, ...(signal !== undefined ? { signal } : {}) });
      endShell(ws);
      if (ws.readyState === ws.OPEN) ws.close(1000, 'shell exited');
    });

    send(ws, {
      type: 'attached',
      sandboxRef: target.ref,
      user: target.user,
      workdir: target.workdir,
    });
    log(`attached ${sessionId} → ${target.ref} as ${target.user} (${shells.size} live)`);
  }

  function closeFor(ws: WebSocket, code: string): void {
    send(ws, { type: 'error', code, message: 'This shell was closed by the runtime broker.' });
    endShell(ws);
    if (ws.readyState === ws.OPEN) ws.close(4408, code);
  }

  function endShell(ws: WebSocket): void {
    const shell = shells.get(ws);
    if (!shell) return;
    shells.delete(ws);
    if (bySessionId.get(shell.sessionId) === ws) bySessionId.delete(shell.sessionId);
    clearTimeout(shell.idleTimer);
    clearTimeout(shell.maxTimer);
    try {
      shell.term.kill();
    } catch {
      /* already dead */
    }
    log(`detached ${shell.sessionId} (${shells.size} live)`);
  }

  httpServer.on('close', () => {
    for (const ws of [...shells.keys()]) endShell(ws);
  });

  return httpServer;
}

/**
 * Why an upgrade is refused, or `null` to allow it.
 *
 * Two gates, and the second is the interesting one. Requiring the internal
 * secret is table stakes; refusing any request that carries an `Origin` header
 * is what makes a browser structurally unable to reach this service even if the
 * secret ever leaked into one, because every browser WebSocket sends `Origin`
 * and no server-side client does.
 */
export function upgradeRefusal(req: IncomingMessage, config: SandboxdConfig): string | null {
  if (req.headers.origin !== undefined) {
    return 'requests carrying an Origin header are not accepted; this endpoint is not browser-facing';
  }
  /*
   * The path decides the scope, and it is resolved before the credential is
   * looked at — so a credential valid for `runtime` or `docker` opens nothing
   * here, and an unknown path has no scope and is refused rather than falling
   * through to a default.
   */
  const scope = scopeForEndpoint(req.url);
  if (scope === null) {
    return `no broker endpoint at '${String(req.url)}'`;
  }
  if (scope !== 'attach') {
    // Reachable only if a non-WebSocket endpoint were ever added to the table.
    return `'${String(req.url)}' is not a WebSocket endpoint`;
  }
  const decision = authorizeScope(req.headers['x-internal-secret'], scope, config.scopeSecrets);
  if (!decision.ok) {
    return decision.message ?? 'not authorized';
  }
  return null;
}

function send(ws: WebSocket, message: BrokerServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
}
