/**
 * The broker's front door and its wire.
 *
 * `attach.test.ts` proves *which container* a session resolves to. This proves
 * the things around it: who may open a socket at all, that a socket cannot send
 * input before it has attached, and that one session's shell is replaced rather
 * than duplicated.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import {
  CONTAINER_SANDBOX_PREFIX,
  LAB_LABEL,
  MANAGED_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  deriveSandboxRef,
} from '@jumptotech/lab-orchestrator';
import type { SandboxSnapshot } from '../src/attach.js';
import { defaultObservabilityConfig, type SandboxdConfig } from '../src/config.js';
import { createSandboxd, upgradeRefusal, type BrokerPty } from '../src/server.js';

const SECRET = 'internal-service-secret-for-tests';
const DERIVATION = 'derivation-secret-for-tests';
const SESSION_A = 'sess-aaaaaaaaaaaaaaaa';
const SESSION_B = 'sess-bbbbbbbbbbbbbbbb';

const config: SandboxdConfig = {
  port: 0,
  observability: defaultObservabilityConfig('sandboxd', 0),
  bindAddress: '127.0.0.1',
  scopeSecrets: { attach: SECRET + '-attach', runtime: SECRET + '-runtime', docker: SECRET + '-docker' },
  derivationSecret: DERIVATION,
  runtimeOwner: 'jumptotech',
  containerBinary: 'docker',
  shell: '/bin/bash',
  docker: null,
  sandboxUser: 'student',
  sandboxHome: '/home/student',
  maxSessions: 4,
  idleTimeoutMs: 60_000,
  maxSessionMs: 120_000,
};

const refFor = (sessionId: string): string =>
  deriveSandboxRef({ sessionId, secret: DERIVATION, prefix: CONTAINER_SANDBOX_PREFIX });

function snapshotFor(sessionId: string): SandboxSnapshot {
  return {
    state: 'running',
    user: 'student',
    workdir: '/home/student',
    labels: {
      [MANAGED_LABEL]: 'true',
      [RUNTIME_OWNER_LABEL]: 'jumptotech',
      [SESSION_LABEL]: sessionId,
      [LAB_LABEL]: 'LINUX-001',
    },
  };
}

/** A PTY that records what it was told, so no real shell is involved. */
function fakePty(): BrokerPty & { written: string[]; killed: boolean; emit(data: string): void } {
  let onData: (d: string) => void = () => undefined;
  return {
    written: [],
    killed: false,
    write(data) {
      this.written.push(data);
    },
    resize() {
      /* recorded nowhere; resize is exercised for its absence of throw */
    },
    kill() {
      this.killed = true;
    },
    onData(listener) {
      onData = listener;
    },
    onExit() {
      /* no exit in these tests */
    },
    emit(data) {
      onData(data);
    },
  };
}

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
});

interface Harness {
  url: string;
  ptys: ReturnType<typeof fakePty>[];
  argvs: string[][];
}

