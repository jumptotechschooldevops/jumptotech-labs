/**
 * Five students, many lifecycles, nothing left behind — a bounded churn run.
 *
 * Every hop is real and in-process: the api (session manager, internal
 * credential route), the terminal service and sandboxd, with a fake container
 * runtime and fake PTYs. Five students run concurrently; each repeats, a
 * bounded number of times, Start → attach → a second tab taking over → a
 * dropped socket and a reconnect → (sometimes) Reset with the shell
 * reattached → End with the shell terminated, and checks isolation on the way.
 *
 * What it looks for is state that outlives its owner: a shell the relays still
 * hold, a PTY never killed, a slot never released. After the run every
 * counter the services expose must be back to zero, and every PTY sandboxd
 * ever spawned must have been killed. Bounded by iteration count and by the
 * test timeout; no real container, no real host process.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LAB_LABEL,
  LabRegistry,
  LinuxLabProvider,
  MANAGED_LABEL,
  ProviderRegistry,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  SessionManager,
  issueSessionToken,
  type LabSession,
  type OutputFlowOptions,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '@jumptotech/api';
import { loadConfig } from '@jumptotech/api/config';
import { createSandboxd, type BrokerPty } from '@jumptotech/sandboxd/server';
import { defaultObservabilityConfig, type SandboxdConfig } from '@jumptotech/sandboxd/config';
import type { SandboxSnapshot } from '@jumptotech/sandboxd/attach';
import { loadTerminalConfig } from '../src/config.js';
import { createTerminalServer } from '../src/server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const TERMINAL_SECRET = 'lifecycle-churn-session-secret';
const INTERNAL_SECRET = 'lifecycle-churn-internal-secret';
const DERIVATION = 'lifecycle-churn-derivation-secret';
const RUNTIME_OWNER = 'jumptotech';


const STUDENTS = 5;
const CYCLES = Number(process.env.JTT_CHURN_CYCLES ?? '6');

interface CountingPty extends BrokerPty {
  sessionId: string;
  killed: boolean;
  input: string;
}

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
}, 60_000);

const closables: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of closables.splice(0)) server.close();
});

async function listen(server: Server): Promise<number> {
  closables.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function bringUpStack() {
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
  } as NodeJS.ProcessEnv);

  // The terminal is not listening yet when the manager is built; End and
  // Reset reach it through this, as the api's HTTP terminal control does.
  let terminalControlUrl = '';
  const control = async (action: 'terminate' | 'reattach', sessionId: string) => {
    const res = await fetch(`${terminalControlUrl}/internal/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) throw new Error(`terminal ${action} replied ${res.status}`);
  };
  const store = new InMemorySessionStore();
  const manager = new SessionManager({
    registry,
    providers,
    store,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: DERIVATION,
    terminal: {
      terminate: (sessionId) => control('terminate', sessionId),
      reattach: (sessionId) => control('reattach', sessionId),
    },
  });
  const apiPort = await listen(
    createServer(createApp({ registry, sessions: manager, k8s: new FakeKubernetes(), config })),
  );

  const ptys: CountingPty[] = [];
  const brokerConfig: SandboxdConfig = {
    observability: defaultObservabilityConfig('sandboxd', 0),
    port: 0,
    bindAddress: '127.0.0.1',
    scopeSecrets: {
      attach: `${INTERNAL_SECRET}-attach`,
      runtime: `${INTERNAL_SECRET}-runtime`,
      docker: `${INTERNAL_SECRET}-docker`,
    },
    derivationSecret: DERIVATION,
    runtimeOwner: RUNTIME_OWNER,
    containerBinary: 'docker',
    shell: '/bin/bash',
    docker: null,
    sandboxUser: 'student',
    sandboxHome: '/home/student',
    maxSessions: 8,
    idleTimeoutMs: 60_000,
    maxSessionMs: 120_000,
  };
  const brokerPort = await listen(
    createSandboxd({
      config: brokerConfig,
      // Answers from the live session rows, so a finished session's sandbox is gone.
      inspector: {
        inspect: async (ref): Promise<SandboxSnapshot | null> => {
          const session = (await manager.list()).find((s) => s.sandboxRef === ref);
          if (!session || !['ACTIVE', 'RESETTING'].includes(session.status)) return null;
          return {
            state: 'running',
            user: 'student',
            workdir: '/home/student',
            labels: {
              [MANAGED_LABEL]: 'true',
              [RUNTIME_OWNER_LABEL]: RUNTIME_OWNER,
              [SESSION_LABEL]: session.sessionId,
              [LAB_LABEL]: session.labId,
            },
          };
        },
      },
      spawn: (_command, args) => {
        const sessionRef = args.find((a) => a.startsWith('jtt-lab-')) ?? '';
        let onExit: (event: { exitCode: number }) => void = () => undefined;
        const pty: CountingPty = {
          sessionId: sessionRef,
          killed: false,
          input: '',
          write(data) {
            pty.input += data;
          },
          resize() {},
          pause() {},
          resume() {},
          pendingInputBytes: () => 0,
          kill() {
            if (pty.killed) return;
            pty.killed = true;
            onExit({ exitCode: 0 });
          },
          onData() {},
          onExit(listener) {
            onExit = listener;
          },
        };
        ptys.push(pty);
        return pty;
      },
      log: () => undefined,
    }),
  );

  const terminalConfig = loadTerminalConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    SANDBOX_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
    SANDBOXD_ATTACH_SECRET: `${INTERNAL_SECRET}-attach`,
    TERMINAL_SANDBOX_BROKER_ENABLED: 'true',
    TERMINAL_CONTAINER_EXEC_ENABLED: 'false',
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);
  const terminalPort = await listen(createTerminalServer(terminalConfig));
  terminalControlUrl = `http://127.0.0.1:${terminalPort}`;

  return {
    manager,
    ptys,
    terminalUrl: `ws://127.0.0.1:${terminalPort}/terminal`,
    terminalHealth: `http://127.0.0.1:${terminalPort}/health`,
    brokerHealth: `http://127.0.0.1:${brokerPort}/health`,
  };
}

function tokenFor(session: LabSession, ownerUserId: string): string {
  return issueSessionToken({
    sessionId: session.sessionId,
    ownerUserId,
    labId: session.labId,
    namespace: session.sandboxRef!,
    secret: TERMINAL_SECRET,
    ttlSeconds: 300,
  }).token;
}

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

async function connect(url: string, token: string): Promise<Client> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
  return { ws, frames, closed };
}

async function ready(client: Client): Promise<void> {
  await eventually(() => client.frames.find((f) => f.type === 'ready' || f.type === 'error'));
  const refusal = client.frames.find((f) => f.type === 'error');
  if (refusal) throw new Error(`attach refused: ${String(refusal.code)}`);
}

async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function health(url: string): Promise<Record<string, unknown>> {
  return (await (await fetch(url)).json()) as Record<string, unknown>;
}

/** Deterministic per student and cycle, so a failure replays. */
const doesReset = (student: number, cycle: number) => (student + cycle) % 3 === 0;

