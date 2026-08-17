/**
 * `LabProvider` backed by a private directory per session.
 *
 * This is the file-backed sibling of `KindLabProvider`. Where that one hands a
 * student a Kubernetes namespace, this one hands them a project: a directory
 * seeded from the lab's `setup.workspace`, which they edit from their shell and
 * which the verifier reads. CI/CD is its first consumer; the Linux, Docker and
 * Terraform tracks are expected to share it rather than each growing a provider
 * of their own, which is why nothing here mentions CI, Actions, or Jenkins.
 *
 * ```text
 *   <root>/
 *     lab-3f9c1a7b2d40/          ← one session's workspace: HOME, cwd, project
 *     lab-88b0e2c94117/          ← another session's; different bytes, always
 *     .index/
 *       lab-3f9c1a7b2d40.json    ← ownership + expiry, platform-only
 * ```
 *
 * The directory *name* is the session's `namespace` — the same HMAC-derived,
 * one-way identifier the Kubernetes provider uses. Reusing it is what keeps the
 * session manager, the reaper, and the API routes provider-agnostic: they deal
 * in "this session's isolation unit", and a namespace and a workspace are two
 * spellings of that.
 *
 * The metadata index lives *outside* the seeded tree, deliberately: a student
 * `ls`-ing their own workspace sees their project and nothing of the platform's,
 * and a Reset — which empties the workspace — cannot destroy the record that
 * says who owns it.
 *
 * ### What this isolates, and what it does not
 *
 * Isolated, and covered by tests: each session's project files, artifacts,
 * build outputs, temporary files, and shell environment. A reset of one session
 * cannot touch another's; ending one cannot end another's.
 *
 * NOT isolated in this MVP: the operating-system boundary. Every PTY runs as
 * the same UID inside the terminal container, so directory permissions cannot
 * stop a determined student from reading a peer's workspace — the names are
 * HMAC-derived and unguessable and the modes exclude everyone else on the host,
 * which raises the bar without being a boundary. The real fix is one container
 * (or one OS user) per session, and it is the next story rather than something
 * this file quietly claims to have done. See README → CI/CD sandbox.
 */
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CreateResult,
  DestroyResult,
  EnvironmentInfo,
  ExecRequest,
  ExecResult,
  LabError,
  LabProvider,
  LabSessionContext,
  ManagedNamespace,
  ProvisionStep,
  ResetResult,
  StudentCredentials,
  VerificationEvidence,
} from '../types.js';
import { assertValidLabNamespace, isLabNamespace } from '../session/identifiers.js';
import { loadWorkspaceSeed, type SeedFile } from '../workspace/seed.js';
import { FsWorkspace } from '../workspace/fs-workspace.js';
import type { WorkspacePort } from '../workspace/port.js';
import { isWorkspaceTaskId, workspaceTask, type WorkspaceTaskId } from '../workspace/tasks.js';
import type { Requirement } from '../requirements.js';

/** Directory holding per-session ownership records. Never a workspace itself. */
export const INDEX_DIRECTORY = '.index';

/**
 * Mode for a session workspace, its files, and the index.
 *
 * Owner and group, no world access. The group bit is not slack: the API
 * process seeds and verifies the workspace while the terminal process runs the
 * student's shell in it, and in the shipped deployment those are two
 * containers with two different users sharing one volume — so the volume's
 * group is what lets both reach it while nothing else on the host can.
 *
 * Note carefully what this does *not* do. Every student PTY runs as the same
 * user inside the terminal container, so no file mode can stop one student
 * from reading another's workspace; the names are unguessable and the
 * functional isolation is real, but the OS boundary is not. A container (or an
 * OS user) per session is the fix, and it is the next story — see the class
 * comment and README → CI/CD sandbox.
 */
const PRIVATE_DIR_MODE = 0o770;
const PRIVATE_FILE_MODE = 0o660;
const EXECUTABLE_FILE_MODE = 0o770;

/**
 * Setup verification, injected.
 *
 * Mirrors `KindLabProvider`'s `RequirementWaiter`: the verifier package depends
 * on this one, so the provider cannot import it without a cycle. The
 * composition root supplies the function.
 */
export type WorkspaceRequirementWaiter = (input: {
  workspace: WorkspacePort;
  namespace: string;
  requirements: readonly Requirement[];
  timeoutMs: number;
}) => Promise<{ ok: boolean; checks: Array<{ label: string; status: string; detail?: string }> }>;

