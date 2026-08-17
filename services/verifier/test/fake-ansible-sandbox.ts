/**
 * In-memory `AnsibleSandboxPort` for verifier handler tests.
 *
 * Models the two things handlers read — the student's project on the control
 * node and the state on the managed nodes — plus scripted results for the four
 * Ansible commands the platform is allowed to run.
 *
 * The command results are scripted rather than simulated. Faking Ansible's own
 * behaviour would let these tests "prove" that a playbook converges against a
 * mock; that property is proven against real containers in the orchestrator's
 * `ansible-integration.test.ts`. What these tests do prove is that each handler
 * reaches the right verdict from a given observation, which is the part that
 * lives in this package.
 */
import {
  ForbiddenSandboxPathError,
  resolveManagedPath,
  resolveWorkspacePath,
  type AnsibleCommand,
  type AnsibleNodeName,
  type AnsiblePathInfo,
  type AnsiblePlaybookRun,
  type AnsibleRunResult,
  type AnsibleSandboxPort,
} from '@jumptotech/lab-orchestrator';

export interface FakeSandboxOptions {
  /** Project files on the control node, keyed by workspace-relative path. */
  workspace?: Record<string, string>;
  /** Directories that exist in the project but hold no listed files. */
  workspaceDirectories?: string[];
  /** Managed-node files: `{ node1: { '/etc/jumptotech/app.conf': '…' } }`. */
  managed?: Record<string, Record<string, string>>;
  /** Managed-node directories. */
  managedDirectories?: Record<string, string[]>;
  /** Running process names per node. */
  processes?: Record<string, string[]>;
  nodes?: string[];
  /** Result of `ansible-inventory --list`. */
  inventory?: AnsibleRunResult;
  /** Result of `ansible <pattern> -m ping`, keyed by pattern (`*` = any). */
  ping?: Record<string, AnsibleRunResult>;
  /** Result of `ansible-playbook --syntax-check <playbook>`. */
  syntaxCheck?: Record<string, AnsibleRunResult>;
  /** Consumed in order, one per `runPlaybook` call. */
  playbookRuns?: AnsiblePlaybookRun[];
}

const OK: AnsibleRunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };

export class FakeAnsibleSandbox implements AnsibleSandboxPort {
  readonly workspaceDir = '/home/student/lab';

  readonly workspace = new Map<string, string>();
  readonly workspaceDirs = new Set<string>();
  readonly managed = new Map<string, Map<string, string>>();
  readonly managedDirs = new Map<string, Set<string>>();
  readonly processes = new Map<string, Set<string>>();
  /** Every managed path this sandbox was asked to delete, in order. */
  readonly removed: Array<{ node: string; path: string }> = [];
  /** Every playbook run requested, in order. */
  readonly playbookCalls: string[] = [];

  #nodes: string[];
  #inventory: AnsibleRunResult;
  #ping: Record<string, AnsibleRunResult>;
  #syntax: Record<string, AnsibleRunResult>;
  #runs: AnsiblePlaybookRun[];

  constructor(options: FakeSandboxOptions = {}) {
    this.#nodes = options.nodes ?? ['node1', 'node2'];

    for (const [file, content] of Object.entries(options.workspace ?? {})) {
      this.workspace.set(file, content);
      for (const dir of parents(file)) this.workspaceDirs.add(dir);
    }
    for (const dir of options.workspaceDirectories ?? []) this.workspaceDirs.add(dir);

    for (const node of this.#nodes) {
      this.managed.set(node, new Map());
      this.managedDirs.set(node, new Set());
      this.processes.set(node, new Set());
    }
    for (const [node, files] of Object.entries(options.managed ?? {})) {
      const bucket = this.managed.get(node) ?? new Map();
      for (const [file, content] of Object.entries(files)) bucket.set(file, content);
      this.managed.set(node, bucket);
    }
    for (const [node, dirs] of Object.entries(options.managedDirectories ?? {})) {
      this.managedDirs.set(node, new Set(dirs));
    }
    for (const [node, names] of Object.entries(options.processes ?? {})) {
      this.processes.set(node, new Set(names));
    }

    this.#inventory = options.inventory ?? OK;
    this.#ping = options.ping ?? {};
    this.#syntax = options.syntaxCheck ?? {};
    this.#runs = [...(options.playbookRuns ?? [])];
  }

  managedNodes(): readonly AnsibleNodeName[] {
    return this.#nodes;
  }

  async ping(): Promise<void> {
    /* always up in the fake */
  }

  // ------------------------------------------------------------- workspace

  async readWorkspaceFile(_sandbox: string, relativePath: string): Promise<string | null> {
    resolveWorkspacePath(this.workspaceDir, relativePath);
    return this.workspace.get(relativePath) ?? null;
  }

  async statWorkspacePath(_sandbox: string, relativePath: string): Promise<AnsiblePathInfo> {
    resolveWorkspacePath(this.workspaceDir, relativePath);
    if (this.workspace.has(relativePath)) {
      return { path: relativePath, exists: true, kind: 'file', mode: '0644' };
    }
    if (this.workspaceDirs.has(relativePath)) {
      return { path: relativePath, exists: true, kind: 'directory', mode: '0755' };
    }
    return { path: relativePath, exists: false, kind: 'other' };
  }

