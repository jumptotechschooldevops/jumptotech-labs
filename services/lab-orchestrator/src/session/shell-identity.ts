/**
 * The Unix identity a session's shell runs as — SEC-ARCH-2.
 *
 * Kubernetes- and Docker-track shells run in the terminal service's own
 * container, not in a sandbox of their own. They all used to run as one uid
 * (`student`, 1001), so any student could read another's kubeconfig or Docker
 * client key, write into their workspace, and signal their processes: the
 * files were `0600`, but `0600` to a uid everyone shared. Each session now
 * gets its own uid, and every file and process of that session belongs to it.
 *
 * ## Where a uid comes from
 *
 * The session store assigns it when the session row is created — PostgreSQL
 * from a sequence (`lab_session_shell_uid_seq`, migration 007), the in-memory
 * store from a counter — and it never changes afterwards. So it is:
 *
 *   - **distinct** for every session: a sequence value is handed out once, and
 *     the column is `UNIQUE` on top of that;
 *   - **stable**: it is part of the row, so an api restart, a recovered
 *     session and a reconnecting terminal all read the same number;
 *   - **never reused**: the sequence does not cycle. A uid is not handed to a
 *     second session after the first ended, so nothing the first left behind —
 *     a file in `/tmp`, a process that escaped its teardown — can be inherited
 *     by whoever came next. When the range runs out, Start fails rather than
 *     wrapping around;
 *   - **never chosen by a client**: no request field names one, both stores
 *     ignore a `shellUid` on the session they are given, and a patch cannot
 *     change it.
 *
 * ## Why this range
 *
 * High enough to stay clear of every uid a system or a container runtime
 * hands out by convention (daemons below 1000, people from 1000, subordinate
 * ranges for rootless and user-namespaced containers from 100000, `nobody` at
 * 65534), and below 2^31 so that nothing treating a uid as a signed 32-bit
 * integer misreads it. A million sessions is several orders of magnitude past
 * any cohort this platform runs.
 */

/** The first uid a session shell may run as. */
export const SHELL_UID_MIN = 1_900_000_000;

/** The last one. Migration 007's sequence and CHECK use the same bounds. */
export const SHELL_UID_MAX = 1_900_999_999;

/** True when `value` is a uid this platform could have assigned to a session. */
export function isValidShellUid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= SHELL_UID_MIN &&
    value <= SHELL_UID_MAX
  );
}

/** Thrown when a store has no uid left to assign. Start fails closed. */
export class ShellUidExhaustedError extends Error {
  readonly code = 'SHELL_UID_EXHAUSTED';
  constructor() {
    super(
      `every session shell uid from ${SHELL_UID_MIN} to ${SHELL_UID_MAX} has been assigned; ` +
        'refusing to reuse one',
    );
    this.name = 'ShellUidExhaustedError';
  }
}
