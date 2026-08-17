/**
 * Memoised, sandbox-scoped reads for one verification run.
 *
 * The container counterpart of `VerifyReader`. Same two properties, for the
 * same reasons:
 *
 *   - **Each path is read at most once per run**, so a lab asking three
 *     questions about one file ("does it exist", "is the mode right", "who owns
 *     it") cannot produce a self-contradictory report by observing three
 *     different states.
 *   - **The sandbox is fixed at construction.** A handler is never given the
 *     chance to name one, so it cannot read another student's sandbox — and the
 *     port it is handed only reaches inside one container, as the unprivileged
 *     student user.
 *
 * Paths were already validated by the lab schema and are re-resolved against
 * the sandbox home by the provider before any read; nothing here can widen
 * that. See `session/sandbox-paths.ts`.
 */
import type { SandboxInspectResult, SandboxPathRead } from '@jumptotech/lab-orchestrator';

/** The primitives a sandbox provider offers the verifier. */
export interface SandboxPort {
  read(relativePath: string, options?: { maxBytes?: number }): Promise<SandboxPathRead | null>;
  /**
   * Ask the sandbox one allow-listed, read-only inspection question.
   *
   * Optional, and the whole reason the `linux` requirement family is separate
   * from `filesystem`: "is `ledger-api` running" and "is anything listening on
   * 9105" are not questions a path read can answer. A provider that does not
   * offer it (Terraform, Docker) makes `linux` checks report as skipped, which
   * is the honest outcome — the platform could not look, so the student is not
   * told they failed.
   */
  inspect?(
    command: string,
    args: readonly string[],
    options?: { asRoot?: boolean; timeoutMs?: number },
  ): Promise<SandboxInspectResult>;
  /**
   * Run one path *the student wrote* inside their own sandbox, as themselves.
   *
   * Deliberately a separate capability from `inspect` rather than a widened
   * allow-list. `inspect` runs a fixed set of read-only platform binaries;
   * this runs student code, which is a different thing to reason about and
   * should be a different thing to grant. Only `script_runs` uses it, and only
   * the Linux provider offers it.
   */
  runScript?(
    path: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<SandboxInspectResult>;
}

/** One entry of the sandbox's process table, as the verifier reads it. */
export interface ProcessEntry {
  pid: number;
  user: string;
  /** Full command line, exactly as `ps` reported it. */
  command: string;
}

/** One listening socket, as `ss` reported it. */
export interface ListeningSocket {
  protocol: 'tcp' | 'udp';
  port: number;
  address: string;
}

/** Raised when the sandbox itself could not be reached. Never a failed check. */
export class SandboxUnreachableError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnreachableError';
  }
}

/**
 * The slice of Terraform state the checks care about.
 *
 * Deliberately minimal, and deliberately read from the state file rather than
 * by running `terraform`: the verifier must not depend on being able to execute
 * a student-influenced working directory, and `terraform.tfstate` is the
 * authoritative record of what an apply actually produced.
 */
export interface TerraformStateSnapshot {
  version: number;
  resources: Array<{
    /** `managed` | `data`. */
    mode: string;
    type: string;
    name: string;
    provider?: string;
    instanceCount: number;
  }>;
  outputs: Record<string, { value: unknown; type?: unknown; sensitive?: boolean }>;
}

export const TERRAFORM_STATE_FILE = 'terraform.tfstate';
export const TERRAFORM_LOCK_FILE = '.terraform.lock.hcl';
export const TERRAFORM_WORK_DIR = '.terraform';

export class SandboxReader {
  readonly #cache = new Map<string, Promise<SandboxPathRead | null>>();
  #processes: Promise<ProcessEntry[]> | undefined;
  #sockets: Promise<ListeningSocket[]> | undefined;

  constructor(private readonly port: SandboxPort) {}

  /** Whether this sandbox can answer `linux`-family checks at all. */
  get canInspect(): boolean {
    return typeof this.port.inspect === 'function';
  }

  /** Whether this sandbox can run a student's own script. */
  get canRunScripts(): boolean {
    return typeof this.port.runScript === 'function';
  }

  path(relativePath: string, options?: { maxBytes?: number }): Promise<SandboxPathRead | null> {
    const key = `${relativePath}#${options?.maxBytes ?? 'default'}`;
    const existing = this.#cache.get(key);
    if (existing) return existing;
    const promise = this.port.read(relativePath, options);
    this.#cache.set(key, promise);
    return promise;
  }

  /** `dir/name`, for the fixed file names the Terraform checks look for. */
  join(dir: string, name: string): string {
    return dir === '.' ? name : `${dir.replace(/\/+$/, '')}/${name}`;
  }

  /**
   * Run one allow-listed inspection command.
   *
   * Deliberately *not* memoised: `script_runs` exists to run a student's own
   * script, and two identical invocations are two observations, not one.
   * The memoised readers below are the ones where a single consistent snapshot
   * matters.
   */
  async inspect(
    command: string,
    args: readonly string[],
    options?: { asRoot?: boolean; timeoutMs?: number },
  ): Promise<SandboxInspectResult> {
    if (!this.port.inspect) {
      throw new SandboxUnreachableError('this lab environment cannot be inspected');
    }
    return this.port.inspect(command, args, options);
  }

