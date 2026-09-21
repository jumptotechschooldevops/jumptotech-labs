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
    type(data: string): void;
    written: string[];
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
    dataListeners = new Set<(data: string) => void>();
    written: string[] = [];
    onData(listener: (data: string) => void) {
      this.dataListeners.add(listener);
      return { dispose: () => this.dataListeners.delete(listener) };
    }
    /** What a keystroke or a paste does: every current onData listener hears it. */
    type(data: string) {
      for (const listener of [...this.dataListeners]) listener(data);
    }
    write() {}
    writeln(text: string) {
      this.written.push(text);
    }
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

const GRANT = { url: 'ws://terminal.test', token: 'signed.token' };

function mount() {
  const onEvent = vi.fn();
  const view = render(<LabTerminal grant={GRANT} onEvent={onEvent} />);
  const socket = FakeSocket.all.at(-1)!;
  /** What the workspace does after a container Reset: same grant, a fresh connection. */
  const reconnect = (connectKey: number) => {
    view.rerender(<LabTerminal grant={GRANT} connectKey={connectKey} onEvent={onEvent} />);
    return FakeSocket.all.at(-1)!;
  };
  return { socket, term: xterm.terms.at(-1)!, onEvent, reconnect };
}

const inputs = (socket: FakeSocket) =>
  socket.sent.filter((frame) => frame.type === 'input').map((frame) => frame.data as string).join('');

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

  it('writes words for the code into the terminal, never the service\'s raw exception text', () => {
    const { socket, onEvent } = mount();
    act(() => socket.serverOpens());
    // What the terminal service really sends when the credentials fetch fails:
    // the fetch error's message, passed through (services/terminal/src/credentials.ts).
    act(() =>
      socket.serverSends({
        type: 'error',
        code: 'CREDENTIALS_UNAVAILABLE',
        message: 'Could not reach the lab API to obtain session credentials: connect ECONNREFUSED 172.18.0.4:4000',
      }),
    );
    act(() => socket.onclose?.({ code: 4403 }));

    const written = xterm.terms[0]!.written.join('\n');
    expect(written).toContain('The terminal could not attach to your environment.');
    expect(written).not.toMatch(/ECONNREFUSED|172\.18|lab API|credentials/);
    // The workspace still learns the code, which is what decides a retry.
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'disconnected', code: 'CREDENTIALS_UNAVAILABLE' }),
    );
  });

  it('says something neutral for a code it does not know', () => {
    const { socket } = mount();
    act(() => socket.serverOpens());
    act(() => socket.serverSends({ type: 'error', code: 'SOMETHING_NEW', message: 'Error: spawn /usr/bin/docker ENOENT' }));

    const written = xterm.terms[0]!.written.join('\n');
    expect(written).toContain('The terminal connection was interrupted.');
    expect(written).not.toMatch(/ENOENT|docker/);
  });
});

/*
 * Keystrokes typed while a connection is being set up.
 *
 * Measured in the browser against the real stack (2026-09-17): after Reset the
 * page reconnects, and a student who starts typing as soon as the dialog
 * closes types into a socket that is open but not yet `ready`. The component
 * listened for keystrokes only from `ready`, so everything before it was
 * dropped without a trace: `echo EARLY…-$((6*7))` reached the shell as
 * `((6*7))`. The same gap exists on every first connect and reconnect.
 */
describe('LabTerminal input typed while connecting', () => {
  it('delivers keystrokes typed before ready, in order, once the shell is ready — and never before auth', () => {
    const { socket, term } = mount();
    act(() => term.type('ec'));
    act(() => socket.serverOpens());
    act(() => term.type('ho hi'));
    expect(socket.sent.map((frame) => frame.type)).toEqual(['auth']);

    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));
    act(() => term.type('\r'));

    expect(socket.sent[0]).toMatchObject({ type: 'auth' });
    expect(inputs(socket)).toBe('echo hi\r');
  });

  it('delivers a line typed during the reconnect after a Reset to the new shell, not the old socket', () => {
    const { socket: first, term, reconnect } = mount();
    act(() => first.serverOpens());
    act(() => first.serverSends({ type: 'ready', sessionId: 'sess-a' }));
    act(() => term.type('ls\r'));

    // The reset killed the old shell; the service closed that socket.
    act(() => first.serverSends({ type: 'exit', exitCode: 137 }));
    act(() => first.onclose?.({ code: 1000 }));
    const second = reconnect(1);
    act(() => second.serverOpens());
    act(() => term.type('whoami\r'));
    act(() => second.serverSends({ type: 'ready', sessionId: 'sess-a' }));

    expect(inputs(first)).toBe('ls\r');
    expect(inputs(second)).toBe('whoami\r');
  });

  it('does not replay input from a connection attempt that was refused into the next one', () => {
    const { socket: first, term, reconnect } = mount();
    act(() => first.serverOpens());
    act(() => term.type('rm -rf ~/project\r'));
    act(() => first.serverSends({ type: 'error', code: 'CREDENTIALS_UNAVAILABLE', message: 'no' }));
    act(() => first.onclose?.({ code: 4403 }));

    const second = reconnect(1);
    act(() => second.serverOpens());
    act(() => second.serverSends({ type: 'ready', sessionId: 'sess-a' }));

    expect(inputs(first)).toBe('');
    expect(inputs(second)).toBe('');
  });

  it('holds a bounded amount, sends it in frames the service accepts, and says what it dropped', () => {
    const { socket, term } = mount();
    act(() => socket.serverOpens());
    const paste = 'x'.repeat(20_000);
    act(() => term.type(paste));
    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));

    const frames = socket.sent.filter((frame) => frame.type === 'input');
    expect(frames.length).toBeGreaterThan(0);
    // services/terminal/src/protocol.ts MAX_INPUT_CHARS
    for (const frame of frames) expect((frame.data as string).length).toBeLessThanOrEqual(8 * 1024);
    const delivered = inputs(socket);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(paste.length);
    expect(term.written.join('\n')).toMatch(/not sent/);
  });

  it('delivers a paste larger than one input frame whole, once connected', () => {
    // The service refuses an `input` frame over 8 KB (FRAME_TOO_LARGE), which
    // used to lose a pasted block outright.
    const { socket, term } = mount();
    act(() => socket.serverOpens());
    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));
    const paste = 'line of a pasted config file\n'.repeat(1_000);
    act(() => term.type(paste));

    const frames = socket.sent.filter((frame) => frame.type === 'input');
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect((frame.data as string).length).toBeLessThanOrEqual(8 * 1024);
    expect(inputs(socket)).toBe(paste);
  });

  it('never splits an emoji across input frames or at the bound', () => {
    const { socket, term } = mount();
    act(() => socket.serverOpens());
    // 2,047 ASCII characters put the frame and buffer boundaries inside each 😀.
    const paste = `${'a'.repeat(2047)}${'😀'.repeat(2048)}`;
    act(() => term.type(paste));
    act(() => socket.serverSends({ type: 'ready', sessionId: 'sess-a' }));

    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const frame of socket.sent.filter((f) => f.type === 'input')) {
      expect(lone.test(frame.data as string)).toBe(false);
    }
    expect(paste.startsWith(inputs(socket))).toBe(true);
  });
});
