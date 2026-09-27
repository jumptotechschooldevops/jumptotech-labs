/**
 * `SANDBOXD_MAX_SESSIONS` binds when a class attaches at once.
 *
 * The broker hosts every container student's PTY in one process, capped at
 * 512 MiB, and each shell carries a `docker exec` child and up to a megabyte
 * of buffered output and input before flow control pauses it. `maxSessions` is
 * what bounds that.
 *
 * It was checked against `shells.size` — the shells that already exist —
 * before `resolveAttachTarget`, which is a `docker inspect` of the student's
 * container with a 15 s deadline. Attaches that arrive together therefore all
 * passed the check while the count was still low, and each then spawned a PTY.
 * The same burst the cap exists for — a class starting, or every terminal
 * reattaching after a restart — walked straight past it.
 *
 * Invariant: at most `maxSessions` shells exist at any moment, whatever the
 * arrival pattern; a session that already holds one is replacing it, not
 * taking a second slot.
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
import { createSandboxd, type BrokerPty } from '../src/server.js';

const SECRET = 'capacity-admission-secret';
const DERIVATION = 'capacity-admission-derivation';
const MAX = 3;

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
  maxSessions: MAX,
  idleTimeoutMs: 60_000,
  maxSessionMs: 120_000,
};

const sessionId = (index: number): string => `sess-aaaaaaaaaaaa${index.toString(16).padStart(4, '0')}`;
const refFor = (id: string): string =>
  deriveSandboxRef({ sessionId: id, secret: DERIVATION, prefix: CONTAINER_SANDBOX_PREFIX });

function snapshotFor(id: string): SandboxSnapshot {
  return {
    state: 'running',
    user: 'student',
    workdir: '/home/student',
    labels: {
      [MANAGED_LABEL]: 'true',
      [RUNTIME_OWNER_LABEL]: 'jumptotech',
      [SESSION_LABEL]: id,
      [LAB_LABEL]: 'LINUX-001',
    },
  };
}

function fakePty(): BrokerPty & { killed: boolean } {
  return {
    killed: false,
    write: () => undefined,
    resize: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    pendingInputBytes: () => 0,
    kill() {
      this.killed = true;
    },
    onData: () => undefined,
    onExit: () => undefined,
  };
}

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
});

async function start(count: number, inspectGate?: () => Promise<void>) {
  const containers: Record<string, SandboxSnapshot> = {};
  for (let i = 0; i < count; i += 1) containers[refFor(sessionId(i))] = snapshotFor(sessionId(i));
  const ptys: ReturnType<typeof fakePty>[] = [];
  const server = createSandboxd({
    config,
    inspector: {
      inspect: async (ref) => {
        await inspectGate?.();
        return containers[ref] ?? null;
      },
    },
    spawn: () => {
      const pty = fakePty();
      ptys.push(pty);
      return pty;
    },
    log: () => undefined,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/v1/attach`, ptys };
}

/** Attach one session and resolve with its first `attached` or `error` frame. */
async function attach(url: string, id: string): Promise<Record<string, unknown>> {
  const ws = new WebSocket(url, { headers: { 'x-internal-secret': SECRET + '-attach' } });
  sockets.push(ws);
  const frame = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no attached/error frame')), 8_000);
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type !== 'attached' && message.type !== 'error') return;
      clearTimeout(timer);
      resolve(message);
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ type: 'attach', sessionId: id, cols: 80, rows: 24 }));
  return frame;
}

describe('the broker shell ceiling under a simultaneous class', () => {
  it('never spawns more PTYs than maxSessions, however many attach at once', async () => {
    // Every inspect waits on this, so all ten attaches are in flight together.
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve as () => void;
    });
    const { url, ptys } = await start(10, () => gate);

    const frames = Promise.all(Array.from({ length: 10 }, (_, i) => attach(url, sessionId(i))));
    // Let every attach reach the inspect before any of them finishes.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const answers = await frames;

    expect(ptys.filter((pty) => !pty.killed)).toHaveLength(MAX);
    expect(answers.filter((frame) => frame.type === 'attached')).toHaveLength(MAX);
    expect(answers.filter((frame) => frame.code === 'BROKER_AT_CAPACITY')).toHaveLength(10 - MAX);
  }, 30_000);

  it('lets a session reattach while the broker is full, because that replaces its shell', async () => {
    const { url, ptys } = await start(MAX + 1);
    for (let i = 0; i < MAX; i += 1) {
      expect(await attach(url, sessionId(i))).toMatchObject({ type: 'attached' });
    }
    expect(ptys.filter((pty) => !pty.killed)).toHaveLength(MAX);

    // The same session again: its shell is replaced, so the count is unchanged.
    expect(await attach(url, sessionId(0))).toMatchObject({ type: 'attached' });
    expect(ptys.filter((pty) => !pty.killed)).toHaveLength(MAX);

    // A session that holds none is refused while the others are open.
    expect(await attach(url, sessionId(MAX))).toMatchObject({ code: 'BROKER_AT_CAPACITY' });
  }, 30_000);
});
