/**
 * Session lifecycle manager.
 *
 * Owns the state machine, the capacity guard, and the mapping from a session
 * to its namespace. Everything above it (REST routes, the reaper, the
 * verifier) works in terms of a *session*, never a namespace string supplied
 * by a client.
 *
 * ```text
 *  start()   CREATING ──► ACTIVE ◄──► RESETTING   reset()
 *                            │
 *              expire() ─────┼──► EXPIRING ──► EXPIRED
 *                 end() ─────┴──► ENDING   ──► ENDED
 *                            └──► FAILED                (provisioning failed)
 * ```
 */
import type { LabRegistry } from '../lab-registry.js';
import type { LoadedLabDefinition } from '../lab-definition.js';
import type {
  CreateResult,
  DestroyResult,
  EnvironmentInfo,
  ExecResult,
  LabSessionContext,
  LabProvider,
  ProvisionStep,
  ResetResult,
  SandboxListOptions,
  SandboxPathRead,
  SandboxToolRequest,
  StudentCredentials,
  TerminalContext,
} from '../types.js';
import { ProviderUnavailableError } from '../types.js';
import {
  CONTAINER_SANDBOX_PREFIX,
  NAMESPACE_PREFIX,
  assertValidSessionId,
  deriveNamespace,
  deriveSandboxRef,
  newSessionId,
} from './identifiers.js';
import {
  PROVIDER_SANDBOX_KIND,
  type LabProviderId,
  type SandboxKind,
} from '../providers/catalog.js';
import { ProviderRegistry, singleProviderRegistry } from '../providers/registry.js';
import type { SessionStore } from './store.js';
import {
  OCCUPYING_STATUSES,
  SessionError,
  isTerminalStatus,
  type LabSession,
  type SessionPolicy,
  type SessionStatus,
} from './types.js';

/** Reasons that flow into `last_activity_at`. Polling is deliberately absent. */
export type ActivityReason = 'terminal' | 'check' | 'reset' | 'continue' | 'start';

export interface SessionLifetimeConfig {
  /** Absolute cap. Activity never extends this. */
  maxSessionSeconds: number;
  /** Idle window before the reaper collects the session. */
  idleTimeoutSeconds: number;
  /** How long before idle expiry the UI shows "Continue Lab". */
  warningSeconds: number;
  /** Refuse to start a new session beyond this many concurrent ones. */
  maxActiveSessions: number;
}

/**
 * The read primitive the verifier uses for filesystem and Terraform checks.
 *
 * Already bound to one session's sandbox — there is no parameter for naming a
 * different one.
 */
export interface SandboxReadPort {
  read(
    relativePath: string,
    options?: { maxBytes?: number },
  ): Promise<SandboxPathRead | null>;

  /**
   * List files under a sandbox directory. Present only for providers that
   * implement it — Terraform configuration checks need it; nothing else does.
   */
  list?(relativeDir: string, options?: SandboxListOptions): Promise<string[]>;

  /**
   * Run one allow-listed read-only tool in the sandbox. Present only for
   * providers that allow one; the provider, not the caller, decides which.
   */
  runTool?(request: SandboxToolRequest): Promise<ExecResult>;
}

/** Hook used to close a student's terminal when their session goes away. */
export interface TerminalTerminator {
  terminate(sessionId: string): Promise<void>;
}

/**
 * A session reached the end of its life.
 *
 * Emitted once per session, after the sandbox is verifiably gone, whether that
 * came from End Lab or from the reaper.
 */
export interface SessionClosedEvent {
  sessionId: string;
  labId: string;
  provider: LabProviderId;
  /** How it ended. The reaper produces EXPIRED; the student produces ENDED. */
  status: Extract<SessionStatus, 'ENDED' | 'EXPIRED'>;
  reason: string;
}

/**
 * An outbound notification port for session lifecycle changes.
 *
 * This exists so PLATFORM-005 can close a student's *attempt* when their
 * sandbox goes away without the orchestrator learning that persistence exists.
 * The dependency points the right way: the orchestrator declares the interface,
 * the composition root supplies an implementation, and nothing in this package
 * imports `@jumptotech/progress`.
 *
 * A listener that throws is logged and ignored — bookkeeping must never be able
 * to stop a sandbox being reclaimed.
 */
export interface SessionLifecycleListener {
  onSessionClosed?(event: SessionClosedEvent): Promise<void> | void;
}

