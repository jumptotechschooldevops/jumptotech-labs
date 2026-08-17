/**
 * `LabProvider` backed by one throwaway container per session.
 *
 * This is the engine behind the Linux and Terraform providers (and, when its
 * sandbox is genuinely safe, the Docker one). The three differ only in image,
 * provider id, and the label on the terminal — everything about the lifecycle,
 * the guardrails, the reset, the cleanup and the verification reads is here.
 *
 * ```text
 *   Student session
 *        ↓
 *   ContainerLabProvider
 *        ↓
 *   docker run --network none --cap-drop ALL --user student
 *              --cpus … --memory … --pids-limit …
 *        ↓
 *   jtt-lab-3f9c1a7b2d40      one container, one session, no host mounts
 *        ↓
 *   bash (docker exec, as student)      ← the browser terminal attaches here
 *        ↓
 *   verifier reads files back through the same runtime
 * ```
 *
 * ## What bounds a sandbox
 *
 * | Concern | Control |
 * |---|---|
 * | host filesystem | no bind mounts at all, and the Docker socket is never passed in |
 * | privilege | `--user student`, `--cap-drop ALL`, `--security-opt no-new-privileges` |
 * | network | `--network none` by default — a Linux or Terraform lab needs none |
 * | CPU / memory | `--cpus`, `--memory`, `--memory-swap` from `SessionPolicy.sandbox` |
 * | fork bombs | `--pids-limit` |
 * | lifetime | the session's own deadlines, plus the reaper |
 *
 * ## What this is *not*
 *
 * A container is not a virtual machine. Everything shares one kernel, and a
 * kernel or runtime escape crosses every boundary above. This is stated in the
 * README too, and it is why the AWS provider does not hand out real
 * credentials: the isolation here is good enough for a single-tenant teaching
 * laptop, not for hostile multi-tenancy.
 */
import {
  ProviderUnavailableError,
  sandboxRefOf,
  type CreateResult,
  type DestroyResult,
  type EnvironmentInfo,
  type ExecRequest,
  type ExecResult,
  type LabError,
  type LabProvider,
  type LabProviderId,
  type LabSessionContext,
  type ManagedSandbox,
  type ProvisionStep,
  type ResetResult,
  type SandboxPathRead,
  type TerminalContext,
} from '../../types.js';
import {
  assertValidContainerSandboxRef,
  isContainerSandboxRef,
} from '../../session/identifiers.js';
import { resolveSandboxPath, sandboxParent } from '../../session/sandbox-paths.js';
import { loadSetupFiles, type LoadedSetupFile } from '../../session/setup-files.js';
import { AVAILABLE, unavailable, type ProviderAvailability } from '../catalog.js';
import {
  CONTAINER_EXPIRES_LABEL,
  CONTAINER_LAB_LABEL,
  CONTAINER_PROVIDER_LABEL,
  CONTAINER_SESSION_LABEL,
  MANAGED_CONTAINER_LABEL,
  MANAGED_CONTAINER_SELECTOR,
  MAX_SANDBOX_READ_BYTES,
  type ContainerInfo,
  type ContainerRuntimePort,
} from './runtime.js';

/** Binaries the provider itself may run inside a sandbox, for reads and setup. */
const INTERNAL_EXEC_ALLOWLIST = new Set([
  '/usr/bin/stat',
  '/bin/cat',
  '/usr/bin/tee',
  '/bin/mkdir',
  '/bin/chmod',
  '/bin/rm',
  '/usr/bin/id',
  '/usr/bin/env',
  '/usr/bin/find',
]);

/** Bounds on a `listSandboxFiles` sweep. A lab cannot widen either. */
const MAX_LIST_DEPTH = 6;
const MAX_LIST_ENTRIES = 200;

/** A tool name the provider may be configured to allow, e.g. `terraform`. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * One read-only tool a provider lets the verifier run.
 *
 * `subcommands` is the second half of the gate: allowing `terraform` is not
 * allowing `terraform apply`. A provider states the exact verbs it will pass
 * through, and everything else is refused before any argv is built.
 */
export interface VerifierTool {
  name: string;
  subcommands: string[];
}

