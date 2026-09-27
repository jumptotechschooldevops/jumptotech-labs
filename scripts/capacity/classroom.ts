/**
 * Classroom capacity probe — a bounded, measured burst of N students.
 *
 *   npx tsx scripts/capacity/classroom.ts --web http://127.0.0.1:33700 \
 *     --oidc http://127.0.0.1:39700 --owner jtt-e2e --students 5 \
 *     --labs linux-a,linux-b,…
 *
 * Drives a RUNNING stack the way a class does: N students sign in through the
 * identity provider, press Start within the same second, open their terminals,
 * type, press Check, press Reset, and End. Every request goes through the web
 * edge, so nginx, the api, the terminal and the runtime are all on the path a
 * browser uses. It measures; it does not assert a latency. What it does fail on
 * is a broken contract: a start that neither succeeds nor is refused cleanly, a
 * terminal that never answers, a sandbox that outlives its End.
 *
 * Built for the E2E stack (e2e/stack.sh), whose test identity provider signs a
 * username in without a password. It refuses non-loopback targets.
 *
 * Bounds: at most 25 students; output pressure is one `seq` of a fixed size;
 * every wait has a deadline. Nothing is deleted except through End Lab.
 *
 * Output: a JSON report on stdout and a human summary on stderr.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs, promisify } from 'node:util';
import WebSocket from 'ws';

const run = promisify(execFile);

const { values: args } = parseArgs({
  options: {
    web: { type: 'string', default: 'http://127.0.0.1:33700' },
    oidc: { type: 'string', default: 'http://127.0.0.1:39700' },
    owner: { type: 'string' },
    project: { type: 'string' },
    students: { type: 'string', default: '5' },
    labs: { type: 'string' },
    prefix: { type: 'string', default: 'cap' },
    'noise-lines': { type: 'string', default: '200000' },
    'commands-per-student': { type: 'string', default: '10' },
    'skip-reset': { type: 'boolean', default: false },
    'skip-check': { type: 'boolean', default: false },
    'extra-students': { type: 'string', default: '1' },
  },
});

const WEB = new URL(args.web!);
const OIDC = new URL(args.oidc!);
for (const u of [WEB, OIDC]) {
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error(`refusing non-loopback target ${u.href}`);
}
const ORIGIN = WEB.origin;
const N = Number(args.students);
if (!Number.isInteger(N) || N < 1 || N > 25) throw new Error('--students must be 1..25');
const EXTRA = Number(args['extra-students']);
const OWNER = args.owner;
if (!OWNER) throw new Error('--owner (the stack RUNTIME_OWNER_ID) is required');
const NOISE_LINES = Math.min(Number(args['noise-lines']), 1_000_000);
const COMMANDS = Math.min(Number(args['commands-per-student']), 50);
const log = (...a: unknown[]) => console.error(`[classroom +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const T0 = Date.now();

// ---------------------------------------------------------------------------
// HTTP with a per-student cookie jar

class Jar {
  #cookies = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(line)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

interface Timed<T> {
  ms: number;
  status: number;
  body: T;
}

async function call<T = any>(jar: Jar, method: string, path: string, body?: unknown, timeoutMs = 300_000): Promise<Timed<T>> {
  const t = performance.now();
  const res = await fetch(new URL(path, WEB), {
    method,
    redirect: 'manual',
    headers: {
      cookie: jar.header(),
      origin: ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  jar.take(res);
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { ms: performance.now() - t, status: res.status, body: parsed };
}

async function signIn(username: string): Promise<Jar> {
  const jar = new Jar();
  const login = await fetch(new URL('/auth/login', WEB), { redirect: 'manual' });
  jar.take(login);
  const authorize = login.headers.get('location');
  if (login.status !== 302 || !authorize) throw new Error(`/auth/login -> ${login.status}`);
  const page = await (await fetch(authorize)).text();
  const requestId = /name="request" value="([^"]+)"/.exec(page)?.[1];
  if (!requestId) throw new Error('no request id on the identity provider login page');
  const posted = await fetch(new URL('/login', OIDC), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: requestId, username }),
  });
  const callback = posted.headers.get('location');
  if (posted.status !== 302 || !callback) throw new Error(`identity provider /login -> ${posted.status}`);
  const cb = await fetch(callback, { redirect: 'manual', headers: { cookie: jar.header() } });
  jar.take(cb);
  if (cb.status >= 400) throw new Error(`/auth/callback -> ${cb.status}`);
  const me = await call(jar, 'GET', '/auth/session');
  if (me.status !== 200) throw new Error(`/auth/session -> ${me.status} after sign-in`);
  return jar;
}

// ---------------------------------------------------------------------------
// Terminal over the real protocol

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

class Term {
  frames: Array<{ type: string; [k: string]: unknown }> = [];
  buffer = '';
  bytes = 0;
  closed: number | undefined;
  #notify = new Set<() => void>();
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      let f: any;
      try {
        f = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.frames.push(f.type === 'output' ? { type: 'output' } : f);
      if (f.type === 'output') {
        const s = String(f.data);
        this.bytes += s.length;
        this.buffer += s;
        // Bounded: keep only the tail the markers are searched in.
        if (this.buffer.length > 256_000) this.buffer = this.buffer.slice(-128_000);
      }
      for (const n of this.#notify) n();
    });
    ws.on('close', (code) => {
      this.closed = code;
      for (const n of this.#notify) n();
    });
    ws.on('error', () => undefined);
  }
  static async open(token: string): Promise<Term> {
    const url = `${WEB.protocol === 'https:' ? 'wss' : 'ws'}://${WEB.host}/terminal`;
    const ws = new WebSocket(url, { headers: { Origin: ORIGIN } });
    const term = new Term(ws);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket did not open')), 15_000);
      ws.once('open', () => (clearTimeout(t), resolve()));
      ws.once('error', (e) => (clearTimeout(t), reject(e)));
    });
    ws.send(JSON.stringify({ type: 'auth', token, cols: 200, rows: 50 }));
    return term;
  }
  until<T>(probe: () => T | undefined, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.#notify.delete(check);
      };
      const check = () => {
        const v = probe();
        if (v !== undefined) {
          done();
          resolve(v);
        } else if (this.closed !== undefined) {
          done();
          reject(new Error(`socket closed ${this.closed} waiting for ${what}`));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timeout ${ms}ms waiting for ${what}`));
      }, ms);
      this.#notify.add(check);
      check();
    });
  }
  get errorCode(): string | undefined {
    return this.frames.find((f) => f.type === 'error')?.code as string | undefined;
  }
  waitType(type: string, ms = 60_000, from = 0) {
    return this.until(() => this.frames.slice(from).find((f) => f.type === type), ms, `'${type}' frame`);
  }
  async cmd(command: string, ms = 120_000): Promise<{ ms: number; exit: number }> {
    const nonce = randomBytes(4).toString('hex');
    const t = performance.now();
    this.buffer = '';
    this.ws.send(JSON.stringify({ type: 'input', data: `${command}; echo __CAP_${nonce}_$?__\n` }));
    const re = new RegExp(`__CAP_${nonce}_(\\d+)__`);
    const exit = await this.until(() => {
      const m = re.exec(this.buffer.replace(ANSI, ''));
      return m ? Number(m[1]) : undefined;
    }, ms, `command '${command.slice(0, 30)}'`);
    return { ms: performance.now() - t, exit };
  }
  close() {
    try {
      this.ws.terminate();
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Measurement helpers

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : NaN);
  const r = (x: number) => Math.round(x);
  return { n: s.length, min: r(s[0] ?? NaN), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1] ?? NaN) };
}

async function docker(...a: string[]): Promise<string> {
  const { stdout } = await run('docker', a, { timeout: 60_000, maxBuffer: 8 << 20 });
  return stdout.trim();
}

async function ownedSandboxes(): Promise<string[]> {
  const out = await docker('ps', '-a', '--filter', `label=jumptotech.io/runtime-owner=${OWNER}`, '--format', '{{.Names}}');
  return out ? out.split('\n') : [];
}

async function ownedNetworks(): Promise<string[]> {
  const out = await docker('network', 'ls', '--filter', `label=jumptotech.io/runtime-owner=${OWNER}`, '--format', '{{.Name}}');
  return out ? out.split('\n') : [];
}

async function ownedVolumes(): Promise<string[]> {
  const out = await docker('volume', 'ls', '--filter', `label=jumptotech.io/runtime-owner=${OWNER}`, '--format', '{{.Name}}');
  return out ? out.split('\n') : [];
}

/**
 * The Docker host's own pressure: load average, available memory, swap and
 * PSI. /proc/loadavg, /proc/meminfo and /proc/pressure are not namespaced, so
 * any container shows the VM's. Every latency in the report is read against
 * this — a number measured on a starved host says little about a healthy one.
 */