async function start(containers: Record<string, SandboxSnapshot>): Promise<Harness> {
  const ptys: ReturnType<typeof fakePty>[] = [];
  const argvs: string[][] = [];
  const server = createSandboxd({
    config,
    inspector: { inspect: async (ref) => containers[ref] ?? null },
    spawn: (_command, args) => {
      argvs.push(args);
      const p = fakePty();
      ptys.push(p);
      return p;
    },
    log: () => undefined,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/v1/attach`, ptys, argvs };
}

function connect(url: string, headers: Record<string, string>): WebSocket {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  return ws;
}

/** Resolve with the first server frame of one of `types`. */
function nextFrame(ws: WebSocket, types: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${types.join('/')} frame`)), 4000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (!types.includes(String(msg.type))) return;
      clearTimeout(timer);
      resolve(msg);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe('upgradeRefusal', () => {
  const req = (headers: Record<string, string>, url = '/v1/attach') =>
    ({ headers, url }) as never;

  it('accepts an internal caller on the attach path', () => {
    expect(upgradeRefusal(req({ 'x-internal-secret': SECRET + '-attach' }), config)).toBeNull();
  });

  it('refuses a caller with no secret, or the wrong one', () => {
    expect(upgradeRefusal(req({}), config)).toMatch(/credential is required/);
    expect(upgradeRefusal(req({ 'x-internal-secret': 'nope' }), config)).toMatch(/'attach' capability/);
  });

  it('refuses anything sent by a browser, secret or not', () => {
    // Every browser WebSocket sends Origin; no server-side client does. So this
    // makes the service structurally unreachable from a page even if the
    // internal secret ever leaked into one.
    const refusal = upgradeRefusal(
      req({ 'x-internal-secret': SECRET + '-attach', origin: 'http://localhost:3000' }),
      config,
    );
    expect(refusal).toMatch(/Origin/);
  });

  it('refuses any path but the attach endpoint', () => {
    expect(upgradeRefusal(req({ 'x-internal-secret': SECRET + '-attach' }, '/'), config)).toMatch(/no broker endpoint/);
    expect(upgradeRefusal(req({ 'x-internal-secret': SECRET + '-attach' }, '/v1/exec'), config)).toMatch(
      /no broker endpoint/,
    );
  });
});

describe('sandboxd attach', () => {
  it('opens a PTY into the session-derived container and pipes both ways', async () => {
    const harness = await start({ [refFor(SESSION_A)]: snapshotFor(SESSION_A) });
    const ws = connect(harness.url, { 'x-internal-secret': SECRET + '-attach' });

    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'attach', sessionId: SESSION_A, cols: 80, rows: 24 }));

    const attached = await nextFrame(ws, ['attached', 'error']);
    expect(attached.type).toBe('attached');
    expect(attached.sandboxRef).toBe(refFor(SESSION_A));
    expect(harness.argvs[0]).toContain(refFor(SESSION_A));

    ws.send(JSON.stringify({ type: 'input', data: 'whoami\r' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.ptys[0]!.written).toEqual(['whoami\r']);

    const output = nextFrame(ws, ['output']);
    harness.ptys[0]!.emit('student\r\n');
    expect((await output).data).toBe('student\r\n');
  });

  it('refuses an upgrade without the internal secret', async () => {
    const harness = await start({ [refFor(SESSION_A)]: snapshotFor(SESSION_A) });
    const ws = connect(harness.url, {});
    const error = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(error.message).toMatch(/401/);
  });

  it("refuses to attach a session to another session's sandbox", async () => {
    // Both sandboxes exist on the runtime. A caller naming session A gets A's
    // container or nothing — there is no field in the protocol that could ask
    // for B's, and B's label would refuse it anyway.
    const harness = await start({
      [refFor(SESSION_A)]: snapshotFor(SESSION_A),
      [refFor(SESSION_B)]: snapshotFor(SESSION_B),
    });

    const ws = connect(harness.url, { 'x-internal-secret': SECRET + '-attach' });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(
      JSON.stringify({
        type: 'attach',
        sessionId: SESSION_A,
        // Not part of the protocol. Present here precisely to prove it is
        // ignored rather than honoured.
        containerRef: refFor(SESSION_B),
        sandboxRef: refFor(SESSION_B),
      }),
    );

    const attached = await nextFrame(ws, ['attached', 'error']);
    expect(attached.sandboxRef).toBe(refFor(SESSION_A));
    expect(harness.argvs[0]).not.toContain(refFor(SESSION_B));
  });

  it('forwards a refusal with its code and opens nothing', async () => {
    const harness = await start({});
    const ws = connect(harness.url, { 'x-internal-secret': SECRET + '-attach' });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'attach', sessionId: SESSION_A }));

    const frame = await nextFrame(ws, ['attached', 'error']);
    expect(frame).toMatchObject({ type: 'error', code: 'SANDBOX_NOT_FOUND' });
    expect(harness.ptys).toHaveLength(0);
  });

  it('closes a socket that sends input before it has attached', async () => {
    const harness = await start({ [refFor(SESSION_A)]: snapshotFor(SESSION_A) });
    const ws = connect(harness.url, { 'x-internal-secret': SECRET + '-attach' });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'input', data: 'rm -rf /\r' }));

    const frame = await nextFrame(ws, ['error']);
    expect(frame).toMatchObject({ code: 'NOT_ATTACHED' });
    expect(harness.ptys).toHaveLength(0);
  });

  it('closes a socket that sends a frame it does not understand', async () => {
    const harness = await start({ [refFor(SESSION_A)]: snapshotFor(SESSION_A) });
    const ws = connect(harness.url, { 'x-internal-secret': SECRET + '-attach' });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'exec', argv: ['sh', '-c', 'id'] }));

    const frame = await nextFrame(ws, ['error']);
    expect(frame).toMatchObject({ code: 'BAD_FRAME' });
    expect(harness.ptys).toHaveLength(0);
  });

  it('replaces a session shell rather than running two against one sandbox', async () => {
    const harness = await start({ [refFor(SESSION_A)]: snapshotFor(SESSION_A) });

    const first = connect(harness.url, { 'x-internal-secret': SECRET + '-attach' });
    await new Promise((resolve) => first.on('open', resolve));
    first.send(JSON.stringify({ type: 'attach', sessionId: SESSION_A }));
    await nextFrame(first, ['attached']);

    const second = connect(harness.url, { 'x-internal-secret': SECRET + '-attach' });
    await new Promise((resolve) => second.on('open', resolve));
    second.send(JSON.stringify({ type: 'attach', sessionId: SESSION_A }));
    await nextFrame(second, ['attached']);

    await new Promise((r) => setTimeout(r, 50));
    expect(harness.ptys[0]!.killed).toBe(true);
    expect(harness.ptys[1]!.killed).toBe(false);
  });

  it('kills the PTY when the socket goes away', async () => {
    const harness = await start({ [refFor(SESSION_A)]: snapshotFor(SESSION_A) });
    const ws = connect(harness.url, { 'x-internal-secret': SECRET + '-attach' });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'attach', sessionId: SESSION_A }));
    await nextFrame(ws, ['attached']);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(harness.ptys[0]!.killed).toBe(true);
  });
});
