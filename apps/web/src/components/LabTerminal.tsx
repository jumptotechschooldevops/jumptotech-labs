/**
 * xterm.js terminal bound to the terminal service over a WebSocket.
 *
 * There is no simulation here: keystrokes go to a real PTY and everything
 * rendered is bytes that process produced. This component owns one connection
 * at a time and reports what happened to it; *whether* to reconnect is the
 * workspace's decision, because only the workspace knows the session's state.
 *
 * ## What a disconnect means
 *
 * The terminal service names a code in an `error` frame before it closes a
 * socket on purpose; `codeForClose` (lib/terminal.ts) folds that and the close
 * code into one `code`, so the workspace can tell "your lab ended" from "the
 * network blinked".
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { codeForClose } from '../lib/terminal';
import type { TerminalGrant } from '../lib/types';

export type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface TerminalEvent {
  status: TerminalStatus;
  /** Why it disconnected — see the table above. */
  code?: string;
  message?: string;
  /** True for a `reattached` frame: same socket, new shell after a reset. */
  reattached?: boolean;
}

export interface LabTerminalHandle {
  clear: () => void;
  focus: () => void;
  writeNotice: (text: string) => void;
}

interface LabTerminalProps {
  /** Where to connect, and the token to present. Null means "stay disconnected". */
  grant: TerminalGrant | null;
  /**
   * Bump to force a fresh connection with the current grant.
   *
   * A container-backed Reset replaces the sandbox, which ends the shell that
   * was attached to the old one; a Reconnect after a dropped socket does the
   * same. The terminal service resolves the session's *current* sandbox from
   * the token — the browser still names nothing.
   */
  connectKey?: number;
  onEvent: (event: TerminalEvent) => void;
}

const THEME = {
  background: '#0b1020',
  foreground: '#d7e0f2',
  cursor: '#3ddc97',
  cursorAccent: '#0b1020',
  selectionBackground: '#26365e',
  black: '#0b1020',
  red: '#ff6b6b',
  green: '#3ddc97',
  yellow: '#ffd166',
  blue: '#4dabf7',
  magenta: '#c792ea',
  cyan: '#41d6c3',
  white: '#d7e0f2',
} as const;

export const LabTerminal = forwardRef<LabTerminalHandle, LabTerminalProps>(function LabTerminal(
  { grant, connectKey = 0, onEvent },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  // Keep the latest callback without re-running the connection effect.
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;

  useImperativeHandle(
    ref,
    () => ({
      clear: () => termRef.current?.clear(),
      focus: () => termRef.current?.focus(),
      writeNotice: (text: string) => termRef.current?.writeln(`\r\n\x1b[36m${text}\x1b[0m`),
    }),
    [],
  );

  // --- create the xterm instance once -------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.3,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    /*
     * Shift+Tab leaves the terminal.
     *
     * A shell needs Tab for completion, so the terminal must keep it — which on
     * its own would trap a keyboard user inside. Returning false hands
     * Shift+Tab back to the browser, whose default moves focus to the previous
     * control. The terminal bar tells students this.
     */
    term.attachCustomKeyEventHandler((event) => !(event.key === 'Tab' && event.shiftKey));

    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* container not laid out yet */
      }
    });

    termRef.current = term;
    fitRef.current = fit;

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore transient zero-size */
      }
    });
    observer.observe(containerRef.current);

    // Push terminal size to the PTY whenever xterm re-flows.
    const resize = term.onResize(({ cols, rows }) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    return () => {
      resize.dispose();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // --- connect when there is a grant --------------------------------------
  const url = grant?.url ?? null;
  const token = grant?.token ?? null;

  useEffect(() => {
    if (!url || !token) {
      eventRef.current({ status: 'idle' });
      return;
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    let serverCode: string | undefined;
    let serverMessage: string | undefined;

    const connect = () => {
      if (cancelled) return;
      const term = termRef.current;
      if (!term) {
        requestAnimationFrame(connect);
        return;
      }

      eventRef.current({ status: 'connecting' });
      socket = new WebSocket(`${url.replace(/\/$/, '')}/terminal`);
      socketRef.current = socket;

      socket.onopen = () => {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
        socket!.send(JSON.stringify({ type: 'auth', token, cols: term.cols, rows: term.rows }));
      };

      socket.onmessage = (event) => {
        if (cancelled) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        switch (msg.type) {
          case 'ready':
            try {
              fitRef.current?.fit();
            } catch {
              /* ignore */
            }
            inputDisposable?.dispose();
            inputDisposable = term.onData((data) => {
              if (socket!.readyState === WebSocket.OPEN) {
                socket!.send(JSON.stringify({ type: 'input', data }));
              }
            });
            if (keepAlive) clearInterval(keepAlive);
            keepAlive = setInterval(() => {
              if (socket!.readyState === WebSocket.OPEN) socket!.send(JSON.stringify({ type: 'ping' }));
            }, 30_000);
            eventRef.current({ status: 'connected' });
            term.focus();
            break;

          case 'reattached':
            term.writeln('\r\n\x1b[36mEnvironment reset — connected to a fresh shell.\x1b[0m');
            eventRef.current({ status: 'connected', reattached: true });
            break;

          case 'output':
            termRef.current?.write(String(msg.data ?? ''));
            break;

          case 'error': {
            serverCode = typeof msg.code === 'string' ? msg.code : serverCode;
            serverMessage = String(msg.message ?? 'Terminal error');
            // SESSION_ENDED is also what the terminal service sends this socket
            // when the same session's terminal is opened in another tab — one
            // shell per session. Its "the lab has ended" text would be false
            // then, so the workspace works out which case it is from the
            // session state and says so in the terminal bar.
            term.writeln(
              `\r\n\x1b[31m${serverCode === 'SESSION_ENDED' ? 'The terminal was disconnected.' : serverMessage}\x1b[0m`,
            );
            break;
          }

          case 'exit':
            term.writeln(`\r\n\x1b[33mThe shell exited (code ${String(msg.exitCode ?? '?')}).\x1b[0m`);
            serverCode = serverCode ?? 'SHELL_EXITED';
            break;

          default:
            break;
        }
      };

      socket.onclose = (event) => {
        inputDisposable?.dispose();
        inputDisposable = null;
        if (keepAlive) clearInterval(keepAlive);
        // Our own cleanup closed it: nothing happened that anyone needs to hear.
        if (cancelled) return;
        eventRef.current({
          status: 'disconnected',
          code: codeForClose(event.code, serverCode),
          ...(serverMessage ? { message: serverMessage } : {}),
        });
      };
    };

    connect();

    return () => {
      cancelled = true;
      inputDisposable?.dispose();
      if (keepAlive) clearInterval(keepAlive);
      socketRef.current = null;
      socket?.close(1000, 'component unmounted');
    };
  }, [url, token, connectKey]);

  const handleClick = useCallback(() => termRef.current?.focus(), []);

  return <div className="terminal-surface" ref={containerRef} onClick={handleClick} />;
});
