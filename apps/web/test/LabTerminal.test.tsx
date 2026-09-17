/**
 * What the real terminal component puts on the wire, and when.
 *
 * xterm cannot lay out in jsdom, so the emulator and its fit addon are
 * stand-ins that behave like the real ones where it matters: `fit()` changes
 * the size and fires `onResize` synchronously. The WebSocket is a stand-in the
 * test drives. Everything else is the shipped component.
 *
 * PR #37 CI: a student re-opening a workspace had the socket open before the
 * layout settled. `onopen` fitted xterm, xterm fired `onResize` synchronously,
 * and the component put `resize` on the wire *before* `auth` (trace frames:
 * resize 102x23, then auth). The service closed it with "First message must be
 * an auth frame." and the terminal stayed "Connection to the terminal was
 * lost." The first test below reproduces exactly that order without the fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const xterm = vi.hoisted(() => ({
  terms: [] as {
    cols: number;
    rows: number;
    resizeListeners: ((size: { cols: number; rows: number }) => void)[];
    setSize(cols: number, rows: number): void;
  }[],
  /** The size the next `fit()` settles on. */
  fitTo: { cols: 80, rows: 24 },
}));

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    resizeListeners: ((size: { cols: number; rows: number }) => void)[] = [];
    constructor() {
      xterm.terms.push(this);
    }
    setSize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      for (const listener of this.resizeListeners) listener({ cols, rows });
    }
    loadAddon(addon: { activate?: (term: Terminal) => void }) {
      addon.activate?.(this);
    }
    open() {}
    attachCustomKeyEventHandler() {}
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resizeListeners.push(listener);
      return { dispose: () => undefined };
    }
    onData() {
      return { dispose: () => undefined };
    }
    write() {}
    writeln() {}
    focus() {}
    clear() {}
    dispose() {}
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    private term: { setSize(cols: number, rows: number): void } | null = null;
    activate(term: { setSize(cols: number, rows: number): void }) {
      this.term = term;
    }
    fit() {
      this.term?.setSize(xterm.fitTo.cols, xterm.fitTo.rows);
    }
  }
  return { FitAddon };
});

vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  serverOpens() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  serverSends(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const { LabTerminal } = await import('../src/components/LabTerminal');

beforeEach(() => {
  xterm.terms.length = 0;
  xterm.fitTo = { cols: 80, rows: 24 };
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const onEvent = vi.fn();
  render(<LabTerminal grant={{ url: 'ws://terminal.test', token: 'signed.token' }} onEvent={onEvent} />);
  const socket = FakeSocket.all.at(-1)!;
  return { socket, term: xterm.terms.at(-1)!, onEvent };
}

describe('LabTerminal handshake', () => {
  it('sends nothing but auth until the service says ready, then sends the size the layout settled on', () => {
    const { socket, term } = mount();

    xterm.fitTo = { cols: 100, rows: 30 };
    act(() => socket.serverOpens());
    expect(socket.sent).toEqual([{ type: 'auth', token: 'signed.token', cols: 100, rows: 30 }]);

    // The layout settles while the service is still attaching.
    xterm.fitTo = { cols: 132, rows: 40 };
    act(() => term.setSize(132, 40));
    expect(socket.sent.map((frame) => frame.type)).toEqual(['auth']);

    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));
    expect(socket.sent.slice(1)).toEqual([{ type: 'resize', cols: 132, rows: 40 }]);
  });

  it('sends no resize on ready when nothing changed since auth', () => {
    const { socket } = mount();
    act(() => socket.serverOpens());
    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));
    expect(socket.sent.map((frame) => frame.type)).toEqual(['auth']);
  });

  it('forwards resizes as they happen once connected', () => {
    const { socket, term, onEvent } = mount();
    act(() => socket.serverOpens());
    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));
    expect(onEvent).toHaveBeenLastCalledWith({ status: 'connected' });

    act(() => term.setSize(90, 28));
    expect(socket.sent.at(-1)).toEqual({ type: 'resize', cols: 90, rows: 28 });
  });
});

describe('LabTerminal close reasons', () => {
  it('does not blame a later network drop on a refusal that left the socket open', () => {
    const { socket, onEvent } = mount();
    act(() => socket.serverOpens());
    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));

    // A paste over the frame limit: shown, and the socket stays open.
    act(() => socket.serverSends({ type: 'error', code: 'FRAME_TOO_LARGE', message: 'input payload is too large' }));
    // Later the network drops.
    act(() => socket.onclose?.({ code: 1006 }));

    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disconnected', code: 'CONNECTION_LOST' }));
  });

  it('still reports the code the service named before it closed', () => {
    const { socket, onEvent } = mount();
    act(() => socket.serverOpens());
    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));
    act(() => socket.serverSends({ type: 'error', code: 'FRAME_TOO_LARGE', message: 'input payload is too large' }));
    act(() => socket.serverSends({ type: 'error', code: 'SESSION_ENDED', message: 'ended' }));
    act(() => socket.onclose?.({ code: 4410 }));

    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disconnected', code: 'SESSION_ENDED' }));
  });
});
