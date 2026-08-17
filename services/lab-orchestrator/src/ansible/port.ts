/**
 * The read surface an Ansible sandbox exposes to the verifier.
 *
 * The Kubernetes verifier answers "is the desired state true?" by reading the
 * API server. An Ansible sandbox has no API server, so the equivalent question
 * is answered by reading two things: the project the student authored on the
 * control node, and the state their automation actually produced on the managed
 * nodes.
 *
 * ```text
 *   requirement ──► handler ──► AnsibleSandboxPort ──► control node   (project)
 *                                                 └──► managed nodes (result)
 * ```
 *
 * Three properties this interface deliberately guarantees:
 *
 *   1. **No arbitrary execution.** There is no `exec(command)` here. The only
 *      thing a caller may run is one of the closed `AnsibleCommand` variants
 *      below, each of which the implementation turns into a fixed argv. A lab
 *      definition therefore cannot cause anything to run that the platform did
 *      not write.
 *   2. **No arbitrary paths.** Every path a lab supplies is validated by the
 *      requirement schema *and* re-checked by the implementation against the
 *      roots in `ALLOWED_*_ROOTS`, so a check cannot be pointed at `/etc/shadow`
 *      or at anything outside the sandbox.
 *   3. **One sandbox per call.** The sandbox id is passed explicitly and comes
 *      from the session record. There is no "current sandbox", so a handler
 *      cannot drift into another student's environment.
 */

/** A node inside one sandbox, by its student-visible name. */
export type AnsibleNodeName = string;

export interface AnsiblePathInfo {
  path: string;
  exists: boolean;
  /** `file`, `directory`, `symlink`, or `other`. */
  kind: 'file' | 'directory' | 'symlink' | 'other';
  /** Octal permission bits, e.g. `0644`. Absent when the path does not exist. */
  mode?: string;
  owner?: string;
  group?: string;
  sizeBytes?: number;
}

export interface AnsibleRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Per-host counters from one playbook run, read from the platform callback. */
export interface AnsibleHostStats {
  ok: number;
  changed: number;
  failures: number;
  unreachable: number;
  skipped: number;
  rescued?: number;
  ignored?: number;
}

export interface AnsiblePlaybookRun extends AnsibleRunResult {
  /**
   * Per-host recap, or `null` when the run never reached the stats phase (a
   * syntax error, for instance). `null` is meaningfully different from an empty
   * object: the latter means the playbook matched no hosts.
   */
  stats: Record<string, AnsibleHostStats> | null;
}

/**
 * The closed set of things the platform may run inside a sandbox.
 *
 * Each variant maps to one fixed argv in the implementation. The string fields
 * are inventory patterns and project-relative file names, both constrained by
 * the requirement schema to a conservative character class, and all of them are
 * passed as separate argv elements — never through a shell.
 */
export type AnsibleCommand =
  /** `ansible-inventory --list` — the parsed inventory, as JSON. */
  | { readonly kind: 'inventory' }
  /** `ansible <pattern> -m ping` — real connectivity, not a simulation. */
  | { readonly kind: 'ping'; readonly pattern: string }
  /** `ansible-playbook --syntax-check <playbook>`. */
  | { readonly kind: 'syntax-check'; readonly playbook: string }
  /** `ansible-playbook <playbook>`, with the structured-stats callback on. */
  | { readonly kind: 'playbook'; readonly playbook: string };

export class AnsibleSandboxUnreachableError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AnsibleSandboxUnreachableError';
  }
}

/** A path a lab asked about that the platform refuses to read. */
export class ForbiddenSandboxPathError extends Error {
  readonly code = 'FORBIDDEN_PATH';
  constructor(readonly path: string, reason: string) {
    super(`Refusing to inspect '${path}': ${reason}`);
    this.name = 'ForbiddenSandboxPathError';
  }
}

/**
 * Absolute roots a requirement may name on a **managed node**.
 *
 * Deliberately narrow: these are the directories the labs write into. A lab
 * cannot ask the verifier to read `/etc/shadow`, `/root/.ssh`, or anything else
 * outside this list, whatever it puts in `lab.yaml`.
 */
export const ALLOWED_MANAGED_ROOTS: readonly string[] = [
  '/etc/jumptotech',
  '/opt/jumptotech',
  '/srv/jumptotech',
  '/var/log/jumptotech',
  '/var/www',
  '/tmp/jumptotech',
];

/** Maximum bytes the verifier will read from any single file. */
export const MAX_READ_BYTES = 64 * 1024;

export interface AnsibleSandboxPort {
  /** Absolute path of the student's project directory on the control node. */
  readonly workspaceDir: string;

  /** Cheap liveness probe. Throws `AnsibleSandboxUnreachableError` when down. */
  ping(sandboxId: string): Promise<void>;

  /** Managed node names in this sandbox, in topology order. */
  managedNodes(sandboxId: string): readonly AnsibleNodeName[];

  /**
   * Read a file from the student's project on the control node.
   *
   * `relativePath` is resolved inside `workspaceDir`; anything that escapes it
   * is refused. Returns `null` when the file does not exist.
   */
  readWorkspaceFile(sandboxId: string, relativePath: string): Promise<string | null>;

  /** Stat a path inside the student's project. */
  statWorkspacePath(sandboxId: string, relativePath: string): Promise<AnsiblePathInfo>;

  /** Names directly inside a project directory, or `null` when it is absent. */
  listWorkspaceDirectory(sandboxId: string, relativePath: string): Promise<string[] | null>;

  /** Read a file on a managed node. The path must sit under an allowed root. */
  readManagedFile(
    sandboxId: string,
    node: AnsibleNodeName,
    absolutePath: string,
  ): Promise<string | null>;

  /** Stat a path on a managed node. */
  statManagedPath(
    sandboxId: string,
    node: AnsibleNodeName,
    absolutePath: string,
  ): Promise<AnsiblePathInfo>;

  /** Delete a path on a managed node, used only to establish an idempotency baseline. */
  removeManagedPath(sandboxId: string, node: AnsibleNodeName, absolutePath: string): Promise<void>;

  /**
   * Is a named process running on a managed node?
   *
   * Sandbox nodes are containers and carry no init system, so "service" means
   * "a process by this name is running" — see README → Ansible track for why
   * that is the honest reading here rather than a systemd fiction.
   */
  processRunning(sandboxId: string, node: AnsibleNodeName, processName: string): Promise<boolean>;

  /** Run one allow-listed Ansible command on the control node. */
  run(sandboxId: string, command: AnsibleCommand): Promise<AnsibleRunResult>;

  /** Run a playbook and return its structured per-host recap. */
  runPlaybook(sandboxId: string, playbook: string): Promise<AnsiblePlaybookRun>;
}