  /**
   * Run a student's own script, once. Never memoised — see `inspect`.
   */
  async script(
    path: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<SandboxInspectResult> {
    if (!this.port.runScript) {
      throw new SandboxUnreachableError('this lab environment cannot run scripts');
    }
    return this.port.runScript(path, args, options);
  }

  /**
   * The sandbox's process table, read once per verification run.
   *
   * Read once for the same reason each path is: a lab asking "the stale job is
   * gone" and "the new job is running" must be answering from one snapshot, or
   * it could report a self-contradictory pair of results.
   *
   * `ps -eo pid=,user=,args=` rather than `pgrep`: matching happens here, over
   * a table the verifier read itself, so a lab's pattern is never handed to a
   * pattern-matching binary and never reaches a regular-expression engine.
   */
  processes(): Promise<ProcessEntry[]> {
    this.#processes ??= this.inspect('ps', ['-eo', 'pid=,user=,args=']).then((result) => {
      if (result.exitCode !== 0) {
        throw new SandboxUnreachableError(
          result.stderr.trim() || 'could not read the process table in your lab environment',
        );
      }
      return parseProcessTable(result.stdout);
    });
    return this.#processes;
  }

  /** The sandbox's listening sockets, read once per verification run. */
  sockets(): Promise<ListeningSocket[]> {
    this.#sockets ??= this.inspect('ss', ['-H', '-lntu']).then((result) => {
      if (result.exitCode !== 0) {
        throw new SandboxUnreachableError(
          result.stderr.trim() || 'could not read listening sockets in your lab environment',
        );
      }
      return parseListeningSockets(result.stdout);
    });
    return this.#sockets;
  }

  /**
   * Parse `terraform.tfstate` in a working directory.
   *
   * Returns `null` when there is no state at all — which is the honest answer
   * for "the student has not applied anything yet", and is reported as such
   * rather than as a parse failure.
   */
  async terraformState(dir: string): Promise<TerraformStateSnapshot | null> {
    const read = await this.path(this.join(dir, TERRAFORM_STATE_FILE));
    if (!read || read.type !== 'file' || read.content === undefined) return null;
    return parseTerraformState(read.content);
  }
}

/** Parse a Terraform state document defensively. Returns null on anything odd. */
export function parseTerraformState(text: string): TerraformStateSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const doc = parsed as Record<string, unknown>;
  const rawResources = Array.isArray(doc.resources) ? doc.resources : [];
  const resources: TerraformStateSnapshot['resources'] = [];

  for (const entry of rawResources) {
    if (typeof entry !== 'object' || entry === null) continue;
    const resource = entry as Record<string, unknown>;
    if (typeof resource.type !== 'string' || typeof resource.name !== 'string') continue;
    resources.push({
      mode: typeof resource.mode === 'string' ? resource.mode : 'managed',
      type: resource.type,
      name: resource.name,
      ...(typeof resource.provider === 'string' ? { provider: resource.provider } : {}),
      instanceCount: Array.isArray(resource.instances) ? resource.instances.length : 0,
    });
  }

  const outputs: TerraformStateSnapshot['outputs'] = {};
  if (typeof doc.outputs === 'object' && doc.outputs !== null) {
    for (const [name, raw] of Object.entries(doc.outputs as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const output = raw as Record<string, unknown>;
      outputs[name] = {
        value: output.value,
        ...(output.type !== undefined ? { type: output.type } : {}),
        ...(typeof output.sensitive === 'boolean' ? { sensitive: output.sensitive } : {}),
      };
    }
  }

  return {
    version: typeof doc.version === 'number' ? doc.version : 0,
    resources,
    outputs,
  };
}

/** Parse `ps -eo pid=,user=,args=` output. Unparseable lines are ignored. */
export function parseProcessTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, user, command] = match;
    entries.push({ pid: Number.parseInt(pid ?? '0', 10), user: user ?? '', command: command ?? '' });
  }
  return entries;
}

/**
 * Parse `ss -H -lntu` output.
 *
 * Columns are `Netid State Recv-Q Send-Q Local:Port Peer:Port`. The local
 * address may be IPv4 (`0.0.0.0:9105`), IPv6 (`[::]:9105`) or a wildcard
 * (`*:9105`), so the port is taken from after the last colon and everything
 * before it is reported as the address.
 */
export function parseListeningSockets(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;

    const netid = columns[0];
    if (netid !== 'tcp' && netid !== 'udp') continue;

    const local = columns[4] ?? '';
    const separator = local.lastIndexOf(':');
    if (separator < 0) continue;

    const port = Number.parseInt(local.slice(separator + 1), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

    sockets.push({ protocol: netid, port, address: local.slice(0, separator) });
  }
  return sockets;
}
