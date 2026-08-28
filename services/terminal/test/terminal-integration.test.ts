/**
 * End-to-end terminal test against a REAL kind cluster and a REAL PTY.
 *
 * This is the one chain that unit tests cannot prove, because every link is a
 * different process boundary:
 *
 * ```text
 *   browser ──WebSocket + signed token──► terminal service
 *                                         └─► api /internal/…/credentials
 *                                             └─► Kubernetes TokenRequest
 *                                                 └─► kubeconfig on disk (0600)
 *                                                     └─► real bash PTY
 *                                                         └─► real kubectl
 * ```
 *
 * What it establishes: the shell a student actually gets is authenticated as
 * their session's ServiceAccount, is scoped to their namespace, and is refused
 * by the API server everywhere else.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import * as pty from 'node-pty';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  KubernetesClient,
  SessionManager,
  issueSessionToken,
  type LabSession,
} from '@jumptotech/lab-orchestrator';
import { createApp } from '@jumptotech/api';
import { loadConfig } from '@jumptotech/api/config';
import { createTerminalServer } from '../src/server.js';
import { loadTerminalConfig } from '../src/config.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_KUBECONFIG =
  process.env.KUBECONFIG ?? path.join(repoRoot, 'infrastructure/kind/generated/kubeconfig-host.yaml');

/**
 * Can this host spawn a PTY at all?
 *
 * `node-pty` is a native addon and does not build against every Node release —
 * the repo pins Node 22 for exactly this reason (README → Requirements). On a
 * host running a newer Node, `pty.spawn` fails with `posix_spawnp failed` and
 * this suite would report a platform limitation as a product failure. Probe
 * first and skip loudly instead.
 */
function canSpawnPty(): boolean {
  try {
    const probe = pty.spawn('/bin/sh', ['-c', 'exit 0'], { name: 'xterm-color', cols: 80, rows: 24 });
    probe.kill();
    return true;
  } catch {
    return false;
  }
}

const ptyAvailable = canSpawnPty();
const enabled = process.env.RUN_INTEGRATION_TESTS === '1' && existsSync(HOST_KUBECONFIG) && ptyAvailable;
const suite = enabled ? describe : describe.skip;

const SECRET = 'terminal-integration-secret-value';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A connected, authenticated student terminal. */
class TerminalClient {
  #ws: WebSocket;
  #buffer = '';
  readonly frames: Array<Record<string, unknown>> = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
  }

  /**
   * Open a socket, optionally sending the auth frame.
   *
   * `token` is omitted by the tests that check what happens when a client never
   * authenticates, or sends something else first — cases the handshake has to
   * handle and which a helper that always authenticated could not reach.
   */
  static async connect(port: number, token?: string): Promise<TerminalClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`);
    const client = new TerminalClient(ws);

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      client.frames.push(frame);
      if (frame.type === 'output') client.#buffer += String(frame.data);
    });

    if (token !== undefined) {
      ws.send(JSON.stringify({ type: 'auth', token, cols: 120, rows: 40 }));
    }
    return client;
  }

  send(message: unknown): void {
    this.#ws.send(JSON.stringify(message));
  }

  /** Type a command and press Enter. */
  run(command: string): void {
    this.send({ type: 'input', data: `${command}\n` });
  }

  get output(): string {
    return this.#buffer;
  }

  clearOutput(): void {
    this.#buffer = '';
  }

  /** Wait for a frame of a given type. */
  waitForFrame(type: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const existing = this.frames.find((f) => f.type === type);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for '${type}' frame`)), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame.type === type) {
          clearTimeout(timer);
          this.#ws.off('message', onMessage);
          resolve(frame);
        }
      };
      this.#ws.on('message', onMessage);
    });
  }

  /** Wait until the accumulated output matches. */
  async waitForOutput(pattern: RegExp, timeoutMs = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(this.#buffer)) return this.#buffer;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timed out waiting for ${pattern}. Output so far:\n${this.#buffer}`);
  }

  get closed(): boolean {
    return this.#ws.readyState === WebSocket.CLOSED || this.#ws.readyState === WebSocket.CLOSING;
  }

  async waitForClose(timeoutMs = 30_000): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.#ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  dispose(): void {
    try {
      this.#ws.terminate();
    } catch {
      /* already gone */
    }
  }
}

