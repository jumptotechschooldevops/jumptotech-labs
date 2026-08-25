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
  return typeof nameOrLabel === 'string' && nameOrLabel.includes(testRunId());
}

/** A temp-directory prefix unique to this run, for `mkdtemp`. */
export function scopedTmpPrefix(kind = 'run'): string {
  return `jtt-${kind}-${testRunId()}-`;
}
