/**
 * PLATFORM-006 — proof that this workspace's suite actually runs guarded.
 *
 * The assertions live in `@jumptotech/test-support/guard-contract` so there is
 * one implementation rather than seven that can drift. What matters is *where*
 * they run: inside this workspace's own vitest configuration, so the thing
 * being proven is that `setupFiles` took effect here — not that a guard exists
 * somewhere in the repository.
 *
 * The `node-pty` half matters more here than anywhere else. `src/shell.ts`
 * calls `pty.spawn` directly, with none of the injection seam that sandboxd's
 * `BrokerDeps.spawn` provides, so before the guard covered `node-pty` a unit
 * test that reached that line opened a real PTY on the developer's machine and
 * nothing said so.
 */
import {
  hostExecutionGuardContract,
  nodePtyGuardContract,
} from '@jumptotech/test-support/guard-contract';

hostExecutionGuardContract('services/terminal');
nodePtyGuardContract('services/terminal');
