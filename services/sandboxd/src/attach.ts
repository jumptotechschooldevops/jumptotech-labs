/**
 * The attach gate.
 *
 * This is the security boundary the whole service exists for. `sandboxd` is the
 * only process in the deployment that can drive a container runtime, so the one
 * question that matters is *what it will agree to attach a shell to*.
 *
 * The answer is deliberately narrow: **one container, derived from one session
 * id, that the platform itself created for that same session.**
 *
 * ```text
 *   terminal ──{ sessionId }──► sandboxd
 *                                  │ 1. shape-check the session id
 *                                  │ 2. DERIVE the container name (HMAC)
 *                                  │ 3. inspect it
 *                                  │ 4. require: managed=true
 *                                  │             runtime-owner = mine
 *                                  │             session-id    = the one asked for
 *                                  │             state         = running
 *                                  ▼
 *                            docker exec -it <derived> $SHELL
 * ```
 *
 * Note what is *absent* from the input. No container name, no image, no user,
 * no working directory, no command, no path, no namespace, no kubeconfig. A
 * caller cannot name a container even if it wants to, because the name is not a
 * parameter — it is computed here from the session id and this service's own
 * copy of the derivation secret. That is what makes invariants 2–6 structural
 * rather than a validation that could be forgotten.
 *
 * Step 4 is not redundant with step 2. Deriving the name proves only that the
 * *caller* knew a session id; the label check proves that the container on the
 * daemon right now genuinely belongs to that session and to this platform. A
 * container someone else created under a colliding name carries neither label
 * and is refused, which is the same rule `assertDeletable` applies before the
 * reaper removes anything.
 *
 * The user and working directory come from **this service's configuration**,
 * not from the request and not from the container.
 *
 * Not from the request is obvious. Not from the container took a real bug to
 * learn: `Config.User` is the account the container's *foreground process*
 * runs as, and for a Linux sandbox that is deliberately `root` — the init
 * process is a real service supervisor and has to be. The student is never that
 * account. Reading it back and attaching with it handed every Linux, CS,
 * Networking and AWS student a root shell, silently, while the terminal service
 * it replaced had always attached as `student`.
 *
 * So the shell user is `SANDBOX_USER` — the same policy value the API's
 * `getTerminalContext` uses — and `assertShellUser` refuses `root` outright, so
 * no configuration and no future container can reintroduce that.
 */
import {
  CONTAINER_SANDBOX_PREFIX,
  MANAGED_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  LAB_LABEL,
  assertValidSessionId,
  deriveSandboxRef,
} from '@jumptotech/lab-orchestrator';

/** What `docker inspect` tells us about a candidate sandbox. */
export interface SandboxSnapshot {
  /** `running` | `exited` | `created` | … */
  state: string;
  labels: Record<string, string>;
  /** The container's own `Config.User`. */
  user: string;
  /** The container's own `Config.WorkingDir`. */
  workdir: string;
}

/** The single runtime capability this gate needs. Faked wholesale in tests. */
export interface SandboxInspectorPort {
  inspect(ref: string): Promise<SandboxSnapshot | null>;
}

export class AttachDeniedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AttachDeniedError';
  }
}

/** Everything needed to open a PTY, and nothing a caller supplied. */
export interface AttachTarget {
  /** The derived container name. */
  ref: string;
  user: string;
  workdir: string;
  /** From the container's own label, for the shell's `JTT_LAB_ID`. */
  labId: string;
}

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const WORKDIR_PATTERN = /^\/[A-Za-z0-9._\-/]{0,255}$/;
const LAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ResolveAttachOptions {
  sessionId: unknown;
  inspector: SandboxInspectorPort;
  derivationSecret: string;
  runtimeOwner: string;
  /** The student account, from configuration. Never `root`, never from a request. */
  sandboxUser: string;
  /** The student's working directory, from configuration. */
  sandboxHome: string;
}

/**
 * The account a student's shell may run as.
 *
 * `root` is refused rather than merely not-chosen. A sandbox is bounded by the
 * container, not by the account inside it, so a root shell is not a *breach* —
 * but it is not the lesson either: the Linux track teaches `sudo`, and a
 * student who is already root learns nothing from it, while `unprivileged_shell`
 * labs like the CS track depend on there being no route to root at all (their
 * verifiers read state with binaries a root student could replace).
 *
 * A closed refusal here, rather than a comment saying "don't", is what makes
 * the mistake unrepeatable.
 */