export interface SessionManagerOptions {
  registry: LabRegistry;
  /**
   * Every sandbox backend the platform can run.
   *
   * The provider for a session is resolved from *the lab it is starting*, not
   * from configuration — that is what makes a track's technology lab metadata
   * rather than an application branch.
   */
  providers?: ProviderRegistry;
  /**
   * A single provider, for callers that only have one.
   *
   * Registered under its own id, so a lab declaring a different provider still
   * fails loudly rather than silently landing in the wrong kind of sandbox.
   */
  provider?: LabProvider;
  store: SessionStore;
  policy: SessionPolicy;
  lifetimes: SessionLifetimeConfig;
  /** Keys the session-id → namespace derivation. */
  namespaceSecret: string;
  terminal?: TerminalTerminator;
  /** Told when a session finishes, so learning history can be closed off. */
  listener?: SessionLifecycleListener;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface StartSessionResult {
  session: LabSession;
  lab: LoadedLabDefinition;
  environment: EnvironmentInfo;
  steps: ProvisionStep[];
}

export interface TeardownResult {
  session: LabSession;
  destroy: DestroyResult;
}

/** Live view of a session, including derived countdowns for the UI. */
export interface SessionView {
  sessionId: string;
  labId: string;
  status: SessionStatus;
  /** Which sandbox backend owns this session. */
  provider: LabProviderId;
  sandboxKind: SandboxKind;
  /** The provider's handle for the sandbox: namespace name, container name, … */
  sandboxRef: string;
  /** Kubernetes namespace. Only meaningful when `provider` is `kubernetes`. */
  namespace: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  endedAt?: string;
  statusReason?: string;
  /** Seconds until the absolute deadline. Never negative. */
  secondsRemaining: number;
  /** Seconds until the idle deadline. Never negative. */
  secondsUntilIdle: number;
  /** True once the idle countdown enters the warning window. */
  idleWarning: boolean;
  idleTimeoutSeconds: number;
  warningSeconds: number;
}

export class SessionManager {
  readonly #registry: LabRegistry;
  readonly #providers: ProviderRegistry;
  readonly #store: SessionStore;
  readonly #policy: SessionPolicy;
  readonly #lifetimes: SessionLifetimeConfig;
  readonly #namespaceSecret: string;
  readonly #terminal: TerminalTerminator | undefined;
  readonly #listener: SessionLifecycleListener | undefined;
  readonly #now: () => number;
  readonly #log: (message: string) => void;

  /**
   * Capacity is reserved synchronously, before the first `await`, so two
   * simultaneous Start Lab requests cannot both slip past the limit. (A
   * multi-instance deployment will need the same guard inside a database
   * transaction — noted in the README.)
   */
  #occupied = 0;
  readonly #released = new Set<string>();

  constructor(options: SessionManagerOptions) {
    if (!options.providers && !options.provider) {
      throw new Error('SessionManager requires either a provider registry or a single provider');
    }
    this.#registry = options.registry;
    this.#providers =
      options.providers ?? singleProviderRegistry(options.provider as LabProvider);
    this.#store = options.store;
    this.#policy = options.policy;
    this.#lifetimes = options.lifetimes;
    this.#namespaceSecret = options.namespaceSecret;
    this.#terminal = options.terminal;
    this.#listener = options.listener;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.logger ?? (() => undefined);
  }

  get policy(): SessionPolicy {
    return this.#policy;
  }

  get lifetimes(): SessionLifetimeConfig {
    return this.#lifetimes;
  }

  get activeCount(): number {
    return this.#occupied;
  }

  get providers(): ProviderRegistry {
    return this.#providers;
  }

  /**
   * The provider that owns a session's sandbox.
   *
   * Looked up from the *stored* provider id, never from the lab definition as
   * it stands now: a lab edited to declare a different provider must not make
   * an already-running session tear down through the wrong backend.
   *
   * `peek` rather than `resolve`: cleanup has to work while a provider is
   * reporting unhealthy, or a transient Docker hiccup would leak sandboxes.
   */
  #providerFor(session: LabSession): LabProvider {
    const provider = this.#providers.peek(session.provider);
    if (!provider) {
      throw new ProviderUnavailableError(
        session.provider,
        'no implementation is registered for the provider that created this session',
      );
    }
    return provider;
  }

