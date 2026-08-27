/**
 * Unique, ownership-stamped names for anything an integration test creates.
 *
 * Why every integration test needs this
 * -------------------------------------
 * Seven worktrees share one Docker daemon and one kind cluster on a developer
 * laptop. Fixed names — `jumptotech-postgres`, a hard-coded sandbox name, a
 * predictable temp directory — mean two runs collide, and worse, that one run's
 * cleanup deletes the other's resources mid-test. The PLATFORM-006 audit caught
 * exactly that: eight failures in main while five foreign sandboxes were alive.
 *
 * The rule
 * --------
 * Every resource an integration test creates carries the run's own id, and
 * every cleanup is filtered by that id. A test therefore cannot delete a
 * resource it did not create — not because it is careful, but because it cannot
 * name one.
 *
 * The id is derived once per process from the pid and a monotonic counter, so
 * it is stable within a run, unique across concurrent runs, and — deliberately
 * — never random per call, which would make cleanup impossible.
 */

/** Label key marking a resource as belonging to one test run. */
export const TEST_RUN_LABEL = 'jumptotech.io/test-run';

/** Label key marking a resource as test-created at all. */
export const TEST_OWNED_LABEL = 'jumptotech.io/test-owned';

import { createHash } from 'node:crypto';

let cached: string | undefined;

/**
 * This process's run id: short, lowercase, DNS-safe, stable for the process.
 *
 * `JTT_TEST_RUN_ID` overrides it so a CI job — or a developer running two
 * shells on purpose — can pin distinct ids and prove non-interference.
 */
export function testRunId(): string {
  if (cached) return cached;
  const override = process.env.JTT_TEST_RUN_ID;
  if (override && /^[a-z0-9][a-z0-9-]{0,23}$/.test(override)) {
    cached = override;
    return cached;
  }
  // pid alone is not enough: pids are reused. Mixing in the start time gives a
  // value unique across concurrent and consecutive runs on one machine.
  const stamp = process.hrtime.bigint().toString(36).slice(-6);
  cached = `t${String(process.pid).slice(-5)}${stamp}`.toLowerCase();
  return cached;
}

/**
 * A resource name scoped to this run: `jtt-<kind>-<runId>-<suffix>`.
 *
 * Kept inside Docker's and Kubernetes' name rules (lowercase alphanumeric and
 * dashes, <= 63 characters) so the same helper works for a container, a
 * network, a volume and a namespace.
 */
export function scopedName(kind: string, suffix = ''): string {
  const base = `jtt-${kind}-${testRunId()}${suffix ? `-${suffix}` : ''}`;
  return base.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
}

/**
 * A hex token unique to this run, for names the platform pattern-matches.
 *
 * `scopedName` embeds the run id verbatim, which is right for every resource
 * the platform treats as an opaque string. A sandbox reference is not one:
 * `CONTAINER_SANDBOX_PATTERN` is `^jtt-lab-[0-9a-f]{6,40}$`, so it admits no
 * dash and no letter past `f` — and a run id like `t63405bznyxz`, or any
 * `<name>-<suffix>` built from one, can never match it.
 *
 * A test that needs a *validly shaped* sandbox name it still owns therefore
 * cannot use `scopedName`. Hashing the run id keeps exactly the property that
 * matters — two concurrent worktrees never produce the same value — while
 * yielding characters the shape gate accepts.
 */
export function scopedHex(length = 12): string {
  const digest = createHash('sha256').update(testRunId()).digest('hex');
  return digest.slice(0, Math.min(40, Math.max(6, length)));
}

/**
 * A `jtt-lab-<hex>` sandbox reference scoped to this run.
 *
 * Use for a container that must pass `assertValidContainerSandboxRef` — a
 * decoy or lookalike whose *refusal* is the thing under test. Passing a name
 * the shape gate rejects would prove only that the shape gate works, and would
 * silently stop exercising the ownership-label gate behind it.
 */
export function scopedSandboxRef(discriminator = ''): string {
  if (discriminator && !/^[0-9a-f]{1,8}$/.test(discriminator)) {
    throw new Error(`sandbox-ref discriminator must be hex, got '${discriminator}'`);
  }
  return `jtt-lab-${scopedHex()}${discriminator}`;
}

/** Labels every test-created resource should carry, for owned-only cleanup. */
export function ownershipLabels(): Record<string, string> {
  return { [TEST_OWNED_LABEL]: 'true', [TEST_RUN_LABEL]: testRunId() };
}

/** `docker ... --filter` arguments selecting only this run's resources. */
export function ownershipFilters(): string[] {
  return ['--filter', `label=${TEST_RUN_LABEL}=${testRunId()}`];
}

/**
 * True when a resource belongs to this run.
 *
 * The guard every cleanup path should call before deleting anything: a name
 * that does not carry this run's id belongs to someone else — possibly another
 * worktree mid-test — and must be left alone.
 */
export function ownedByThisRun(nameOrLabel: string | undefined): boolean {
  if (typeof nameOrLabel !== 'string') return false;
  // Either spelling of this run's identity counts: the verbatim id used by
  // `scopedName`, or the hashed token `scopedSandboxRef` must use where the
  // platform's own name pattern forbids the raw one.
  return nameOrLabel.includes(testRunId()) || nameOrLabel.includes(scopedHex());
}

/** A temp-directory prefix unique to this run, for `mkdtemp`. */
export function scopedTmpPrefix(kind = 'run'): string {
  return `jtt-${kind}-${testRunId()}-`;
}
