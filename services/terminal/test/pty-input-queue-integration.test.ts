/**
 * The input bound depends on reading node-pty's private write queue, so this
 * proves the queue is where `ptyPendingInputBytes` looks, against the real
 * module and a real PTY. A node-pty upgrade that moves it fails here instead of
 * silently removing the bound (see "student input" in `output-flow.ts`).
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1: it spawns a host process.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as pty from 'node-pty';
import { ptyInputQueueReadable, ptyPendingInputBytes } from '@jumptotech/lab-orchestrator';
import { localShell, type Shell } from '../src/shell.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === '1';

/** Newline-terminated, so a canonical-mode tty keeps it rather than discarding an over-long line. */
const FRAME = `${'x'.repeat(63)}\n`.repeat(128);

const open: Array<{ kill(): void }> = [];
afterEach(() => {
  for (const term of open.splice(0)) {
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  }
});

describe.skipIf(!enabled)('node-pty input queue (real PTY)', () => {
  it('exposes the write queue that ptyPendingInputBytes reads', () => {
    const term = pty.spawn('/bin/sh', ['-c', 'sleep 30'], { cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' } });
    open.push(term);
    expect(ptyInputQueueReadable(term)).toBe(true);
    for (let i = 0; i < 400; i += 1) term.write(FRAME);
    // The kernel's tty buffer takes a few KiB; everything else waits in the process.
    expect(ptyPendingInputBytes(term)).toBeGreaterThan(200 * FRAME.length);
  });

  it("reports a local shell's unread input through the Shell interface", () => {
    const shell: Shell = localShell(
      { command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: '/', env: { PATH: '/usr/bin:/bin' } },
      { cols: 80, rows: 24 },
    );
    open.push(shell);
    for (let i = 0; i < 400; i += 1) shell.write(FRAME);
    expect(shell.pendingInputBytes()).toBeGreaterThan(200 * FRAME.length);
  });
});