export function assertShellUser(user: unknown): string {
  if (typeof user !== 'string' || !USER_PATTERN.test(user)) {
    throw new AttachDeniedError(
      'SANDBOX_USER_INVALID',
      `'${String(user)}' is not a valid sandbox shell user.`,
    );
  }
  if (user === 'root') {
    throw new AttachDeniedError(
      'SANDBOX_USER_INVALID',
      'A student shell may not run as root. Set SANDBOX_USER to the unprivileged sandbox account.',
    );
  }
  return user;
}

/**
 * Resolve a session id to the one container this broker may attach to.
 *
 * Throws `AttachDeniedError` on every refusal, with a code the terminal
 * forwards to the browser. Refusals are deliberately specific for an operator
 * reading logs and deliberately uninformative about *other* sessions: a caller
 * learns only whether its own session has a live sandbox.
 */
export async function resolveAttachTarget(options: ResolveAttachOptions): Promise<AttachTarget> {
  let sessionId: string;
  try {
    sessionId = assertValidSessionId(options.sessionId);
  } catch {
    throw new AttachDeniedError('INVALID_SESSION_ID', 'That is not a lab session id.');
  }

  // The name is computed, never received. See the module header.
  const ref = deriveSandboxRef({
    sessionId,
    secret: options.derivationSecret,
    prefix: CONTAINER_SANDBOX_PREFIX,
  });

  const snapshot = await options.inspector.inspect(ref);
  if (!snapshot) {
    throw new AttachDeniedError(
      'SANDBOX_NOT_FOUND',
      'This session has no sandbox on this runtime.',
    );
  }

  /*
   * Ownership, in the order that fails cheapest. All three must hold: the
   * platform created it, *this* runtime owner created it, and it belongs to the
   * session being asked about. Missing labels are refusals, not defaults.
   */
  if (snapshot.labels[MANAGED_LABEL] !== 'true') {
    throw new AttachDeniedError(
      'SANDBOX_NOT_MANAGED',
      'That container was not created by this platform.',
    );
  }
  if (snapshot.labels[RUNTIME_OWNER_LABEL] !== options.runtimeOwner) {
    throw new AttachDeniedError(
      'SANDBOX_NOT_OWNED',
      'That container belongs to a different runtime owner.',
    );
  }
  if (snapshot.labels[SESSION_LABEL] !== sessionId) {
    throw new AttachDeniedError(
      'SANDBOX_SESSION_MISMATCH',
      'That container does not belong to this session.',
    );
  }
  if (snapshot.state !== 'running') {
    throw new AttachDeniedError(
      'SANDBOX_NOT_RUNNING',
      `This session's sandbox is ${snapshot.state}, not running.`,
    );
  }

  /*
   * From configuration, re-validated. These two are the only values that reach
   * an argv, so they are checked here even though they came from this service's
   * own environment — the cost is nothing and the failure mode is a shell with
   * the wrong identity.
   *
   * `snapshot.user` is deliberately unused. See the module header.
   */
  const user = assertShellUser(options.sandboxUser);
  const workdir = options.sandboxHome;
  if (!WORKDIR_PATTERN.test(workdir)) {
    throw new AttachDeniedError(
      'SANDBOX_WORKDIR_INVALID',
      `'${String(workdir)}' is not a valid sandbox working directory.`,
    );
  }

  const rawLabId = snapshot.labels[LAB_LABEL] ?? '';
  const labId = LAB_ID_PATTERN.test(rawLabId) ? rawLabId : '';

  return { ref, user, workdir, labId };
}

/**
 * The argv for the PTY.
 *
 * Built here so there is one place to read when auditing what a student's shell
 * actually is. Every element is either a constant, configuration, or a value
 * `resolveAttachTarget` took from the container itself — nothing from a
 * request. In particular there is no `--privileged`, no `--user root` override,
 * no mount and no capability: those are properties of the container the
 * orchestrator created, and `docker exec` cannot add to them.
 */
export function attachArgv(
  target: AttachTarget,
  options: { shell: string; promptUser?: string; promptHost?: string },
): string[] {
  const promptUser = options.promptUser ?? target.user;
  const promptHost = options.promptHost ?? 'lab';
  const env: Record<string, string> = {
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    PS1: `\\[\\e[32m\\]${promptUser}@${promptHost}\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ `,
  };
  if (target.labId) env.JTT_LAB_ID = target.labId;

  const argv = ['exec', '--interactive', '--tty', '--user', target.user, '--workdir', target.workdir];
  for (const [key, value] of Object.entries(env)) argv.push('--env', `${key}=${value}`);
  argv.push(target.ref, options.shell, '--norc', '--noprofile');
  return argv;
}