/** The ownership record written beside each workspace. */
interface WorkspaceIndexEntry {
  namespace: string;
  sessionId: string;
  labId: string;
  createdAt: string;
  expiresAtMs: number;
  /** Marks the directory as ours, the way the namespace label does in kind. */
  managedBy: 'jumptotech.io';
}

export interface WorkspaceProviderOptions {
  /** Directory holding every session workspace. Must not be a shared temp dir. */
  root: string;
  /** Names the environment id; matches `LAB_WORKSPACE_ROOT` in configuration. */
  environmentName?: string;
  waitForRequirements?: WorkspaceRequirementWaiter;
  now?: () => number;
}

export class WorkspaceLabProvider implements LabProvider {
  readonly name = 'workspace';

  readonly #root: string;
  readonly #environmentName: string;
  readonly #wait: WorkspaceRequirementWaiter | undefined;
  readonly #now: () => number;

  constructor(options: WorkspaceProviderOptions) {
    this.#root = path.resolve(options.root);
    this.#environmentName = options.environmentName ?? 'workspaces';
    this.#wait = options.waitForRequirements;
    this.#now = options.now ?? (() => Date.now());
  }

  get root(): string {
    return this.#root;
  }

  /** Absolute path of one session's workspace. The name is always validated. */
  workspacePath(namespace: string): string {
    return path.join(this.#root, assertValidLabNamespace(namespace));
  }

  /** A read port bound to one session's workspace. */
  workspaceFor(namespace: string): WorkspacePort {
    return new FsWorkspace({ root: this.workspacePath(namespace) });
  }

  environmentId(context: LabSessionContext): string {
    return `${this.name}:${this.#environmentName}/${context.namespace}#${context.labId}`;
  }

  #environment(
    context: LabSessionContext,
    phase: EnvironmentInfo['phase'],
    extra: Partial<EnvironmentInfo> = {},
  ): EnvironmentInfo {
    return {
      environmentId: this.environmentId(context),
      provider: this.name,
      phase,
      namespace: context.namespace,
      sessionId: context.sessionId,
      ...extra,
    };
  }

  // ---------------------------------------------------------------- create

