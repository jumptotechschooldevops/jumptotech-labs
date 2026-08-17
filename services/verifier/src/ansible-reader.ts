/**
 * Memoised, sandbox-scoped reads for one Ansible verification run.
 *
 * The counterpart to `VerifyReader`, and it exists for the same two reasons.
 *
 * **Consistency.** A lab typically asks several questions about one artefact
 * ("does site.yml parse", "does it have a template task", "does that task
 * notify the handler"). Reading and parsing it once per run keeps a single
 * report self-consistent, and stops one Check from shelling into a container
 * a dozen times.
 *
 * **Confinement.** The sandbox id is fixed at construction, and every method
 * passes it through. A handler is never given the chance to name a sandbox, so
 * it cannot read another student's environment even by accident.
 *
 * Playbook *runs* are deliberately not memoised. Running a playbook is the one
 * operation with a side effect, and the idempotency check needs two distinct,
 * ordered runs — caching them would silently turn the check into a tautology.
 */
import type {
  AnsibleNodeName,
  AnsiblePathInfo,
  AnsiblePlaybookRun,
  AnsibleRunResult,
  AnsibleSandboxPort,
} from '@jumptotech/lab-orchestrator';
import { parseInventoryJson, parseYamlText, type ParsedInventory, type ParsedYaml } from './ansible-yaml.js';

/** How a requirement selects managed nodes. */
export type HostSelection = 'all' | readonly string[];

export interface InventoryReading {
  /** Exit code of `ansible-inventory --list`. */
  exitCode: number;
  /** Present when the command succeeded and its output parsed as JSON. */
  inventory?: ParsedInventory;
  /** Why the inventory could not be read. Student-facing. */
  error?: string;
}

export class AnsibleVerifyReader {
  readonly #cache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly sandbox: AnsibleSandboxPort,
    readonly sandboxId: string,
  ) {}

  #once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#cache.get(key);
    if (existing) return existing as Promise<T>;
    const promise = load();
    this.#cache.set(key, promise);
    return promise;
  }

  get workspaceDir(): string {
    return this.sandbox.workspaceDir;
  }

  // ------------------------------------------------------------- topology

  managedNodes(): readonly AnsibleNodeName[] {
    return this.sandbox.managedNodes(this.sandboxId);
  }

  /** Expand a requirement's host selection into concrete node names. */
  resolveHosts(selection: HostSelection): string[] {
    if (selection === 'all') return [...this.managedNodes()];
    return [...selection];
  }

  // ------------------------------------------------------ project reading

  workspaceFile(relativePath: string): Promise<string | null> {
    return this.#once(`file:${relativePath}`, () =>
      this.sandbox.readWorkspaceFile(this.sandboxId, relativePath),
    );
  }

  workspacePath(relativePath: string): Promise<AnsiblePathInfo> {
    return this.#once(`stat:${relativePath}`, () =>
      this.sandbox.statWorkspacePath(this.sandboxId, relativePath),
    );
  }

  workspaceDirectory(relativePath: string): Promise<string[] | null> {
    return this.#once(`dir:${relativePath}`, () =>
      this.sandbox.listWorkspaceDirectory(this.sandboxId, relativePath),
    );
  }

  /**
   * Read and parse one project file as YAML.
   *
   * `null` means the file is not there — meaningfully different from a parse
   * failure, and the handlers report the two differently.
   */
  yaml(relativePath: string): Promise<ParsedYaml | null> {
    return this.#once(`yaml:${relativePath}`, async () => {
      const text = await this.workspaceFile(relativePath);
      return text === null ? null : parseYamlText(text);
    });
  }

  // ------------------------------------------------- managed node reading

  managedFile(node: AnsibleNodeName, absolutePath: string): Promise<string | null> {
    return this.#once(`managed-file:${node}:${absolutePath}`, () =>
      this.sandbox.readManagedFile(this.sandboxId, node, absolutePath),
    );
  }

  managedPath(node: AnsibleNodeName, absolutePath: string): Promise<AnsiblePathInfo> {
    return this.#once(`managed-stat:${node}:${absolutePath}`, () =>
      this.sandbox.statManagedPath(this.sandboxId, node, absolutePath),
    );
  }

  processRunning(node: AnsibleNodeName, processName: string): Promise<boolean> {
    return this.#once(`proc:${node}:${processName}`, () =>
      this.sandbox.processRunning(this.sandboxId, node, processName),
    );
  }

  /** Clear a managed path. Only the idempotency baseline uses this. */
  removeManagedPath(node: AnsibleNodeName, absolutePath: string): Promise<void> {
    return this.sandbox.removeManagedPath(this.sandboxId, node, absolutePath);
  }

  // ---------------------------------------------------- ansible commands

  /** `ansible-inventory --list`, parsed. Run at most once per verification. */
  inventory(): Promise<InventoryReading> {
    return this.#once('inventory', async () => {
      const result = await this.sandbox.run(this.sandboxId, { kind: 'inventory' });
      if (result.exitCode !== 0) {
        return {
          exitCode: result.exitCode,
          error: firstMeaningfulLine(result.stderr) || 'ansible-inventory could not read the inventory',
        };
      }
      try {
        return { exitCode: 0, inventory: parseInventoryJson(JSON.parse(result.stdout)) };
      } catch {
        return { exitCode: 0, error: 'ansible-inventory did not return valid JSON' };
      }
    });
  }

  /** `ansible <pattern> -m ping` — a real SSH round trip to every matched host. */
  ping(pattern: string): Promise<AnsibleRunResult> {
    return this.#once(`ping:${pattern}`, () =>
      this.sandbox.run(this.sandboxId, { kind: 'ping', pattern }),
    );
  }

  syntaxCheck(playbook: string): Promise<AnsibleRunResult> {
    return this.#once(`syntax:${playbook}`, () =>
      this.sandbox.run(this.sandboxId, { kind: 'syntax-check', playbook }),
    );
  }

  /** Run a playbook. Never memoised — see the note at the top of this file. */
  runPlaybook(playbook: string): Promise<AnsiblePlaybookRun> {
    return this.sandbox.runPlaybook(this.sandboxId, playbook);
  }
}

/** First line of stderr that is worth showing a student. */
export function firstMeaningfulLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^\[WARNING\]/i.test(line)) ?? ''
  );
}
