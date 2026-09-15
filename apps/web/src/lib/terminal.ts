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