  async create(context: LabSessionContext): Promise<CreateResult> {
    const steps: ProvisionStep[] = [];
    assertValidLabNamespace(context.namespace);
    let summary: string | undefined;

    const createStep = await this.#runStep(steps, 'environment-created', 'Workspace created', async () => {
      // Re-creating an existing workspace resets it to the lab baseline rather
      // than failing — providers are required to be idempotent.
      await this.#emptyWorkspace(context.namespace);
      await mkdir(this.workspacePath(context.namespace), { recursive: true, mode: PRIVATE_DIR_MODE });
      await chmod(this.workspacePath(context.namespace), PRIVATE_DIR_MODE);
      await this.#writeIndex(context);
      return `private workspace ${context.namespace} created`;
    });
    if (!createStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'error', { message: createStep.detail }),
        steps,
        error: this.#toLabError(createStep.error, 'PROVISION_FAILED', {
          remediation: `Check that LAB_WORKSPACE_ROOT (${this.#root}) exists and is writable by the api process.`,
        }),
      };
    }

    const toolchainStep = await this.#runStep(steps, 'toolchain', 'Toolchain ready', async () => {
      const result = await this.workspaceFor(context.namespace).runTask('node_version');
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `node exited with code ${result.exitCode}`);
      }
      summary = `Node.js ${result.stdout.trim() || 'unknown'}`;
      return summary;
    });
    if (!toolchainStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'degraded', { message: toolchainStep.detail }),
        steps,
        error: this.#toLabError(toolchainStep.error, 'EXEC_FAILED', {
          remediation: 'A Node.js runtime must be available to the api process for workspace labs.',
        }),
      };
    }

    if (context.lab.setup.workspace) {
      const seedStep = await this.#runStep(steps, 'lab-initial-state', 'Lab project files ready', () =>
        this.#applySeed(context),
      );
      if (!seedStep.ok) {
        return {
          ok: false,
          environment: this.#environment(context, 'degraded', { message: seedStep.detail }),
          steps,
          error: this.#toLabError(seedStep.error, 'SETUP_FAILED', {
            remediation: `Check the workspace seed declared by ${context.labId}.`,
          }),
        };
      }
    }

    return {
      ok: true,
      environment: this.#environment(context, 'ready', { ...(summary ? { summary } : {}) }),
      steps,
    };
  }

  // ---------------------------------------------------------------- status

  async status(context: LabSessionContext): Promise<EnvironmentInfo> {
    try {
      const info = await stat(this.workspacePath(context.namespace)).catch(() => null);
      if (!info || !info.isDirectory()) {
        return this.#environment(context, 'not_created', {
          message: `workspace ${context.namespace} does not exist`,
        });
      }
      const entries = await readdir(this.workspacePath(context.namespace)).catch(() => []);
      return this.#environment(context, 'ready', {
        summary: `workspace · ${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'}`,
      });
    } catch (error) {
      return this.#environment(context, 'error', { message: describe(error) });
    }
  }

  // ----------------------------------------------------------------- reset

  /**
   * Restore the lab's starting condition: empty the workspace, re-seed it.
   *
   * The workspace directory itself survives, so the student's shell keeps its
   * working directory and their session is untouched — the same contract the
   * Kubernetes provider offers by keeping the namespace and purging inside it.
   */
  async reset(context: LabSessionContext): Promise<ResetResult> {
    assertValidLabNamespace(context.namespace);
    const steps: ProvisionStep[] = [];
    let removed: string[] = [];
    let restored: string[] = [];

    const purgeStep = await this.#runStep(steps, 'purge', 'Student files removed', async () => {
      removed = await this.#emptyWorkspaceContents(context.namespace);
      await mkdir(this.workspacePath(context.namespace), { recursive: true, mode: PRIVATE_DIR_MODE });
      return removed.length > 0 ? removed.join(', ') : 'nothing to remove';
    });
    if (!purgeStep.ok) {
      return this.#failedReset(context, steps, removed, restored, purgeStep.error);
    }

    if (context.lab.setup.workspace) {
      const restoreStep = await this.#runStep(steps, 'restore', 'Lab project files restored', async () => {
        const detail = await this.#applySeed(context);
        restored = (await loadWorkspaceSeed(context.lab)).map((file) => file.path);
        return detail;
      });
      if (!restoreStep.ok) {
        return this.#failedReset(context, steps, removed, restored, restoreStep.error, 'SETUP_FAILED');
      }
    }

    const healthStep = await this.#runStep(steps, 'health', 'Workspace healthy', async () => {
      const info = await this.status(context);
      if (info.phase !== 'ready') throw new Error(info.message ?? `workspace phase is '${info.phase}'`);
      return info.summary ?? 'ready';
    });

    const environment = await this.status(context);
    if (!healthStep.ok) {
      return {
        ok: false,
        removed,
        restored,
        steps,
        environment,
        error: this.#toLabError(healthStep.error, 'RESET_FAILED'),
      };
    }

    return { ok: true, removed, restored, steps, environment };
  }

  // --------------------------------------------------------------- destroy

  async destroy(context: LabSessionContext): Promise<DestroyResult> {
    return this.destroyNamespace(context.namespace, context.sessionId);
  }

  /**
   * Remove one session's workspace, and confirm it is gone.
   *
   * The same four gates as the Kubernetes provider, in the same order:
   * name shape, then the *live* ownership record, then the session id when one
   * is supplied. A workspace that is already absent counts as success, which is
   * what makes the reaper safe to re-enter.
   */
  async destroyNamespace(namespace: string, expectedSessionId?: string): Promise<DestroyResult> {
    const steps: ProvisionStep[] = [];

    if (!isLabNamespace(namespace)) {
      return this.#refuseDestroy(steps, namespace, `'${namespace}' is not a JumpToTech lab sandbox name`);
    }

    const target = this.workspacePath(namespace);
    const exists = (await stat(target).catch(() => null)) !== null;
    const record = await this.#readIndex(namespace);

    if (!exists && !record) {
      steps.push({ id: 'delete-workspace', label: 'Workspace deleted', status: 'ok', detail: 'already absent' });
      return { ok: true, namespaceGone: true, steps };
    }

    // A directory with no ownership record is not ours to delete. Refusing is
    // the safe answer: an operator can remove it by hand, and the platform
    // never guesses about a directory it cannot prove it created.
    if (!record) {
      return this.#refuseDestroy(steps, namespace, 'no JumpToTech ownership record for this workspace');
    }
    if (record.managedBy !== 'jumptotech.io') {
      return this.#refuseDestroy(steps, namespace, 'ownership record is not managed by JumpToTech');
    }
    if (expectedSessionId && record.sessionId !== expectedSessionId) {
      return this.#refuseDestroy(
        steps,
        namespace,
        'workspace belongs to a different session than the one requesting deletion',
      );
    }
    steps.push({ id: 'verify-managed', label: 'Workspace ownership verified', status: 'ok' });

    try {
      await rm(target, { recursive: true, force: true });
      await rm(this.#indexPath(namespace), { force: true });
    } catch (error) {
      steps.push({
        id: 'delete-workspace',
        label: 'Workspace deleted',
        status: 'failed',
        detail: describe(error),
      });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    const gone = (await stat(target).catch(() => null)) === null;
    steps.push({
      id: 'delete-workspace',
      label: 'Workspace deleted',
      status: gone ? 'ok' : 'pending',
      detail: gone ? namespace : `${namespace} could not be removed`,
    });

    return {
      ok: true,
      namespaceGone: gone,
      steps,
      ...(gone
        ? {}
        : { error: { code: 'DESTROY_FAILED' as const, message: `workspace ${namespace} still exists` } }),
    };
  }

  #refuseDestroy(steps: ProvisionStep[], namespace: string, reason: string): DestroyResult {
    const message = `Refusing to delete workspace: ${reason}`;
    steps.push({ id: 'verify-managed', label: 'Workspace ownership verified', status: 'failed', detail: message });
    return {
      ok: false,
      namespaceGone: false,
      steps,
      error: {
        code: 'DESTROY_FAILED',
        message,
        remediation:
          'Cleanup only ever removes workspaces this platform created and recorded. Remove anything else by hand.',
      },
    };
  }

  // ----------------------------------------------------------- credentials

  /**
   * What the student's shell gets: a directory, and no cluster credential.
   *
   * A workspace lab hands out no token of any kind. That is stronger than the
   * Kubernetes path, not weaker — there is simply nothing to leak.
   */
  async issueCredentials(context: LabSessionContext): Promise<StudentCredentials> {
    assertValidLabNamespace(context.namespace);
    const workspacePath = this.workspacePath(context.namespace);

    const info = await stat(workspacePath).catch(() => null);
    if (!info || !info.isDirectory()) {
      throw new Error(`workspace ${context.namespace} does not exist`);
    }

    return {
      kind: 'workspace',
      namespace: context.namespace,
      workspacePath,
      environment: {
        // Read by the sample application and by the labs' own pipeline files;
        // this is what a CI runner sets, and the labs teach that.
        CI: 'true',
        JTT_LAB_ID: context.labId,
        JTT_WORKSPACE: workspacePath,
      },
      expiresAt: new Date(context.expiresAtMs).toISOString(),
    };
  }

  /**
   * The workspace the verifier should read for this session.
   *
   * Bound to one directory at construction, so a handler holding it cannot
   * reach another session's files even if it tried to name one.
   */
  verificationEvidence(context: LabSessionContext): VerificationEvidence {
    return { workspace: this.workspaceFor(context.namespace) };
  }

  // --------------------------------------------------------------- cleanup

  async listManagedNamespaces(): Promise<ManagedNamespace[]> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    const managed: ManagedNamespace[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isLabNamespace(entry.name)) continue; // skips `.index` and anything else
      const record = await this.#readIndex(entry.name);
      if (!record) continue;
      managed.push({
        namespace: entry.name,
        sessionId: record.sessionId,
        labId: record.labId,
        expiresAtMs: record.expiresAtMs,
        phase: 'Active',
      });
    }
    return managed;
  }

  // --------------------------------------------------------------- execute

  /**
   * Run one allow-listed task in the session's workspace.
   *
   * `request.command` is a task *id*, not a command line — the same closed
   * table the verifier draws from. Anything else is refused.
   */
  async execute(context: LabSessionContext, request: ExecRequest): Promise<ExecResult> {
    if (!isWorkspaceTaskId(request.command)) {
      throw new Error(
        `'${request.command}' is not an allow-listed workspace task. Workspace labs never execute a supplied command line.`,
      );
    }
    if (request.args.length > 0) {
      throw new Error('workspace tasks take no caller-supplied arguments');
    }
    const result = await this.workspaceFor(context.namespace).runTask(
      request.command as WorkspaceTaskId,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  // --------------------------------------------------------------- helpers

  /** Copy the lab's seed files in, then confirm the declared starting state. */
  async #applySeed(context: LabSessionContext): Promise<string> {
    const seed = await loadWorkspaceSeed(context.lab);
    await this.#writeSeed(context.namespace, seed);

    const requirements = context.lab.setup.verify as readonly Requirement[];
    if (requirements.length === 0 || !this.#wait) {
      return `seeded ${seed.length} file${seed.length === 1 ? '' : 's'}`;
    }

    const result = await this.#wait({
      workspace: this.workspaceFor(context.namespace),
      namespace: context.namespace,
      requirements,
      timeoutMs: context.lab.setup.verify_timeout_seconds * 1000,
    });
    if (!result.ok) {
      const failed = result.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ''}`)
        .join('; ');
      throw new Error(`lab initial state did not become ready — ${failed}`);
    }
    return `seeded and verified ${seed.length} file${seed.length === 1 ? '' : 's'}`;
  }

  async #writeSeed(namespace: string, seed: readonly SeedFile[]): Promise<void> {
    const root = this.workspacePath(namespace);
    for (const file of seed) {
      // `file.path` was canonicalised by the seed loader; joining it with a
      // root that was validated as a lab namespace cannot escape.
      const destination = path.join(root, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: PRIVATE_DIR_MODE });
      await writeFile(destination, file.contents, { mode: file.executable ? EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE });
    }
  }

  /** Delete a workspace directory outright. Used to make `create` idempotent. */
  async #emptyWorkspace(namespace: string): Promise<void> {
    await rm(this.workspacePath(namespace), { recursive: true, force: true });
  }

  /** Delete everything *inside* a workspace, keeping the directory itself. */
  async #emptyWorkspaceContents(namespace: string): Promise<string[]> {
    const root = this.workspacePath(namespace);
    const entries = await readdir(root).catch(() => []);
    const removed: string[] = [];
    for (const entry of [...entries].sort()) {
      await rm(path.join(root, entry), { recursive: true, force: true });
      removed.push(entry);
    }
    return removed;
  }

  #indexPath(namespace: string): string {
    return path.join(this.#root, INDEX_DIRECTORY, `${assertValidLabNamespace(namespace)}.json`);
  }

  async #writeIndex(context: LabSessionContext): Promise<void> {
    const entry: WorkspaceIndexEntry = {
      namespace: context.namespace,
      sessionId: context.sessionId,
      labId: context.labId,
      createdAt: new Date(this.#now()).toISOString(),
      expiresAtMs: context.expiresAtMs,
      managedBy: 'jumptotech.io',
    };
    await mkdir(path.join(this.#root, INDEX_DIRECTORY), { recursive: true, mode: PRIVATE_DIR_MODE });
    await writeFile(this.#indexPath(context.namespace), JSON.stringify(entry, null, 2), {
      mode: PRIVATE_FILE_MODE,
    });
  }

  async #readIndex(namespace: string): Promise<WorkspaceIndexEntry | null> {
    const text = await readFile(this.#indexPath(namespace), 'utf8').catch(() => null);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as WorkspaceIndexEntry;
      if (parsed.namespace !== namespace) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async #failedReset(
    context: LabSessionContext,
    steps: ProvisionStep[],
    removed: string[],
    restored: string[],
    error: unknown,
    code: LabError['code'] = 'RESET_FAILED',
  ): Promise<ResetResult> {
    return {
      ok: false,
      removed,
      restored,
      steps,
      environment: await this.status(context),
      error: this.#toLabError(error, code),
    };
  }

  async #runStep(
    steps: ProvisionStep[],
    id: string,
    label: string,
    fn: () => Promise<string | undefined>,
  ): Promise<{ ok: boolean; detail?: string; error?: unknown }> {
    const startedAt = this.#now();
    try {
      const detail = await fn();
      const step: ProvisionStep = { id, label, status: 'ok', durationMs: this.#now() - startedAt };
      if (detail) step.detail = detail;
      steps.push(step);
      return { ok: true, ...(detail ? { detail } : {}) };
    } catch (error) {
      const detail = describe(error);
      steps.push({ id, label, status: 'failed', detail, durationMs: this.#now() - startedAt });
      return { ok: false, detail, error };
    }
  }

  #toLabError(
    error: unknown,
    fallback: LabError['code'],
    extra: { remediation?: string } = {},
  ): LabError {
    return { code: fallback, message: describe(error), ...extra };
  }
}

/** Human-readable description of an allow-listed task, for provisioning UI. */
export function describeWorkspaceTask(id: WorkspaceTaskId): string {
  return workspaceTask(id).label;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