  async listWorkspaceDirectory(_sandbox: string, relativePath: string): Promise<string[] | null> {
    resolveWorkspacePath(this.workspaceDir, relativePath);
    if (!this.workspaceDirs.has(relativePath)) return null;
    const prefix = `${relativePath}/`;
    const names = new Set<string>();
    for (const file of this.workspace.keys()) {
      if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('/')[0] ?? '');
    }
    return [...names].filter(Boolean).sort();
  }

  // ---------------------------------------------------------- managed node

  async readManagedFile(
    _sandbox: string,
    node: AnsibleNodeName,
    absolutePath: string,
  ): Promise<string | null> {
    this.#assertManaged(node);
    const target = resolveManagedPath(absolutePath);
    return this.managed.get(node)?.get(target) ?? null;
  }

  async statManagedPath(
    _sandbox: string,
    node: AnsibleNodeName,
    absolutePath: string,
  ): Promise<AnsiblePathInfo> {
    this.#assertManaged(node);
    const target = resolveManagedPath(absolutePath);
    if (this.managed.get(node)?.has(target)) {
      return { path: target, exists: true, kind: 'file', mode: '0644' };
    }
    if (this.managedDirs.get(node)?.has(target)) {
      return { path: target, exists: true, kind: 'directory', mode: '0755' };
    }
    return { path: target, exists: false, kind: 'other' };
  }

  async removeManagedPath(
    _sandbox: string,
    node: AnsibleNodeName,
    absolutePath: string,
  ): Promise<void> {
    this.#assertManaged(node);
    const target = resolveManagedPath(absolutePath);
    this.removed.push({ node, path: target });

    const files = this.managed.get(node);
    for (const key of [...(files?.keys() ?? [])]) {
      if (key === target || key.startsWith(`${target}/`)) files?.delete(key);
    }
    const dirs = this.managedDirs.get(node);
    for (const key of [...(dirs ?? [])]) {
      if (key === target || key.startsWith(`${target}/`)) dirs?.delete(key);
    }
  }

  async processRunning(
    _sandbox: string,
    node: AnsibleNodeName,
    processName: string,
  ): Promise<boolean> {
    this.#assertManaged(node);
    return this.processes.get(node)?.has(processName) ?? false;
  }

  #assertManaged(node: string): void {
    if (!this.#nodes.includes(node)) {
      throw new ForbiddenSandboxPathError(node, 'not a managed node in this sandbox');
    }
  }

  // -------------------------------------------------------------- commands

  async run(_sandbox: string, command: AnsibleCommand): Promise<AnsibleRunResult> {
    switch (command.kind) {
      case 'inventory':
        return this.#inventory;
      case 'ping':
        return this.#ping[command.pattern] ?? this.#ping['*'] ?? OK;
      case 'syntax-check':
        return this.#syntax[command.playbook] ?? OK;
      case 'playbook':
        return OK;
    }
  }

  async runPlaybook(_sandbox: string, playbook: string): Promise<AnsiblePlaybookRun> {
    this.playbookCalls.push(playbook);
    const next = this.#runs.shift();
    if (next) return next;
    return { ...OK, stats: {} };
  }
}

/** Convenience builder for a scripted playbook run. */
export function playbookRun(
  stats: Record<string, Partial<{ ok: number; changed: number; failures: number; unreachable: number; skipped: number }>> | null,
  overrides: Partial<AnsiblePlaybookRun> = {},
): AnsiblePlaybookRun {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    stats:
      stats === null
        ? null
        : Object.fromEntries(
            Object.entries(stats).map(([host, counts]) => [
              host,
              { ok: 0, changed: 0, failures: 0, unreachable: 0, skipped: 0, ...counts },
            ]),
          ),
    ...overrides,
  };
}

/** Convenience builder for `ansible-inventory --list` output. */
export function inventoryJson(groups: Record<string, string[]>, hostvars: string[] = []): AnsibleRunResult {
  const payload: Record<string, unknown> = {
    _meta: { hostvars: Object.fromEntries(hostvars.map((host) => [host, {}])) },
    all: { children: ['ungrouped', ...Object.keys(groups)] },
  };
  for (const [group, hosts] of Object.entries(groups)) payload[group] = { hosts };
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false };
}

/** Convenience builder for `ansible … -m ping` output. */
export function pingOutput(results: Record<string, 'SUCCESS' | 'UNREACHABLE' | 'FAILED'>): AnsibleRunResult {
  const lines = Object.entries(results).map(
    ([host, status]) => `${host} | ${status}${status === 'SUCCESS' ? ' => ' : '! => '}{"ping": "pong"}`,
  );
  const bad = Object.values(results).some((status) => status !== 'SUCCESS');
  return { exitCode: bad ? 2 : 0, stdout: lines.join('\n'), stderr: '', timedOut: false };
}

function parents(file: string): string[] {
  const segments = file.split('/').slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}
