/**
 * One shell per lab session, even when two attaches for it overlap.
 *
 * `startSession` closes the session's registered socket first, then awaits the
 * API and the broker. An attach that was still in flight at that moment was
 * not registered yet, so nothing closed it: two tabs opening together, or a
 * page reconnect overlapping an older attempt, each finished and registered.
 * The earlier socket kept a live shell that `bySessionId` no longer named — so
 * ending the lab (`/internal/terminate`) closed only the later one, and the
 * orphan held a PTY and a broker slot for a sandbox being torn down. The same
 * gap let an attach in flight when the lab ended register afterwards.
 *
 * The broker's inventory lookup is gated, so both attaches are provably in
 * flight together rather than hoped to be.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  OWNER_A,
  bringUpStack,
  eventually,
  open,
  sendAuth,
  settle,
  tearDownStacks,
  tokenFor,
} from './support/broker-stack.js';

afterEach(tearDownStacks);

/** Holds every broker attach at the inventory lookup until `release()`. */
function gate() {
  let waiting = 0;
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: async () => {
      waiting += 1;
      await opened;
    },
    waiting: () => waiting,
    release: () => release(),
  };
}

const kinds = (frames: Array<Record<string, unknown>>) => frames.map((f) => (f.type === 'error' ? `error:${String(f.code)}` : f.type));

describe('overlapping attaches for one session', () => {
  it('leaves exactly one live shell — the newest attach — and closes the other', async () => {
    const hold = gate();
    const stack = await bringUpStack({ inspectGate: hold.wait });
    const token = tokenFor(stack.a, OWNER_A);

    const older = await open(stack.terminalUrl);
    sendAuth(older, token);
    await eventually(() => hold.waiting() === 1);
    const newer = await open(stack.terminalUrl);
    sendAuth(newer, token);
    await eventually(() => hold.waiting() === 2);
    hold.release();

    await eventually(() => newer.frames.some((f) => f.type === 'ready'));
    expect(await older.closed).toBe(4410);
    expect(kinds(older.frames)).toEqual(['error:SESSION_ENDED']);
    expect(newer.ws.readyState).toBe(WebSocket.OPEN);

    // Every PTY the broker opened for the older attach was killed; one is live.
    await eventually(() => stack.ptys.filter((p) => !p.killed).length === 1);
    await settle();
    const live = stack.ptys.filter((p) => !p.killed);
    expect(live).toHaveLength(1);

    newer.ws.send(JSON.stringify({ type: 'input', data: 'whoami\r' }));
    await eventually(() => live[0]!.written.length === 1);
    expect(live[0]!.written).toEqual(['whoami\r']);
    expect(stack.ptys.filter((p) => p.killed).flatMap((p) => p.written)).toEqual([]);

    // Ending the lab now reaches the one shell there is.
    const response = await fetch(`${stack.terminalControlUrl}/internal/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': stack.internalSecret },
      body: JSON.stringify({ sessionId: stack.a.sessionId }),
    });
    expect(response.ok).toBe(true);
    expect(await newer.closed).toBe(4410);
    await eventually(() => stack.ptys.every((p) => p.killed));
  });

  it('does not register an attach that was still in flight when the lab ended', async () => {
    const hold = gate();
    const stack = await bringUpStack({ inspectGate: hold.wait });

    const socket = await open(stack.terminalUrl);
    sendAuth(socket, tokenFor(stack.a, OWNER_A));
    await eventually(() => hold.waiting() === 1);

    const response = await fetch(`${stack.terminalControlUrl}/internal/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': stack.internalSecret },
      body: JSON.stringify({ sessionId: stack.a.sessionId }),
    });
    expect(response.ok).toBe(true);
    hold.release();

    expect(await socket.closed).toBe(4410);
    expect(kinds(socket.frames)).toEqual(['error:SESSION_ENDED']);
    await settle();
    expect(stack.ptys.every((p) => p.killed)).toBe(true);
  });

  it('still lets a later attach take over a registered one, as a second tab does', async () => {
    const stack = await bringUpStack();
    const token = tokenFor(stack.a, OWNER_A);

    const first = await open(stack.terminalUrl);
    sendAuth(first, token);
    await eventually(() => first.frames.some((f) => f.type === 'ready'));
    const second = await open(stack.terminalUrl);
    sendAuth(second, token);
    await eventually(() => second.frames.some((f) => f.type === 'ready'));

    expect(await first.closed).toBe(4410);
    expect(kinds(first.frames)).toEqual(['ready', 'error:SESSION_ENDED']);
    await eventually(() => stack.ptys.filter((p) => !p.killed).length === 1);
    expect(stack.ptys[0]!.killed).toBe(true);
  });
});
