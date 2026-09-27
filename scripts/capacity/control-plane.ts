/**
 * Control-plane capacity probe — what the api itself costs per student.
 *
 *   npx tsx scripts/capacity/control-plane.ts --students 5,10,25,50
 *
 * The runtime underneath is FakeContainerRuntime, which answers at once, so
 * what is measured is only the platform's own work: HTTP, authentication,
 * the session guard, admission under the capacity lock, the verifier's
 * bookkeeping, progress writes, JSON. The Docker host, the sandbox and the
 * network are deliberately absent. They are measured by classroom.ts, against a
 * real stack. The session and progress stores are in memory, so PostgreSQL
 * round-trips are absent too and the numbers are a lower bound on api cost.
 *
 * The api runs in a child process that reports its own CPU time, event-loop
 * utilisation, event-loop delay and memory, so the load generator's CPU is
 * never counted as the api's. CPU time per request is the figure to trust on
 * a busy machine: wall-clock latency moves with whatever else the host runs,
 * CPU time much less.
 *
 * Bounded: at most 50 students, a fixed number of requests per phase.
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '../..');

// ---------------------------------------------------------------------------
// Server side (child process)

async function serve(maxSessions: number): Promise<void> {
  const { InMemorySessionStore, LabRegistry, LinuxLabProvider, ProviderRegistry, SessionManager } = await import('@jumptotech/lab-orchestrator');
  const { FakeKubernetes } = await import('@jumptotech/lab-orchestrator/testing');
  const { FakeContainerRuntime } = await import('@jumptotech/lab-orchestrator/testing/containers');
  const { DevStudentIdentity, InMemoryProgressRepository, ProgressService } = await import('@jumptotech/progress');
  const { createApp } = await import('../../apps/api/src/app.js');
  const { loadConfig } = await import('../../apps/api/src/config.js');
  const { AttemptClosingListener } = await import('../../apps/api/src/progress.js');

  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'control-plane-probe-secret',
    LABS_DIR: path.join(REPO, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_ACTIVE_SESSIONS: String(maxSessions),
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
    LOG_LEVEL: 'error',
  } as NodeJS.ProcessEnv);
  const labs = new LabRegistry(path.join(REPO, 'labs'));
  await labs.load();
  const runtime = new FakeContainerRuntime();
  const providers = new ProviderRegistry();
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  const progress = new ProgressService({ repository: new InMemoryProgressRepository() });
  const store = new InMemorySessionStore();
  const sessions = new SessionManager({
    registry: labs,
    providers,
    store,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    listener: new AttemptClosingListener(progress),
  });
  const app = createApp({
    registry: labs,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    // Budgets far above the probe's request counts: this measures cost, not refusals.
    sandboxWriteRateLimit: { limit: 1_000_000, windowMs: 60_000 },
    checkRateLimit: { limit: 1_000_000, windowMs: 60_000 },
    progress: {
      progress,
      identity: new DevStudentIdentity({ studentId: config.progress.devStudentId }),
      store: 'memory',
      durable: false,
    },
  } as Parameters<typeof createApp>[0]);

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let elu = performance.eventLoopUtilization();
  let cpu = process.cpuUsage();
  const server = app.listen(0, '127.0.0.1', () => {
    const address = server.address();
    process.send!({ type: 'listening', port: typeof address === 'object' && address ? address.port : 0 });
  });
  process.on('message', async (m: { type: string }) => {
    if (m.type === 'settle') {
      // What the reaper's retention sweep does in production: finished
      // sessions are forgotten, so what remains after GC is what leaked.
      for (const s of await store.list()) {
        if (['ENDED', 'EXPIRED', 'FAILED'].includes(s.status)) await store.delete(s.sessionId);
      }
      // The fake runtime keeps a log of every call for test assertions (every
      // exec request, the seed script included). That is the harness
      // remembering, not the api, so it is emptied before measuring.
      for (const log of [runtime.created, runtime.removed, runtime.execs, runtime.seedScriptsRun, runtime.networksCreated, runtime.networksRemoved]) {
        log.length = 0;
      }
      await new Promise((r) => setTimeout(r, 50));
      (globalThis as { gc?: () => void }).gc?.();
      const kinds: Record<string, number> = {};
      for (const k of process.getActiveResourcesInfo()) kinds[k] = (kinds[k] ?? 0) + 1;
      process.send!({
        type: 'settled',
        heapKiB: Math.round(process.memoryUsage().heapUsed / 1024),
        rssMiB: Math.round(process.memoryUsage().rss / 1048576),
        sessionsHeld: (await store.list()).length,
        activeResources: kinds,
      });
    } else if (m.type === 'snapshot' && process.env.CAPACITY_SNAPSHOT_DIR) {
      // Diagnostics only: a heap snapshot for diffing what a churn retained.
      const { writeHeapSnapshot } = await import('node:v8');
      (globalThis as { gc?: () => void }).gc?.();
      const file = writeHeapSnapshot(path.join(process.env.CAPACITY_SNAPSHOT_DIR, `churn-${Date.now()}.heapsnapshot`));
      process.send!({ type: 'snapshotted', file });
    } else if (m.type === 'mark') {
      elu = performance.eventLoopUtilization();
      cpu = process.cpuUsage();
      delay.reset();
      process.send!({ type: 'marked' });
    } else if (m.type === 'sample') {
      const used = process.cpuUsage(cpu);
      const u = performance.eventLoopUtilization(elu);
      const mem = process.memoryUsage();
      process.send!({
        type: 'sample',
        cpuUs: used.user + used.system,
        elu: u.utilization,
        delayP99Ms: delay.percentile(99) / 1e6,
        delayMaxMs: delay.max / 1e6,
        rssMiB: Math.round(mem.rss / 1048576),
        heapMiB: Math.round(mem.heapUsed / 1048576),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Driver (parent process)

interface Sample {
  cpuUs: number;
  elu: number;
  delayP99Ms: number;
  delayMaxMs: number;
  rssMiB: number;
  heapMiB: number;
}

function ask<T>(child: ChildProcess, type: string, reply: string): Promise<T> {
  return new Promise((resolve) => {
    const on = (m: { type: string }) => {
      if (m.type === reply) {
        child.off('message', on);
        resolve(m as T);
      }
    };
    child.on('message', on);
    child.send({ type });
  });
}

function pct(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? NaN;
  return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +(s[s.length - 1] ?? NaN).toFixed(1) };
}

async function probe(students: number) {
  const child = fork(SELF, ['--serve', String(students)], {
    execArgv: ['--import', 'tsx', '--expose-gc'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const { port } = await ask<{ port: number }>(child, 'noop', 'listening');
  const base = `http://127.0.0.1:${port}`;
  const names = Array.from({ length: students }, (_, i) => `cap-${i + 1}`);
  const req = async (who: string, method: string, url: string) => {
    const t = performance.now();
    const r = await fetch(base + url, {
      method,
      headers: { authorization: `Developer ${who}`, origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    const body = (await r.json().catch(() => ({}))) as any;
    return { ms: performance.now() - t, status: r.status, body };
  };

  const phases: Record<string, unknown> = {};
  const phase = async (name: string, fn: () => Promise<Array<{ ms: number; status: number }>>) => {
    await ask(child, 'mark', 'marked');
    const t = performance.now();
    const results = await fn();
    const wall = performance.now() - t;
    const s = await ask<Sample & { type: string }>(child, 'sample', 'sample');
    const statuses: Record<number, number> = {};
    for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    phases[name] = {
      requests: results.length,
      statuses,
      latencyMs: pct(results.map((r) => r.ms)),
      wallMs: Math.round(wall),
      apiCpuMsPerRequest: +(s.cpuUs / 1000 / Math.max(1, results.length)).toFixed(3),
      apiElu: +s.elu.toFixed(3),
      eventLoopDelayP99Ms: +s.delayP99Ms.toFixed(1),
      eventLoopDelayMaxMs: +s.delayMaxMs.toFixed(1),
      rssMiB: s.rssMiB,
      heapMiB: s.heapMiB,
    };
  };

  const labs = ['LINUX-001', 'LINUX-002', 'LINUX-003', 'LINUX-004', 'LINUX-005'];
  const ids = new Map<string, string>();
  // Warm-up, not measured: first-request compilation and caches.
  await req('warmup', 'GET', '/api/labs');

  await phase('signIn (GET /api/me)', () => Promise.all(names.map((n) => req(n, 'GET', '/api/me'))));
  await phase('catalog (GET /api/labs)', () => Promise.all(names.map((n) => req(n, 'GET', '/api/labs'))));
  await phase('start burst', () =>
    Promise.all(
      names.map(async (n, i) => {
        const r = await req(n, 'POST', `/api/labs/${labs[i % labs.length]}/start`);
        const id = r.body?.data?.session?.sessionId;
        if (id) ids.set(n, id);
        return r;
      }),
    ),
  );
  await phase('steady polls x10 (GET /api/sessions/:id)', async () => {
    const out: Array<{ ms: number; status: number }> = [];
    await Promise.all(
      names.map(async (n) => {
        for (let k = 0; k < 10; k += 1) out.push(await req(n, 'GET', `/api/sessions/${ids.get(n)}`));
      }),
    );
    return out;
  });
  await phase('resume list (GET /api/sessions)', () => Promise.all(names.map((n) => req(n, 'GET', '/api/sessions'))));
  await phase('terminal grant', () => Promise.all(names.map((n) => req(n, 'POST', `/api/sessions/${ids.get(n)}/terminal`))));
  await phase('check burst', () => Promise.all(names.map((n) => req(n, 'POST', `/api/sessions/${ids.get(n)}/check`))));
  await phase('reset burst', () => Promise.all(names.map((n) => req(n, 'POST', `/api/sessions/${ids.get(n)}/reset`))));
  await phase('end burst', () => Promise.all(names.map((n) => req(n, 'DELETE', `/api/sessions/${ids.get(n)}`))));
  child.kill();
  return { students, admitted: ids.size, phases };
}

/**
 * Repeated classes against one api process: every student starts, polls,
 * checks and ends, `cycles` times. After each block of cycles the child forgets
 * finished sessions (the reaper's retention sweep), forces GC and reports heap,
 * RSS and its active handles and timers. A leak shows as heap growing block
 * after block, or as handles that do not return to their baseline. Progress
 * attempts are kept in memory by design here (PostgreSQL in production), so a
 * small steady heap growth per Start is expected and is reported per session.
 */
