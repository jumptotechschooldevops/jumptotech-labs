/**
 * xterm.js terminal bound to the terminal service over a WebSocket.
 *
 * There is no simulation here: keystrokes go to a real PTY and everything
 * rendered is bytes that process produced.
 */
import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export interface LabTerminalHandle {
  clear: () => void;
  focus: () => void;
  writeNotice: (text: string) => void;
}

interface LabTerminalProps {
  /** WebSocket base URL of the terminal service, e.g. ws://localhost:4001 */
  url: string | null;
  /** Session token minted by POST /api/labs/:id/start. */
  token: string | null;
  /**
   * Bump to force a reconnection with the same session.
   *
   * A container-backed Reset replaces the sandbox, which ends the shell that
   * was attached to the old one. Changing this re-runs the connection effect,
   * and the terminal service resolves the session's *new* sandbox from the same
   * token — the browser still names nothing.
   */
  reconnectNonce?: number;
  onStatusChange: (status: TerminalStatus, detail?: string) => void;
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
  { url, token, reconnectNonce = 0, onStatusChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  // Keep the latest callback without re-running the connection effect.
  const statusCbRef = useRef(onStatusChange);
  statusCbRef.current = onStatusChange;

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
      fontFamily:
        '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    // Defer the first fit until the pane has its final size.
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

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Push terminal size to the PTY whenever xterm re-flows.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const disposable = term.onResize(({ cols, rows }) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
    return () => disposable.dispose();
  }, []);

  // --- connect when we have a url + token ---------------------------------
  useEffect(() => {
    if (!url || !token) return;
    const term = termRef.current;
    if (!term) return;

    statusCbRef.current('connecting');
    const socket = new WebSocket(`${url.replace(/\/$/, '')}/terminal`);
    socketRef.current = socket;

    let inputDisposable: { dispose: () => void } | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    socket.onopen = () => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      socket.send(
        JSON.stringify({ type: 'auth', token, cols: term.cols, rows: term.rows }),
      );
    };

    socket.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'ready':
          statusCbRef.current('connected');
          inputDisposable = term.onData((data) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'input', data }));
            }
          });
          keepAlive = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'ping' }));
            }
          }, 30_000);
          term.focus();
          break;

        case 'output':
          term.write(String(msg.data ?? ''));
          break;

        case 'error': {
          const detail = String(msg.message ?? 'Terminal error');
          term.writeln(`\r\n\x1b[31m✗ ${detail}\x1b[0m`);
          statusCbRef.current('error', detail);
          break;
        }

        case 'exit':
          term.writeln(`\r\n\x1b[33mShell exited (code ${String(msg.exitCode ?? '?')}).\x1b[0m`);
          statusCbRef.current('closed', 'Shell exited');
          break;

        default:
          break;
      }
    };

    socket.onerror = () => {
      statusCbRef.current('error', `Could not connect to the terminal service at ${url}.`);
    };

    socket.onclose = (event) => {
      inputDisposable?.dispose();
      if (keepAlive) clearInterval(keepAlive);
      if (event.code !== 1000) {
        statusCbRef.current('closed', event.reason || `Connection closed (${event.code})`);
      } else {
        statusCbRef.current('closed');
      }
    };

    return () => {
      inputDisposable?.dispose();
      if (keepAlive) clearInterval(keepAlive);
      socketRef.current = null;
      socket.close(1000, 'component unmounted');
    };
  }, [url, token, reconnectNonce]);

  const handleClick = useCallback(() => termRef.current?.focus(), []);

  return <div className="terminal-surface" ref={containerRef} onClick={handleClick} />;
});
