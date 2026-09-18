/**
 * BETA-P0-005 — typing in the terminal is lab-session activity.
 *
 * The gap: `lastActivityAt` only moved on REST actions (Continue, Check, Reset).
 * A student working purely in the shell never touched it, so the reaper judged
 * an environment in active use to be idle and collected it.
 *
 * ```text
 *   ws input ──► terminal service ──internal secret + uid──► real API
 *                                                            └─► SessionStore.touchActivity
 * ```
 *
 * Every boundary that carries the fix is real here: a real terminal server, the
 * real API app with its real internal router and session manager, and a real
 * `sandboxd` broker. The only fakes are the PTY at the far end and the
 * container inventory it answers from — a container runtime is exactly what a
 * unit suite must not need — and a store wrapper that counts writes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { LabSession } from '@jumptotech/lab-orchestrator';
import {
  OWNER_A,
  OWNER_B,
  authenticate,
  bringUpStack,
  eventually,
  open,
  settle,
  tearDownStacks,
  tokenFor,
  type Stack,
} from './support/broker-stack.js';

/** Well inside the idle budget, and unmistakably not "now". */
const PAST = () => new Date(Date.now() - 10 * 60_000).toISOString();

afterEach(tearDownStacks);

async function lastActivity(stack: Stack, session: LabSession): Promise<string | undefined> {
  return (await stack.manager.get(session.sessionId))?.lastActivityAt;
}

describe('terminal input is lab-session activity', () => {
  it('advances the session’s activity timestamp from typing alone', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });

    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    expect(first.type).toBe('ready');
    // Opening the terminal is not the student doing anything.
    await settle();
    expect(await lastActivity(stack, stack.a)).toBe(past);
    expect(stack.store.touches).toEqual([]);

    // Input, and nothing else: no Continue, no Check, no other API call.
    ws.send(JSON.stringify({ type: 'input', data: 'ls -la\r' }));

    const advanced = await eventually(async () => {
      const at = await lastActivity(stack, stack.a);
      return at !== past ? at : undefined;
    });
    expect(Date.parse(advanced)).toBeGreaterThan(Date.parse(past));
    // Idle deadline only; the absolute one is never moved by activity.
    expect((await stack.manager.get(stack.a.sessionId))?.expiresAt).toBe(stack.a.expiresAt);
    expect(stack.ptys[0]!.written).toEqual(['ls -la\r']);
  });

  it('writes once per window under sustained typing, not once per keystroke', async () => {
    const stack = await bringUpStack({ activityReportIntervalMs: 400 });
    const { ws } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));

    const burstStartedAt = Date.now();
    for (const ch of 'kubectl get pods --all-namespaces -o wide\r') {
      ws.send(JSON.stringify({ type: 'input', data: ch }));
    }
    await eventually(() => stack.ptys[0]!.written.length === 42);
    await settle(100);
    // Every keystroke reached the shell; one of them reached the database.
    expect(stack.store.touches).toEqual([stack.a.sessionId]);

    // Still typing once the window has passed: the session is refreshed again.
    await settle(Math.max(0, 450 - (Date.now() - burstStartedAt)));
    ws.send(JSON.stringify({ type: 'input', data: 'x' }));
    ws.send(JSON.stringify({ type: 'input', data: 'y' }));
    await eventually(() => stack.store.touches.length === 2);
    await settle(100);
    expect(stack.store.touches).toEqual([stack.a.sessionId, stack.a.sessionId]);
  });

  it('never moves another session’s clock', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });
    await stack.store.update(stack.b.sessionId, { lastActivityAt: past });

    // Both students connected; only A types.
    const a = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    const b = await authenticate(stack.terminalUrl, tokenFor(stack.b, OWNER_B));
    expect(a.first.type).toBe('ready');
    expect(b.first.type).toBe('ready');

    a.ws.send(JSON.stringify({ type: 'input', data: 'whoami\r' }));
    await eventually(async () => (await lastActivity(stack, stack.a)) !== past);
    await settle();

    expect(await lastActivity(stack, stack.b)).toBe(past);
    expect(stack.store.touches).toEqual([stack.a.sessionId]);
  });

  it('records nothing for a token whose owner does not own the session', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });

    // Correctly signed, A's session, B's owner: the API refuses the attach.
    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_B));
    expect(first.type).toBe('error');
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));
    await settle();

    expect(stack.ptys).toHaveLength(0);
    expect(stack.store.touches).toEqual([]);
    expect(await lastActivity(stack, stack.a)).toBe(past);
  });

  it('records nothing for unauthenticated or forged traffic', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });

    // Typing before authenticating.
    const early = await open(stack.terminalUrl);
    early.ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));
    expect((await eventually(() => early.frames.find((f) => f.type === 'error'))).code).toBe(
      'UNAUTHENTICATED',
    );

    // A token for A signed with the wrong secret, followed by input.
    const forged = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A, 'not-the-terminal-secret'));
    expect(forged.first.code).toBe('UNAUTHORIZED');
    if (forged.ws.readyState === WebSocket.OPEN) {
      forged.ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));
    }
    await settle();

    expect(stack.store.touches).toEqual([]);
    expect(await lastActivity(stack, stack.a)).toBe(past);
  });

  it('does not count connecting, resizing, keep-alive pings or disconnecting', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });

    const { ws, frames } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }));
    ws.send(JSON.stringify({ type: 'ping' }));
    await eventually(() => frames.some((f) => f.type === 'pong'));
    ws.close();
    await settle();

    expect(stack.store.touches).toEqual([]);
    expect(await lastActivity(stack, stack.a)).toBe(past);
  });

  it('keeps the shell working when the activity write fails', async () => {
    const stack = await bringUpStack();
    stack.store.failTouches = true;

    const { ws, frames } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    ws.send(JSON.stringify({ type: 'input', data: 'echo hi\r' }));
    await eventually(() => stack.store.touches.length === 1);

    // The failure is not retried per keystroke: the window still applies.
    ws.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
    await eventually(() => stack.ptys[0]!.written.length === 2);
    await settle();
    expect(stack.store.touches).toHaveLength(1);

    // And the terminal is untouched: input arrived, output comes back.
    expect(stack.ptys[0]!.written).toEqual(['echo hi\r', 'pwd\r']);
    stack.ptys[0]!.emit('hi\r\n');
    await eventually(() => frames.some((f) => f.type === 'output' && f.data === 'hi\r\n'));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(frames.some((f) => f.type === 'error')).toBe(false);
  });
});
