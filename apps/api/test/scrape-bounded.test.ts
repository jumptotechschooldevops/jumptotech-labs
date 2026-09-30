/**
 * A dependency that hangs must not take the api's own scrape down with it.
 *
 * Measured in the 2026-09-28 observability drill: on a loaded host, with no
 * fault at all, an api scrape took 33 s and failed 9 of 40 samples, because
 * the provider-availability collector awaits a broker probe (ping timeout
 * 120 s) whenever its 30 s memo is stale. A hung broker makes it certain.
 * `ServiceDown{job="api"}` paged for a service that was serving students, and
 * its inhibition silenced every api-labelled alert, `ProviderUnavailable`
 * included. A database that accepts connections and never answers did the same
 * through the session gauges, and `jtt_db_up` vanished instead of reading 0.
 *
 * This wires the real collectors to a broker and a session store that never
 * answer and requires the scrape to finish, with `jtt_db_up` in it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LabSession, SessionManager } from '@jumptotech/lab-orchestrator';
import type { ProgressService } from '@jumptotech/progress';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

import { loadConfig } from '../src/config.js';
import { buildApiObservability } from '../src/observability.js';
import { installRuntimeCollectors } from '../src/observability-collectors.js';
import type { AuthSessionStore } from '../src/auth/browser-session.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hex = (c: string) => c.repeat(64).replace(/[^0-9a-f]/g, 'a');
const never = <T>() => new Promise<T>(() => undefined);

const stops: Array<{ stop(): void }> = [];
afterEach(() => stops.splice(0).forEach((s) => s.stop()));

describe('the api scrape when a dependency hangs', () => {
  it('finishes well inside the scrape timeout, still reporting the database probe', async () => {
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: hex('1'),
      INTERNAL_SERVICE_SECRET: hex('2'),
      NAMESPACE_DERIVATION_SECRET: hex('3'),
      LABS_DIR: path.join(repoRoot, 'labs'),
      ALLOWED_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'error',
    } as NodeJS.ProcessEnv);
    const observability = buildApiObservability(config);

    // A paused broker behind every provider, and a store that never answers.
    const sessions = {
      providers: { statuses: () => never() },
      listOccupying: () => never<LabSession[]>(),
    } as unknown as SessionManager;
    const authSessions = { countActive: () => never<number>() } as unknown as AuthSessionStore;

    stops.push(
      installRuntimeCollectors({
        metrics: observability.metrics,
        sessions,
        registry: await realCatalog(),
        progress: {} as ProgressService,
        database: { ping: async () => undefined },
        authSessions,
        config,
        logger: observability.logger,
        recordDatabaseProbe: observability.recordDatabaseProbe,
      }),
    );

    const started = Date.now();
    const text = await observability.registry.metrics();
    const elapsed = Date.now() - started;

    // Prometheus gives up at 10 s; the readiness refresh adds up to 2 s more.
    expect(elapsed).toBeLessThan(5_000);
    expect(text).toMatch(/^jtt_db_up 1$/m);
    // The catalogue-derived series are still there: the scrape was served.
    expect(text).toMatch(/^jtt_provider_labs_total\{provider="linux"\} \d+$/m);
  }, 15_000);
});
