/**
 * How a closed terminal socket is classified.
 *
 * The terminal service sends an `error` frame naming a code before it closes a
 * socket on purpose, and uses distinct close codes. Both are folded into one
 * code so the workspace can tell "your lab ended" from "the network blinked":
 *
 * ```text
 *   4410  SESSION_ENDED     the environment is gone — do not reconnect
 *   4401  UNAUTHORIZED      the token was refused (e.g. expired) — mint a new one
 *   4403  CREDENTIALS_UNAVAILABLE
 *   4408  IDLE_TIMEOUT / SESSION_EXPIRED   the terminal's own timers (named in the frame)
 *   1013  CAPACITY          the terminal service is full
 *   1000  SHELL_EXITED      the student typed `exit`
 *   else  CONNECTION_LOST   anything abnormal (1006 …)
 * ```
 *
 * Kept apart from the xterm component so it can be used and tested without
 * loading a terminal emulator.
 */
export function codeForClose(closeCode: number, serverCode: string | undefined): string {
  if (serverCode) return serverCode;
  switch (closeCode) {
    case 4410:
      return 'SESSION_ENDED';
    case 4401:
      return 'UNAUTHORIZED';
    case 4403:
      return 'CREDENTIALS_UNAVAILABLE';
    case 1013:
      return 'CAPACITY';
    case 1000:
      return 'SHELL_EXITED';
    default:
      return 'CONNECTION_LOST';
  }
}

/**
 * The line written into the terminal when the service sends an `error` frame.
 *
 * Not the frame's own `message`: several are an exception's text passed
 * through — the credentials fetch ("Could not reach the lab API to obtain
 * session credentials: connect ECONNREFUSED …"), a shell that would not start
 * ("Could not start a shell: …") — written for the service's log, not for a
 * student. The code is enough to say what happened; the terminal bar says what
 * to do about it.
 */
const TERMINAL_NOTICE: Record<string, string> = {
  // Also sent when this lab's terminal is opened in another tab, so it must not
  // say the lab has ended; the workspace works out which it was.
  SESSION_ENDED: 'The terminal was disconnected.',
  IDLE_TIMEOUT: 'The terminal closed after a period of inactivity.',
  SESSION_EXPIRED: 'The terminal reached its time limit.',
  CAPACITY: 'The terminal service is busy right now.',
  UNAUTHORIZED: 'The terminal’s access expired.',
  UNAUTHENTICATED: 'The terminal connection was refused.',
  AUTH_TIMEOUT: 'The terminal took too long to connect.',
  CREDENTIALS_UNAVAILABLE: 'The terminal could not attach to your environment.',
  SANDBOX_UNAVAILABLE: 'The terminal could not attach to your environment.',
  BROKER_UNREACHABLE: 'The terminal could not start a shell in your environment.',
  PTY_SPAWN_FAILED: 'The terminal could not start a shell in your environment.',
  FRAME_TOO_LARGE: 'That was too much to send at once, so it was not sent.',
};

export function terminalNotice(code: string | undefined): string {
  return (code && TERMINAL_NOTICE[code]) || 'The terminal connection was interrupted.';
}