async function hostContext() {
  if (!args.project) return undefined;
  try {
    const out = await docker('exec', `${args.project}-web-1`, 'sh', '-c',
      'cat /proc/loadavg; grep -E "^(MemAvailable|SwapTotal|SwapFree):" /proc/meminfo; for r in cpu memory io; do printf "%s " $r; head -1 /proc/pressure/$r 2>/dev/null || echo; done');
    const lines = out.split('\n');
    const kb = (k: string) => Number(/(\d+)/.exec(lines.find((l) => l.startsWith(k)) ?? '')?.[1] ?? NaN);
    const psi = (r: string) => Number(/avg10=([\d.]+)/.exec(lines.find((l) => l.startsWith(`${r} `)) ?? '')?.[1] ?? NaN);
    return {
      load1: Number((lines[0] ?? '').split(' ')[0]),
      memAvailableMiB: Math.round(kb('MemAvailable') / 1024),
      swapUsedMiB: Math.round((kb('SwapTotal') - kb('SwapFree')) / 1024),
      psiSomeAvg10: { cpu: psi('cpu'), memory: psi('memory'), io: psi('io') },
    };
  } catch {
    return undefined;
  }
}

/** CPU%, memory and PIDs of the platform services and every owned sandbox. */
async function sample(label: string) {
  const names = [...(args.project ? ['api', 'terminal', 'sandboxd', 'postgres', 'web'].map((s) => `${args.project}-${s}-1`) : []), ...(await ownedSandboxes())];
  const host = await hostContext();
  if (!names.length) return { label, host, rows: [] };
  let out = '';
  try {
    out = await docker('stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}', ...names);
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? '');
  }
  const rows = out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, cpu, mem, pids] = l.split('\t');
      return { name, cpu, mem: (mem ?? '').split(' / ')[0], pids: Number(pids) };
    });
  return { label, host, rows };
}

