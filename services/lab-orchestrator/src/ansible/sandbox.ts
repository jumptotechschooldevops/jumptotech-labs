/**
 * `AnsibleSandboxPort` backed by the per-session Docker containers.
 *
 * This is the *read* half of the Ansible track: given a sandbox id it can
 * inspect the student's project on the control node, inspect the state their
 * automation produced on the managed nodes, and run the small set of Ansible
 * commands the verifier is allowed to run.
 *
 * The provider (`AnsibleDockerProvider`) owns the *write* half — creating,
 * resetting, and destroying the containers. Splitting them keeps the verifier's
 * dependency honest: it is handed something that can read a sandbox and run
 * `ansible`, and nothing that can create or delete one.
 *
 * Everything here goes through `docker exec` with an explicit argv array. There
 * is no shell anywhere in this file, and no string built by concatenating a
 * lab-supplied value into a command.
 */
import { randomBytes } from 'node:crypto';
import type {
  AnsibleCommand,
  AnsibleHostStats,
  AnsibleNodeName,
  AnsiblePathInfo,
  AnsiblePlaybookRun,
  AnsibleRunResult,
  AnsibleSandboxPort,
} from './port.js';
import { AnsibleSandboxUnreachableError, ForbiddenSandboxPathError, MAX_READ_BYTES } from './port.js';
import { resolveManagedPath, resolveWorkspacePath } from './paths.js';
import type { DockerExecResult, DockerPort } from './docker-port.js';
import {
  ANSIBLE_CALLBACK_DIR,
  ANSIBLE_CALLBACK_NAME,
  ANSIBLE_SHELL_USER,
  ANSIBLE_WORKSPACE_DIR,
  DEFAULT_MANAGED_NODE_COUNT,
  nodeByName,
  topologyFor,
  type AnsibleTopology,
} from './topology.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_PLAYBOOK_TIMEOUT_MS = 180_000;

/** Inventory patterns and playbook names a command may carry. */
const SAFE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:,!&*-]{0,63}$/;

export interface DockerAnsibleSandboxOptions {
  docker: DockerPort;
  managedNodeCount?: number;
  commandTimeoutMs?: number;
  playbookTimeoutMs?: number;
}

export class DockerAnsibleSandbox implements AnsibleSandboxPort {
  readonly workspaceDir = ANSIBLE_WORKSPACE_DIR;

  readonly #docker: DockerPort;
  readonly #managedNodeCount: number;
  readonly #commandTimeoutMs: number;
  readonly #playbookTimeoutMs: number;

  constructor(options: DockerAnsibleSandboxOptions) {
    this.#docker = options.docker;
    this.#managedNodeCount = options.managedNodeCount ?? DEFAULT_MANAGED_NODE_COUNT;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#playbookTimeoutMs = options.playbookTimeoutMs ?? DEFAULT_PLAYBOOK_TIMEOUT_MS;
  }