  // ----------------------------------------------------------------- start

  /** Create a session: unique id, unique namespace, fully provisioned sandbox. */
  async start(labId: string): Promise<StartSessionResult> {
    // Throws LabNotFoundError / InvalidLabIdError before anything is reserved.
    const lab = this.#registry.get(labId);

    // Resolve the sandbox backend from the lab *before* reserving capacity, so
    // a lab whose provider cannot run here never consumes a slot and never
    // creates a session record.
    let provider: LabProvider;
    try {
      provider = await this.#providers.resolve(lab.environment.provider);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        throw new SessionError(
          'PROVIDER_UNAVAILABLE',
          error.message,
          error.remediation ??
            'This lab needs a sandbox backend that is not available on this deployment.',
          { provider: lab.environment.provider },
        );
      }
      throw error;
    }

    if (this.#occupied >= this.#lifetimes.maxActiveSessions) {
      throw new SessionError(
        'LAB_CAPACITY_REACHED',
        `All ${this.#lifetimes.maxActiveSessions} practice environments are currently in use.`,
        'Try again shortly — environments are released automatically when students finish or go idle.',
        { activeSessions: this.#occupied, maxActiveSessions: this.#lifetimes.maxActiveSessions },
      );
    }
    this.#occupied += 1;

    let session: LabSession;
    try {
      session = await this.#insertSession(lab, provider);
    } catch (error) {
      this.#occupied -= 1;
      throw error;
    }

    const context = this.#contextFor(lab, session);
    let result: CreateResult;
    try {
      result = await provider.create(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#failSession(session, context, message);
      throw new SessionError('SESSION_PROVISION_FAILED', message);
    }

    if (!result.ok) {
      const message = result.error?.message ?? 'Failed to create the lab environment';
      await this.#failSession(session, context, message);
      throw new SessionError(
        'SESSION_PROVISION_FAILED',
        message,
        result.error?.remediation,
        { steps: result.steps, environment: result.environment, code: result.error?.code },
      );
    }

    const nowIso = new Date(this.#now()).toISOString();
    const active = await this.#store.update(session.sessionId, {
      status: 'ACTIVE',
      environmentId: result.environment.environmentId,
      lastActivityAt: nowIso,
    });

    this.#log(
      `session ${session.sessionId} ACTIVE (lab=${lab.id} provider=${session.provider} sandbox=${session.sandboxRef}, ${this.#occupied}/${this.#lifetimes.maxActiveSessions} in use)`,
    );

    return {
      session: active ?? session,
      lab,
      environment: result.environment,
      steps: result.steps,
    };
  }

  /**
   * Create the session record, binding it to a provider and a sandbox handle.
   *
   * Both are derived here, server-side: the provider from the lab definition,
   * the sandbox handle from the session id through a keyed HMAC. Neither can be
   * influenced by request input, which is what makes "a browser cannot choose
   * its sandbox, or another session's" true at the point it matters.
   */
  async #insertSession(lab: LoadedLabDefinition, provider: LabProvider): Promise<LabSession> {
    const createdAtMs = this.#now();
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(
      createdAtMs + this.#lifetimes.maxSessionSeconds * 1000,
    ).toISOString();
    const sandboxKind = PROVIDER_SANDBOX_KIND[provider.id];
    const prefix = sandboxKind === 'container' ? CONTAINER_SANDBOX_PREFIX : NAMESPACE_PREFIX;

    // Random ids collide with negligible probability; check anyway rather than
    // ever handing two students the same sandbox.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sessionId = newSessionId();
      const namespace = deriveNamespace({ sessionId, secret: this.#namespaceSecret });
      const sandboxRef =
        prefix === NAMESPACE_PREFIX
          ? namespace
          : deriveSandboxRef({ sessionId, secret: this.#namespaceSecret, prefix });
      if (await this.#store.findBySandboxRef(sandboxRef)) continue;

      const session: LabSession = {
        sessionId,
        labId: lab.id,
        provider: provider.id,
        sandboxKind,
        sandboxRef,
        namespace,
        serviceAccountName: this.#policy.serviceAccountName,
        status: 'CREATING',
        environmentId: '',
        createdAt,
        lastActivityAt: createdAt,
        expiresAt,
        idleTimeoutSeconds: this.#lifetimes.idleTimeoutSeconds,
        idleWarningSeconds: this.#lifetimes.warningSeconds,
      };
      await this.#store.create(session);
      return session;
    }
    throw new SessionError(
      'SESSION_PROVISION_FAILED',
      'Could not allocate a unique lab sandbox after 5 attempts.',
    );
  }

  async #failSession(
    session: LabSession,
    context: LabSessionContext,
    reason: string,
  ): Promise<void> {
    // Best-effort teardown so a failed start does not leak a namespace.
    await this.#providerFor(session).destroy(context).catch(() => undefined);
    await this.#store.update(session.sessionId, {
      status: 'FAILED',
      statusReason: reason,
      endedAt: new Date(this.#now()).toISOString(),
    });
    this.#release(session.sessionId);
    this.#log(`session ${session.sessionId} FAILED: ${reason}`);
  }

  // ------------------------------------------------------------- retrieval

  /** Look up a session by id. Throws `SESSION_NOT_FOUND` when absent. */
  async require(sessionId: unknown): Promise<LabSession> {
    let id: string;
    try {
      id = assertValidSessionId(sessionId);
    } catch {
      throw new SessionError('INVALID_SESSION_ID', 'Session ids look like sess-<hex>.');
    }
    const session = await this.#store.get(id);
    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'That lab session does not exist, or it has already been cleaned up.',
        'Start the lab again to get a fresh environment.',
      );
    }
    return session;
  }

  /** A session that can still be acted on. Throws otherwise. */
  async requireActive(sessionId: unknown): Promise<{ session: LabSession; lab: LoadedLabDefinition }> {
    const session = await this.require(sessionId);
    if (session.status !== 'ACTIVE') {
      throw new SessionError(
        'SESSION_NOT_ACTIVE',
        `This lab session is ${session.status}.`,
        isTerminalStatus(session.status)
          ? 'Start the lab again to get a fresh environment.'
          : 'The environment is busy; try again in a moment.',
        { status: session.status },
      );
    }
    return { session, lab: this.#registry.get(session.labId) };
  }

  async get(sessionId: string): Promise<LabSession | null> {
    return this.#store.get(sessionId);
  }

  /** Live environment health for one session. Cheap enough for the UI to poll. */
  async status(session: LabSession): Promise<EnvironmentInfo> {
    return this.#providerFor(session).status(this.contextFor(session));
  }

  async list(): Promise<LabSession[]> {
    return this.#store.list();
  }

  /** Provider context for a session. The namespace always comes from the store. */
  contextFor(session: LabSession): LabSessionContext {
    return this.#contextFor(this.#registry.get(session.labId), session);
  }

  /**
   * Assemble the provider context.
   *
   * Every field is derived server-side: the namespace comes from the stored
   * session record (itself derived from the session id), and the policy comes
   * from configuration. Nothing here can be influenced by request input, which
   * is what makes "possessing a namespace name grants nothing" true.
   */
  #contextFor(lab: LoadedLabDefinition, session: LabSession): LabSessionContext {
    return {
      sessionId: session.sessionId,
      labId: session.labId,
      // Both come from the stored record, itself derived from the session id.
      sandboxRef: session.sandboxRef ?? session.namespace,
      namespace: session.namespace,
      serviceAccountName: session.serviceAccountName,
      lab,
      expiresAtMs: Date.parse(session.expiresAt),
      policy: this.#policy,
    };
  }

  /**
   * A read port into one session's sandbox, for the verifier.
   *
   * Returns `null` for a provider with no sandbox filesystem (Kubernetes labs
   * verify through the Kubernetes API instead). The session's context — and
   * therefore its sandbox — is bound here, so a handler is never in a position
   * to name a path in someone else's environment.
   */
  sandboxPort(session: LabSession): SandboxReadPort | null {
    const provider = this.#providers.peek(session.provider);
    if (!provider?.readSandboxPath) return null;
    const context = this.contextFor(session);
    const read = provider.readSandboxPath.bind(provider);
    const list = provider.listSandboxFiles?.bind(provider);
    const runTool = provider.runSandboxTool?.bind(provider);
    return {
      read: (relativePath, options) => read(context, relativePath, options),
      // Both are optional capabilities: a provider that does not implement
      // them leaves the corresponding checks reported as skipped, with a
      // reason, rather than failing a student for a platform gap.
      ...(list ? { list: (dir, options) => list(context, dir, options) } : {}),
      ...(runTool ? { runTool: (request) => runTool(context, request) } : {}),
    };
  }

  /** Derived, client-facing view with the countdowns the UI renders. */
  view(session: LabSession): SessionView {
    const now = this.#now();
    const expiresMs = Date.parse(session.expiresAt);
    const idleDeadlineMs =
      Date.parse(session.lastActivityAt) + session.idleTimeoutSeconds * 1000;
    const secondsRemaining = Math.max(0, Math.floor((expiresMs - now) / 1000));
    const secondsUntilIdle = Math.max(0, Math.floor((idleDeadlineMs - now) / 1000));
    const live = session.status === 'ACTIVE' || session.status === 'RESETTING';

    return {
      sessionId: session.sessionId,
      labId: session.labId,
      status: session.status,
      provider: session.provider,
      sandboxKind: session.sandboxKind,
      sandboxRef: session.sandboxRef ?? session.namespace,
      namespace: session.namespace,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      expiresAt: session.expiresAt,
      ...(session.endedAt ? { endedAt: session.endedAt } : {}),
      ...(session.statusReason ? { statusReason: session.statusReason } : {}),
      secondsRemaining: live ? secondsRemaining : 0,
      secondsUntilIdle: live ? secondsUntilIdle : 0,
      idleWarning: live && secondsUntilIdle <= session.idleWarningSeconds && secondsRemaining > 0,
      idleTimeoutSeconds: session.idleTimeoutSeconds,
      warningSeconds: session.idleWarningSeconds,
    };
  }

  // -------------------------------------------------------------- activity

  /**
   * Record meaningful activity.
   *
   * Status polling deliberately does NOT call this: if it did, an open browser
   * tab would keep an abandoned environment alive forever. The absolute
   * deadline (`expiresAt`) is never moved.
   */
  async touch(sessionId: string, reason: ActivityReason): Promise<LabSession | null> {
    const session = await this.#store.get(sessionId);
    if (!session) return null;
    if (session.status !== 'ACTIVE' && session.status !== 'RESETTING') return session;
    void reason;
    return this.#store.update(sessionId, {
      lastActivityAt: new Date(this.#now()).toISOString(),
    });
  }

  // ----------------------------------------------------------------- reset

  /** Reset only the requesting session's namespace. */
  async reset(sessionId: string): Promise<{ session: LabSession; result: ResetResult }> {
    const { session, lab } = await this.requireActive(sessionId);
    const context = this.#contextFor(lab, session);

    await this.#store.update(sessionId, { status: 'RESETTING' });
    let result: ResetResult;
    try {
      result = await this.#providerFor(session).reset(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.update(sessionId, { status: 'ACTIVE', statusReason: message });
      throw new SessionError('SESSION_RESET_FAILED', message);
    }

    const updated = await this.#store.update(sessionId, {
      status: 'ACTIVE',
      lastActivityAt: new Date(this.#now()).toISOString(),
      ...(result.ok ? {} : { statusReason: result.error?.message ?? 'reset failed' }),
    });

    return { session: updated ?? session, result };
  }

  // ------------------------------------------------------- end / expire

  /** Student pressed End Lab. */
  async end(sessionId: string): Promise<TeardownResult> {
    const session = await this.require(sessionId);
    return this.#teardown(session, 'ENDING', 'ENDED', 'ended by student');
  }

  /** Reaper collected the session. */
  async expire(sessionId: string, reason: string): Promise<TeardownResult> {
    const session = await this.require(sessionId);
    return this.#teardown(session, 'EXPIRING', 'EXPIRED', reason);
  }

  /**
   * Shared teardown, safe to run twice.
   *
   * A session that already reached a terminal state short-circuits, and a
   * namespace that is already gone counts as a success — the reaper re-enters
   * this path on every pass until the namespace is verifiably removed.
   */
  async #teardown(
    session: LabSession,
    inProgress: Extract<SessionStatus, 'ENDING' | 'EXPIRING'>,
    done: Extract<SessionStatus, 'ENDED' | 'EXPIRED'>,
    reason: string,
  ): Promise<TeardownResult> {
    if (isTerminalStatus(session.status)) {
      return {
        session,
        destroy: { ok: true, namespaceGone: true, steps: [] },
      };
    }

    const marked =
      (await this.#store.update(session.sessionId, {
        status: inProgress,
        statusReason: reason,
      })) ?? session;

    // Close the student's shell first: once the namespace goes, their kubectl
    // would only produce confusing errors.
    if (this.#terminal) {
      await this.#terminal.terminate(session.sessionId).catch((error: unknown) => {
        this.#log(
          `session ${session.sessionId}: could not close terminal — ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    const context = this.contextFor(marked);
    const destroy = await this.#providerFor(marked).destroy(context);

    // `ok` means the delete call was accepted; `namespaceGone` means the
    // namespace is verifiably absent. Only the latter finishes the teardown.
    if (!destroy.ok || !destroy.namespaceGone) {
      // Deletion is asynchronous; stay in EXPIRING/ENDING and let the next
      // cleanup pass verify. Nothing is marked done until the namespace is gone.
      this.#log(
        `session ${session.sessionId} ${inProgress}: ${destroy.error?.message ?? 'namespace not yet removed'}`,
      );
      const current = (await this.#store.get(session.sessionId)) ?? marked;
      return { session: current, destroy };
    }

    const ended =
      (await this.#store.update(session.sessionId, {
        status: done,
        statusReason: reason,
        endedAt: new Date(this.#now()).toISOString(),
      })) ?? marked;
    this.#release(session.sessionId);
    this.#log(`session ${session.sessionId} ${done} (${reason})`);

    // The sandbox is gone; tell whoever keeps the durable record. Emitted here
    // rather than in the two callers so End Lab and the reaper cannot drift.
    await this.#notifyClosed({
      sessionId: ended.sessionId,
      labId: ended.labId,
      provider: ended.provider,
      status: done,
      reason,
    });

    return { session: ended, destroy };
  }

  /** Never lets a listener failure escape into the teardown path. */
  async #notifyClosed(event: SessionClosedEvent): Promise<void> {
    if (!this.#listener?.onSessionClosed) return;
    try {
      await this.#listener.onSessionClosed(event);
    } catch (error) {
      this.#log(
        `session ${event.sessionId}: lifecycle listener failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Release a capacity slot exactly once per session.
   *
   * The `#released` marker is never cleared: teardown is re-entrant, and a
   * second pass over an already-released session must not hand back a slot
   * that was already handed back.
   */
  #release(sessionId: string): void {
    if (this.#released.has(sessionId)) return;
    this.#released.add(sessionId);
    this.#occupied = Math.max(0, this.#occupied - 1);
  }

  /** Forget a finished session record (used by the reaper's retention sweep). */
  async forget(sessionId: string): Promise<void> {
    this.#release(sessionId);
    await this.#store.delete(sessionId);
  }

  // ----------------------------------------------------------- credentials

  /**
   * Kubeconfig for the terminal service. Never returned to the browser: only
   * the internal, service-authenticated route calls this.
   */
  async issueCredentials(sessionId: string): Promise<StudentCredentials> {
    const context = await this.getTerminalContext(sessionId);
    if (context.kind !== 'kubernetes') {
      throw new SessionError(
        'CREDENTIALS_UNAVAILABLE',
        `This session's sandbox is not a Kubernetes namespace, so it has no kubeconfig.`,
      );
    }
    return {
      kubeconfig: context.kubeconfig,
      namespace: context.namespace,
      serviceAccountName: context.serviceAccountName,
      expiresAt: context.expiresAt,
    };
  }

  /**
   * The terminal binding for a session.
   *
   * The generic replacement for "hand the terminal a kubeconfig". Resolved from
   * the session record through that session's own provider, so the terminal
   * service never learns which sandbox to attach to from anything a browser
   * sent — see `apps/api/src/routes/internal.ts`.
   */
  async getTerminalContext(sessionId: string): Promise<TerminalContext> {
    const { session, lab } = await this.requireActive(sessionId);
    try {
      return await this.#providerFor(session).getTerminalContext(this.#contextFor(lab, session));
    } catch (error) {
      throw new SessionError(
        'CREDENTIALS_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Sessions that hold a namespace right now. */
  async listOccupying(): Promise<LabSession[]> {
    return this.#store.listOccupying();
  }

  /** Statuses that count towards `MAX_ACTIVE_SESSIONS`. */
  static readonly OCCUPYING_STATUSES = OCCUPYING_STATUSES;
}
