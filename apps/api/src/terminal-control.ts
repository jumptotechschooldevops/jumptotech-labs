/**
 * Closing a student's shell when their session goes away.
 *
 * When a session ends — End Lab, idle timeout, or absolute expiry — the
 * namespace is deleted. Leaving the PTY open would give the student a shell
 * whose every `kubectl` call fails with a confusing error, so the terminal is
 * closed *first*.
 *
 * This is best-effort by design: the sandbox teardown must not be blocked by an
 * unreachable terminal service. `SessionManager` catches and logs failures here
 * and proceeds with deleting the namespace, which is the part that actually
 * matters for isolation and cost.
 */
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
    try {
      const response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, '')}/internal/terminate`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-secret': this.options.secret,
          },
          body: JSON.stringify({ sessionId }),
          signal: controller.signal,
        },
      );
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
};