  topology(sandboxId: string): AnsibleTopology {
    return topologyFor(sandboxId, this.#managedNodeCount);
  }

  managedNodes(sandboxId: string): readonly AnsibleNodeName[] {
    return this.topology(sandboxId).managed.map((node) => node.name);
  }

  async ping(sandboxId: string): Promise<void> {
    const topology = this.topology(sandboxId);
    const info = await this.#docker.inspectContainer(topology.control.container);
    if (!info) {
      throw new AnsibleSandboxUnreachableError(
        `the control node for this session is not running (${topology.control.container} does not exist)`,
      );
    }
    if (info.state !== 'running') {
      throw new AnsibleSandboxUnreachableError(
        `the control node for this session is ${info.state}, not running`,
      );
    }
  }

  // ------------------------------------------------------- workspace reads

  async readWorkspaceFile(sandboxId: string, relativePath: string): Promise<string | null> {
    const absolute = resolveWorkspacePath(this.workspaceDir, relativePath);
    return this.#readFile(this.topology(sandboxId).control.container, absolute, ANSIBLE_SHELL_USER);
  }

  async statWorkspacePath(sandboxId: string, relativePath: string): Promise<AnsiblePathInfo> {
    const absolute = resolveWorkspacePath(this.workspaceDir, relativePath);
    return this.#stat(this.topology(sandboxId).control.container, absolute, ANSIBLE_SHELL_USER);
  }

  async listWorkspaceDirectory(sandboxId: string, relativePath: string): Promise<string[] | null> {
    const absolute = resolveWorkspacePath(this.workspaceDir, relativePath);
    const result = await this.#exec(this.topology(sandboxId).control.container, {
      argv: ['ls', '-1A', absolute],
      user: ANSIBLE_SHELL_USER,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // ---------------------------------------------------- managed node reads

  async readManagedFile(
    sandboxId: string,
    node: AnsibleNodeName,
    absolutePath: string,
  ): Promise<string | null> {
    const target = resolveManagedPath(absolutePath);
    return this.#readFile(this.#managedContainer(sandboxId, node), target, 'root');
  }

  async statManagedPath(
    sandboxId: string,
    node: AnsibleNodeName,
    absolutePath: string,
  ): Promise<AnsiblePathInfo> {
    const target = resolveManagedPath(absolutePath);
    return this.#stat(this.#managedContainer(sandboxId, node), target, 'root');
  }

  /**
   * Remove a managed-node path.
   *
   * The only caller is the idempotency check, which needs a known-clean
   * baseline before its first run. The path goes through the same allow-list as
   * every read, so this can only ever clear directories the labs themselves
   * write into.
   */
  async removeManagedPath(
    sandboxId: string,
    node: AnsibleNodeName,
    absolutePath: string,
  ): Promise<void> {
    const target = resolveManagedPath(absolutePath);
    await this.#exec(this.#managedContainer(sandboxId, node), {
      argv: ['rm', '-rf', target],
      user: 'root',
    });
  }

  async processRunning(
    sandboxId: string,
    node: AnsibleNodeName,
    processName: string,
  ): Promise<boolean> {
    if (!SAFE_PATTERN.test(processName)) {
      throw new ForbiddenSandboxPathError(processName, 'not a valid process name');
    }
    const result = await this.#exec(this.#managedContainer(sandboxId, node), {
      argv: ['pgrep', '-x', processName],
      user: 'root',
    });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  // ------------------------------------------------------- ansible commands

  async run(sandboxId: string, command: AnsibleCommand): Promise<AnsibleRunResult> {
    const argv = toArgv(command);
    const result = await this.#exec(this.topology(sandboxId).control.container, {
      argv,
      user: ANSIBLE_SHELL_USER,
      workdir: this.workspaceDir,
      env: baseAnsibleEnv(),
      timeoutMs: this.#commandTimeoutMs,
    });
    return toRunResult(result);
  }

  /**
   * Run a playbook and read back the structured recap.
   *
   * The stats file name is random per run, so two concurrent checks in one
   * sandbox cannot read each other's numbers, and it is removed afterwards so a
   * later run can never observe a stale result.
   */
  async runPlaybook(sandboxId: string, playbook: string): Promise<AnsiblePlaybookRun> {
    assertSafePattern(playbook, 'playbook');
    const container = this.topology(sandboxId).control.container;
    const statsFile = `/tmp/jtt-stats-${randomBytes(8).toString('hex')}.json`;

    const result = await this.#exec(container, {
      argv: ['ansible-playbook', playbook],
      user: ANSIBLE_SHELL_USER,
      workdir: this.workspaceDir,
      env: {
        ...baseAnsibleEnv(),
        ANSIBLE_CALLBACK_PLUGINS: ANSIBLE_CALLBACK_DIR,
        ANSIBLE_CALLBACKS_ENABLED: ANSIBLE_CALLBACK_NAME,
        JTT_STATS_FILE: statsFile,
      },
      timeoutMs: this.#playbookTimeoutMs,
    });

    const stats = await this.#readStats(container, statsFile);
    await this.#exec(container, { argv: ['rm', '-f', statsFile], user: ANSIBLE_SHELL_USER });

    return { ...toRunResult(result), stats };
  }

  async #readStats(
    container: string,
    statsFile: string,
  ): Promise<Record<string, AnsibleHostStats> | null> {
    const raw = await this.#readFile(container, statsFile, ANSIBLE_SHELL_USER);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { hosts?: Record<string, AnsibleHostStats> };
      return parsed.hosts ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- private

  #managedContainer(sandboxId: string, node: AnsibleNodeName): string {
    const topology = this.topology(sandboxId);
    const found = nodeByName(topology, node);
    if (!found || found.role !== 'managed') {
      throw new ForbiddenSandboxPathError(
        node,
        `not a managed node in this sandbox (expected one of ${topology.managed.map((n) => n.name).join(', ')})`,
      );
    }
    return found.container;
  }

  async #readFile(container: string, absolute: string, user: string): Promise<string | null> {
    // `head -c` bounds the read: a lab cannot make the verifier pull an
    // arbitrarily large file into the API process's memory.
    const result = await this.#exec(container, {
      argv: ['head', '-c', String(MAX_READ_BYTES), absolute],
      user,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  async #stat(container: string, absolute: string, user: string): Promise<AnsiblePathInfo> {
    const result = await this.#exec(container, {
      argv: ['stat', '-c', '%F|%a|%U|%G|%s', absolute],
      user,
    });
    if (result.exitCode !== 0) {
      return { path: absolute, exists: false, kind: 'other' };
    }

    const [description = '', mode = '', owner = '', group = '', size = ''] = result.stdout
      .trim()
      .split('|');
    const parsedSize = Number.parseInt(size, 10);

    return {
      path: absolute,
      exists: true,
      kind: describeKind(description),
      mode: mode.padStart(4, '0'),
      owner,
      group,
      ...(Number.isFinite(parsedSize) ? { sizeBytes: parsedSize } : {}),
    };
  }

  async #exec(
    container: string,
    spec: {
      argv: string[];
      user?: string;
      workdir?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<DockerExecResult> {
    return this.#docker.exec({
      container,
      argv: spec.argv,
      ...(spec.user ? { user: spec.user } : {}),
      ...(spec.workdir ? { workdir: spec.workdir } : {}),
      env: { HOME: '/home/student', ...(spec.env ?? {}) },
      timeoutMs: spec.timeoutMs ?? this.#commandTimeoutMs,
    });
  }
}

