/**
 * PLATFORM-006 — proof that this workspace's suite actually runs guarded.
 *
 * See `test-support/guard-contract.ts` for why the assertion is a runtime one
 * rather than a check that the config names a setup file.
 */
import { hostExecutionGuardContract } from '@jumptotech/test-support/guard-contract';

hostExecutionGuardContract('services/observability');