export interface ContainerProviderOptions {
  id: LabProviderId;
  /** Implementation name shown to operators, e.g. `docker-linux`. */
  name: string;
  runtime: ContainerRuntimePort;
  /** Sandbox image. Built on the host by `npm run sandbox:build`. */
  image: string;
  /** Where the student lands, and the root every verifier path resolves under. */
  home?: string;
  /** Binaries a lab's own environment must contain for this provider to be usable. */
  requiredBinaries?: string[];
  /**
   * Read-only CLI tools the *verifier* may run in this provider's sandboxes.
   *
   * Empty for Linux and Docker: their checks are filesystem reads and need no
   * tool. The Terraform provider allows `terraform`, and only its two
   * read-only subcommands — so "a verification pass cannot apply or destroy" is
   * enforced here, at the boundary, rather than trusted to every caller.
   */
  verifierTools?: VerifierTool[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ContainerLabProvider implements LabProvider {
  readonly id: LabProviderId;
  readonly name: string;
  readonly sandboxKind = 'container' as const;

  readonly #runtime: ContainerRuntimePort;
  readonly #image: string;
  readonly #home: string;
  readonly #requiredBinaries: string[];
  readonly #verifierTools: ReadonlyMap<string, ReadonlySet<string>>;
  readonly #now: () => number;

  constructor(options: ContainerProviderOptions) {
    this.id = options.id;
    this.name = options.name;
    this.#runtime = options.runtime;
    this.#image = options.image;
    this.#home = options.home ?? '/home/student';
    this.#requiredBinaries = options.requiredBinaries ?? [];
    this.#verifierTools = new Map(
      (options.verifierTools ?? []).map((tool) => {
        if (!TOOL_NAME_PATTERN.test(tool.name)) {
          throw new Error(`'${tool.name}' is not a valid verifier tool name`);
        }
        return [tool.name, new Set(tool.subcommands)] as const;
      }),
    );
    this.#now = options.now ?? (() => Date.now());
  }

  get image(): string {
    return this.#image;
  }

  get home(): string {
    return this.#home;
  }

  // ---------------------------------------------------------- availability

  /**
   * Two questions, answered separately because the fixes differ: can we reach a
   * container runtime at all, and has the sandbox image been built?
   */
  async availability(): Promise<ProviderAvailability> {
    try {
      await this.#runtime.ping();
    } catch (error) {
      return unavailable(
        `no container runtime is reachable (${describe(error)})`,
        'Start Docker Desktop (or your container runtime) and reload the catalog.',
      );
    }

    try {
      if (!(await this.#runtime.imageExists(this.#image))) {
        return unavailable(
          `the sandbox image '${this.#image}' has not been built on this machine`,
          'Build the sandbox images once with: npm run sandbox:build',
        );
      }
    } catch (error) {
      return unavailable(`could not inspect '${this.#image}' (${describe(error)})`);
    }

    return AVAILABLE;
  }

  // ---------------------------------------------------------------- create

  async create(context: LabSessionContext): Promise<CreateResult> {
    const steps: ProvisionStep[] = [];
    const ref = this.#ref(context);

    const createStep = await this.#runStep(steps, 'environment-created', 'Environment created', async () => {
      // Re-entrant by design: a create over an existing sandbox replaces it
      // rather than failing, which is what makes a retried Start Lab safe.
      await this.#runtime.remove(ref).catch(() => undefined);
      await this.#runtime.create({
        name: ref,
        image: this.#image,
        hostname: 'lab',
        user: context.policy.sandbox.user,
        workdir: this.#home,
        cpus: context.policy.sandbox.cpus,
        memory: context.policy.sandbox.memory,
        pidsLimit: context.policy.sandbox.pidsLimit,
        network: context.policy.sandbox.network,
        labels: {
          [MANAGED_CONTAINER_LABEL]: 'true',
          [CONTAINER_SESSION_LABEL]: context.sessionId,
          [CONTAINER_LAB_LABEL]: context.labId,
          [CONTAINER_EXPIRES_LABEL]: String(context.expiresAtMs),
          [CONTAINER_PROVIDER_LABEL]: this.id,
        },
        env: {
          JTT_LAB_ID: context.labId,
          HOME: this.#home,
        },
        // A container needs a foreground process to stay alive; the student's
        // shells are `docker exec` children of it.
        command: ['sleep', 'infinity'],
      });
      return `sandbox container ${ref} created (cpus=${context.policy.sandbox.cpus} memory=${context.policy.sandbox.memory} pids=${context.policy.sandbox.pidsLimit} network=${context.policy.sandbox.network})`;
    });
    if (!createStep.ok) {
      return {
        ok: false,
        environment: this.#environment(context, 'error', { message: createStep.detail }),
        steps,
        error: this.#toLabError(createStep.error, 'PROVISION_FAILED', {
          remediation: `Check that Docker is running and that '${this.#image}' exists: npm run sandbox:build`,
        }),
      };
    }

    const toolingStep = await this.#runStep(steps, 'sandbox-tooling', 'Sandbox tooling ready', async () =>
      this.#checkTooling(ref, context),
    );
    if (!toolingStep.ok) {
      await this.#runtime.remove(ref).catch(() => undefined);
      return {
        ok: false,
        environment: this.#environment(context, 'degraded', { message: toolingStep.detail }),
        steps,
        error: this.#toLabError(toolingStep.error, 'PROVISION_FAILED', {
          remediation: `Rebuild the sandbox image: npm run sandbox:build`,
        }),
      };
    }

    if (context.lab.setup.files.length > 0) {
      const setupStep = await this.#runStep(steps, 'lab-initial-state', 'Lab initial state ready', async () =>
        this.#applySetup(context),
      );
      if (!setupStep.ok) {
        await this.#runtime.remove(ref).catch(() => undefined);
        return {
          ok: false,
          environment: this.#environment(context, 'degraded', { message: setupStep.detail }),
          steps,
          error: this.#toLabError(setupStep.error, 'SETUP_FAILED', {
            remediation: `Check the setup files declared by ${context.labId}.`,
          }),
        };
      }
    }

    return { ok: true, environment: this.#environment(context, 'ready'), steps };
  }

  // ---------------------------------------------------------------- status

  async status(context: LabSessionContext): Promise<EnvironmentInfo> {
    const ref = this.#ref(context);
    let info: ContainerInfo | null;
    try {
      info = await this.#runtime.inspect(ref);
    } catch (error) {
      return this.#environment(context, 'error', { message: describe(error) });
    }

    if (!info) {
      return this.#environment(context, 'not_created', {
        message: `sandbox container ${ref} does not exist`,
      });
    }
    if (info.state !== 'running') {
      return this.#environment(context, 'degraded', {
        message: `sandbox container ${ref} is ${info.state}`,
      });
    }
    return this.#environment(context, 'ready');
  }

  // ----------------------------------------------------------------- reset

  /**
   * Restore the lab's starting condition by replacing the sandbox.
   *
   * A Kubernetes reset can purge objects and keep the namespace, because the
   * namespace is not where the student's state lives. A container *is* where it
   * lives: files, background processes, shell history and installed packages
   * are all inside it. Deleting selected files back to a baseline would leave
   * whatever else the student changed, so "reset" here means a genuinely fresh
   * container from the same image, re-seeded with the lab's starter files.
   *
   * The cost is that the student's shell is a `docker exec` into the old
   * container and therefore dies. The reset response asks the UI to reconnect
   * the terminal, which reattaches to the new sandbox with the same session.
   */
  async reset(context: LabSessionContext): Promise<ResetResult> {
    const steps: ProvisionStep[] = [];
    const ref = this.#ref(context);
    const removed: string[] = [];
    let restored: string[] = [];

    const destroyStep = await this.#runStep(steps, 'purge', 'Sandbox contents discarded', async () => {
      const existing = await this.#runtime.inspect(ref);
      if (existing) {
        this.#assertOwned(ref, existing, context.sessionId);
        await this.#runtime.remove(ref);
        removed.push(`container/${ref}`);
        return `discarded the previous sandbox container`;
      }
      return 'no sandbox container to discard';
    });
    if (!destroyStep.ok) {
      return this.#failedReset(context, steps, removed, restored, destroyStep.error);
    }

    const recreated = await this.create(context);
    steps.push(...recreated.steps.map((step) => ({ ...step, id: `recreate-${step.id}` })));
    if (!recreated.ok) {
      return {
        ok: false,
        removed,
        restored,
        steps,
        environment: recreated.environment,
        ...(recreated.error ? { error: recreated.error } : {}),
      };
    }
    restored = context.lab.setup.files.map((file) => file.path);

    return {
      ok: true,
      removed,
      restored,
      steps,
      environment: await this.status(context),
    };
  }

  // --------------------------------------------------------------- destroy

  async destroy(context: LabSessionContext): Promise<DestroyResult> {
    return this.destroySandbox(this.#ref(context), context.sessionId);
  }

  /**
   * Delete one sandbox container, and confirm it is gone.
   *
   * The same four gates the Kubernetes provider applies, in the same order:
   * name shape, then the *live* ownership label, then the session label when a
   * session was named. Labels are re-read from the runtime immediately before
   * the delete, so a stale record cannot authorise one.
   */
  async destroySandbox(sandboxRef: string, expectedSessionId?: string): Promise<DestroyResult> {
    const steps: ProvisionStep[] = [];

    if (!isContainerSandboxRef(sandboxRef)) {
      return refuse(steps, `'${sandboxRef}' is not a JumpToTech sandbox container name`);
    }

    let info: ContainerInfo | null;
    try {
      info = await this.#runtime.inspect(sandboxRef);
    } catch (error) {
      steps.push({
        id: 'verify-managed',
        label: 'Sandbox ownership verified',
        status: 'failed',
        detail: describe(error),
      });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    if (info === null) {
      steps.push({ id: 'delete-sandbox', label: 'Sandbox deleted', status: 'ok', detail: 'already absent' });
      return { ok: true, namespaceGone: true, steps };
    }

    try {
      this.#assertOwned(sandboxRef, info, expectedSessionId);
    } catch (error) {
      return refuse(steps, describe(error));
    }
    steps.push({ id: 'verify-managed', label: 'Sandbox ownership verified', status: 'ok' });

    try {
      await this.#runtime.remove(sandboxRef);
    } catch (error) {
      steps.push({ id: 'delete-sandbox', label: 'Sandbox deleted', status: 'failed', detail: describe(error) });
      return { ok: false, namespaceGone: false, steps, error: this.#toLabError(error, 'DESTROY_FAILED') };
    }

    const gone = (await this.#runtime.inspect(sandboxRef).catch(() => null)) === null;
    steps.push({
      id: 'delete-sandbox',
      label: 'Sandbox deleted',
      status: gone ? 'ok' : 'pending',
      detail: gone ? sandboxRef : `${sandboxRef} is still shutting down`,
    });

    return {
      ok: true,
      namespaceGone: gone,
      steps,
      ...(gone
        ? {}
        : { error: { code: 'DESTROY_FAILED' as const, message: `${sandboxRef} is still shutting down` } }),
    };
  }

  // --------------------------------------------------------------- cleanup

  async listManagedSandboxes(): Promise<ManagedSandbox[]> {
    const containers = await this.#runtime.list(MANAGED_CONTAINER_SELECTOR);
    return containers
      .filter((c) => isContainerSandboxRef(c.name))
      // A shared daemon may host several providers' sandboxes; each reaps its own.
      .filter((c) => (c.labels[CONTAINER_PROVIDER_LABEL] ?? this.id) === this.id)
      .map((c) => ({
        providerId: this.id,
        sandboxRef: c.name,
        sandboxKind: this.sandboxKind,
        sessionId: c.labels[CONTAINER_SESSION_LABEL] ?? '',
        labId: c.labels[CONTAINER_LAB_LABEL] ?? '',
        expiresAtMs: parseExpiry(c.labels[CONTAINER_EXPIRES_LABEL]),
        phase: c.state,
      }));
  }

  // -------------------------------------------------------------- terminal

  /**
   * The terminal binding: attach a PTY to this session's container.
   *
   * The container name is derived from the session id here, server-side. The
   * browser never sends one, and the terminal service re-validates the name
   * shape before it builds an argv — so even a compromised API cannot talk the
   * terminal into exec'ing an arbitrary container.
   */
  async getTerminalContext(context: LabSessionContext): Promise<TerminalContext> {
    const ref = this.#ref(context);
    const info = await this.#runtime.inspect(ref);
    if (!info) {
      throw new ProviderUnavailableError(this.id, `sandbox container ${ref} does not exist`);
    }
    this.#assertOwned(ref, info, context.sessionId);

    return {
      kind: 'container-exec',
      runtime: 'docker',
      containerRef: ref,
      user: context.policy.sandbox.user,
      workdir: this.#home,
      env: { JTT_LAB_ID: context.labId },
      expiresAt: new Date(context.expiresAtMs).toISOString(),
    };
  }

  // --------------------------------------------------------------- execute

  /**
   * Run one allow-listed binary inside the sandbox.
   *
   * Internal health checks and verifier reads only. As with the Kubernetes
   * provider this is deliberately not wired to any REST route: student commands
   * travel through the terminal service, over an authenticated WebSocket.
   */
  async execute(context: LabSessionContext, request: ExecRequest): Promise<ExecResult> {
    if (!INTERNAL_EXEC_ALLOWLIST.has(request.command)) {
      throw new Error(
        `Command '${request.command}' is not allow-listed for provider execution (allowed: ${[...INTERNAL_EXEC_ALLOWLIST].join(', ')})`,
      );
    }
    if (!Array.isArray(request.args) || request.args.some((a) => typeof a !== 'string')) {
      throw new Error('execute() requires args to be an array of strings');
    }

    const result = await this.#runtime.exec(this.#ref(context), {
      argv: [request.command, ...request.args],
      user: context.policy.sandbox.user,
      workdir: this.#home,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });
    return result;
  }

  // ------------------------------------------------------- verifier reads

  /**
   * Read one path back out of the sandbox, for state-based verification.
   *
   * `stat` is run *without* `-L`, so a symlink reports as a symlink rather than
   * as whatever it points at. That is what stops a student satisfying a
   * `file_content` check by linking the expected path at some other file, and
   * it is why `file_content` additionally requires a regular file.
   *
   * The read runs as the unprivileged student user, so it can see exactly what
   * the student can see — no privileged bypass of the permissions the lab is
   * teaching.
   */
  async readSandboxPath(
    context: LabSessionContext,
    relativePath: string,
    options: { maxBytes?: number } = {},
  ): Promise<SandboxPathRead | null> {
    const ref = this.#ref(context);
    const absolute = resolveSandboxPath(this.#home, relativePath);
    const user = context.policy.sandbox.user;

    const stat = await this.#runtime.exec(ref, {
      argv: ['/usr/bin/stat', '-c', '%F|%a|%U|%G|%s', '--', absolute],
      user,
      workdir: this.#home,
      timeoutMs: 10_000,
    });
    if (stat.exitCode !== 0) return null;

    const [rawType, mode, owner, group, size] = stat.stdout.trim().split('|');
    const type = normalisePathType(rawType);
    const read: SandboxPathRead = {
      type,
      mode: (mode ?? '').padStart(3, '0'),
      owner: owner ?? '',
      group: group ?? '',
      sizeBytes: Number.parseInt(size ?? '0', 10) || 0,
    };

    if (type !== 'file') return read;

    const maxBytes = Math.min(options.maxBytes ?? MAX_SANDBOX_READ_BYTES, MAX_SANDBOX_READ_BYTES);
    const cat = await this.#runtime.exec(ref, {
      argv: ['/bin/cat', '--', absolute],
      user,
      workdir: this.#home,
      timeoutMs: 10_000,
      maxBufferBytes: maxBytes,
    });
    if (cat.exitCode !== 0) return read;

    read.content = cat.stdout.slice(0, maxBytes);
    if (cat.stdout.length > maxBytes) read.truncated = true;
    return read;
  }

  /**
   * List files under one directory in the sandbox.
   *
   * Bounded three ways — depth, entry count, and an optional suffix — because
   * the caller is a verification pass, not a file browser. `find` is given an
   * argv array with no shell, and the results are re-anchored to the directory
   * the caller asked about, so nothing outside it can be returned even if the
   * sandbox contains a symlink pointing elsewhere.
   */
  async listSandboxFiles(
    context: LabSessionContext,
    relativeDir: string,
    options: { suffix?: string; maxDepth?: number; maxEntries?: number } = {},
  ): Promise<string[]> {
    const ref = this.#ref(context);
    const absolute = resolveSandboxPath(this.#home, relativeDir);
    const depth = Math.min(Math.max(options.maxDepth ?? 4, 1), MAX_LIST_DEPTH);
    const limit = Math.min(options.maxEntries ?? MAX_LIST_ENTRIES, MAX_LIST_ENTRIES);

    const argv = ['/usr/bin/find', absolute, '-maxdepth', String(depth), '-type', 'f'];
    if (options.suffix !== undefined) {
      if (!/^\.[A-Za-z0-9]{1,16}$/.test(options.suffix)) {
        throw new Error(`'${options.suffix}' is not a valid file suffix`);
      }
      argv.push('-name', `*${options.suffix}`);
    }

    const result = await this.#runtime.exec(ref, {
      argv,
      user: context.policy.sandbox.user,
      workdir: this.#home,
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) return [];

    const prefix = `${absolute}/`;
    const seen = new Set<string>();
    for (const line of result.stdout.split('\n')) {
      const path = line.trim();
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      // `.terraform/` holds installed provider plugins, not the student's work.
      if (relative.length === 0 || relative.split('/').some((s) => s.startsWith('.'))) continue;
      seen.add(relative);
      if (seen.size >= limit) break;
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Run one allow-listed read-only tool inside the sandbox.
   *
   * The gate is the *tool name*, configured per provider at construction. A
   * provider that was given no tools refuses everything, so the capability
   * cannot be reached by a lab that merely declares the wrong requirement.
   */
  async runSandboxTool(
    context: LabSessionContext,
    request: { tool: string; args: string[]; dir: string; timeoutMs?: number; maxBytes?: number },
  ): Promise<ExecResult> {
    const subcommands = this.#verifierTools.get(request.tool);
    if (!subcommands) {
      throw new Error(
        this.#verifierTools.size === 0
          ? `Provider '${this.id}' runs no verifier tools`
          : `'${request.tool}' is not an allow-listed verifier tool for provider '${this.id}' (allowed: ${[...this.#verifierTools.keys()].join(', ')})`,
      );
    }
    if (!Array.isArray(request.args) || request.args.some((a) => typeof a !== 'string')) {
      throw new Error('runSandboxTool() requires args to be an array of strings');
    }
    // Allowing `terraform` is not allowing `terraform apply`. The verb is
    // checked here so that no caller — however it was reached — can turn a
    // verification pass into something that writes.
    const subcommand = request.args[0] ?? '';
    if (!subcommands.has(subcommand)) {
      throw new Error(
        `'${request.tool} ${subcommand}' is not a read-only check this provider will run (allowed: ${[...subcommands].join(', ')})`,
      );
    }

    return this.#runtime.exec(this.#ref(context), {
      // `env` resolves the tool from the sandbox PATH without the platform
      // needing to know where the image put it.
      argv: ['/usr/bin/env', request.tool, ...request.args],
      user: context.policy.sandbox.user,
      workdir: resolveSandboxPath(this.#home, request.dir),
      timeoutMs: request.timeoutMs ?? 60_000,
      ...(request.maxBytes !== undefined ? { maxBufferBytes: request.maxBytes } : {}),
    });
  }

  // --------------------------------------------------------------- helpers

  #ref(context: LabSessionContext): string {
    return assertValidContainerSandboxRef(sandboxRefOf(context));
  }

  #environment(
    context: LabSessionContext,
    phase: EnvironmentInfo['phase'],
    extra: Partial<EnvironmentInfo> = {},
  ): EnvironmentInfo {
    const ref = sandboxRefOf(context);
    return {
      environmentId: `${this.name}:${this.#image}/${ref}#${context.labId}`,
      provider: this.name,
      providerId: this.id,
      phase,
      sandboxRef: ref,
      sandboxKind: this.sandboxKind,
      namespace: ref,
      sessionId: context.sessionId,
      image: this.#image,
      ...extra,
    };
  }

  /** Confirm the tools this provider's labs assume are genuinely present. */
  async #checkTooling(ref: string, context: LabSessionContext): Promise<string> {
    const identity = await this.#runtime.exec(ref, {
      argv: ['/usr/bin/id', '-un'],
      user: context.policy.sandbox.user,
      workdir: this.#home,
      timeoutMs: 15_000,
    });
    if (identity.exitCode !== 0) {
      throw new Error(identity.stderr.trim() || 'could not run a command inside the sandbox');
    }
    const who = identity.stdout.trim();
    if (who !== context.policy.sandbox.user) {
      throw new Error(`sandbox shell would run as '${who}', expected '${context.policy.sandbox.user}'`);
    }

    const found: string[] = [];
    for (const binary of this.#requiredBinaries) {
      const probe = await this.#runtime.exec(ref, {
        argv: ['/usr/bin/env', binary, '--version'],
        user: context.policy.sandbox.user,
        workdir: this.#home,
        timeoutMs: 30_000,
      });
      if (probe.exitCode !== 0) {
        throw new Error(
          `'${binary}' is not usable inside ${this.#image}: ${probe.stderr.trim() || `exit ${probe.exitCode}`}`,
        );
      }
      found.push(`${binary} ${firstLine(probe.stdout)}`);
    }

    return found.length > 0 ? `${who}; ${found.join('; ')}` : `unprivileged user '${who}'`;
  }

  /** Write the lab's starter files into the sandbox home. */
  async #applySetup(context: LabSessionContext): Promise<string> {
    const files = await loadSetupFiles(context.lab);
    const ref = this.#ref(context);
    for (const file of files) {
      await this.#writeFile(ref, context.policy.sandbox.user, file);
    }
    return `seeded ${files.length} starter file${files.length === 1 ? '' : 's'}`;
  }

  async #writeFile(ref: string, user: string, file: LoadedSetupFile): Promise<void> {
    const absolute = resolveSandboxPath(this.#home, file.path);
    const parent = sandboxParent(absolute);

    const mkdir = await this.#runtime.exec(ref, {
      argv: ['/bin/mkdir', '-p', '--', parent],
      user,
      workdir: this.#home,
    });
    if (mkdir.exitCode !== 0) {
      throw new Error(`could not create '${parent}': ${mkdir.stderr.trim()}`);
    }

    // `tee` reads the body from stdin, so file content never becomes part of a
    // command line — there is nothing to quote and nothing to escape.
    const write = await this.#runtime.exec(ref, {
      argv: ['/usr/bin/tee', '--', absolute],
      user,
      workdir: this.#home,
      stdin: file.content,
    });
    if (write.exitCode !== 0) {
      throw new Error(`could not write '${file.path}': ${write.stderr.trim()}`);
    }

    const chmod = await this.#runtime.exec(ref, {
      argv: ['/bin/chmod', file.mode, '--', absolute],
      user,
      workdir: this.#home,
    });
    if (chmod.exitCode !== 0) {
      throw new Error(`could not set mode on '${file.path}': ${chmod.stderr.trim()}`);
    }
  }

  /** The ownership gate: managed label, then session label when one is named. */
  #assertOwned(ref: string, info: ContainerInfo, expectedSessionId?: string): void {
    if (info.labels[MANAGED_CONTAINER_LABEL] !== 'true') {
      throw new Error(`container '${ref}' is not labelled ${MANAGED_CONTAINER_LABEL}=true`);
    }
    if (expectedSessionId !== undefined) {
      const owner = info.labels[CONTAINER_SESSION_LABEL];
      if (owner !== expectedSessionId) {
        throw new Error(
          `container '${ref}' belongs to ${owner ?? '<unlabelled>'}, not ${expectedSessionId}`,
        );
      }
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
    const code: LabError['code'] =
      error instanceof ProviderUnavailableError ? 'PROVIDER_UNAVAILABLE' : fallback;
    return { code, message: describe(error), ...extra };
  }
}

function refuse(steps: ProvisionStep[], reason: string): DestroyResult {
  const message = `Refusing to delete sandbox: ${reason}`;
  steps.push({
    id: 'verify-managed',
    label: 'Sandbox ownership verified',
    status: 'failed',
    detail: message,
  });
  return {
    ok: false,
    namespaceGone: false,
    steps,
    error: {
      code: 'DESTROY_FAILED',
      message,
      remediation:
        'Cleanup only ever removes sandboxes this platform created and labelled. Remove other containers by hand.',
    },
  };
}

function normalisePathType(raw: string | undefined): SandboxPathRead['type'] {
  switch (raw) {
    case 'regular file':
    case 'regular empty file':
      return 'file';
    case 'directory':
      return 'directory';
    case 'symbolic link':
      return 'symlink';
    default:
      return 'other';
  }
}

function parseExpiry(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
