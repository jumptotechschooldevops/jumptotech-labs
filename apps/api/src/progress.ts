/**
 * Persistence wiring (PLATFORM-005).
 *
 * Assembles the learning-history side of the object graph and keeps two rules
 * that the rest of the API then gets for free:
 *
 *   1. **The database is chosen once, here.** Routes are handed a
 *      `ProgressService`; nothing above this file knows whether it is talking
 *      to PostgreSQL or to the in-memory fallback.
 *   2. **Bookkeeping must never break the classroom.** Every write from a lab
 *      operation goes through `record()`, which logs a failure and returns
 *      undefined. If the database is down, a student can still start a lab,
 *      check their work, reset, and end — they just lose the history for it,
 *      and `/health` says so out loud.
 */
import {
  DevStudentIdentity,
  InMemoryProgressRepository,
  PostgresDatabase,
  PostgresProgressRepository,
  ProgressService,
  describeDatabase,
  migrate,
  type ProgressRepository,
  type StudentIdentityResolver,
} from '@jumptotech/progress';
import type { SessionClosedEvent, SessionLifecycleListener } from '@jumptotech/lab-orchestrator';
import type { ApiConfig } from './config.js';

export interface ProgressRuntime {
  progress: ProgressService;
  identity: StudentIdentityResolver;
  /** `postgres` or `memory`. Reported on /health, never to a student. */
  store: 'postgres' | 'memory';
  /** True only when history outlives the process. */
  durable: boolean;
  /** Open pool, for a clean shutdown. */
  database: PostgresDatabase | null;
}

/**
 * Build the persistence layer from configuration.
 *
 * A configured-but-unreachable database is a startup failure, deliberately: the
 * alternative is silently falling back to memory and telling students their
 * progress is saved when it is not. An *unconfigured* database is not a
 * failure — it is the documented laptop setup, and it says so.
 */
export async function buildProgressRuntime(
  config: ApiConfig,
  log: (message: string) => void = () => undefined,
  /** Reports the schema state once, after migrations run. */
  onMigrations?: (state: { applied: number; latest: string }) => void,
): Promise<ProgressRuntime> {
  const settings = config.progress;
  const identity = new DevStudentIdentity({
    studentId: settings.devStudentId,
    allowHeaderOverride: settings.allowStudentHeader,
  });

  if (!settings.database) {
    log(
      'no DATABASE_URL configured — student progress is IN MEMORY and will be lost on restart',
    );
    return {
      progress: new ProgressService({ repository: new InMemoryProgressRepository(), logger: log }),
      identity,
      store: 'memory',
      durable: false,
      database: null,
    };
  }

  const database = PostgresDatabase.fromConfig(settings.database);
  log(`progress database ${describeDatabase(settings.database)}`);

  if (settings.autoMigrate) {
    // Forward-only and idempotent. Never destructive — see the migrator.
    const report = await migrate(database, { logger: (message) => log(`migration ${message}`) });
    log(
      report.applied.length > 0
        ? `applied ${report.applied.length} migration(s)`
        : 'schema up to date',
    );
    /*
     * The schema version, as a metric — PLATFORM-003.
     *
     * RB-02's recovery checklist says to confirm the schema is intact after a
     * database incident, because a database that comes back on an *empty*
     * volume looks healthy in every other respect: it accepts connections, the
     * pool is fine, `jtt_db_up` is 1, and a cohort's history is gone. The
     * migration version is what distinguishes "recovered" from "recreated".
     */
    onMigrations?.({
      applied: report.applied.length + report.skipped.length,
      latest: [...report.applied, ...report.skipped].sort().pop() ?? 'none',
    });
  } else {
    await database.ping();
    log('DATABASE_AUTO_MIGRATE is off — run `npm run db:migrate` before starting');
  }

  const repository: ProgressRepository = new PostgresProgressRepository(database);
  return {
    progress: new ProgressService({ repository, logger: log }),
    identity,
    store: 'postgres',
    durable: true,
    database,
  };
}

/**
 * The bridge from "a sandbox went away" to "an attempt closed".
 *
 * The orchestrator declares this interface and knows nothing about attempts;
 * this adapter knows nothing about namespaces. End Lab and reaper-driven
 * expiry both arrive here, which is why they cannot record different things.
 */
export class AttemptClosingListener implements SessionLifecycleListener {
  constructor(
    private readonly progress: ProgressService,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async onSessionClosed(event: SessionClosedEvent): Promise<void> {
    await record(this.log, 'close attempt', () =>
      this.progress.closeSession({
        sessionId: event.sessionId,
        outcome: event.status === 'EXPIRED' ? 'EXPIRED' : 'ENDED',
        reason: event.reason,
      }),
    );
  }
}

/**
 * Periodically close attempts no sandbox can still back.
 *
 * An attempt is closed by its session's `onSessionClosed` event. When that
 * event is lost — the in-memory session store forgot the session on restart,
 * the progress write failed, the session record was lost with its database —
 * a student would see that lab "in progress" on their dashboard forever.
 *
 * The cutoff is the absolute session lifetime plus a grace period, and on top
 * of it every session that still occupies a slot is excluded by id. Age alone
 * is not proof: sessions persist across restarts with the deadline they were
 * created with, so after `MAX_SESSION_MINUTES` is lowered, or while the reaper
 * is behind, a live lab can be older than the cutoff. Closing its attempt then
 * would show the student EXPIRED mid-lab and make their End unrecordable.
 * If the live sessions cannot be read, the sweep is skipped, not run blind.
 */
export class AbandonedAttemptSweeper {
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      progress: ProgressService;
      maxSessionSeconds: number;
      /** Ids of the sessions that occupy a slot right now. */
      liveSessionIds: () => Promise<readonly string[]>;
      intervalMs: number;
      graceSeconds?: number;
      log?: (message: string) => void;
    },
  ) {}

  /** Sweep now, then on an interval. The timer never holds the process open. */
  start(): void {
    if (this.#timer) return;
    void this.sweep();
    this.#timer = setInterval(() => void this.sweep(), this.options.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async sweep(): Promise<number> {
    const log = this.options.log ?? (() => undefined);
    return (
      (await record(log, 'close abandoned attempts', async () => {
        const liveSessionIds = await this.options.liveSessionIds();
        return this.options.progress.expireAbandonedAttempts({
          maxSessionSeconds: this.options.maxSessionSeconds,
          liveSessionIds,
          ...(this.options.graceSeconds ? { graceSeconds: this.options.graceSeconds } : {}),
        });
      })) ?? 0
    );
  }
}

/**
 * Run a bookkeeping write, swallowing failure.
 *
 * Returns `undefined` when the store is unavailable. Callers treat that exactly
 * as they treat "this session has no attempt": the lab operation itself has
 * already succeeded and must be reported as such.
 */
export async function record<T>(
  log: (message: string) => void,
  what: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    log(`could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