async function churn(students: number, cycles: number, every: number, checksPerCycle: number) {
  const child = fork(SELF, ['--serve', String(students)], {
    execArgv: ['--import', 'tsx', '--expose-gc'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const { port } = await ask<{ port: number }>(child, 'noop', 'listening');
  const base = `http://127.0.0.1:${port}`;
  const names = Array.from({ length: students }, (_, i) => `churn-${i + 1}`);
  const req = async (who: string, method: string, url: string) => {
    const r = await fetch(base + url, {
      method,
      headers: { authorization: `Developer ${who}`, origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  const labs = ['LINUX-001', 'LINUX-002', 'LINUX-003', 'LINUX-004', 'LINUX-005'];
  const samples = [{ cycle: 0, ...(await ask<Record<string, unknown>>(child, 'settle', 'settled')) }];
  const statuses: Record<string, number> = {};
  for (let c = 1; c <= cycles; c += 1) {
    await Promise.all(
      names.map(async (n, i) => {
        const started = await req(n, 'POST', `/api/labs/${labs[(i + c) % labs.length]}/start`);
        const id = started.body?.data?.session?.sessionId;
        const seen = [started.status];
        if (id) {
          seen.push((await req(n, 'GET', `/api/sessions/${id}`)).status);
          seen.push((await req(n, 'POST', `/api/sessions/${id}/terminal`)).status);
          for (let k = 0; k < checksPerCycle; k += 1) seen.push((await req(n, 'POST', `/api/sessions/${id}/check`)).status);
          seen.push((await req(n, 'DELETE', `/api/sessions/${id}`)).status);
        }
        for (const s of seen) statuses[s] = (statuses[s] ?? 0) + 1;
      }),
    );
    if (c % every === 0) {
      samples.push({ cycle: c, ...(await ask<Record<string, unknown>>(child, 'settle', 'settled')) });
      if (process.env.CAPACITY_SNAPSHOT_DIR && (c === every || c === cycles)) {
        samples.push({ cycle: c, ...(await ask<Record<string, unknown>>(child, 'snapshot', 'snapshotted')) });
      }
    }
  }
  child.kill();
  const first = samples[1] as unknown as { heapKiB: number };
  const last = samples[samples.length - 1] as unknown as { heapKiB: number; cycle: number };
  const sessions = (last.cycle - every) * students;
  return {
    students,
    cycles,
    checksPerCycle,
    statuses,
    samples,
    heapGrowthBytesPerSessionAfterWarmup: sessions > 0 ? Math.round(((last.heapKiB - first.heapKiB) * 1024) / sessions) : null,
  };
}

const { values } = parseArgs({
  options: {
    serve: { type: 'string' },
    students: { type: 'string', default: '5,10,25,50' },
    churn: { type: 'string' },
    'sample-every': { type: 'string', default: '25' },
    'checks-per-cycle': { type: 'string', default: '1' },
  },
  allowPositionals: true,
});

if (process.argv.includes('--serve')) {
  const max = Number(process.argv[process.argv.indexOf('--serve') + 1]);
  await serve(max);
} else {
  const counts = values.students!.split(',').map(Number);
  if (counts.some((c) => !Number.isInteger(c) || c < 1 || c > 50)) throw new Error('--students takes 1..50');
  if (values.churn) {
    const cycles = Number(values.churn);
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 2000) throw new Error('--churn takes 1..2000 cycles');
    const checks = Number(values['checks-per-cycle']);
    if (!Number.isInteger(checks) || checks < 0 || checks > 5) throw new Error('--checks-per-cycle takes 0..5');
    console.log(JSON.stringify(await churn(counts[0]!, cycles, Number(values['sample-every']), checks), null, 2));
  } else {
    const out = [];
    for (const c of counts) out.push(await probe(c));
    console.log(JSON.stringify(out, null, 2));
  }
}