describe('five students, repeated lifecycles', () => {
  it(`leaves no shell, PTY or slot behind after ${STUDENTS} × ${CYCLES} lifecycles`, async () => {
    const stack = await bringUpStack();
    const stats = { lifecycles: 0, attaches: 0, supersededTabs: 0, drops: 0, resets: 0, reattached: 0 };

    const student = async (index: number) => {
      const owner = `usr-${String(index + 1).padStart(8, '0')}`;
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        const { session } = await stack.manager.start('LINUX-001', owner);
        const token = tokenFor(session, owner);

        // First tab.
        const first = await connect(stack.terminalUrl, token);
        await ready(first);
        stats.attaches += 1;

        // A second tab takes the terminal over; the first is closed for it.
        const second = await connect(stack.terminalUrl, token);
        await ready(second);
        stats.attaches += 1;
        await first.closed;
        stats.supersededTabs += 1;

        // The second tab's network drops; the student reconnects.
        second.ws.terminate();
        await second.closed;
        stats.drops += 1;
        const third = await connect(stack.terminalUrl, token);
        await ready(third);
        stats.attaches += 1;

        if (doesReset(index, cycle)) {
          const reattached = eventually(() => third.frames.find((f) => f.type === 'reattached'));
          const { result } = await stack.manager.reset(session.sessionId);
          expect(result.ok).toBe(true);
          stats.resets += 1;
          await reattached;
          stats.reattached += 1;
        }

        // Typed into whichever shell the socket now has (a Reset replaced it).
        third.ws.send(JSON.stringify({ type: 'input', data: `echo ${owner} ${cycle}\r` }));

        // Only this student's input reached this student's shell.
        await eventually(() =>
          stack.ptys.some((p) => !p.killed && p.sessionId === session.sandboxRef && p.input.includes(`${owner} ${cycle}`)),
        );
        for (const pty of stack.ptys) {
          if (pty.sessionId !== session.sandboxRef) expect(pty.input.includes(`${owner} ${cycle}`)).toBe(false);
        }

        // End: the shell is terminated and the socket told why.
        const ended = await stack.manager.end(session.sessionId);
        expect(ended.session.status).toBe('ENDED');
        expect(await third.closed).toBe(4410);
        stats.lifecycles += 1;
      }
    };

    await Promise.all(Array.from({ length: STUDENTS }, (_, i) => student(i)));

    // Nothing outlived its owner.
    await eventually(async () => (await health(stack.terminalHealth)).data && ((await health(stack.terminalHealth)).data as { activeSessions: number }).activeSessions === 0);
    await eventually(async () => (await health(stack.brokerHealth)).shells === 0);
    await eventually(() => stack.ptys.every((p) => p.killed));
    expect(await stack.manager.activeCount()).toBe(0);
    expect(stats.lifecycles).toBe(STUDENTS * CYCLES);
    expect(stats.reattached).toBe(stats.resets);
    // Every attach, reattach and takeover spawned exactly one PTY.
    expect(stack.ptys.length).toBe(stats.attaches + stats.reattached);
    // eslint-disable-next-line no-console
    console.log(`churn: ${JSON.stringify({ ...stats, ptys: stack.ptys.length })}`);
  }, 240_000);
});
