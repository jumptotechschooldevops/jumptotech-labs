/**
 * PLATFORM-006 — proof that this workspace's suite actually runs guarded.
 *
 * The assertions live in `@jumptotech/test-support/guard-contract` so there is
 * one implementation rather than seven that can drift. What matters is *where*
 * they run: inside this workspace's own vitest configuration, so the thing
 * being proven is that `setupFiles` took effect here — not that a guard exists
 * somewhere in the repository.
 *
 * Delete this workspace's config, or drop the setup file from it, and this
 * suite fails. `test-classification.test.ts` fails the build if this file is
 * missing altogether.
 */
import { hostExecutionGuardContract } from '@jumptotech/test-support/guard-contract';

hostExecutionGuardContract('apps/web');
