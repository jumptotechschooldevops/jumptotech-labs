/**
 * Who this process runs as — BETA-P0-010.
 *
 * ## The leak
 *
 * A Kubernetes or Docker student's shell is a PTY spawned by *this* process, in
 * *this* container, as the `student` account. The image used to start this
 * process as that same account. On Linux a process may read another process'
 * `/proc/<pid>/environ` and open its `/proc/<pid>/mem` when both run as the same
 * uid and the target is "dumpable" — which an ordinary process is. So:
 *
 * ```text
 *   student$ tr '\0' '\n' < /proc/<terminal pid>/environ
 *   TERMINAL_SESSION_SECRET=…     forge a terminal token
 *   INTERNAL_SERVICE_SECRET=…     call the API's /internal routes
 *   SANDBOXD_ATTACH_SECRET=…      open a shell through the broker
 * ```
 *
 * Deleting the variables from `process.env` does not help: the kernel serves
 * `environ` from the process' original stack, and `mem` holds them anyway.
 *
 * ## The fix, and why it is this small
 *
 * The container starts as root, holding only `SETUID` and `SETGID`, and this
 * process drops to the student account before it does anything else. Changing
 * uid makes the kernel reset the process' dumpable flag to
 * `fs.suid_dumpable` (0 by default; see prctl(2), PR_SET_DUMPABLE), and a
 * non-dumpable process' `/proc` files are closed to every other process of the
 * same uid. A shell this process later spawns `exec`s a fresh image and is
 * dumpable again — it is the student's own process — but it was never given a
 * secret. The drop also clears every capability, so afterwards this process
 * holds strictly less than it did before: the same uid, no capabilities, and a
 * `/proc` entry its students cannot open.
 *
 * Nothing else changes. Every file this service writes for a shell — the
 * kubeconfig, the Docker client certificates, the workspace — is still written
 * by, and readable to, the account the shell runs as.
 *
 * ## What it does not do
 *
 * A student shell shares the service's uid, so it can still *signal* the
 * service. Separating those identities (shells as a uid the service is not) is
 * a larger change to file ownership and is recorded as a remaining risk in
 * docs/secret-boundaries.md.
 */

export class ProcessIdentityError extends Error {
  readonly code = 'PROCESS_IDENTITY_UNSAFE';
  constructor(message: string) {
    super(message);
    this.name = 'ProcessIdentityError';
  }
}

/** The subset of `process` this module needs, injectable for tests. */
export interface IdentityOps {
  getuid?: () => number;
  getgid?: () => number;
  setgroups?: (groups: number[]) => void;
  setgid?: (id: number) => void;
  setuid?: (id: number) => void;
}

export type IdentityOutcome =
  | { kind: 'dropped'; uid: number; gid: number }
  | {
      kind: 'unchanged';
      reason: 'not-configured' | 'not-root' | 'unsupported-platform';
      uid: number | null;
    };

const WHY =
  'Student shells run as the same account as this service, and an account that ' +
  'did not change uid inside this process leaves its environment and memory ' +
  'readable to them.';

/**
 * Drop to `uid`/`gid` when started as root, and refuse an unsafe identity in
 * production.
 *
 * Development keeps running however it was started — a laptop's
 * `npm run dev:terminal` is not root and has no students — and the outcome says
 * so, for the caller to log.
 */
export function dropServiceIdentity(options: {
  uid: number | undefined;
  gid?: number | undefined;
  production: boolean;
  ops?: IdentityOps;
}): IdentityOutcome {
  const ops: IdentityOps = options.ops ?? process;
  const { production } = options;

  if (!ops.getuid || !ops.getgid || !ops.setuid || !ops.setgid || !ops.setgroups) {
    if (production) {
      throw new ProcessIdentityError(
        `The terminal service needs a POSIX platform to drop privileges in production. ${WHY}`,
      );
    }
    return { kind: 'unchanged', reason: 'unsupported-platform', uid: null };
  }

  const current = ops.getuid();

  if (options.uid === undefined) {
    if (production) {
      throw new ProcessIdentityError(
        'TERMINAL_DROP_TO_UID is not set. In production the terminal must start as root with ' +
          `only SETUID and SETGID and drop to the student account itself. ${WHY}`,
      );
    }
    return { kind: 'unchanged', reason: 'not-configured', uid: current };
  }

  if (current !== 0) {
    if (production) {
      throw new ProcessIdentityError(
        `The terminal service started as uid ${current} rather than root, so it cannot drop to ` +
          `uid ${options.uid} itself. ${WHY} Start the container as root with only the SETUID ` +
          'and SETGID capabilities.',
      );
    }
    return { kind: 'unchanged', reason: 'not-root', uid: current };
  }

  const uid = options.uid;
  const gid = options.gid ?? uid;
  if (uid === 0 || gid === 0) {
    throw new ProcessIdentityError('TERMINAL_DROP_TO_UID and TERMINAL_DROP_TO_GID must not be 0.');
  }

  // Supplementary groups first, while this process still may: root's would
  // otherwise survive the drop and follow every student shell.
  ops.setgroups([]);
  ops.setgid(gid);
  ops.setuid(uid);

  if (ops.getuid() !== uid || ops.getgid() !== gid) {
    throw new ProcessIdentityError(
      `Dropping to ${uid}:${gid} did not take effect; refusing to run with an unknown identity.`,
    );
  }
  return { kind: 'dropped', uid, gid };
}
