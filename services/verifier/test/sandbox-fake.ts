/**
 * An in-memory sandbox, for the verifier suites.
 *
 * It models what a sandbox can be *asked* — a path read, an allow-listed
 * inspection command, a run of the student's own script — and deliberately
 * models nothing about how a container behaves. It cannot show that
 * `--cap-drop ALL` holds, that a pids limit bites, or that a real `ps` sees
 * what this one claims. Those belong to the integration suites against real
 * Docker; what belongs here is that a *check* reads the right thing and reaches
 * the right verdict from it.
 *
 * The world is stated explicitly by each test rather than derived from running
 * anything, so an assertion can never read as "the fake proved the system
 * works".
 */
import type { SandboxInspectResult, SandboxPathRead } from '@jumptotech/lab-orchestrator';
import type { SandboxPort } from '../src/index.js';

export interface FakeWorld {
  /** Paths as the student would see them, keyed exactly as a lab names them. */
  files?: Record<string, Partial<SandboxPathRead>>;
  /** Process command lines, as `ps -eo pid=,user=,args=` would print them. */
  processes?: string[];
  /** Listening sockets. */
  listening?: Array<{ protocol?: 'tcp' | 'udp'; port: number; address?: string }>;
  /** Accounts that exist, with their primary gid. */
  users?: Record<string, { uid: string; gid: string }>;
  /** Groups that exist, with their gid and secondary members. */
  groups?: Record<string, { gid: string; members?: string[] }>;
  /**
   * Outcomes for `script_runs`, keyed `path arg…`.
   *
   * Keyed by the arguments too, because one script is normally graded several
   * times with different inputs — LINUX-009 runs the same health check against
   * a healthy, a degraded and a missing status file and expects three different
   * exit codes. Keying by path alone would have made that lab untestable.
   */
  scripts?: Record<string, { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean }>;
  /** Outcomes for allow-listed inspection commands, keyed `command argv…`. */
  commands?: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>;
}

export class FakeSandbox implements SandboxPort {
  /** Every path read, so a test can assert what a check actually looked at. */
  readonly reads: string[] = [];
  /** Every inspection command, as `command argv…`. */
  readonly inspections: string[] = [];
  /** Every script the verifier ran, by path. */
  readonly scriptRuns: string[] = [];

  constructor(private world: FakeWorld = {}) {}

  put(pathName: string, entry: Partial<SandboxPathRead>): this {
    this.world.files = { ...(this.world.files ?? {}), [pathName]: entry };
    return this;
  }

  remove(pathName: string): this {
    if (this.world.files) delete this.world.files[pathName];
    return this;
  }

  async read(relativePath: string): Promise<SandboxPathRead | null> {
    this.reads.push(relativePath);
    const entry = this.world.files?.[relativePath];
    if (!entry) return null;
    const content = entry.content ?? '';
    return {
      type: entry.type ?? 'file',
      mode: entry.mode ?? '644',
      owner: entry.owner ?? 'student',
      group: entry.group ?? 'student',
      sizeBytes: entry.sizeBytes ?? content.length,
      ...(entry.type === 'directory' ? {} : { content }),
      ...(entry.truncated ? { truncated: true } : {}),
    };
  }

  async inspect(command: string, args: readonly string[]): Promise<SandboxInspectResult> {
    const key = [command, ...args].join(' ');
    this.inspections.push(key);

    const canned = this.world.commands?.[key];
    if (canned) {
      return {
        exitCode: canned.exitCode ?? 0,
        stdout: canned.stdout ?? '',
        stderr: canned.stderr ?? '',
        timedOut: false,
      };
    }

    switch (command) {
      case 'ps':
        return ok(lines(this.world.processes ?? []));

      case 'ss':
        return ok(
          lines(
            (this.world.listening ?? []).map(
              (s) => `${s.protocol ?? 'tcp'}   LISTEN 0      128    ${s.address ?? '0.0.0.0'}:${s.port}   0.0.0.0:*`,
            ),
          ),
        );

      case 'getent': {
        const [database, key2] = args;
        if (database === 'passwd') {
          const user = this.world.users?.[String(key2)];
          return user
            ? ok(`${String(key2)}:x:${user.uid}:${user.gid}::/home/${String(key2)}:/bin/bash\n`)
            : notFound();
        }
        if (database === 'group') {
          const group = this.world.groups?.[String(key2)];
          return group
            ? ok(`${String(key2)}:x:${group.gid}:${(group.members ?? []).join(',')}\n`)
            : notFound();
        }
        return notFound();
      }

      default:
        return notFound();
    }
  }

  async runScript(
    scriptPath: string,
    args: readonly string[],
    _options?: { timeoutMs?: number },
  ): Promise<SandboxInspectResult> {
    const key = [scriptPath, ...args].join(' ');
    this.scriptRuns.push(key);
    const outcome = this.world.scripts?.[key] ?? this.world.scripts?.[scriptPath];
    if (!outcome) return { exitCode: 127, stdout: '', stderr: 'not found', timedOut: false };
    return {
      exitCode: outcome.exitCode ?? 0,
      stdout: outcome.stdout ?? '',
      stderr: outcome.stderr ?? '',
      timedOut: outcome.timedOut ?? false,
    };
  }
}

/**
 * A sandbox that can be read but not inspected.
 *
 * What a Terraform or Docker sandbox looks like to the verifier: a filesystem,
 * and no process table, account database or script runner. `linux` checks
 * against it must report as *skipped*, not failed — the platform could not
 * look, so the student is not told they got it wrong.
 */
export class ReadOnlyFakeSandbox implements SandboxPort {
  constructor(private readonly inner: FakeSandbox = new FakeSandbox()) {}
  read(relativePath: string): Promise<SandboxPathRead | null> {
    return this.inner.read(relativePath);
  }
}

function lines(list: readonly string[]): string {
  return list.length > 0 ? `${list.join('\n')}\n` : '';
}

function ok(stdout: string): SandboxInspectResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function notFound(): SandboxInspectResult {
  return { exitCode: 2, stdout: '', stderr: '', timedOut: false };
}
