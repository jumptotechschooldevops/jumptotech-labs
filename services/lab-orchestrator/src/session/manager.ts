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
 *                            │  ▲           │
 *                            │  └─ DEGRADED ◄┘       (reset failed / interrupted)
 *              expire() ─────┼──► EXPIRING ──► EXPIRED
 *                 end() ─────┴──► ENDING   ──► ENDED
 *                            └──► FAILED                (provisioning failed)
 * ```
 *
 * Every status change is one conditional write (`SessionStore.transition`),
 * made through `#transition` so it is stamped with when it happened. No
 * operation assumes the row is still where it left it: start, reset and
 * teardown each check that their own claim still stands before they report
 * success, and discard what they built when a teardown took the session.
 */
import type { LabRegistry } from '../lab-registry.js';
import type { LoadedLabDefinition } from '../lab-definition.js';
import type {
  CreateResult,
  DestroyResult,
  EnvironmentInfo,
  LabSessionContext,
  LabProvider,
  ProvisionStep,
  ResetResult,
  SandboxListOptions,
  SandboxPathRead,
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
import type { SessionStore, TransitionGuard } from './store.js';
import {
  OCCUPYING_STATUSES,
  RESETTABLE_STATUSES,
  SessionError,
  isTeardownOwned,
  isTerminalStatus,
  type LabSession,
  type SessionPolicy,
  type SessionStatus,
} from './types.js';

/** What a teardown may claim besides its own in-flight state. */
const LIVE_STATUSES: readonly SessionStatus[] = ['CREATING', 'ACTIVE', 'RESETTING', 'DEGRADED'];

const RESET_RETRY_REMEDIATION =
  'The last reset did not finish, so this environment cannot be used as it is. ' +
  'Reset the lab to rebuild it, or End Lab to release it.';

/** What a student can do about a session that is not ACTIVE. */
function remediationFor(status: SessionStatus): string {
  if (isTerminalStatus(status)) return 'Start the lab again to get a fresh environment.';
  if (status === 'DEGRADED') return RESET_RETRY_REMEDIATION;
  return 'The environment is busy; try again in a moment.';
}

/** The refusal for acting on a session that is not ACTIVE. */
function notActive(status: SessionStatus): SessionError {
  return new SessionError(
    'SESSION_NOT_ACTIVE',
    `This lab session is ${status}.`,
    remediationFor(status),
    { status },
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  /**
   * Refuse a student's start once *they* hold this many sessions.
   *
   * Independent of `maxActiveSessions`, which still binds on its own. Absent
   * means no per-student limit — the documented default until a beta value is
   * decided (`MAX_ACTIVE_SESSIONS_PER_STUDENT`). Counted over the same
   * occupying statuses as the global ceiling, and applied only to a start with
   * an owner.
   */
  maxActiveSessionsPerStudent?: number;
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
   * Ask the sandbox an allow-listed inspection question, for the `linux`
   * requirement family — is this process running, is this port listening, is
   * this account in that group.
   *
   * Optional, and absent unless the provider offered it. A Terraform sandbox
   * has a filesystem but is not a system to administer, so it supplies `read`
   * and nothing else, and a `linux` check against it is reported as skipped
   * rather than failed.
   */
  inspect?(
    command: string,
    args: readonly string[],
    options?: { asRoot?: boolean; timeoutMs?: number },
  ): Promise<SandboxInspectResult>;
  /**
   * List files under a sandbox directory, for configuration checks.
   *
   * Present only for providers that implement it. Terraform configuration
   * checks need it because Terraform reads every `.tf` file in a directory and
   * a lab cannot know which ones a student wrote; nothing else needs it.
   */
  list?(relativeDir: string, options?: SandboxListOptions): Promise<string[]>;
  /** Run a script the student wrote, for the `script_runs` check. */
  runScript?(
    scriptPath: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<SandboxInspectResult>;
}

/** What an inspection command reported. Never shown to a student verbatim. */
export interface SandboxInspectResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Hook used to close a student's terminal when their session goes away. */
export interface TerminalTerminator {
  terminate(sessionId: string): Promise<void>;
  /**
   * Reconnect a live terminal to a replaced sandbox.
   *
   * Optional: a provider whose reset leaves the sandbox standing (the
   * Kubernetes one) never triggers it, and a deployment configured without
   * terminal control simply does not have it.
   */
  reattach?(sessionId: string): Promise<void>;
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
  /**
   * How long Start waits for a provider's availability probe before going
   * ahead without it (default 5 s). A hung cluster API must not hang every
   * Start; without an answer, provisioning tries and reports what it finds.
   */
  availabilityCheckTimeoutMs?: number;
  now?: () => number;
  logger?: (message: string) => void;
  /**
   * Observability hooks — PLATFORM-003.
   *
   * Plain callbacks, deliberately: this package must not learn about
   * Prometheus, and a metric type here would put a monitoring dependency
   * underneath every provider. The API adapts these to counters in its own
   * composition root, exactly as it already does for `logger`.
   *
   * Every hook is optional and every call site swallows a throwing hook — a
   * broken metric must never fail a student's lab.
   */
  metrics?: SessionMetricsHooks;
}

/** See `SessionManagerOptions.metrics`. */
export interface SessionMetricsHooks {
  onProvision?(event: {
    provider: string;
    sandboxKind: string;
    /** `success` or `failed`. */
    outcome: string;
    durationMs: number;
    /** Per-step timings, so "provisioning is slow" becomes "the pull is slow". */
    steps: Array<{ name: string; outcome: string; durationMs: number }>;
  }): void;
  onTransition?(from: string, to: string): void;
  /** The platform was full. */
  onCapacityRejected?(track: string): void;
  /** The student already held their share; the platform may have had room. */
  onStudentLimitRejected?(track: string): void;
  onSessionEnded?(event: {
    provider: string;
    /** `student`, `idle`, `expired`, `orphaned`, `failed`. */
    reason: string;
    lifetimeSeconds: number;
  }): void;
}

/**
 * Collapse a teardown into a bounded reason label.
 *
 * `reason` reaching `#teardown` is free text — the reaper builds sentences like
 * `idle for more than 1200s`, and `SessionManager.expire` accepts whatever a
 * caller passes. Free text is exactly what must never become a metric label:
 * `idle for more than 1200s` and `idle for more than 900s` are two series for
 * one condition, and a caller could put anything at all in there.
 *
 * So the *text* stays in the log line, where it is useful and bounded by
 * retention, and the *metric* gets one of four values.
 */
/** The `statusReason` of a session an operator ended. */
export const OPERATOR_END_REASON = 'ended by operator';

/**
 * The `statusReason` of a session the reaper tore down because its start
 * never finished — the process building it died, or lost the database, before
 * it could record ACTIVE or FAILED.
 */
export const ABANDONED_START_REASON = 'the lab did not finish starting';

function endReasonFor(done: 'ENDED' | 'EXPIRED', detail: string): string {
  if (done === 'ENDED') return 'student';
  if (detail === OPERATOR_END_REASON) return 'operator';
  // A start that never finished is a failed start, whoever cleaned it up.
  if (detail === ABANDONED_START_REASON) return 'failed';
  const lowered = detail.toLowerCase();
  if (lowered.includes('idle')) return 'idle';
  if (lowered.includes('lifetime') || lowered.includes('expired')) return 'expired';
  return 'expired';
}

export interface StartSessionResult {
  session: LabSession;
  lab: LoadedLabDefinition;
  environment: EnvironmentInfo;
  steps: ProvisionStep[];
}

/** What a caller of `start` is told along the way. */
export interface StartHooks {
  /**
   * The session was admitted — its row exists, CREATING, holding a slot — and
   * nothing has been built yet.
   *
   * The one point at which a start is known to be an attempt rather than a
   * refusal: every refusal (the lab's provider is down, the platform is full,
   * the student already holds their share) happens before it and never calls
   * it. Awaited, so whatever it records exists before the sandbox does. A hook
   * that throws is logged and ignored: bookkeeping must never stop a lab.
   */
  onAdmitted?(session: LabSession): Promise<void> | void;
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
  readonly #availabilityCheckTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #metrics: SessionMetricsHooks;

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
    this.#availabilityCheckTimeoutMs = options.availabilityCheckTimeoutMs ?? 5_000;
    this.#log = options.logger ?? (() => undefined);
    this.#metrics = options.metrics ?? {};
  }

  /**
   * Call an observability hook without ever letting it affect the caller.
   *
   * A counter that throws — a label policy violation, a registry misuse — must
   * not turn a successful lab start into a 500. Instrumentation is allowed to
   * be wrong; the platform is not allowed to break because of it.
   */
  #emit(call: (hooks: SessionMetricsHooks) => void): void {
    try {
      call(this.#metrics);
    } catch {
      /* an instrumentation failure is never a platform failure */
    }
  }

  get policy(): SessionPolicy {
    return this.#policy;
  }

  get lifetimes(): SessionLifetimeConfig {
    return this.#lifetimes;
  }

  /**
   * How many sessions hold a sandbox, counted from durable state.
   *
   * Asynchronous now because the answer belongs to the store rather than to
   * this process: with several instances running, no one of them can know the
   * total from its own memory.
   */
  activeCount(): Promise<number> {
    return this.#store.countOccupying();
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
  /**
   * Start a lab for a specific owner.
   *
   * `ownerUserId` comes from the caller's verified identity, never from the
   * request body — the route passes what the auth layer resolved, and there is
   * no field a browser could use to name someone else.
   */
  async start(labId: string, ownerUserId?: string, hooks: StartHooks = {}): Promise<StartSessionResult> {
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

    /*
     * Is the substrate up? The same probe the catalog shows students, asked
     * again fresh when its memoised answer is no, and bounded in time: a probe
     * that does not answer lets the start go ahead. Without it a runtime that was down still reached
     * `create`, failed there, and was reported as a failed *provision*: the
     * operator was sent to RB-03 instead of the substrate, and the student
     * was told to rebuild a sandbox image. Checked before capacity, like the
     * registration check above, so a refused start holds no slot.
     */
    let availability = await this.#probe(lab.environment.provider);
    if (availability && !availability.available) {
      // Memoised for 30 s: a substrate that has just come back must not keep
      // refusing starts. Ask again, now, before saying no.
      this.#providers.invalidate(lab.environment.provider);
      availability = await this.#probe(lab.environment.provider);
    }
    if (availability && !availability.available) {
      // The probe's reason names hosts and addresses, and its remediation is
      // an operator's command: both go to the log (and `ops status`), and the
      // student gets words they can act on.
      this.#log(
        `start of ${lab.id} refused: provider ${lab.environment.provider} is unavailable — ${availability.reason ?? 'no reason given'}`,
      );
      throw new SessionError(
        'PROVIDER_UNAVAILABLE',
        // A security refusal says it is one (the network-isolation gate);
        // anything else stays generic.
        availability.studentReason
          ? `This lab's environment cannot be created right now: ${availability.studentReason}.`
          : "This lab's environment cannot be created right now.",
        'Try again in a few minutes. If it keeps happening, tell your instructor.',
        { provider: lab.environment.provider },
      );
    }

    /*
     * Capacity is counted from durable state, and the count and the insert are
     * one step.
     *
     * Three API instances each keeping their own tally would admit three times
     * the configured limit between them, and none would be wrong about its own
     * count — so the tally cannot live in a process. Nor can the check be a
     * separate read: an `await` between counting and inserting is a gap another
     * start can pass through, which is exactly what the simultaneous-starts
     * test catches.
     */
    const session = await this.#insertSession(lab, provider, ownerUserId);
    this.#emit((m) => m.onTransition?.('none', 'CREATING'));

    if (hooks.onAdmitted) {
      try {
        await hooks.onAdmitted(session);
      } catch (error) {
        this.#log(`session ${session.sessionId}: admission hook failed — ${describeError(error)}`);
      }
    }

    const context = this.#contextFor(lab, session);
    const provisionStartedAt = this.#now();
    let result: CreateResult;
    try {
      result = await provider.create(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#recordProvision(session, provisionStartedAt, 'failed', []);
      await this.#failSession(session, context, message);
      throw new SessionError('SESSION_PROVISION_FAILED', message);
    }

    if (!result.ok) {
      this.#recordProvision(session, provisionStartedAt, 'failed', result.steps);
      const message = result.error?.message ?? 'Failed to create the lab environment';
      await this.#failSession(session, context, message);
      throw new SessionError(
        'SESSION_PROVISION_FAILED',
        message,
        result.error?.remediation,
        { steps: result.steps, environment: result.environment, code: result.error?.code },
      );
    }

    this.#recordProvision(session, provisionStartedAt, 'success', result.steps);

    /*
     * Conditional, like every other status change.
     *
     * A teardown — End, or the reaper — can claim a session while the provider
     * is still building it, and can even record ENDED: its destroy found
     * nothing yet to destroy. This used to be an unconditional update, which
     * moved that ENDED row back to ACTIVE over a sandbox the provider went on to
     * create regardless. Now a start that lost its session says so, and removes
     * what it built.
     */
    const active = await this.#transition(session.sessionId, ['CREATING'], 'ACTIVE', {
      environmentId: result.environment.environmentId,
      lastActivityAt: new Date(this.#now()).toISOString(),
    });
    if (!active) {
      await this.#discardLostWork(session, context, 'start');
      await this.#finishTeardownOfLostStart(session.sessionId);
      throw await this.#closedDuringStart(session.sessionId);
    }
    this.#emit((m) => m.onTransition?.('CREATING', 'ACTIVE'));

    // The count is for the log line only. The session is ACTIVE and its
    // sandbox built, so a store that fails this read must not turn the start
    // into an error: the student would be refused a lab that is running and
    // holding their one slot.
    const inUse = await this.#store.countOccupying().then(String, () => '?');
    this.#log(
      `session ${session.sessionId} ACTIVE (lab=${lab.id} provider=${session.provider} ` +
        `sandbox=${session.sandboxRef}, ${inUse}/${this.#lifetimes.maxActiveSessions} in use)`,
    );

    return {
      session: active,
      lab,
      environment: result.environment,
      steps: result.steps,
    };
  }

  /**
   * The provider's availability, or null when the probe did not answer in time.
   * `status()` never rejects: a failing probe is an unavailable provider.
   */
  async #probe(providerId: LabProviderId): Promise<Awaited<ReturnType<ProviderRegistry['status']>> | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.#availabilityCheckTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.#providers.status(providerId), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Create the session record, binding it to a provider and a sandbox handle.
   *
   * Both are derived here, server-side: the provider from the lab definition,
   * the sandbox handle from the session id through a keyed HMAC. Neither can be
   * influenced by request input, which is what makes "a browser cannot choose
   * its sandbox, or another session's" true at the point it matters.
   */
  async #insertSession(
    lab: LoadedLabDefinition,
    provider: LabProvider,
    ownerUserId?: string,
  ): Promise<LabSession> {
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

      const candidate: LabSession = {
        sessionId,
        labId: lab.id,
        provider: provider.id,
        sandboxKind,
        sandboxRef,
        namespace,
        serviceAccountName: this.#policy.serviceAccountName,
        status: 'CREATING',
        environmentId: '',
        ...(ownerUserId ? { ownerUserId } : {}),
        createdAt,
        lastActivityAt: createdAt,
        statusChangedAt: createdAt,
        expiresAt,
        idleTimeoutSeconds: this.#lifetimes.idleTimeoutSeconds,
        idleWarningSeconds: this.#lifetimes.warningSeconds,
      };
      const decision = await this.#store.createWithinLimits(candidate, {
        maxOccupying: this.#lifetimes.maxActiveSessions,
        ...(this.#lifetimes.maxActiveSessionsPerStudent !== undefined
          ? { maxOccupyingPerOwner: this.#lifetimes.maxActiveSessionsPerStudent }
          : {}),
      });
      if (decision.admitted) return candidate;

      /*
       * Two refusals, kept apart all the way out.
       *
       * A student at their own limit is not the platform being full: the alert
       * on capacity refusals pages someone, and one student pressing Start
       * repeatedly must not. The per-student refusal also reports only that
       * student's own numbers — nothing about how busy anyone else is.
       */
      if (decision.refusedBy === 'owner') {
        const limit = this.#lifetimes.maxActiveSessionsPerStudent ?? decision.ownerOccupying;
        this.#emit((m) => m.onStudentLimitRejected?.(lab.track));
        this.#log(
          `start refused for lab=${lab.id}: per-student limit reached (${decision.ownerOccupying}/${limit})`,
        );
        throw new SessionError(
          'STUDENT_SESSION_LIMIT_REACHED',
          limit === 1
            ? 'You already have a practice environment running.'
            : `You already have ${decision.ownerOccupying} practice environments running, the most one student can hold at once.`,
          'End a lab you have finished before starting another. Idle environments are also released automatically.',
          {
            activeSessions: decision.ownerOccupying,
            maxActiveSessionsPerStudent: limit,
          },
        );
      }

      this.#emit((m) => m.onCapacityRejected?.(lab.track));
      this.#log(
        `start refused for lab=${lab.id}: global capacity reached (${decision.occupying}/${this.#lifetimes.maxActiveSessions})`,
      );
      throw new SessionError(
        'LAB_CAPACITY_REACHED',
        `All ${this.#lifetimes.maxActiveSessions} practice environments are currently in use.`,
        'Try again shortly — environments are released automatically when students finish or go idle.',
        {
          activeSessions: decision.occupying,
          maxActiveSessions: this.#lifetimes.maxActiveSessions,
        },
      );
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
    // A failed provision is news about the substrate: forget the memoised
    // "available", so the next Start (and the catalog) probes again instead of
    // walking into the same failure for the rest of the 30 s.
    this.#providers.invalidate(session.provider);

    /*
     * Best-effort teardown so a failed start does not leak a sandbox.
     *
     * Best-effort is enough because it is not the last line: once the row is
     * finished, the reaper reclaims any sandbox still carrying its session id
     * (`SessionReaper`, "sandboxes of finished sessions").
     */
    try {
      const destroy = await this.#providerFor(session).destroy(context);
      if (!destroy.ok || !destroy.namespaceGone) {
        this.#log(
          `session ${session.sessionId}: failed start not yet cleaned up — ${destroy.error?.message ?? 'still present'}`,
        );
      }
    } catch (error) {
      this.#log(`session ${session.sessionId}: could not clean up failed start — ${describeError(error)}`);
    }

    // A teardown that claimed the session during provisioning owns how it
    // ends. FAILED must not overwrite its ENDING/ENDED.
    const failed = await this.#transition(session.sessionId, ['CREATING'], 'FAILED', {
      statusReason: reason,
      endedAt: new Date(this.#now()).toISOString(),
    });
    if (!failed) {
      const current = await this.#store.get(session.sessionId);
      this.#log(
        `session ${session.sessionId}: provisioning failed after a teardown claimed it; left ${current?.status ?? 'removed'} — ${reason}`,
      );
      await this.#finishTeardownOfLostStart(session.sessionId);
      return;
    }
    this.#emit((m) => m.onTransition?.(session.status, 'FAILED'));
    this.#emit((m) =>
      m.onSessionEnded?.({
        provider: session.provider,
        reason: 'failed',
        lifetimeSeconds: Math.max(0, (this.#now() - Date.parse(session.createdAt)) / 1000),
      }),
    );
    this.#log(`session ${session.sessionId} FAILED: ${reason}`);
  }

  /** Observe one provisioning attempt, including its per-step breakdown. */
  #recordProvision(
    session: LabSession,
    startedAt: number,
    outcome: string,
    steps: readonly ProvisionStep[],
  ): void {
    this.#emit((m) =>
      m.onProvision?.({
        provider: session.provider,
        sandboxKind: session.sandboxKind,
        outcome,
        durationMs: Math.max(0, this.#now() - startedAt),
        steps: steps
          .filter((step) => typeof step.durationMs === 'number')
          .map((step) => ({
            // `id` rather than `label`: it is the stable, bounded identifier.
            // A label is prose and would put unbounded text in a metric.
            name: step.id,
            outcome: step.status,
            durationMs: step.durationMs ?? 0,
          })),
      }),
    );
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
    if (session.status !== 'ACTIVE') throw notActive(session.status);
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
    const inspect = provider.inspectSandbox?.bind(provider);
    const runScript = provider.runSandboxScript?.bind(provider);
    const httpFromPeer = provider.requestFromPeer?.bind(provider);
    const list = provider.listSandboxFiles?.bind(provider);
    return {
      read: (relativePath, options) => read(context, relativePath, options),
      // Optional: a provider that does not implement it leaves configuration
      // checks reported as skipped, with a reason, rather than failing a
      // student for a gap in the platform.
      ...(list ? { list: (dir, options) => list(context, dir, options) } : {}),
      ...(inspect
        ? { inspect: (command, args, options) => inspect(context, command, args, options) }
        : {}),
      ...(runScript
        ? { runScript: (scriptPath, args, options) => runScript(context, scriptPath, args, options) }
        : {}),
      // Offered only by a provider that created a peer for this session. A lab
      // asking for a peer request without one fails the check rather than
      // passing it: the platform could not measure, which is not a pass.
      ...(httpFromPeer
        ? {
            httpFromPeer: (request: { port: number; path: string; timeoutSeconds?: number }) =>
              httpFromPeer(context, request),
          }
        : {}),
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
   *
   * One conditional write, so the decision is the store's. This used to read
   * the session and then write unconditionally, and an End landing between the
   * two had `lastActivityAt` stamped onto its ENDED row. When the write
   * declines, the session is read back so the caller is shown what it now is
   * rather than the copy it started with.
   */
  async touch(sessionId: string, reason: ActivityReason): Promise<LabSession | null> {
    void reason;
    const touched = await this.#store.touchActivity(sessionId, new Date(this.#now()).toISOString());
    return touched ?? this.#store.get(sessionId);
  }

  /**
   * Record terminal activity. Same conditional write and deadline rules as
   * `touch`, without the read-back: the terminal only needs to know whether
   * anything was recorded.
   *
   * There is no status pre-check. A pre-check is a read, and a session End
   * claims after it is exactly the one the write must refuse — so the write's
   * own condition is the only check that means anything.
   *
   * Returns `null` when nothing was recorded.
   */
  async touchActivity(sessionId: string, reason: ActivityReason): Promise<LabSession | null> {
    void reason;
    return this.#store.touchActivity(sessionId, new Date(this.#now()).toISOString());
  }

  // ----------------------------------------------------------------- reset

  /**
   * Reset only the requesting session's sandbox.
   *
   * Every status change here is a `transition`, never an `update`.
   *
   * The claim (ACTIVE or DEGRADED → RESETTING) comes before any runtime work,
   * so of two simultaneous resets exactly one replaces the sandbox; the other is
   * refused with `SESSION_NOT_ACTIVE`.
   *
   * Every release is conditional and fenced on that claim's own timestamp. A
   * teardown may claim a RESETTING session, and the reaper may declare an
   * abandoned one DEGRADED — after which a *second* reset can hold RESETTING
   * again. Status alone cannot tell those claims apart, so a release matching
   * status alone could hand the second reset's session back as ACTIVE.
   *
   * A reset that does not succeed never reports ACTIVE. A container reset
   * destroys the sandbox before rebuilding it, and a Kubernetes one purges
   * before it re-applies, so after a failure nobody can vouch for what is left:
   * the session becomes DEGRADED, which refuses checks, terminals and activity
   * but can be reset again or ended.
   */
  async reset(sessionId: string): Promise<{ session: LabSession; result: ResetResult }> {
    const session = await this.require(sessionId);
    if (!RESETTABLE_STATUSES.includes(session.status)) throw notActive(session.status);
    const context = this.#contextFor(this.#registry.get(session.labId), session);

    // Pressing Reset is activity. Stamped only when the reset ends, a reset
    // started near the idle deadline was expired by the reaper mid-rebuild.
    const claimed = await this.#transition(sessionId, RESETTABLE_STATUSES, 'RESETTING', {
      lastActivityAt: new Date(this.#now()).toISOString(),
    });
    if (!claimed) throw await this.#resetConflict(sessionId);
    const fence: TransitionGuard = { statusChangedAt: claimed.statusChangedAt };

    let result: ResetResult;
    try {
      result = await this.#providerFor(session).reset(context);
    } catch (error) {
      const message = describeError(error);
      const degraded = await this.#degrade(sessionId, `The last reset did not finish: ${message}`, fence, true);
      if (!degraded) {
        this.#log(`session ${sessionId}: reset failed after losing its claim — ${message}`);
        await this.#discardLostWork(session, context, 'reset');
        throw await this.#resetConflict(sessionId);
      }
      throw new SessionError('SESSION_RESET_FAILED', message, RESET_RETRY_REMEDIATION, {
        status: degraded.status,
      });
    }

    if (!result.ok) {
      const degraded = await this.#degrade(
        sessionId,
        `The last reset did not finish: ${result.error?.message ?? 'reset failed'}`,
        fence,
        true,
      );
      if (!degraded) {
        await this.#discardLostWork(session, context, 'reset');
        throw await this.#resetConflict(sessionId);
      }
      return { session: degraded, result };
    }

    const updated = await this.#transition(
      sessionId,
      ['RESETTING'],
      'ACTIVE',
      { lastActivityAt: new Date(this.#now()).toISOString() },
      fence,
    );
    if (!updated) {
      await this.#discardLostWork(session, context, 'reset');
      throw await this.#resetConflict(sessionId);
    }

    /*
     * Reconnect the student's shell, for the providers whose reset replaces the
     * sandbox rather than emptying it.
     *
     * A Kubernetes reset purges objects and keeps the namespace, so the shell
     * — a local PTY holding a kubeconfig — survives untouched. A container
     * reset genuinely recreates the container, which kills the `docker exec`
     * inside it, so without this the student would be left looking at a dead
     * terminal after a successful reset.
     *
     * Best-effort on purpose: the reset itself succeeded, and a terminal that
     * could not be reconnected is a worse terminal, not a failed reset. The
     * student can reload the page.
     */
    if (session.sandboxKind === 'container' && this.#terminal?.reattach) {
      await this.#terminal.reattach(session.sessionId).catch((error: unknown) => {
        this.#log(`session ${session.sessionId}: terminal did not reconnect after reset — ${describeError(error)}`);
      });
    }

    return { session: updated, result };
  }

  /**
   * Declare a reset's sandbox unusable: RESETTING → DEGRADED.
   *
   * `studentAction` records activity, so a student who just pressed Reset gets
   * a full idle window to press it again; recovery on the reaper's behalf does
   * not, so an abandoned session is still reclaimed on time.
   */
  async #degrade(
    sessionId: string,
    reason: string,
    guard: TransitionGuard,
    studentAction: boolean,
  ): Promise<LabSession | null> {
    const degraded = await this.#transition(
      sessionId,
      ['RESETTING'],
      'DEGRADED',
      {
        statusReason: reason,
        ...(studentAction ? { lastActivityAt: new Date(this.#now()).toISOString() } : {}),
      },
      guard,
    );
    if (degraded) {
      this.#emit((m) => m.onTransition?.('RESETTING', 'DEGRADED'));
      this.#log(`session ${sessionId} DEGRADED: ${reason}`);
    }
    return degraded;
  }

  /**
   * Recover a reset whose owner is gone — the reaper's half of `reset`.
   *
   * A process that dies mid-reset leaves RESETTING behind, and nothing else
   * would ever move it: only the dead reset could release it. What state its
   * sandbox is in is unknowable — removed, half rebuilt, or fine — so it is
   * not reported as ACTIVE. DEGRADED lets the student reset again or end, and
   * leaves the session to idle and absolute expiry if they have gone.
   *
   * Fenced on the claim the reaper observed. If that reset finished, or
   * another reset has since claimed the session, the row no longer matches and
   * this does nothing. If the "dead" reset is in fact alive and merely slow,
   * its own fenced release fails afterwards and it leaves the sandbox alone.
   */
  async recoverInterruptedReset(observed: LabSession): Promise<LabSession | null> {
    if (observed.status !== 'RESETTING') return null;
    return this.#degrade(
      observed.sessionId,
      'The last reset was interrupted before it finished.',
      { statusChangedAt: observed.statusChangedAt },
      false,
    );
  }

  /**
   * The refusal for a reset that did not hold its claim, describing the session
   * as it is now.
   *
   * Usually another reset is running (RESETTING) or a teardown owns the session
   * (ENDING, ENDED, …). If a competing reset has already finished, the session
   * reads ACTIVE again, and the caller is told to retry rather than shown a
   * status that contradicts the refusal.
   */
  async #resetConflict(sessionId: string): Promise<SessionError> {
    const current = await this.#store.get(sessionId);
    if (!current) {
      return new SessionError(
        'SESSION_NOT_FOUND',
        'That lab session does not exist, or it has already been cleaned up.',
        'Start the lab again to get a fresh environment.',
      );
    }
    return new SessionError(
      'SESSION_NOT_ACTIVE',
      current.status === 'ACTIVE'
        ? 'This lab session was changed by another request.'
        : `This lab session is ${current.status}.`,
      remediationFor(current.status),
      { status: current.status },
    );
  }

  /** The refusal for a start whose session a teardown claimed while it was provisioning. */
  async #closedDuringStart(sessionId: string): Promise<SessionError> {
    const current = await this.#store.get(sessionId);
    return new SessionError(
      'SESSION_NOT_ACTIVE',
      `This lab session was closed while it was starting${current ? ` (${current.status})` : ''}.`,
      'Start the lab again to get a fresh environment.',
      current ? { status: current.status } : undefined,
    );
  }

  /**
   * Remove what a start or reset built after it lost its claim.
   *
   * Only when a teardown owns the session. A teardown may have destroyed the
   * sandbox, and even recorded ENDED, while the provider was still building
   * it; the rebuilt sandbox would then outlive its session. Destroy is
   * idempotent, so running it alongside the teardown's own destroy is safe.
   *
   * When the claim went anywhere else — the reaper recovered an abandoned reset
   * and a second reset now holds the session, or has already made it ACTIVE —
   * the sandbox is that session's current one, and destroying it would break a
   * reset that is about to report success.
   *
   * A failure here is logged, not thrown: the caller's reply is a conflict
   * either way, and a sandbox left behind by a finished session is reclaimed by
   * the reaper.
   */
  async #discardLostWork(
    session: LabSession,
    context: LabSessionContext,
    operation: 'start' | 'reset',
  ): Promise<void> {
    const current = await this.#store.get(session.sessionId);
    if (current && !isTeardownOwned(current.status)) {
      this.#log(
        `session ${session.sessionId}: ${operation} lost its claim, session is now ${current.status}; leaving its sandbox`,
      );
      return;
    }
    this.#log(`session ${session.sessionId}: ${operation} lost its claim to a teardown; discarding its sandbox`);
    try {
      const destroy = await this.#providerFor(session).destroy(context);
      if (!destroy.ok || !destroy.namespaceGone) {
        this.#log(
          `session ${session.sessionId}: sandbox built by a lost ${operation} not yet removed — ${
            destroy.error?.message ?? 'still present'
          }`,
        );
      }
    } catch (error) {
      this.#log(
        `session ${session.sessionId}: could not discard sandbox built by a lost ${operation} — ${describeError(error)}`,
      );
    }
  }

  /**
   * Finish the teardown that claimed a session while its start was building.
   *
   * That teardown only marked the row (see `#teardown`), so it still holds its
   * slot; the start, which alone knew when the build was over, ends it now as
   * what it was — an End as ENDED, an expiry as EXPIRED — with the teardown's
   * own reason. Racing another resumption of the same teardown is safe:
   * destroy is idempotent and only one of them records the ending. A failure
   * is logged; the reaper resumes an unfinished teardown.
   */
  async #finishTeardownOfLostStart(sessionId: string): Promise<void> {
    try {
      const current = await this.#store.get(sessionId);
      if (current?.status === 'ENDING') {
        await this.resumeAbandonedEnd(sessionId);
      } else if (current?.status === 'EXPIRING') {
        await this.#teardown(current, ['EXPIRING'], 'EXPIRING', 'EXPIRED', current.statusReason ?? 'expired');
      }
    } catch (error) {
      this.#log(`session ${sessionId}: could not finish the teardown of a lost start — ${describeError(error)}`);
    }
  }

  // ------------------------------------------------------- end / expire

  /** Student pressed End Lab. */
  async end(sessionId: string): Promise<TeardownResult> {
    const session = await this.require(sessionId);
    return this.#teardown(session, [...LIVE_STATUSES, 'ENDING'], 'ENDING', 'ENDED', 'ended by student', undefined, {
      deferToStart: true,
    });
  }

  /**
   * Reaper collected the session.
   *
   * `claimGuard` fences the claim on what the reaper decided from: an idle
   * expiry passes the activity stamp it saw, so a student active since then
   * keeps their lab.
   */
  async expire(sessionId: string, reason: string, claimGuard?: TransitionGuard): Promise<TeardownResult> {
    const session = await this.require(sessionId);
    return this.#teardown(session, [...LIVE_STATUSES, 'EXPIRING'], 'EXPIRING', 'EXPIRED', reason, claimGuard);
  }

  /**
   * An operator ended the session, from the api's operator socket.
   *
   * The same fenced teardown the reaper uses, recorded EXPIRED with the reason
   * "ended by operator", so the student's page, the metrics and the audit line
   * all say the platform ended it rather than the student. Nothing is skipped:
   * the shell is closed, the provider's own session-scoped destroy re-checks
   * the managed, owner and session labels, and the row stays EXPIRING — holding
   * its slot — until the sandbox is verifiably gone.
   *
   * A teardown already in flight is finished as what it is, never relabelled:
   * ENDING is the student's End (`resumeAbandonedEnd`, as the reaper does), and
   * EXPIRING keeps its reason (idle, lifetime). A finished session is returned
   * as it is; the operator socket refuses to call this for one.
   */
  async endByOperator(sessionId: string): Promise<TeardownResult> {
    const session = await this.require(sessionId);
    if (session.status === 'ENDING') return this.resumeAbandonedEnd(session.sessionId);
    if (session.status === 'EXPIRING') {
      // An expiry already in flight (idle, lifetime) keeps its reason: the
      // operator's request only helps it finish, and must not relabel it.
      return this.#teardown(
        session,
        ['EXPIRING'],
        'EXPIRING',
        'EXPIRED',
        session.statusReason ?? OPERATOR_END_REASON,
      );
    }
    return this.#teardown(session, LIVE_STATUSES, 'EXPIRING', 'EXPIRED', OPERATOR_END_REASON, undefined, {
      deferToStart: true,
    });
  }

  /**
   * Finish an End whose owner is gone — the reaper's half of `end`.
   *
   * If the process holding an `ENDING` teardown died, or its destroy did not
   * complete, nothing else would ever resume it: only `end()` claims `ENDING`,
   * and `end()` runs when a student presses End, which they already did. The
   * row stayed `ENDING`, held a capacity slot, and kept its sandbox.
   *
   * It is resumed *as an End*: the student asked for it, so it is recorded
   * ENDED with the student's reason rather than relabelled EXPIRED. It claims
   * nothing but `ENDING`, so it cannot end a session that is anything else.
   * Racing a live End is the End+End race `#teardown` already settles: destroy
   * is idempotent and only one of them records the ending.
   */
  async resumeAbandonedEnd(sessionId: string): Promise<TeardownResult> {
    const session = await this.require(sessionId);
    return this.#teardown(
      session,
      ['ENDING'],
      'ENDING',
      'ENDED',
      session.statusReason ?? 'ended by student',
    );
  }

  /**
   * Remove a sandbox that outlived its finished session.
   *
   * A start or reset that lost its session to a teardown discards what it
   * built, but that discard is best-effort, and so is the cleanup after a
   * failed start. Anything left carries the id of a session that is already
   * ENDED, EXPIRED or FAILED — and the orphan sweep alone would never take it
   * while the row is retained, because the store still "knows" that sandbox.
   *
   * Only for a finished session, re-read here rather than trusted from the
   * caller. It goes through the provider's own session-scoped destroy, so the
   * managed, provider, runtime-owner and session-label gates are all re-checked
   * against the live resource immediately before anything is deleted.
   */
  async reclaimFinishedSandbox(sessionId: string): Promise<DestroyResult> {
    const session = await this.#store.get(sessionId);
    if (!session || !isTerminalStatus(session.status)) {
      return {
        ok: false,
        namespaceGone: false,
        steps: [],
        error: {
          code: 'DESTROY_FAILED',
          message: `session ${sessionId} is ${session?.status ?? 'unknown'}, not finished`,
        },
      };
    }
    try {
      return await this.#providerFor(session).destroy(this.contextFor(session));
    } catch (error) {
      return {
        ok: false,
        namespaceGone: false,
        steps: [],
        error: { code: 'DESTROY_FAILED', message: describeError(error) },
      };
    }
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
    claimable: readonly SessionStatus[],
    inProgress: Extract<SessionStatus, 'ENDING' | 'EXPIRING'>,
    done: Extract<SessionStatus, 'ENDED' | 'EXPIRED'>,
    reason: string,
    claimGuard?: TransitionGuard,
    options: { deferToStart?: boolean } = {},
  ): Promise<TeardownResult> {
    if (isTerminalStatus(session.status)) {
      return {
        session,
        destroy: { ok: true, namespaceGone: true, steps: [] },
      };
    }

    /*
     * A CREATING session has a start building its sandbox right now — in this
     * instance or another — and a destroy now finds nothing yet to remove.
     * Recording ENDED on that released the slot while the build went on, and
     * the start discarded what it built only when it finished: one student
     * pressing Start and End in a loop had a dozen sandboxes building at once
     * against a limit of one, and the global ceiling was passed the same way.
     *
     * So End only marks such a session, and the row keeps occupying its slot.
     * The start that owns the build discards it and finishes this teardown
     * (`#finishTeardownOfLostStart`); a start whose process died is finished
     * by the reaper, as any unfinished End is. The reaper's own expiry of a
     * CREATING row does not defer: it acts only once that start is presumed
     * dead.
     */
    if (options.deferToStart && session.status === 'CREATING') {
      const claimed = await this.#transition(
        session.sessionId,
        ['CREATING'],
        inProgress,
        { statusReason: reason },
        claimGuard,
      );
      if (claimed) {
        this.#log(`session ${session.sessionId} ${inProgress} (${reason}): its start will discard what it builds`);
        return { session: claimed, destroy: { ok: true, namespaceGone: false, steps: [] } };
      }
      // It moved on meanwhile — ACTIVE, FAILED, … — so it is torn down as what it is now.
    }

    /*
     * Claim the teardown with a conditional write.
     *
     * Two instances can reach here for one session — a student pressing End
     * while a reaper expires the same row. An unconditional update lets both
     * proceed, and the second would finish the session under the *other* one's
     * label, so a student-ended session could be recorded EXPIRED.
     *
     * The `claimable` list never includes the opposite in-flight state: End
     * cannot claim a session already EXPIRING, and expiry cannot claim one
     * already ENDING. `inProgress` itself *is* included, because an interrupted
     * teardown must be resumable — the reaper re-enters this path until the
     * sandbox is verifiably gone, and that is the idempotence the whole cleanup
     * design rests on. An ENDING teardown whose owner is gone is resumed as an
     * End by `resumeAbandonedEnd`, never relabelled.
     */
    const marked = await this.#transition(
      session.sessionId,
      claimable,
      inProgress,
      { statusReason: reason },
      claimGuard,
    );

    if (!marked) {
      // Someone else owns this teardown, or it already finished. Report what is
      // actually true rather than acting on a state we no longer hold.
      const current = (await this.#store.get(session.sessionId)) ?? session;
      this.#log(
        `session ${session.sessionId}: ${inProgress} not claimed — already ${current.status}`,
      );
      return {
        session: current,
        destroy: {
          ok: true,
          namespaceGone: isTerminalStatus(current.status),
          steps: [],
        },
      };
    }

    // Close the student's shell first: once the namespace goes, their kubectl
    // would only produce confusing errors.
    if (this.#terminal) {
      await this.#terminal.terminate(session.sessionId).catch((error: unknown) => {
        this.#log(
          `session ${session.sessionId}: could not close terminal — ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    let destroy: DestroyResult;
    try {
      destroy = await this.#providerFor(marked).destroy(this.contextFor(marked));
    } catch (error) {
      // A throw is a failed delete like any other: the teardown stays in flight
      // for the reaper to resume, rather than escaping as a 500 mid-teardown.
      destroy = {
        ok: false,
        namespaceGone: false,
        steps: [],
        error: { code: 'DESTROY_FAILED', message: describeError(error) },
      };
    }

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

    /*
     * Finish with a conditional write as well.
     *
     * Resuming a teardown is allowed (`inProgress` is claimable from itself), so
     * two Ends can both hold ENDING and both reach this line. An unconditional
     * write let both record ENDED and both notify the listener, closing the
     * attempt twice. Only the first to move the row from `inProgress` records
     * the ending; the other reports the state it finds.
     */
    const ended = await this.#transition(session.sessionId, [inProgress], done, {
      statusReason: reason,
      endedAt: new Date(this.#now()).toISOString(),
    });
    if (!ended) {
      const current = (await this.#store.get(session.sessionId)) ?? marked;
      this.#log(
        `session ${session.sessionId}: ${done} already recorded by another teardown — now ${current.status}`,
      );
      return { session: current, destroy };
    }
    this.#emit((m) => m.onTransition?.(inProgress, done));
    this.#emit((m) =>
      m.onSessionEnded?.({
        provider: ended.provider,
        reason: endReasonFor(done, reason),
        lifetimeSeconds: Math.max(0, (this.#now() - Date.parse(ended.createdAt)) / 1000),
      }),
    );
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

  /**
   * Every status change goes through here, stamped with when it happened.
   *
   * The stamp is applied by the store only when the status really moves; see
   * `LabSession.statusChangedAt` for what reads it.
   */
  #transition(
    sessionId: string,
    from: readonly SessionStatus[],
    to: SessionStatus,
    patch: Partial<LabSession> = {},
    guard?: TransitionGuard,
  ): Promise<LabSession | null> {
    return this.#store.transition(
      sessionId,
      from,
      to,
      { ...patch, statusChangedAt: new Date(this.#now()).toISOString() },
      guard,
    );
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

  /*
   * There is no "release a capacity slot" step anywhere in this class. A slot
   * is released by the session's status leaving the occupying set, which the
   * finishing transition has already written: capacity is counted from those
   * rows (`createWithinLimits`), so there is no tally to decrement and nothing
   * a re-entered teardown could hand back twice.
   *
   * A per-process set of released session ids used to stand in for one. It
   * was never read, and it grew by one entry for every session this process
   * ever finished, for the life of the process.
   */

  /** Forget a finished session record (used by the reaper's retention sweep). */
  async forget(sessionId: string): Promise<void> {
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
