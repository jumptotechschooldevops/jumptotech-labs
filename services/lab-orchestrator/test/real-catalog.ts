/**
 * The shipped catalog as a shared, immutable, per-process fixture.
 *
 * The defect this exists to make impossible
 * -----------------------------------------
 * `LabRegistry.load()` reads, YAML-parses and schema-validates every
 * `lab.yaml` in `labs/`. At 114 labs that used to be a ~1.3s CPU operation —
 * not I/O: reading all 114 files takes 31ms, and the rest was validation. It is
 * ~0.1s now that `requirements.ts` dispatches on `type` instead of trialling a
 * 192-member union, but the arithmetic below is why that alone is not enough.
 *
 * Tests treated that as something to redo per test. One run of this workspace's
 * suite performed **137** full loads of the shipped catalog, which is where
 * essentially all of its ~200s of test CPU went. Worse, it put individual tests
 * within a factor of two of vitest's 5s default timeout, and the tests that
 * loaded the catalog *twice* — `runtime-owner`'s two-owner scenarios and
 * `lab-catalog`'s determinism check — sat right on the line. Whenever the
 * machine was busy (the other 40 test files in the same run, or another
 * worktree), one of them tipped over and the run failed. That is the
 * intermittent failure: not a race over shared state, but a shared *cost*
 * charged to whichever test happened to be running when the machine got busy.
 *
 * Nothing about it was deterministic, because which test is unlucky depends on
 * worker scheduling — which is why it moved between files and reproduced only
 * once every 6–16 runs.
 *
 * The contract
 * ------------
 * The shipped catalog does not change during a run, so it is loaded **once per
 * test file** and shared by every test in it. Once per file rather than once per
 * process is not a choice: vitest runs each file with its own module registry
 * (`isolate` defaults to true), so module state cannot cross files. That is what
 * the 137 -> 21 is — 21 is the number of files in this workspace that need the
 * catalog and are not skipped, which is the floor this design can reach.
 *
 * The load is registered as a `beforeAll` (below) so it is charged to setup
 * rather than to whichever test touches it first.
 *
 * Sharing is only safe if it cannot be mutated, so this fixture enforces that
 * rather than asking for it:
 *
 *   · every definition it hands out is deep-frozen, so a test that writes to a
 *     lab definition throws at the write instead of corrupting a later test;
 *   · `load(true)` on the shared instance throws, so no test can re-read the
 *     directory out from under a test running beside it.
 *
 * A test that genuinely needs an independent load calls `freshRealCatalog()`,
 * which is deliberately explicit: the cost is the point of that test.
 *
 * A test that needs to *change* a catalog must never touch this one. Build an
 * isolated temporary directory instead — `labsDirPlus()` in `catalog-shape.ts`
 * copies the real catalog into one per test.
 */
import { beforeAll } from 'vitest';
import { LabRegistry } from '../src/index.js';
import { LABS_DIR } from './helpers.js';

export { LABS_DIR };

let shared: Promise<LabRegistry> | undefined;

/**
 * The shipped catalog, loaded once per test file and immutable.
 *
 * Use this everywhere a test only *reads* the catalog, which is almost
 * everywhere: session managers, providers, reapers and verifiers all take a
 * loaded registry and never write to it.
 */
export function realCatalog(): Promise<LabRegistry> {
  shared ??= loadSharedCatalog();
  return shared;
}

/**
 * How long the one-time load may take before we call it broken rather than slow.
 *
 * This is a *hook* timeout and it is deliberately not a test timeout. On an idle
 * machine the load is ~120ms; what it is protecting against is a machine so
 * oversubscribed that 120ms of work takes tens of seconds of wall clock — the
 * 4x-oversubscription case, where four suites and their forty workers contend
 * for ten cores. Thirty seconds is far beyond any healthy load and far below
 * hanging forever, so a genuine deadlock or an unreadable `labs/` still fails
 * the run loudly instead of stalling it.
 */
const WARMUP_TIMEOUT_MS = 30_000;

/*
 * Pay for the catalog in setup, not inside somebody's test.
 *
 * Importing this module means the file needs the shipped catalog, so the load
 * is registered as a root-level `beforeAll` for that file. Every `it` then finds
 * `realCatalog()` already resolved and returns from the memoised promise.
 *
 * That distinction is the whole fix for the high-contention flake. The load was
 * never *in* a test conceptually — it is fixture setup — but it was being
 * *charged* to whichever test happened to touch it first, against vitest's 5s
 * default `testTimeout`. Under 4x oversubscription that one-time cost stretched
 * past 5s and the unlucky test failed, which is why the failures were always the
 * first catalog-touching test of a file and never the same file twice.
 *
 * Nothing here is a blanket timeout increase: `testTimeout` is untouched, so
 * every test still gets exactly 5s to do its own work, and a test that is
 * genuinely slow still fails. Only this one setup step, which does measurable
 * one-time work, gets a setup-sized budget.
 *
 * Registering it on import rather than asking each suite to remember is what
 * makes it hold: there is no way to depend on the fixture and skip the hook.
 * Only `*.test.ts` files import this module, and vitest skips the hook for a
 * file whose tests are all skipped, so gated integration suites stay free.
 */
beforeAll(async () => {
  await realCatalog();
}, WARMUP_TIMEOUT_MS);

/**
 * An independent load of the shipped catalog, not shared with anyone.
 *
 * Only for tests whose subject *is* loading — "two loads agree", "a reload
 * picks up a change". Everything else wants `realCatalog()`; each call to this
 * adds a full validation pass to the run.
 */
export async function freshRealCatalog(): Promise<LabRegistry> {
  const registry = new LabRegistry(LABS_DIR);
  await registry.load();
  return registry;
}

async function loadSharedCatalog(): Promise<LabRegistry> {
  const registry = await freshRealCatalog();
  // Freeze what `all()`, `get()` and `getBySlug()` hand out. The registry keeps
  // one object per lab and returns it by reference, so without this a single
  // test assigning to `lab.setup` would change the catalog every later test in
  // the file sees.
  for (const definition of registry.all()) deepFreeze(definition);
  sealAgainstReload(registry);
  return registry;
}

/**
 * Make `load(force)` refuse to re-read the directory.
 *
 * `load()` without `force` is already a no-op on a loaded registry, so only the
 * forcing form is dangerous: it clears the maps and re-reads disk, which would
 * empty the shared catalog for however long the reload takes.
 */
function sealAgainstReload(registry: LabRegistry): void {
  Object.defineProperty(registry, 'load', {
    value: async (force = false): Promise<void> => {
      if (force) {
        throw new Error(
          'The shared catalog from realCatalog() is immutable and cannot be reloaded. ' +
            'Use freshRealCatalog() for an independent load, or labsDirPlus() in ' +
            'catalog-shape.ts for a temporary catalog this test may change.',
        );
      }
    },
    configurable: false,
    writable: false,
  });
}

/** Freeze a lab definition and everything reachable from it. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
}