suite('integration: student terminal against real kind', () => {
  let apiServer: Server;
  let terminalServer: Server;
  let terminalPort: number;
  let manager: SessionManager;
  let credentialsDir: string;
  let sessionA: LabSession;
  let sessionB: LabSession;
  let clientA: TerminalClient;

  /*
   * Two students, and the sessions really belong to them.
   *
   * Before PLATFORM-010 this suite started ownerless sessions, because
   * sessions had no owner. They do now, and an ownerless one is reachable by
   * nobody — `policy.ts` says so for HTTP and the credential exchange says so
   * for the terminal. Starting an ownerless session here would therefore test
   * a state no signed-in student can ever be in.
   */
  const OWNER_A = 'usr-0000000a';
  const OWNER_B = 'usr-0000000b';

  /**
   * The token the API mints at Start Lab, for the session's real owner.
   *
   * `ownerUserId` defaults to the session's actual owner so that the ordinary
   * case is written once; the tests that attack the binding pass a different
   * one deliberately, which is the point.
   */
  function tokenFor(session: LabSession, ownerUserId?: string): string {
    return issueSessionToken({
      sessionId: session.sessionId,
      ownerUserId: ownerUserId ?? (session.ownerUserId as string),
      labId: session.labId,
      namespace: session.namespace,
      secret: SECRET,
      ttlSeconds: 3_600,
    }).token;
  }

  beforeAll(async () => {
    const registry = await realCatalog();

    const k8s = new KubernetesClient({ kubeconfigPath: HOST_KUBECONFIG });
    const provider = new KindLabProvider({
      k8s,
      clusterName: process.env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
      kubeconfigPath: HOST_KUBECONFIG,
      destroyTimeoutMs: 120_000,
    });

    const config = loadConfig({
      TERMINAL_SESSION_SECRET: SECRET,
      LABS_DIR: path.join(repoRoot, 'labs'),
    } as NodeJS.ProcessEnv);

    manager = new SessionManager({
      registry,
      provider,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: config.lifetimes,
      namespaceSecret: 'terminal-integration-namespace-secret',
    });

    apiServer = createServer(createApp({ registry, sessions: manager, k8s, config }));
    const apiPort = await listen(apiServer);

    credentialsDir = await mkdtemp(path.join(tmpdir(), 'jtt-term-creds-'));
    terminalServer = createTerminalServer(
      loadTerminalConfig({
        TERMINAL_SESSION_SECRET: SECRET,
        API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
        TERMINAL_CREDENTIALS_DIR: credentialsDir,
        TERMINAL_WORKDIR: credentialsDir,
        TERMINAL_SHELL: '/bin/bash',
      } as NodeJS.ProcessEnv),
    );
    terminalPort = await listen(terminalServer);

    sessionA = (await manager.start('K8S-001', OWNER_A)).session;
    sessionB = (await manager.start('K8S-001', OWNER_B)).session;
    // The owner really is stored, or every ownership assertion below is vacuous.
    expect(sessionA.ownerUserId).toBe(OWNER_A);
    expect(sessionB.ownerUserId).toBe(OWNER_B);

    clientA = await TerminalClient.connect(terminalPort, tokenFor(sessionA));
    await clientA.waitForFrame('ready');
    // Settle the shell prompt before issuing commands.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 300_000);

  afterAll(async () => {
    clientA?.dispose();
    if (terminalServer) await close(terminalServer);
    if (apiServer) await close(apiServer);
    for (const session of [sessionA, sessionB]) {
      if (session) await manager.end(session.sessionId).catch(() => undefined);
    }
    if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true }).catch(() => undefined);
  }, 300_000);

  it('reports the session it is bound to, and its namespace', async () => {
    const ready = await clientA.waitForFrame('ready');

    expect(ready.sessionId).toBe(sessionA.sessionId);
    expect(ready.namespace).toBe(sessionA.namespace);
    expect(ready.labId).toBe('K8S-001');
  }, 60_000);

  it('gives the shell a session-scoped kubeconfig, written 0600', async () => {
    clientA.clearOutput();
    clientA.run('echo KC=$KUBECONFIG');
    await clientA.waitForOutput(/KC=\S+\.kubeconfig/);

    const match = /KC=(\S+\.kubeconfig)/.exec(clientA.output);
    const kubeconfigPath = match?.[1];
    expect(kubeconfigPath).toBeDefined();
    expect(kubeconfigPath).toContain(sessionA.sessionId);

    const contents = await readFile(kubeconfigPath!, 'utf8');
    expect(contents).toContain(`namespace: ${sessionA.namespace}`);
    // Not the platform's credential.
    expect(contents).not.toContain('client-certificate');
    expect(contents).not.toContain('kubernetes-admin');
  }, 120_000);

  it('runs kubectl as the session ServiceAccount, never as cluster-admin', async () => {
    clientA.clearOutput();
    clientA.run('kubectl auth whoami -o jsonpath={.status.userInfo.username}; echo');
    await clientA.waitForOutput(/system:serviceaccount:/);

    expect(clientA.output).toContain(`system:serviceaccount:${sessionA.namespace}:student`);
    expect(clientA.output).not.toContain('kubernetes-admin');
    expect(clientA.output).not.toContain('system:masters');
  }, 120_000);

  it('defaults to the student’s namespace with no -n flag', async () => {
    clientA.clearOutput();
    clientA.run('kubectl run terminal-probe --image=nginx:stable');
    await clientA.waitForOutput(/pod\/terminal-probe created/);

    clientA.clearOutput();
    clientA.run('kubectl get pods -o name');
    await clientA.waitForOutput(/pod\/terminal-probe/);

    expect(clientA.output).toContain('pod/terminal-probe');
  }, 180_000);

  it('is Forbidden from the other student’s namespace', async () => {
    clientA.clearOutput();
    clientA.run(`kubectl get pods -n ${sessionB.namespace}`);
    await clientA.waitForOutput(/forbidden|Forbidden/);

    expect(clientA.output).toMatch(/Forbidden/);
    expect(clientA.output).toContain(sessionB.namespace);
  }, 120_000);

  it('is Forbidden from kube-system and from node-level reads', async () => {
    clientA.clearOutput();
    clientA.run('kubectl get pods -n kube-system 2>&1 | tail -1');
    await clientA.waitForOutput(/Forbidden/);
    expect(clientA.output).toMatch(/Forbidden/);

    clientA.clearOutput();
    clientA.run('kubectl get nodes 2>&1 | tail -1');
    await clientA.waitForOutput(/Forbidden/);
    expect(clientA.output).toMatch(/Forbidden/);
  }, 120_000);

  it('cannot re-authenticate itself onto another session', async () => {
    // The only way a live socket could change identity would be a second auth
    // frame. It is refused, and the socket keeps session A's shell.
    clientA.send({ type: 'auth', token: tokenFor(sessionB) });

    const error = await clientA.waitForFrame('error');
    expect(error.code).toBe('ALREADY_AUTHENTICATED');

    clientA.clearOutput();
    clientA.run('kubectl auth whoami -o jsonpath={.status.userInfo.username}; echo');
    await clientA.waitForOutput(/system:serviceaccount:/);
    expect(clientA.output).toContain(sessionA.namespace);
    expect(clientA.output).not.toContain(sessionB.namespace);
  }, 120_000);

  it('refuses a forged or unsigned token outright', async () => {
    const forged = issueSessionToken({
      sessionId: sessionB.sessionId,
      ownerUserId: OWNER_B,
      labId: sessionB.labId,
      namespace: sessionB.namespace,
      secret: 'a-completely-different-secret',
      ttlSeconds: 3_600,
    }).token;

    const client = await TerminalClient.connect(terminalPort, forged);
    try {
      const error = await client.waitForFrame('error');
      expect(error.code).toBe('UNAUTHORIZED');
      await client.waitForClose();
    } finally {
      client.dispose();
    }
  }, 60_000);

  it('closes the shell and deletes the credential file when the session ends', async () => {
    const clientB = await TerminalClient.connect(terminalPort, tokenFor(sessionB));
    try {
      await clientB.waitForFrame('ready');

      clientB.clearOutput();
      clientB.run('echo KC=$KUBECONFIG');
      await clientB.waitForOutput(/KC=\S+\.kubeconfig/);
      const kubeconfigPath = /KC=(\S+\.kubeconfig)/.exec(clientB.output)?.[1];
      expect(existsSync(kubeconfigPath!)).toBe(true);

      // The API's teardown path closes the terminal before deleting the namespace.
      const response = await fetch(`http://127.0.0.1:${terminalPort}/internal/terminate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
        body: JSON.stringify({ sessionId: sessionB.sessionId }),
      });
      expect(response.ok).toBe(true);

      await clientB.waitForClose();
      // Give the async unlink a moment.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(kubeconfigPath!)).toBe(false);
    } finally {
      clientB.dispose();
    }
  }, 180_000);


  // ------------------------------------------------ PLATFORM-010 authorization
  //
  // The handshake, attacked. Everything below drives a *real* WebSocket against
  // the *real* terminal service, which resolves credentials from the *real*
  // API — so a pass here is the whole chain, not a mocked slice of it.

  it('refuses a connection that never sends a token', async () => {
    const client = await TerminalClient.connect(terminalPort);
    try {
      // No auth frame at all. The socket is dropped after the grace period
      // rather than left open for something to happen on.
      const error = await client.waitForFrame('error', 30_000);
      expect(error.code).toBe('AUTH_TIMEOUT');
      await client.waitForClose();
    } finally {
      client.dispose();
    }
  }, 60_000);

  it('refuses a first frame that is not an auth frame', async () => {
    const client = await TerminalClient.connect(terminalPort);
    try {
      // Trying to type before authenticating.
      client.send({ type: 'input', data: 'whoami\n' });
      const error = await client.waitForFrame('error');
      expect(error.code).toBe('UNAUTHENTICATED');
      await client.waitForClose();
    } finally {
      client.dispose();
    }
  }, 60_000);

  it('refuses a malformed token', async () => {
    for (const token of ['', 'not-a-token', 'a.b.c', 'eyJhbGciOiJub25lIn0..', 'x'.repeat(5000)]) {
      const client = await TerminalClient.connect(terminalPort, token);
      try {
        const error = await client.waitForFrame('error');
        expect(error.code, token.slice(0, 16)).toBe('UNAUTHORIZED');
        await client.waitForClose();
      } finally {
        client.dispose();
      }
    }
  }, 120_000);

  it('refuses an expired token', async () => {
    // Correctly signed by the real secret, for the real session and its real
    // owner — and issued in the past. The signature is not the only check.
    const expired = issueSessionToken({
      sessionId: sessionA.sessionId,
      ownerUserId: OWNER_A,
      labId: sessionA.labId,
      namespace: sessionA.namespace,
      secret: SECRET,
      ttlSeconds: 60,
      now: () => Date.now() - 3_600_000,
    }).token;

    const client = await TerminalClient.connect(terminalPort, expired);
    try {
      const error = await client.waitForFrame('error');
      expect(error.code).toBe('UNAUTHORIZED');
      expect(String(error.message)).toMatch(/expired/i);
      await client.waitForClose();
    } finally {
      client.dispose();
    }
  }, 60_000);

  it('refuses a token carrying no owner at all', async () => {
    /*
     * A token minted before ownership binding existed: correctly signed with
     * the real secret, naming the real session, and carrying no `uid`. It must
     * fail closed — reading "no owner claim" as "unowned, allow" is exactly the
     * behaviour PLATFORM-010 removed.
     */
    const claims = {
      sid: sessionA.sessionId,
      labId: sessionA.labId,
      namespace: sessionA.namespace,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3_600,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const legacy = `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;

    const client = await TerminalClient.connect(terminalPort, legacy);
    try {
      const error = await client.waitForFrame('error');
      expect(error.code).toBe('UNAUTHORIZED');
      expect(String(error.message)).toMatch(/owner/i);
      await client.waitForClose();
    } finally {
      client.dispose();
    }
  }, 60_000);

  it('refuses User B’s owner id pointed at User A’s session', async () => {
    /*
     * The attack this milestone closed, over a real socket.
     *
     * A perfectly valid HMAC — right secret, right session id, right lab, right
     * namespace — with the wrong owner. Before PLATFORM-010 nothing compared
     * the two, and this connected. Now the API re-checks the claim against the
     * live session record and refuses, so no PTY is ever spawned.
     */
    const crossUser = tokenFor(sessionA, OWNER_B);

    const client = await TerminalClient.connect(terminalPort, crossUser);
    try {
      const error = await client.waitForFrame('error');
      // The refusal comes from the credential exchange, not from the signature.
      expect(String(error.code)).toMatch(/SESSION_NOT_OWNED|CREDENTIALS_UNAVAILABLE/);
      // Nothing about the runtime leaks in the refusal.
      expect(JSON.stringify(error)).not.toContain(sessionA.namespace);
    } finally {
      client.dispose();
    }
  }, 60_000);

  it('refuses a forged session id, even with a well-formed owner', async () => {
    // A session id that never existed, signed correctly. Ownership cannot be
    // established for a row that is not there, so this is refused rather than
    // treated as a new or unowned session.
    const forgedSession = issueSessionToken({
      sessionId: 'sess-00000000deadbeef',
      ownerUserId: OWNER_A,
      labId: sessionA.labId,
      namespace: sessionA.namespace,
      secret: SECRET,
      ttlSeconds: 3_600,
    }).token;

    const client = await TerminalClient.connect(terminalPort, forgedSession);
    try {
      const error = await client.waitForFrame('error');
      expect(error.type).toBe('error');
      expect(JSON.stringify(error)).not.toContain(sessionA.namespace);
    } finally {
      client.dispose();
    }
  }, 60_000);

  it('ignores a namespace the token claims and uses the session’s own', async () => {
    /*
     * The token carries a `namespace` claim, so the obvious question is whether
     * it can steer the shell. It cannot: the terminal service resolves the
     * binding from the API by session id, and the API reads the namespace out
     * of the session record. The claim is a label, not an instruction.
     */
    const lying = issueSessionToken({
      sessionId: sessionA.sessionId,
      ownerUserId: OWNER_A,
      labId: sessionA.labId,
      namespace: sessionB.namespace, // somebody else's namespace
      secret: SECRET,
      ttlSeconds: 3_600,
    }).token;

    const client = await TerminalClient.connect(terminalPort, lying);
    try {
      const ready = await client.waitForFrame('ready');
      // Session A's namespace, not the one the token named.
      expect(ready.namespace).toBe(sessionA.namespace);
      expect(ready.namespace).not.toBe(sessionB.namespace);

      await new Promise((resolve) => setTimeout(resolve, 500));
      client.clearOutput();
      client.run('kubectl config view --minify -o jsonpath={..namespace}; echo');
      await client.waitForOutput(/lab-[0-9a-f]+/);
      // The kubeconfig on disk agrees with the record, not with the claim.
      expect(client.output).toContain(sessionA.namespace);
      expect(client.output).not.toContain(sessionB.namespace);
    } finally {
      client.dispose();
    }
  }, 180_000);

  it('gives the shell only the runtime belonging to its own session', async () => {
    /*
     * Its own connection, deliberately.
     *
     * The terminal service maps one session to one socket (`bySessionId`), so a
     * later connection for the same session displaces the shared `clientA`
     * fixture — which the namespace test above does. Depending on that fixture
     * here would make this test's result an artefact of execution order rather
     * than of the property it names.
     */
    const client = await TerminalClient.connect(terminalPort, tokenFor(sessionA));
    try {
      await client.waitForFrame('ready');
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The positive half of the isolation property: the PTY is authenticated
      // as this session's ServiceAccount, in this session's namespace, and the
      // API server refuses it everywhere else.
      client.clearOutput();
      client.run(`kubectl get pods -n ${sessionB.namespace} >/dev/null 2>&1; echo RC=$?`);
      await client.waitForOutput(/RC=[0-9]+/);
      expect(client.output).not.toMatch(/RC=0/);

      client.clearOutput();
      client.run('kubectl get pods >/dev/null 2>&1; echo OWN=$?');
      await client.waitForOutput(/OWN=[0-9]+/);
      expect(client.output).toMatch(/OWN=0/);
    } finally {
      client.dispose();
    }
  }, 180_000);

  it('refuses an unauthenticated terminate request', async () => {
    const response = await fetch(`http://127.0.0.1:${terminalPort}/internal/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionA.sessionId }),
    });

    expect(response.status).toBe(401);
  }, 60_000);
});

if (!enabled) {
  const reason = !ptyAvailable
    ? `node-pty cannot spawn a PTY on this host (Node ${process.versions.node}; the repo pins Node 22 — see README → Requirements). Run this suite inside the terminal container instead.`
    : 'set RUN_INTEGRATION_TESTS=1 and ensure a kind kubeconfig exists';
  // eslint-disable-next-line no-console
  console.log(`[terminal-integration] skipped — ${reason}`);
}
