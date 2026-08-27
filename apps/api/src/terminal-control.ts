/**
 * Acting on a student's shell from the API.
 *
 * Two operations, both best-effort by design — sandbox teardown must never be
 * blocked by an unreachable terminal service:
 *
 *   terminate  When a session ends (End Lab, idle timeout, absolute expiry) the
 *              sandbox is deleted. Leaving the shell open would give the
 *              student a terminal whose every command fails with a confusing
 *              error, so it is closed *first*.
 *
 *   reattach   When a Linux reset replaces the sandbox container, the shell
 *              inside it dies with it. Rather than leaving a dead terminal on
 *              screen, the terminal service is asked to open a fresh shell in
 *              the fresh container, on the same browser socket.
 *
 * `SessionManager` catches and logs failures here and proceeds, which is the
 * part that actually matters for isolation and cost.
 */
import { currentRequestId, REQUEST_ID_HEADER } from '@jumptotech/observability';
import type { TerminalTerminator } from '@jumptotech/lab-orchestrator';

export interface HttpTerminalControlOptions {
  /** Base URL of the terminal service, e.g. `http://terminal:4001`. */
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export class HttpTerminalControl implements TerminalTerminator {
  constructor(private readonly options: HttpTerminalControlOptions) {}

  async terminate(sessionId: string): Promise<void> {
    await this.#post('terminate', sessionId, 5_000);
  }

  async reattach(sessionId: string): Promise<void> {
    // Opening a shell in a freshly created container is slower than closing
    // one, so this gets a longer budget than terminate.
    await this.#post('reattach', sessionId, this.options.timeoutMs ?? 20_000);
  }

  async #post(action: 'terminate' | 'reattach', sessionId: string, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/internal/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': this.options.secret,
          // Correlation only — see broker-runtime.ts.
          ...(currentRequestId() ? { [REQUEST_ID_HEADER]: currentRequestId()! } : {}),
        },
        body: JSON.stringify({ sessionId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`terminal service replied ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** No-op used when no terminal control URL is configured. */
export const noopTerminalControl: TerminalTerminator = {
  async terminate(): Promise<void> {
    /* nothing to close */
  },
  async reattach(): Promise<void> {
    /* nothing to reconnect */
  },
};