function describeKind(description: string): AnsiblePathInfo['kind'] {
  const text = description.toLowerCase();
  if (text.includes('directory')) return 'directory';
  if (text.includes('symbolic link')) return 'symlink';
  if (text.includes('file')) return 'file';
  return 'other';
}

function assertSafePattern(value: string, what: string): void {
  if (!SAFE_PATTERN.test(value)) {
    throw new ForbiddenSandboxPathError(value, `not a valid ${what}`);
  }
}

/**
 * Environment shared by every Ansible invocation the platform makes.
 *
 * Colour and cowsay are off so output stays diffable, retry files are off so a
 * check never litters the student's project, and host key checking is off
 * because sandbox host keys are generated per container and per session — there
 * is no stable identity to pin, and nothing outside the session network to
 * confuse it with.
 */
function baseAnsibleEnv(): Record<string, string> {
  return {
    ANSIBLE_HOST_KEY_CHECKING: 'False',
    ANSIBLE_RETRY_FILES_ENABLED: 'False',
    ANSIBLE_FORCE_COLOR: '0',
    ANSIBLE_NOCOWS: '1',
    ANSIBLE_DEPRECATION_WARNINGS: 'False',
    PATH: '/usr/local/bin:/usr/bin:/bin',
  };
}

/** Map a closed command variant to its fixed argv. */
function toArgv(command: AnsibleCommand): string[] {
  switch (command.kind) {
    case 'inventory':
      return ['ansible-inventory', '--list'];
    case 'ping':
      assertSafePattern(command.pattern, 'inventory pattern');
      return ['ansible', command.pattern, '-m', 'ping'];
    case 'syntax-check':
      assertSafePattern(command.playbook, 'playbook');
      return ['ansible-playbook', '--syntax-check', command.playbook];
    case 'playbook':
      assertSafePattern(command.playbook, 'playbook');
      return ['ansible-playbook', command.playbook];
    default: {
      const exhaustive: never = command;
      throw new Error(`unhandled ansible command ${JSON.stringify(exhaustive)}`);
    }
  }
}

function toRunResult(result: DockerExecResult): AnsibleRunResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}