/** Open descriptors and threads of PID 1 in a platform container (Linux procfs). */
async function fds(service: string): Promise<{ fds: number; threads: number } | undefined> {
  if (!args.project) return undefined;
  try {
    const out = await docker('exec', `${args.project}-${service}-1`, 'sh', '-c', 'ls /proc/1/fd | wc -l; ls /proc/1/task | wc -l');
    const [f, t] = out.split('\n').map(Number);
    return { fds: f ?? NaN, threads: t ?? NaN };
  } catch {
    return undefined;
  }
}

async function pollActive(jar: Jar, sessionId: string, deadlineMs: number): Promise<{ status: string; polls: number }> {
  const end = Date.now() + deadlineMs;
  let polls = 0;
  let status = '';
  while (Date.now() < end) {
    const r = await call(jar, 'GET', `/api/sessions/${sessionId}`);
    polls += 1;
    status = r.body?.data?.session?.status ?? r.body?.data?.status ?? `HTTP ${r.status}`;
    if (status === 'ACTIVE' || ['FAILED', 'ENDED', 'EXPIRED', 'DEGRADED'].includes(status)) return { status, polls };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { status: `still ${status}`, polls };
}

/**
 * What the browser does (apps/web/src/pages/WorkspacePage.tsx): mint a grant,
 * open the socket, and on a transient refusal wait and try again on the
 * AUTO_RECONNECTS schedule. `attempts` > 1 means a student would have seen
 * "reconnecting…" before the prompt; a failure here is one the browser gives
 * up on too.
 */
const AUTO_RECONNECTS = [1_000, 3_000, 6_000, 10_000, 15_000, 25_000];
const TRANSIENT = new Set(['CONNECTION_LOST', 'BROKER_UNREACHABLE', 'PTY_SPAWN_FAILED', 'CREDENTIALS_UNAVAILABLE', 'SANDBOX_UNAVAILABLE', 'AUTH_TIMEOUT']);

async function connect(s: Student, what: string) {
  const t0 = performance.now();
  const codes: string[] = [];
  let lastError = '';
  for (let attempt = 1; attempt <= AUTO_RECONNECTS.length + 1; attempt += 1) {
    let term: Term | undefined;
    try {
      const g = await call(s.jar, 'POST', `/api/sessions/${s.sessionId}/terminal`, {});
      const token = g.body?.data?.terminal?.token;
      if (!token) throw new Error(`grant HTTP ${g.status} ${g.body?.error?.code ?? ''}`);
      const grantMs = performance.now() - t0;
      term = await Term.open(token);
      await term.waitType('ready', 120_000);
      const readyMs = performance.now() - t0;
      const first = await term.cmd('true', 60_000);
      s.term = term;
      return { student: s.name, ok: true, attempts: attempt, codes, grantMs: Math.round(grantMs), readyMs: Math.round(readyMs), firstCommandMs: Math.round(first.ms) };
    } catch (e) {
      const code = term?.errorCode;
      lastError = `${(e as Error).message}${code ? ` [${code}]` : ''}`;
      codes.push(code ?? 'NO_CODE');
      term?.close();
      if (!code || !TRANSIENT.has(code) || attempt > AUTO_RECONNECTS.length) break;
      await new Promise((r) => setTimeout(r, AUTO_RECONNECTS[attempt - 1]));
    }
  }
  problems.push(`${what} ${s.name}: ${lastError} after ${codes.length} attempts`);
  return { student: s.name, ok: false, attempts: codes.length, codes, error: lastError, readyMs: undefined as number | undefined };
}

// ---------------------------------------------------------------------------

interface Student {
  name: string;
  lab: string;
  jar: Jar;
  sessionId?: string;
  term?: Term;
}

const report: Record<string, any> = { owner: OWNER, students: N, startedAt: new Date(T0).toISOString() };
const problems: string[] = [];

async function main() {
  const labs = (args.labs ?? '').split(',').filter(Boolean);
  if (!labs.length) throw new Error('--labs is required');
  const leftovers = await ownedSandboxes();
  if (leftovers.length) throw new Error(`refusing: ${leftovers.length} sandboxes already carry owner ${OWNER}`);
  const runId = randomBytes(3).toString('hex');

  report.idle = { sample: await sample('idle'), api: await fds('api'), terminal: await fds('terminal') };

  // 1. Sign in -------------------------------------------------------------
  const names = Array.from({ length: N + EXTRA }, (_, i) => `${args.prefix}-${runId}-${i + 1}`);
  let t = performance.now();
  const jars = await Promise.all(names.map(signIn));
  report.signIn = { ms: Math.round(performance.now() - t), students: names.length };
  const students: Student[] = names.slice(0, N).map((name, i) => ({ name, lab: labs[i % labs.length]!, jar: jars[i]! }));
  const extras: Student[] = names.slice(N).map((name, i) => ({ name, lab: labs[i % labs.length]!, jar: jars[N + i]! }));
  everyoneStarted.push(...students, ...extras);
  log(`${names.length} students signed in`);

  // 2. Classroom start burst ----------------------------------------------
  const burstT0 = performance.now();
  const starts = await Promise.all(
    students.map(async (s) => {
      const r = await call(s.jar, 'POST', `/api/labs/${s.lab}/start`, {});
      s.sessionId = r.body?.data?.session?.sessionId;
      const status = r.body?.data?.session?.status;
      let usable = status === 'ACTIVE';
      let settleMs = r.ms;
      if (s.sessionId && !usable) {
        const p = await pollActive(s.jar, s.sessionId, 300_000);
        usable = p.status === 'ACTIVE';
        settleMs = performance.now() - burstT0;
      }
      return { student: s.name, lab: s.lab, http: r.status, code: r.body?.error?.code, ms: Math.round(r.ms), usableMs: Math.round(settleMs), usable };
    }),
  );
  report.startBurst = { wallMs: Math.round(performance.now() - burstT0), latency: stats(starts.filter((s) => s.usable).map((s) => s.usableMs)), starts };
  for (const s of starts) if (!s.usable) problems.push(`start ${s.student} ${s.lab}: HTTP ${s.http} ${s.code ?? ''}`);
  log(`start burst: ${starts.filter((s) => s.usable).length}/${N} usable`, stats(starts.map((s) => s.usableMs)));
  report.afterStart = { sample: await sample('after-start'), api: await fds('api'), terminal: await fds('terminal') };

  // 3. Capacity refusal for the students over the ceiling ------------------
  if (extras.length) {
    const refused = await Promise.all(
      extras.map(async (s) => {
        const r = await call(s.jar, 'POST', `/api/labs/${s.lab}/start`, {});
        if (r.body?.data?.session?.sessionId) s.sessionId = r.body.data.session.sessionId;
        return { student: s.name, http: r.status, code: r.body?.error?.code ?? r.body?.data?.session?.status, ms: Math.round(r.ms) };
      }),
    );
    report.overCapacity = refused;
    log('over-capacity starts:', refused.map((r) => `${r.http} ${r.code}`).join(', '));
  }
  const live = students.filter((s) => s.sessionId);

  // 4. Terminal attach burst ----------------------------------------------
  const attachT0 = performance.now();
  const attaches = await Promise.all(live.map((s) => connect(s, 'attach')));
  report.attachBurst = {
    wallMs: Math.round(performance.now() - attachT0),
    ready: stats(attaches.filter((a) => a.ok).map((a) => a.readyMs!)),
    firstTry: attaches.filter((a) => a.ok && a.attempts === 1).length,
    attaches,
  };
  log(`attach burst: ${attaches.filter((a) => a.ok).length}/${live.length} ready (${report.attachBurst.firstTry} first try)`, stats(attaches.filter((a) => a.ok).map((a) => a.readyMs!)));

  // 5. Interactive latency, quiet then with one noisy neighbour -----------
  const typing = async (who: Student[]) => {
    const rtts: number[] = [];
    await Promise.all(
      who.map(async (s) => {
        for (let i = 0; i < COMMANDS; i += 1) rtts.push((await s.term!.cmd(`echo ${i}`, 60_000)).ms);
      }),
    );
    return stats(rtts);
  };
  const withTerm = live.filter((s) => s.term && s.term.closed === undefined);
  report.interactiveQuiet = await typing(withTerm);
  log('interactive quiet', report.interactiveQuiet);
  if (withTerm.length >= 2) {
    const noisy = withTerm[0]!;
    const others = withTerm.slice(1);
    const noiseT0 = performance.now();
    const before = noisy.term!.bytes;
    const noise = noisy.term!.cmd(`seq 1 ${NOISE_LINES}`, 300_000);
    const during = await typing(others);
    const n = await noise;
    report.noisyNeighbour = {
      noisyMs: Math.round(n.ms),
      noisyBytes: noisy.term!.bytes - before,
      noisyExit: n.exit,
      othersDuring: during,
      wallMs: Math.round(performance.now() - noiseT0),
      terminalService: await fds('terminal'),
      sample: await sample('after-noise'),
    };
    log('noisy neighbour', report.noisyNeighbour);
    // The noisy terminal must still answer.
    const after = await noisy.term!.cmd('echo alive', 60_000);
    (report.noisyNeighbour as any).noisyStillAnswersMs = Math.round(after.ms);
  }

  // 6. Verification burst ---------------------------------------------------
  if (!args['skip-check']) {
    const vT0 = performance.now();
    const checks = await Promise.all(
      live.map(async (s) => {
        const r = await call(s.jar, 'POST', `/api/sessions/${s.sessionId}/check`, {});
        return { student: s.name, lab: s.lab, http: r.status, code: r.body?.error?.code, passed: r.body?.data?.result?.passed ?? r.body?.data?.passed, ms: Math.round(r.ms) };
      }),
    );
    report.checkBurst = { wallMs: Math.round(performance.now() - vT0), latency: stats(checks.map((c) => c.ms)), checks };
    for (const c of checks) if (c.http >= 500) problems.push(`check ${c.student}: HTTP ${c.http} ${c.code ?? ''}`);
    log('check burst', stats(checks.map((c) => c.ms)), checks.map((c) => c.http).join(','));
  }

  // 7. Reset burst, then reconnect ------------------------------------------
  if (!args['skip-reset']) {
    const rT0 = performance.now();
    const resets = await Promise.all(
      live.map(async (s) => {
        const r = await call(s.jar, 'POST', `/api/sessions/${s.sessionId}/reset`, {});
        let status = r.body?.data?.session?.status;
        if (r.status < 300 && status !== 'ACTIVE') status = (await pollActive(s.jar, s.sessionId!, 300_000)).status;
        return { student: s.name, http: r.status, code: r.body?.error?.code, status, ms: Math.round(performance.now() - rT0) };
      }),
    );
    report.resetBurst = { wallMs: Math.round(performance.now() - rT0), latency: stats(resets.map((x) => x.ms)), resets };
    for (const x of resets) if (x.status !== 'ACTIVE') problems.push(`reset ${x.student}: HTTP ${x.http} ${x.code ?? ''} -> ${x.status}`);
    log('reset burst', stats(resets.map((x) => x.ms)), resets.map((x) => x.status).join(','));

    const reconnects = await Promise.all(
      live.map((s) => {
        s.term?.close();
        return connect(s, 'reconnect');
      }),
    );
    report.reconnectAfterReset = {
      latency: stats(reconnects.filter((r) => r.ok).map((r) => r.readyMs!)),
      firstTry: reconnects.filter((r) => r.ok && r.attempts === 1).length,
      reconnects,
    };
    log('reconnect after reset', report.reconnectAfterReset);
  }

  report.beforeEnd = { sample: await sample('before-end'), api: await fds('api'), terminal: await fds('terminal'), networks: (await ownedNetworks()).length, volumes: (await ownedVolumes()).length };

  // 8. End burst and cleanup ------------------------------------------------
  for (const s of live) s.term?.close();
  const eT0 = performance.now();
  const everyone = [...students, ...extras].filter((s) => s.sessionId);
  const ends = await Promise.all(
    everyone.map(async (s) => {
      const r = await call(s.jar, 'DELETE', `/api/sessions/${s.sessionId}`);
      return { student: s.name, http: r.status, ms: Math.round(r.ms) };
    }),
  );
  let gone = -1;
  let remaining: string[] = [];
  for (let i = 0; i < 240; i += 1) {
    remaining = await ownedSandboxes();
    if (!remaining.length) {
      gone = Math.round(performance.now() - eT0);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const nets = await ownedNetworks();
  const vols = await ownedVolumes();
  report.endBurst = { http: stats(ends.map((e) => e.ms)), codes: ends.map((e) => e.http), sandboxesGoneMs: gone, remaining, networksLeft: nets, volumesLeft: vols };
  if (gone < 0) problems.push(`sandboxes remain after End: ${remaining.join(' ')}`);
  if (nets.length) problems.push(`networks remain: ${nets.join(' ')}`);
  if (vols.length) problems.push(`volumes remain: ${vols.join(' ')}`);
  log('end burst', report.endBurst);

  // Settle, then resources after the class has gone.
  await new Promise((r) => setTimeout(r, 5_000));
  report.afterEnd = { sample: await sample('after-end'), api: await fds('api'), terminal: await fds('terminal') };
  const listed = await Promise.all(everyone.map((s) => call(s.jar, 'GET', '/api/sessions')));
  report.liveSessionsAfterEnd = listed.map((l) => (l.body?.data?.sessions ?? []).length).reduce((a, b) => a + b, 0);
  if ((report.liveSessionsAfterEnd as number) > 0) problems.push(`${report.liveSessionsAfterEnd} sessions still listed as live after End`);

  report.problems = problems;
  report.verdict = problems.length ? 'FAIL' : 'PASS';
  report.totalMs = Date.now() - T0;
  console.log(JSON.stringify(report, null, 2));
  log(`verdict ${report.verdict}`, problems);
  process.exit(problems.length ? 1 : 0);
}

/** Every student this run may have started a lab for, so a fatal error can still End them. */
const everyoneStarted: Student[] = [];

/**
 * A run that dies part-way must not leave sandboxes behind: End every session
 * it knows of, through the same route a student uses, then report. Bounded:
 * one DELETE per session, in parallel, each with its own deadline.
 */
async function endWhatWasStarted(): Promise<string[]> {
  for (const s of everyoneStarted) s.term?.close();
  const outcomes = await Promise.all(
    everyoneStarted.map(async (s) => {
      // Asked, not remembered: a Start whose response never arrived (the
      // client gave up) may still have created a session on the server.
      const ids = new Set<string>(s.sessionId ? [s.sessionId] : []);
      try {
        const listed = await call(s.jar, 'GET', '/api/sessions', undefined, 60_000);
        for (const entry of listed.body?.data?.sessions ?? []) {
          const id = entry?.session?.sessionId ?? entry?.sessionId;
          if (typeof id === 'string') ids.add(id);
        }
      } catch {
        /* fall back to the id we know */
      }
      const results: string[] = [];
      for (const id of ids) {
        try {
          const r = await call(s.jar, 'DELETE', `/api/sessions/${id}`, undefined, 180_000);
          results.push(`${id}: HTTP ${r.status}`);
        } catch (e) {
          results.push(`${id}: ${(e as Error).message}`);
        }
      }
      return results;
    }),
  );
  return outcomes.flat();
}

main().catch(async (e) => {
  console.error(e);
  report.fatal = String(e);
  report.cleanupAfterFatal = await endWhatWasStarted();
  log('ended after fatal error:', report.cleanupAfterFatal);
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
});
