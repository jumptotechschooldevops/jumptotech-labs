/**
 * BETA-P0-019 — FIVE-STUDENT CONCURRENT PRIVATE-BETA VALIDATION (release gate).
 *
 *   make beta-validate                      # reads ports, owner and cluster from .env
 *   npm run beta:validate -- --api … --runtime-owner … --kubeconfig …   # explicit
 *
 * Drives a RUNNING local stack — api, PostgreSQL, sandboxd, terminal, kind,
 * Prometheus — as five synthetic students at once, and exits non-zero on any
 * contract violation. docs/runbooks/five-student-beta-validation.md is the
 * operator document: prerequisites, duration, PASS criteria, cleanup.
 *
 * WHAT IT MUTATES (E2E, test-support/README.md):
 *   · lab sessions for beta-student-1…6, every one ended before exit;
 *   · `users` rows for those six synthetic handles (kept: they are identities,
 *     and the next run upserts the same rows);
 *   · two run-scoped sentinels — a container and a namespace labelled as
 *     another runtime owner's sandbox — removed by exact name at the end;
 *   · one `docker restart` of the api container (skip with --skip-api-restart).
 * It never deletes a runtime resource itself: sandboxes go only through End Lab.
 *
 * WHAT IT REFUSES: non-loopback targets, non-kind kubeconfigs, OIDC (production)
 * auth, MAX_ACTIVE_SESSIONS ≠ 5, MAX_ACTIVE_SESSIONS_PER_STUDENT ≠ 1, a stack
 * with live sessions, and leftovers already carrying the runtime owner.
 * Exit: 0 PASS · 1 FAIL · 2 refused or could not run.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BETA_CONTRACT,
  DEVELOPMENT_ISSUER,
  LAB_PLAN,
  RACE_LAB,
  RACE_SECOND_LAB,
  REUSE_PLAN,
  SIXTH_STUDENT,
  SYNTHETIC_STUDENTS,
  ValidationReport,
  alertNames,
  concurrentStartViolations,
  forgeTokenForSession,
  metricSum,
  provokedAlertGuards,
  parsePromtool,
  redact,
  targetRefusals,
  unexpectedAlerts,
  type PlannedLab,
  type StartObservation,
} from '@jumptotech/test-support/beta-contract';
import { TerminalClient } from './terminal-client.js';
import * as rt from './runtime.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OCCUPYING = ['CREATING', 'ACTIVE', 'RESETTING', 'DEGRADED', 'EXPIRING', 'ENDING'];
const HARNESS_STUDENTS = [...SYNTHETIC_STUDENTS, SIXTH_STUDENT];

const { values: args } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4000' },
    terminal: { type: 'string', default: 'ws://127.0.0.1:4001' },
    origin: { type: 'string', default: 'http://127.0.0.1:3000' },
    metrics: { type: 'string', default: 'http://127.0.0.1:9400' },
    'terminal-metrics': { type: 'string', default: 'http://127.0.0.1:9401' },
    'scrape-token-file': { type: 'string', default: path.join(REPO_ROOT, 'infrastructure/observability/secrets/scrape-token') },
    'compose-project': { type: 'string', default: 'jumptotech-labs' },
    'runtime-owner': { type: 'string' },
    kubeconfig: { type: 'string' },
    'sentinel-image': { type: 'string', default: 'jumptotech/lab-linux:latest' },
    'soak-seconds': { type: 'string', default: '300' },
    'race-iterations': { type: 'string', default: '3' },
    'skip-api-restart': { type: 'boolean', default: false },
    'skip-network-probe': { type: 'boolean', default: false },
    'report-dir': { type: 'string', default: path.join(os.tmpdir(), 'jtt-beta-validation') },
  },
});

if (!args['runtime-owner'] || !args.kubeconfig) {
  console.error('usage: five-student.ts --runtime-owner <RUNTIME_OWNER_ID> --kubeconfig <kind host kubeconfig> [options]');
  console.error('       docs/runbooks/five-student-beta-validation.md');
  process.exit(2);
}

const owner = args['runtime-owner'];
const soakSeconds = Number(args['soak-seconds']);
const raceIterations = Number(args['race-iterations']);
const runId = randomBytes(4).toString('hex');
const scrapeToken = readFileSync(args['scrape-token-file'], 'utf8').trim();
const secrets: string[] = [scrapeToken];
const kube = new rt.Kube(args.kubeconfig);
const started = Date.now();

/**
 * The commit this run validated, so the report can be matched to a deployment
 * (the evidence template asks for the gate "on the deployed commit"). Read from
 * the checkout, not taken from the environment; `null` when it cannot be read,
 * never guessed.
 */
function checkoutCommit(): { commit: string | null; clean: boolean | null } {
  try {
    const commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    return { commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null, clean: dirty.length === 0 };
  } catch {
    return { commit: null, clean: null };
  }
}
const validated = checkoutCommit();

const report = new ValidationReport((line) => console.log(redact(line, secrets)));

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function api(method: string, pathname: string, student: string | null, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { Origin: args.origin! };
  if (student) headers.Authorization = `Developer ${student}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(new URL(pathname, args.api), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 200) } };
  }
}

async function scrape(base: string): Promise<string> {
  const res = await fetch(`${base.replace(/\/$/, '')}/metrics`, { headers: { Authorization: `Bearer ${scrapeToken}` } });
  if (!res.ok) throw new Error(`metrics listener ${new URL(base).port} answered ${res.status}`);
  return res.text();
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${last ? ` (${(last as Error).message})` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const SESSION_ID = /^sess-[0-9a-f]{7,32}$/;
const sqlList = (ids: readonly string[]) => {
  for (const id of ids) if (!SESSION_ID.test(id)) throw new Error(`refusing to put '${id}' in SQL`);
  return ids.map((id) => `'${id}'`).join(',');
};
const studentSql = HARNESS_STUDENTS.map((s) => `'${s}'`).join(',');

let pg = '';
let prometheus = '';
let apiContainer = '';

async function occupyingRows(): Promise<number> {
  const rows = await rt.psql(
    pg,
    `select count(*) from lab_sessions s join users u on u.user_id = s.owner_user_id
      where u.issuer = '${DEVELOPMENT_ISSUER}' and u.subject in (${studentSql})
        and s.status in (${OCCUPYING.map((s) => `'${s}'`).join(',')})`,
  );
  return Number(rows[0]?.[0]);
}

async function prom(expr: string): Promise<number | undefined> {
  const series = parsePromtool(await rt.promQuery(prometheus, expr));
  return series.length === 0 ? undefined : series.reduce((sum, s) => sum + s.value, 0);
}

/** Every series of an expression, labels verbatim — for gauges that must not be summed. */
async function promSeries(expr: string): Promise<Record<string, number>> {
  return Object.fromEntries(parsePromtool(await rt.promQuery(prometheus, expr)).map((s) => [s.labels, s.value]));
}

async function firingAlerts(): Promise<string[]> {
  return alertNames(await rt.promQuery(prometheus, 'ALERTS{alertstate="firing"}'));
}

/**
 * Every alert-related violation right now: alerts nobody expected, and
 * provoked alerts whose guard shows a cause the scenario did not create.
 */
async function alertViolations(): Promise<string[]> {
  const firing = await firingAlerts();
  const violations = unexpectedAlerts(firing, alertsBefore).map((name) => `unexpected alert ${name}`);
  const window = `${Math.ceil((Date.now() - started) / 60_000) + 2}m`;
  for (const { name, cause, expr } of provokedAlertGuards(firing, window)) {
    const value = await prom(expr);
    if ((value ?? 0) > 0) violations.push(`${name} is firing for more than ${cause}: ${expr} = ${value}`);
    else provoked.add(`${name} (${cause})`);
  }
  return violations;
}
const provoked = new Set<string>();

// ---------------------------------------------------------------------------
// Sessions the harness holds
// ---------------------------------------------------------------------------

interface Live {
  plan: Pick<PlannedLab, 'student' | 'labId' | 'provider'> & { solution?: string };
  sessionId: string;
  sandboxRef: string;
  sandboxKind: string;
  token: string;
  terminal?: TerminalClient;
  namespace?: string;
  ended: boolean;
}

const held = new Map<string, Live>();

function admit(plan: Live['plan'], reply: Reply): Live {
  const data = reply.body.data;
  const live: Live = {
    plan,
    sessionId: data.session.sessionId,
    sandboxRef: data.session.sandboxRef,
    sandboxKind: data.session.sandboxKind,
    token: data.terminal.token,
    ended: false,
  };
  secrets.push(live.token);
  held.set(live.sessionId, live);
  return live;
}

async function startMany(plans: ReadonlyArray<Live['plan']>) {
  // Every request is dispatched in the same tick, so they genuinely race.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pending = plans.map(async (plan) => {
    await gate;
    const t0 = Date.now();
    const reply = await api('POST', `/api/labs/${plan.labId}/start`, plan.student);
    return { plan, reply, ms: Date.now() - t0 };
  });
  release();
  const results = await Promise.all(pending);
  return results.map(({ plan, reply, ms }) => ({
    plan,
    reply,
    ms,
    live: reply.status === 200 ? admit(plan, reply) : undefined,
  }));
}

async function owners(ids: readonly string[]): Promise<Map<string, { subject: string; status: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await rt.psql(
    pg,
    `select s.session_id, u.subject, s.status from lab_sessions s join users u on u.user_id = s.owner_user_id
      where s.session_id in (${sqlList(ids)})`,
  );
  return new Map(rows.map(([id, subject, status]) => [id!, { subject: subject!, status: status! }]));
}

async function endSession(live: Live): Promise<Reply> {
  const reply = await api('DELETE', `/api/sessions/${live.sessionId}`, live.plan.student);
  if (reply.status === 200) live.ended = true;
  return reply;
}

interface Snapshot {
  bySession: Map<string, string[]>;
  unattributed: string[];
  containers: number;
  namespaces: number;
}

/** What the runtime holds for this owner, keyed by the session label it carries. */
async function snapshot(): Promise<Snapshot> {
  const [containers, namespaces] = await Promise.all([rt.ownedContainers(owner), kube.ownedNamespaces(owner)]);
  const bySession = new Map<string, string[]>();
  const unattributed: string[] = [];
  const put = (sessionId: string | undefined, identity: string) => {
    if (!sessionId || !held.has(sessionId)) {
      unattributed.push(identity);
      return;
    }
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), identity].sort());
  };
  for (const c of containers) put(c.sessionId, `container:${c.name}:${c.id.slice(0, 12)}`);
  for (const ns of namespaces) put(ns.sessionId, `namespace:${ns.name}:${ns.uid}`);
  return { bySession, unattributed, containers: containers.length, namespaces: namespaces.length };
}

const identityOf = (snap: Snapshot, live: Live) => (snap.bySession.get(live.sessionId) ?? []).join(',');

async function connectTerminal(live: Live): Promise<TerminalClient> {
  const terminal = await TerminalClient.connect(args.terminal!, live.token, args.origin!);
  live.terminal = terminal;
  const ready = await terminal.waitForFrame('ready', 90_000);
  if (ready.sessionId !== live.sessionId) {
    throw new Error(`terminal attached to ${String(ready.sessionId)}, not ${live.sessionId}`);
  }
  if (typeof ready.namespace === 'string') live.namespace = ready.namespace;
  return terminal;
}

async function check(live: Live, as = live.plan.student) {
  return api('POST', `/api/sessions/${live.sessionId}/check`, as);
}

async function waitPassed(live: Live, timeoutMs: number) {
  return until(
    `${live.plan.labId} to pass for ${live.plan.student}`,
    async () => {
      const reply = await check(live);
      return reply.status === 200 && reply.body.data.passed === true ? reply : undefined;
    },
    timeoutMs,
    3000,
  );
}

async function startOutcomes() {
  const text = await scrape(args.metrics!);
  const out: Record<string, number> = {};
  for (const outcome of ['success', 'capacity_reached', 'student_limit_reached', 'provider_unavailable', 'provision_failed', 'unauthorized']) {
    out[outcome] = metricSum(text, 'jtt_lab_start_outcome_total', { outcome }) ?? 0;
  }
  out.capacityRejections = metricSum(text, 'jtt_session_capacity_rejections_total') ?? 0;
  out.studentLimitRejections = metricSum(text, 'jtt_session_student_limit_rejections_total') ?? 0;
  for (const outcome of ['success', 'pending', 'rejected', 'failed']) {
    out[`end_${outcome}`] = metricSum(text, 'jtt_lab_end_outcome_total', { outcome }) ?? 0;
    out[`reset_${outcome}`] = metricSum(text, 'jtt_lab_reset_outcome_total', { outcome }) ?? 0;
  }
  return out;
}

const delta = (after: Record<string, number>, before: Record<string, number>, key: string) => (after[key] ?? 0) - (before[key] ?? 0);

async function resourceSample(label: string) {
  const [stack, sandboxes] = await Promise.all([
    rt.sh('docker', ['ps', '--filter', `label=com.docker.compose.project=${args['compose-project']}`, '--format', '{{.Names}}']),
    rt.ownedContainers(owner),
  ]);
  const clusterNode = (await kube.context()).context.replace(/^kind-/, '') + '-control-plane';
  const stackNames = stack.split('\n').filter(Boolean);
  const sandboxNames = sandboxes.map((c) => c.name);
  const stats = await rt.containerStats([...stackNames, ...sandboxNames, clusterNode]);
  const sum = (names: string[]) =>
    stats.filter((s) => names.includes(s.name)).reduce((acc, s) => ({ cpu: acc.cpu + s.cpuPercent, mem: acc.mem + s.memBytes }), { cpu: 0, mem: 0 });
  const mib = (b: number) => Math.round(b / 1024 / 1024);
  const sample = {
    label,
    at: new Date().toISOString(),
    stack: { containers: stackNames.length, ...((s) => ({ cpuPercent: Math.round(s.cpu), memMiB: mib(s.mem) }))(sum(stackNames)) },
    sandboxes: { containers: sandboxNames.length, ...((s) => ({ cpuPercent: Math.round(s.cpu), memMiB: mib(s.mem) }))(sum(sandboxNames)) },
    kindNode: ((s) => ({ cpuPercent: Math.round(s.cpu), memMiB: mib(s.mem) }))(sum([clusterNode])),
    perContainer: stats.map((s) => ({ name: s.name, cpuPercent: s.cpuPercent, memMiB: mib(s.memBytes) })),
  };
  const pods = await kube.kubectl(['get', 'pods', '-A', '-l', 'run', '--no-headers']).catch(() => '');
  return { ...sample, labPods: pods.split('\n').filter(Boolean).length };
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

let sentinels: { container: string; namespace: string } | undefined;
let alertsBefore: string[] = [];

async function preflight(): Promise<boolean> {
  report.phase('0 · preflight — refuse anything but an idle local beta stack');
  const [{ context, server }, health, apiMetrics, me, containers, namespaces] = await Promise.all([
    kube.context(),
    api('GET', '/health', null),
    scrape(args.metrics!),
    api('GET', '/api/me', SYNTHETIC_STUDENTS[0]),
    rt.ownedContainers(owner),
    kube.ownedNamespaces(owner),
  ]);
  const refusals = targetRefusals({
    apiUrl: args.api!,
    terminalUrl: args.terminal!,
    metricsUrl: args.metrics!,
    kubeServer: server,
    kubeContext: context,
    runtimeOwner: owner,
    health: health.body?.data?.sessions,
    perStudentLimit: metricSum(apiMetrics, 'jtt_sessions_per_student_limit'),
    developerAuthStatus: me.status,
    preexistingOwnedResources: containers.length + namespaces.length,
  });
  if (refusals.length > 0) {
    for (const reason of refusals) report.fail('target refused', reason);
    return false;
  }
  report.pass('target is an idle loopback beta stack', `context ${context}, owner ${owner}, limits ${BETA_CONTRACT.maxActiveSessions}/${BETA_CONTRACT.maxActiveSessionsPerStudent}`);

  const providers = new Map<string, { available: boolean }>(
    (health.body.data.providers as Array<{ provider: string; available: boolean }>).map((p) => [p.provider, p]),
  );
  for (const provider of new Set([...LAB_PLAN.map((p) => p.provider), REUSE_PLAN.provider])) {
    if (!report.check(`provider ${provider} available`, providers.get(provider)?.available === true)) return false;
  }
  report.check(
    'P0-015 NetworkPolicy attestation is valid and required for Kubernetes admission',
    metricSum(apiMetrics, 'jtt_network_isolation_attestation_valid') === 1,
  );

  pg = await rt.composeContainer(args['compose-project']!, 'postgres');
  apiContainer = await rt.composeContainer(args['compose-project']!, 'api');
  try {
    prometheus = await rt.composeContainer(args['compose-project']!, 'prometheus');
  } catch (error) {
    report.fail('observability stack running', (error as Error).message);
    return false;
  }
  alertsBefore = await firingAlerts();
  report.observe('alertsFiringBeforeRun', alertsBefore);
  report.pass('observability stack reachable', `alerts already firing before the run: ${alertsBefore.join(', ') || 'none'}`);
  report.check('no synthetic student holds a session', (await occupyingRows()) === 0);

  sentinels = await rt.createSentinels(kube, { owner, runId, image: args['sentinel-image']! });
  report.pass('foreign-owner sentinels created', `${sentinels.container}, namespace ${sentinels.namespace}`);
  report.observe('resources.idle', await resourceSample('idle, before any session'));
  return true;
}

async function concurrentStart(): Promise<Live[]> {
  report.phase('1 · five distinct students press Start at the same instant');
  const before = await startOutcomes();
  const results = await startMany(LAB_PLAN);
  const admitted = results.flatMap((r) => (r.live ? [r.live] : []));
  const persisted = await owners(admitted.map((l) => l.sessionId));
  const observations: StartObservation[] = results.map((r) => ({
    student: r.plan.student,
    status: r.reply.status,
    code: r.reply.body?.error?.code,
    sessionId: r.live?.sessionId,
    sandboxRef: r.live?.sandboxRef,
    ownerSubject: r.live ? persisted.get(r.live.sessionId)?.subject : undefined,
  }));
  report.observe('concurrentStart', results.map((r) => ({ student: r.plan.student, lab: r.plan.labId, status: r.reply.status, code: r.reply.body?.error?.code, ms: r.ms, sessionId: r.live?.sessionId, sandboxRef: r.live?.sandboxRef })));
  const ok = report.expectNone(
    'concurrent start: 5 admitted, unique sessions and runtimes, owners persisted correctly, no 429/503',
    concurrentStartViolations(observations, { admitted: 5, capacityRejections: 0, studentLimitRejections: 0 }),
    results.map((r) => `${r.plan.student}/${r.plan.labId} ${r.reply.status} in ${(r.ms / 1000).toFixed(1)}s`).join(', '),
  );
  if (!ok) {
    for (const r of results.filter((x) => x.reply.status !== 200)) {
      report.record('INFO', `start refused for ${r.plan.student}`, JSON.stringify(r.reply.body?.error ?? r.reply.body).slice(0, 400));
    }
    return admitted;
  }

  const views = await Promise.all(admitted.map((l) => api('GET', `/api/sessions/${l.sessionId}`, l.plan.student)));
  report.check(
    'every session is ACTIVE on the expected provider, read back by its owner',
    views.every((v, i) => v.status === 200 && v.body.data.session.status === 'ACTIVE' && v.body.data.session.provider === admitted[i]!.plan.provider),
    admitted.map((l, i) => `${l.plan.student}:${views[i]!.body?.data?.session?.status}/${views[i]!.body?.data?.session?.provider}`).join(', '),
  );
  report.check(
    'PostgreSQL: each session row is ACTIVE and owned by its synthetic student',
    admitted.every((l) => persisted.get(l.sessionId)?.subject === l.plan.student && persisted.get(l.sessionId)?.status === 'ACTIVE'),
  );
  report.check('PostgreSQL: exactly 5 occupying rows for the synthetic students', (await occupyingRows()) === 5);

  const snap = await snapshot();
  report.expectNone(
    'runtime: every session has its own sandbox resources and nothing unattributed carries this owner',
    [
      ...admitted.filter((l) => !snap.bySession.has(l.sessionId)).map((l) => `${l.plan.student} has no runtime resource`),
      ...snap.unattributed.map((u) => `orphan ${u}`),
    ],
    `${snap.containers} container(s), ${snap.namespaces} namespace(s)`,
  );
  const after = await startOutcomes();
  report.check('metrics: 5 successful starts recorded', delta(after, before, 'success') === 5, `+${delta(after, before, 'success')}`);
  report.observe('runtimeAfterStart', Object.fromEntries(snap.bySession));
  return admitted;
}

async function terminals(live: Live[]) {
  report.phase('2 · five terminals attached and typing at once');
  const attached = await Promise.allSettled(live.map((l) => connectTerminal(l)));
  report.expectNone(
    'every student attaches a terminal to their own session',
    attached.flatMap((a, i) => (a.status === 'rejected' ? [`${live[i]!.plan.student}: ${(a.reason as Error).message}`] : [])),
  );
  if (attached.some((a) => a.status === 'rejected')) return false;

  const runs = await Promise.all(
    live.map((l) => l.terminal!.run(`whoami; pwd; echo P0019-MARK-$((6*7))-${l.plan.student}`, 60_000)),
  );
  const who = live.map((l, i) => {
    const lines = runs[i]!.output.split('\n').map((x) => x.trim()).filter((x) => x && !x.includes('__P0019_') && !x.includes('whoami;'));
    return { student: l.plan.student, lab: l.plan.labId, whoami: lines[0], pwd: lines[1] };
  });
  report.observe('terminalIdentity', who);
  report.expectNone(
    'whoami / pwd / marker execute in all five shells concurrently, each shell printing only its own marker',
    live.flatMap((l, i) => {
      const out = runs[i]!.output;
      const problems: string[] = [];
      if (runs[i]!.exitCode !== 0) problems.push(`${l.plan.student} exit ${runs[i]!.exitCode}`);
      if (!out.includes(`P0019-MARK-42-${l.plan.student}`)) problems.push(`${l.plan.student} marker missing`);
      for (const other of live) {
        if (other !== l && out.includes(`P0019-MARK-42-${other.plan.student}`)) problems.push(`${l.plan.student} saw ${other.plan.student}'s marker`);
      }
      return problems;
    }),
    who.map((w) => `${w.student}(${w.lab}): ${w.whoami} @ ${w.pwd}`).join('; '),
  );

  const usable = await Promise.all(
    live.map((l) => l.terminal!.run(`f=.p0019-probe-${runId} && echo ${l.plan.student} > "$f" && grep -qx ${l.plan.student} "$f" && rm "$f"`, 60_000)),
  );
  report.check('workspace is writable in every sandbox', usable.every((r) => r.exitCode === 0));

  const termMetrics = await scrape(args['terminal-metrics']!);
  const open = metricSum(termMetrics, 'jtt_terminal_connections_open') ?? 0;
  report.check('terminal service reports ≥5 open connections', open >= 5, `jtt_terminal_connections_open=${open}`);
  return true;
}

async function verifierBaseline(live: Live[]) {
  report.phase('3 · verifier runs for all five before any work');
  const replies = await Promise.all(live.map((l) => check(l)));
  report.check(
    'every check runs (HTTP 200) and reports the lab incomplete',
    replies.every((r) => r.status === 200 && r.body.data.passed === false),
    live.map((l, i) => `${l.plan.labId}:${replies[i]!.status}/${replies[i]!.body?.data?.summary}`).join(', '),
  );
}

async function capacity(live: Live[]) {
  report.phase('4 · capacity: sixth student and a second session are refused by different controls');
  const before = await startOutcomes();
  const snapBefore = await snapshot();

  const sixth = await api('POST', '/api/labs/LINUX-001/start', SIXTH_STUDENT);
  if (sixth.status === 200) admit({ student: SIXTH_STUDENT as never, labId: 'LINUX-001', provider: 'linux' }, sixth);
  report.check(
    'sixth distinct student → 503 LAB_CAPACITY_REACHED {activeSessions:5, maxActiveSessions:5}',
    sixth.status === 503 && sixth.body.error?.code === 'LAB_CAPACITY_REACHED' && sixth.body.error?.details?.activeSessions === 5 && sixth.body.error?.details?.maxActiveSessions === 5,
    `${sixth.status} ${JSON.stringify(sixth.body.error ?? {}).slice(0, 200)}`,
  );

  const holder = live[1]!;
  const second = await api('POST', '/api/labs/LINUX-001/start', holder.plan.student);
  if (second.status === 200) admit({ student: holder.plan.student, labId: 'LINUX-001', provider: 'linux' }, second);
  report.check(
    `${holder.plan.student} second session → 429 STUDENT_SESSION_LIMIT_REACHED {activeSessions:1, maxActiveSessionsPerStudent:1}`,
    second.status === 429 && second.body.error?.code === 'STUDENT_SESSION_LIMIT_REACHED' && second.body.error?.details?.activeSessions === 1 && second.body.error?.details?.maxActiveSessionsPerStudent === 1,
    `${second.status} ${JSON.stringify(second.body.error ?? {}).slice(0, 200)}`,
  );

  const raced = await startMany([
    { student: SIXTH_STUDENT as never, labId: 'LINUX-001', provider: 'linux' },
    { student: holder.plan.student, labId: 'TF-001', provider: 'terraform' },
    { student: live[3]!.plan.student, labId: 'CS-001', provider: 'linux' },
  ]);
  report.expectNone(
    'the same refusals hold when fired simultaneously at a full platform',
    concurrentStartViolations(
      raced.map((r) => ({ student: r.plan.student, status: r.reply.status, code: r.reply.body?.error?.code, sessionId: r.live?.sessionId, sandboxRef: r.live?.sandboxRef })),
      { admitted: 0, capacityRejections: 1, studentLimitRejections: 2, alreadyHolding: live.map((l) => l.plan.student) },
    ),
  );

  const snapAfter = await snapshot();
  report.check(
    'refusals created no runtime resource and changed no existing one',
    snapAfter.unattributed.length === 0 && live.every((l) => identityOf(snapAfter, l) === identityOf(snapBefore, l)) && snapAfter.containers === snapBefore.containers && snapAfter.namespaces === snapBefore.namespaces,
  );
  const health = await api('GET', '/health', null);
  report.check('active sessions stay at 5', health.body.data.sessions.active === 5 && (await occupyingRows()) === 5, `health ${health.body.data.sessions.active}`);
  const after = await startOutcomes();
  report.check(
    'metrics: capacity and per-student refusals are counted separately',
    delta(after, before, 'capacity_reached') === 2 && delta(after, before, 'student_limit_reached') === 3 && delta(after, before, 'capacityRejections') === 2 && delta(after, before, 'studentLimitRejections') === 3 && delta(after, before, 'success') === 0,
    `capacity_reached +${delta(after, before, 'capacity_reached')}, student_limit_reached +${delta(after, before, 'student_limit_reached')}`,
  );
}

async function isolation(live: Live[]) {
  report.phase('5 · isolation between active students');
  const snapBefore = await snapshot();
  const probes: string[] = [];
  for (let i = 0; i < live.length; i += 1) {
    const a = live[i]!;
    const b = live[(i + 1) % live.length]!;
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/api/sessions/${b.sessionId}`],
      ['POST', `/api/sessions/${b.sessionId}/check`],
      ['POST', `/api/sessions/${b.sessionId}/activity`, {}],
      ['POST', `/api/sessions/${b.sessionId}/hints`, {}],
      ['POST', `/api/sessions/${b.sessionId}/reset`],
      ['DELETE', `/api/sessions/${b.sessionId}`],
    ];
    for (const [method, route, body] of attempts) {
      const reply = await api(method, route, a.plan.student, body);
      if (!(reply.status === 404 && reply.body.error?.code === 'SESSION_NOT_FOUND')) {
        probes.push(`${a.plan.student} ${method} ${route.replace(b.sessionId, '<B>')} → ${reply.status} ${reply.body.error?.code ?? ''}`);
      }
    }
  }
  const anonymous = await api('GET', `/api/sessions/${live[0]!.sessionId}`, null);
  if (anonymous.status !== 404) probes.push(`request with no credential → ${anonymous.status}`);
  report.expectNone('API: every cross-student read, check, activity, hint, reset and end → 404 SESSION_NOT_FOUND', probes, `${live.length * 6 + 1} attempts`);

  const snapAfter = await snapshot();
  const views = await Promise.all(live.map((l) => api('GET', `/api/sessions/${l.sessionId}`, l.plan.student)));
  report.check(
    'no cross-student attempt changed a victim session or its runtime',
    live.every((l, i) => identityOf(snapAfter, l) === identityOf(snapBefore, l) && views[i]!.body.data.session.status === 'ACTIVE'),
  );

  // A student re-points their own terminal token at a classmate's session.
  const forged: string[] = [];
  for (const [a, b] of [[live[0]!, live[1]!], [live[2]!, live[3]!]] as const) {
    const token = forgeTokenForSession(a.token, b.sessionId);
    secrets.push(token);
    const socket = await TerminalClient.connect(args.terminal!, token, args.origin!);
    const code = await socket.waitForClose(30_000).catch(() => undefined);
    if (code !== 4401 || socket.frames.some((f) => f.type === 'ready')) forged.push(`${a.plan.student}→${b.plan.student}: close ${code}, ready=${socket.frames.some((f) => f.type === 'ready')}`);
    socket.dispose();
  }
  report.expectNone('terminal: a token re-pointed at another student’s session is refused (4401) before any shell', forged);

  const byProvider = (p: string) => live.find((l) => l.plan.provider === p)!;
  const k8s = byProvider('kubernetes');
  const k8sOut = await k8s.terminal!.run(
    `kubectl get namespaces >/dev/null 2>&1; echo NS=$?; kubectl -n kube-system get pods >/dev/null 2>&1; echo KS=$?; kubectl -n ${sentinels!.namespace} get pods >/dev/null 2>&1; echo SN=$?`,
  );
  report.check(
    'Kubernetes shell cannot list namespaces, kube-system, or another owner’s namespace',
    /NS=[1-9]/.test(k8sOut.output) && /KS=[1-9]/.test(k8sOut.output) && /SN=[1-9]/.test(k8sOut.output),
    (k8sOut.output.match(/(NS|KS|SN)=\d+/g) ?? []).join(' '),
  );
  const [nsLabels, policies] = await Promise.all([
    kube.kubectl(['get', 'namespace', k8s.namespace!, '-o', 'jsonpath={.metadata.labels.pod-security\\.kubernetes\\.io/enforce}']),
    kube.kubectl(['get', 'networkpolicy', '-n', k8s.namespace!, '-o', 'jsonpath={.items[*].metadata.name}']),
  ]);
  report.check('P0-016: session namespace enforces Pod Security baseline', nsLabels.trim() === 'baseline', nsLabels.trim());
  report.check('P0-015: session namespace carries the default-deny NetworkPolicy set', /deny/.test(policies), policies.trim());

  const others = [...live.map((l) => l.sandboxRef), sentinels!.container];
  const docker = byProvider('docker');
  const dockerOut = await docker.terminal!.run(`docker ps -a --format 'NAME={{.Names}}'`);
  const leakedNames = others.filter((ref) => ref !== docker.sandboxRef && dockerOut.output.includes(`NAME=${ref}`));
  report.check(
    'Docker-track shell sees only its own daemon (no host, classmate or sentinel containers)',
    dockerOut.exitCode === 0 && leakedNames.length === 0 && !dockerOut.output.includes(`NAME=${apiContainer}`),
    leakedNames.join(', '),
  );
  for (const provider of ['linux', 'terraform']) {
    const l = byProvider(provider);
    // `/sys/class/net` also lists the kernel's inert tunnel devices (gre0, sit0…)
    // in every namespace, so "no network" is asserted as: no route, no
    // ethernet/veth interface, and Docker's own record of `--network none`.
    const out = await l.terminal!.run(
      `echo ROUTES=$(tail -n +2 /proc/net/route | wc -l); echo ETH=$(ls /sys/class/net | grep -cE '^(eth|en|veth)'); test -S /var/run/docker.sock; echo SOCK=$?`,
    );
    const mode = (await rt.sh('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', l.sandboxRef])).trim();
    report.check(
      `${provider} sandbox has no route, no network interface, NetworkMode=none and no Docker socket`,
      /ROUTES=0\b/.test(out.output) && /ETH=0\b/.test(out.output) && /SOCK=1\b/.test(out.output) && mode === 'none',
      `${(out.output.match(/(ROUTES|ETH|SOCK)=\d+/g) ?? []).join(' ')} NetworkMode=${mode}`,
    );
  }
  const ansible = byProvider('ansible');
  // The typed line echoes back as `RESOLVED=$h`; only an expanded name is a resolution.
  const ansibleOut = await ansible.terminal!.run(`for h in ${others.filter((r) => r !== ansible.sandboxRef).join(' ')}; do getent hosts "$h" >/dev/null && echo RESOLVED=$h; done; true`);
  report.check(
    'Ansible control node cannot resolve any classmate or sentinel sandbox',
    ansibleOut.exitCode === 0 && !/RESOLVED=jtt-lab-/.test(ansibleOut.output),
    (ansibleOut.output.match(/RESOLVED=jtt-lab-\S+/g) ?? []).join(' '),
  );

  if (args['skip-network-probe']) {
    report.record('SKIP', 'P0-015 enforcement probe under load', '--skip-network-probe');
  } else {
    // The probe reads KUBECONFIG, never a flag. It is set explicitly and the
    // inherited one is dropped: the host's default kubeconfig may hold real
    // clusters, and the target gate above only vetted --kubeconfig.
    const env: NodeJS.ProcessEnv = { ...process.env, KUBECONFIG: path.resolve(args.kubeconfig!) };
    const t0 = Date.now();
    try {
      const out = await rt
        .sh('npx', ['tsx', path.join(REPO_ROOT, 'scripts/verify-network-policy.ts'), '--run-id', `b${runId.slice(0, 5)}`], 900_000, env)
        .catch((e: { stdout?: string; stderr?: string; message: string }) => {
          throw Object.assign(new Error(e.message), { output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` });
        });
      report.check('P0-015 cross-namespace enforcement probe PASSES while five students are active', /VERDICT: PASS/.test(out), `${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (error) {
      const output = String((error as { output?: string }).output ?? '');
      report.fail(
        'P0-015 cross-namespace enforcement probe PASSES while five students are active',
        (output.split('\n').filter((l) => /VERDICT|leak|FAIL|rror/.test(l)).join(' | ') || (error as Error).message).slice(0, 600),
      );
    }
  }
}

async function workAndVerify(live: Live[]) {
  report.phase('6 · each student solves their lab; verifiers see only their own sandbox');
  const solvedTimings: string[] = [];
  for (let i = 0; i < live.length; i += 1) {
    const l = live[i]!;
    const t0 = Date.now();
    const typed = await l.terminal!.run(l.plan.solution!, 300_000);
    if (!report.check(`${l.plan.student} types the ${l.plan.labId} solution in the terminal`, typed.exitCode === 0, `exit ${typed.exitCode}`)) {
      report.record('INFO', `${l.plan.student} output`, typed.output.slice(-600));
    }
    try {
      await waitPassed(l, l.plan.provider === 'kubernetes' ? 300_000 : 120_000);
      solvedTimings.push(`${l.plan.labId} ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (error) {
      const last = await check(l);
      report.fail(`${l.plan.labId} verifier passes for ${l.plan.student}`, `${(error as Error).message}; ${JSON.stringify(last.body?.data?.checks ?? last.body).slice(0, 600)}`);
      continue;
    }
    const matrix = await Promise.all(live.map((x) => check(x)));
    report.check(
      `after ${l.plan.student} solves: exactly students 1…${i + 1} pass, the rest are untouched`,
      matrix.every((m, j) => m.status === 200 && m.body.data.passed === j <= i),
      matrix.map((m, j) => `${live[j]!.plan.labId}:${m.body?.data?.passed}`).join(' '),
    );
  }
  report.observe('solveTimings', solvedTimings);
}

async function reset(live: Live[]) {
  report.phase('7 · one student resets while four stay active');
  const target = live[0]!;
  const rest = live.slice(1);
  const before = await snapshot();
  const outcomes = await startOutcomes();
  const mark = target.terminal!.frames.length;
  const reply = await api('POST', `/api/sessions/${target.sessionId}/reset`, target.plan.student);
  report.check(
    `${target.plan.labId} reset → 200, reconnectTerminal for a container sandbox`,
    reply.status === 200 && reply.body.data.reconnectTerminal === true && reply.body.data.session.status === 'ACTIVE',
    `${reply.status} ${reply.body.error?.code ?? ''}`,
  );
  /*
   * What the browser does (apps/web WorkspacePage → LabTerminal): on
   * `reconnectTerminal` it re-runs the terminal effect, which closes the old
   * socket and opens a new one with the same token. The terminal service may
   * get there first with a same-socket `reattached` frame; behind the broker
   * the old `docker exec` usually ends first and closes the socket instead.
   * Either is correct for a student. Which one happened is recorded.
   */
  let bound = target.terminal!.frames.slice(mark).find((f) => f.type === 'reattached');
  let reconnected = bound !== undefined && target.terminal!.open;
  let how = 'same socket received `reattached`';
  if (!reconnected) {
    const oldClose = target.terminal!.closeCode;
    target.terminal!.dispose();
    try {
      const fresh = await connectTerminal(target);
      bound = fresh.frames.find((f) => f.type === 'ready');
      reconnected = fresh.open;
      how = `old socket closed (${oldClose ?? 'still open'}); reconnected with the same token, as the browser does`;
    } catch (error) {
      how = `reconnect failed: ${(error as Error).message}`;
    }
  }
  report.check('the reset student’s terminal is connected to the rebuilt sandbox', reconnected, how);
  report.observe('resetTerminalPath', how);
  const readyFrame = bound;
  const after = await snapshot();
  report.check(
    'the terminal is bound to the new sandbox, not the destroyed one',
    readyFrame?.sessionId === target.sessionId && (after.bySession.get(target.sessionId) ?? []).some((id) => id.includes(String(readyFrame?.sandboxRef))),
    `sandboxRef ${String(readyFrame?.sandboxRef)}`,
  );
  report.check('the reset student’s sandbox was replaced', identityOf(after, target) !== identityOf(before, target) && identityOf(after, target) !== '');
  report.check('the other four runtimes are the same objects as before the reset', rest.every((l) => identityOf(after, l) === identityOf(before, l)));
  const checks = await Promise.all(live.map((l) => check(l)));
  report.check(
    'verifier: the reset student is back to incomplete; the other four still pass',
    checks[0]!.body.data.passed === false && checks.slice(1).every((c) => c.body.data.passed === true),
  );
  const alive = await Promise.all(live.map((l) => l.terminal!.run(`echo P0019-ALIVE-$((20+2))`, 60_000)));
  report.check('all five terminals execute after the reset', alive.every((r) => r.exitCode === 0 && r.output.includes('P0019-ALIVE-22')));
  const again = await target.terminal!.run(target.plan.solution!, 120_000);
  const passedAgain = again.exitCode === 0 && (await waitPassed(target, 120_000).then(() => true, () => false));
  report.check('the reset student solves the lab again in the new sandbox', passedAgain);
  const outcomesAfter = await startOutcomes();
  report.check('metrics: one successful reset, none failed', delta(outcomesAfter, outcomes, 'reset_success') === 1 && delta(outcomesAfter, outcomes, 'reset_failed') === 0);
}

async function observabilityAtFive(live: Live[]) {
  report.phase('8 · observability reflects five active students');
  const text = await scrape(args.metrics!);
  report.check(
    'api /metrics: jtt_sessions_active{status="ACTIVE"} = 5, limits 5 and 1',
    metricSum(text, 'jtt_sessions_active', { status: 'ACTIVE' }) === 5 && metricSum(text, 'jtt_sessions_capacity_limit') === 5 && metricSum(text, 'jtt_sessions_per_student_limit') === 1,
  );
  const expectations: Array<[string, string, (v: number | undefined) => boolean]> = [
    ['Prometheus sum(jtt_sessions_active) = 5', 'sum(jtt_sessions_active)', (v) => v === 5],
    ['jtt:sessions_headroom:count = 0', 'jtt:sessions_headroom:count', (v) => v === 0],
    ['jtt:sessions_utilization:ratio = 1', 'jtt:sessions_utilization:ratio', (v) => v === 1],
    ['api, terminal and sandboxd targets up', 'min(up{job=~"api|terminal|sandboxd"})', (v) => v === 1],
    ['sandboxd runtime up', 'min(jtt_sandboxd_runtime_up)', (v) => v === 1],
    ['session starts recorded (≥5 success)', 'sum(jtt_lab_start_outcome_total{outcome="success"})', (v) => (v ?? 0) >= 5],
    ['capacity refusals recorded', 'sum(jtt_lab_start_outcome_total{outcome="capacity_reached"})', (v) => (v ?? 0) >= 2],
    ['per-student refusals recorded', 'sum(jtt_lab_start_outcome_total{outcome="student_limit_reached"})', (v) => (v ?? 0) >= 3],
    ['network isolation attestation valid', 'min(jtt_network_isolation_attestation_valid)', (v) => v === 1],
    ['terminal connections ≥5', 'sum(jtt_terminal_connections_open)', (v) => (v ?? 0) >= 5],
  ];
  for (const [id, expr, ok] of expectations) {
    try {
      const value = await until(id, async () => {
        const v = await prom(expr);
        return ok(v) ? { v } : undefined;
      }, 90_000, 5000);
      report.pass(id, `${expr} = ${value.v}`);
    } catch {
      report.fail(id, `${expr} = ${await prom(expr).catch(() => 'error')}`);
    }
  }
  const containers = (await rt.ownedContainers(owner)).length;
  const managed = await prom('sum(jtt_sandboxd_containers_managed)');
  report.check('sandboxd managed-container gauge matches the daemon', managed === containers, `gauge ${managed}, daemon ${containers}`);
  report.observe('leakCountAtFive', { leak: await prom('jtt:sandbox_leak:count'), containers, sessions: live.length, note: 'containers per session differ by provider (ansible 3, kubernetes 0)' });
  // Per series: the filesystem ratio has one series per filesystem, and a sum
  // of ratios is meaningless.
  const hostGauges: Record<string, Record<string, number>> = {};
  for (const key of ['jtt:host_memory_available:ratio', 'jtt:host_filesystem_available:ratio', 'jtt:host_load5_per_cpu:ratio']) {
    hostGauges[key] = await promSeries(key).catch(() => ({}));
  }
  report.observe('hostGaugesAtFive', hostGauges);
  report.expectNone('no unexpected lifecycle, recovery or isolation alert is firing', await alertViolations());
}

async function soak(live: Live[]) {
  report.phase(`9 · soak: ${soakSeconds}s of health polling with five students active`);
  const baseline = await snapshot();
  const deadline = Date.now() + soakSeconds * 1000;
  const problems: string[] = [];
  const samples: unknown[] = [await resourceSample('five active, soak start')];
  let ticks = 0;
  while (Date.now() < deadline) {
    const tickStart = Date.now();
    ticks += 1;
    const [health, views, echoes, snap] = await Promise.all([
      api('GET', '/health', null),
      Promise.all(live.map((l) => api('GET', `/api/sessions/${l.sessionId}`, l.plan.student))),
      Promise.allSettled(live.map((l) => l.terminal!.run(`echo P0019-TICK-${ticks}-$((ticks=${ticks}+0))`, 30_000))),
      snapshot(),
    ]);
    if (health.status !== 200 || health.body.data.sessions.active !== 5) problems.push(`tick ${ticks}: health active ${health.body?.data?.sessions?.active}`);
    views.forEach((v, i) => {
      if (v.body?.data?.session?.status !== 'ACTIVE') problems.push(`tick ${ticks}: ${live[i]!.plan.student} ${v.body?.data?.session?.status}`);
    });
    echoes.forEach((e, i) => {
      if (e.status === 'rejected' || e.value.exitCode !== 0) problems.push(`tick ${ticks}: ${live[i]!.plan.student} terminal ${e.status === 'rejected' ? (e.reason as Error).message : e.value.exitCode}`);
    });
    for (const l of live) if (identityOf(snap, l) !== identityOf(baseline, l)) problems.push(`tick ${ticks}: ${l.plan.student} runtime changed`);
    if (snap.unattributed.length) problems.push(`tick ${ticks}: unattributed ${snap.unattributed.join(',')}`);
    if (ticks === Math.max(1, Math.round(soakSeconds / 30))) samples.push(await resourceSample('five active, soak middle'));
    const wait = 15_000 - (Date.now() - tickStart);
    if (wait > 0 && Date.now() + wait < deadline) await new Promise((resolve) => setTimeout(resolve, wait));
    else if (Date.now() + wait >= deadline) break;
  }
  samples.push(await resourceSample('five active, soak end'));
  report.observe('resources.fiveActive', samples);
  report.expectNone(`${ticks} health ticks: sessions ACTIVE, shells responsive, runtimes stable`, problems.slice(0, 20), `${ticks} ticks over ${soakSeconds}s`);
  report.expectNone('still no unexpected alert after the soak', await alertViolations());
}

async function recovery(live: Live[]) {
  report.phase('10 · recovery: restart the api with five sessions live');
  if (args['skip-api-restart']) {
    report.record('SKIP', 'api restart', '--skip-api-restart');
    return;
  }
  const before = await snapshot();
  await rt.sh('docker', ['restart', apiContainer], 180_000);
  await until('api /health after restart', async () => {
    const h = await api('GET', '/health', null);
    return h.status === 200 && h.body.data.sessions ? h : undefined;
  }, 180_000, 2000);
  const views = await Promise.all(live.map((l) => api('GET', `/api/sessions/${l.sessionId}`, l.plan.student)));
  report.check('every session survives the restart ACTIVE (durable sessions)', views.every((v) => v.body?.data?.session?.status === 'ACTIVE'));
  const after = await snapshot();
  report.check('no runtime was touched by the restart', live.every((l) => identityOf(after, l) === identityOf(before, l)) && after.unattributed.length === 0);
  const echoes = await Promise.allSettled(live.map((l) => l.terminal!.run('echo P0019-AFTER-API-RESTART-$((3*3))', 60_000)));
  report.check('open terminals keep working across the api restart', echoes.every((e) => e.status === 'fulfilled' && e.value.output.includes('P0019-AFTER-API-RESTART-9')));

  const sweep = await until('a completed reaper sweep in the restarted api', async () => {
    const text = await scrape(args.metrics!);
    return (metricSum(text, 'jtt_reaper_sweeps_total', { outcome: 'ok' }) ?? 0) >= 1 ? text : undefined;
  }, 180_000, 5000).catch(() => undefined);
  if (!sweep) {
    report.fail('reaper sweeps successfully with five live sessions', 'no successful sweep within 180s');
    return;
  }
  report.check(
    'reaper: sweep succeeds, 0 errors, nothing reclaimed, no recoveries, no orphans',
    (metricSum(sweep, 'jtt_reaper_last_sweep_errors') ?? 0) === 0 && (metricSum(sweep, 'jtt_reaper_reclaimed_total') ?? 0) === 0 && (metricSum(sweep, 'jtt_reaper_recoveries_total') ?? 0) === 0 && (metricSum(sweep, 'jtt_reaper_orphans_found') ?? 0) === 0,
    ['jtt_reaper_last_sweep_errors', 'jtt_reaper_reclaimed_total', 'jtt_reaper_recoveries_total', 'jtt_reaper_orphans_found'].map((n) => `${n}=${metricSum(sweep, n) ?? 0}`).join(' '),
  );
  const postSweep = await Promise.all(live.map((l) => api('GET', `/api/sessions/${l.sessionId}`, l.plan.student)));
  report.check('sessions are still ACTIVE after the sweep', postSweep.every((v) => v.body?.data?.session?.status === 'ACTIVE'));
}

async function endAll(live: Live[]) {
  report.phase('11 · students end one at a time; nobody else is disturbed');
  const outcomes = await startOutcomes();
  let ends = 0;
  for (let i = live.length - 1; i >= 0; i -= 1) {
    const l = live[i]!;
    const remaining = live.slice(0, i);
    const before = await snapshot();
    const reply = await endSession(l);
    ends += 1;
    report.check(`${l.plan.student} End Lab → 200 ENDED`, reply.status === 200 && reply.body.data.session.status === 'ENDED', `${reply.status} ${reply.body.error?.code ?? ''}`);
    const gone = await until(`${l.plan.student}'s runtime to disappear`, async () => {
      const s = await snapshot();
      return s.bySession.has(l.sessionId) ? undefined : s;
    }, 180_000, 2000).catch(() => undefined);
    report.check(`${l.plan.student}'s sandbox resources are removed`, gone !== undefined);
    report.check(
      'the remaining students’ runtimes are untouched',
      gone !== undefined && remaining.every((r) => identityOf(gone, r) === identityOf(before, r)),
    );
    const closed = await l.terminal!.waitForClose(30_000).catch(() => undefined);
    report.check(`${l.plan.student}'s terminal is closed by the platform`, closed === 4410 || closed === 4403 || closed === 1000, `close ${closed}`);
    const reuse = await TerminalClient.connect(args.terminal!, l.token, args.origin!);
    const reuseCode = await reuse.waitForClose(30_000).catch(() => undefined);
    report.check(`${l.plan.student}'s token cannot attach to the ended session`, reuseCode !== undefined && !reuse.frames.some((f) => f.type === 'ready'), `close ${reuseCode}`);
    reuse.dispose();
    if (remaining.length) {
      const echoes = await Promise.all(remaining.map((r) => r.terminal!.run(`echo P0019-STILL-${remaining.length}-$((1+0))`, 60_000)));
      report.check(`${remaining.length} remaining terminal(s) still execute`, echoes.every((e) => e.exitCode === 0));
    }

    if (i === live.length - 1) {
      // Four active: the global control has room, the per-student one does not.
      const dup = await api('POST', '/api/labs/LINUX-001/start', live[1]!.plan.student);
      if (dup.status === 200) admit({ student: live[1]!.plan.student, labId: 'LINUX-001', provider: 'linux' }, dup);
      report.check('with capacity free, a student holding a session is still refused 429', dup.status === 429 && dup.body.error?.code === 'STUDENT_SESSION_LIMIT_REACHED', `${dup.status}`);
      const sixth = await api('POST', '/api/labs/LINUX-001/start', SIXTH_STUDENT);
      const sixthLive = sixth.status === 200 ? admit({ student: SIXTH_STUDENT as never, labId: 'LINUX-001', provider: 'linux' }, sixth) : undefined;
      report.check('with capacity free, the sixth student is now admitted (the 503 was the global control)', sixth.status === 200, `${sixth.status} ${sixth.body.error?.code ?? ''}`);
      if (sixthLive) {
        const ended = await endSession(sixthLive);
        ends += 1;
        report.check('the sixth student ends cleanly', ended.status === 200);
        await until('the sixth student’s sandbox to disappear', async () => ((await snapshot()).bySession.has(sixthLive.sessionId) ? undefined : true), 120_000, 2000).catch(() => undefined);
      }
    }
  }

  report.phase('12 · after End: nothing left behind');
  const empty = await until('owned runtime to be empty', async () => {
    const [c, n, nets] = await Promise.all([rt.ownedContainers(owner), kube.ownedNamespaces(owner), rt.ownedNetworks(owner)]);
    return c.length + n.length + nets.length === 0 ? { c, n, nets } : undefined;
  }, 240_000, 3000).catch(async () => ({ c: await rt.ownedContainers(owner), n: await kube.ownedNamespaces(owner), nets: await rt.ownedNetworks(owner) }));
  report.check(
    'no container, namespace or lab network carries this runtime owner',
    empty.c.length + empty.n.length + empty.nets.length === 0,
    `${empty.c.length} container(s) ${empty.n.length} namespace(s) ${empty.nets.length} network(s)`,
  );
  const health = await api('GET', '/health', null);
  report.check('active session count is 0', health.body.data.sessions.active === 0 && (await occupyingRows()) === 0);
  const rows = await owners([...held.keys()]);
  report.check('PostgreSQL: every harness session is ENDED', [...held.keys()].every((id) => rows.get(id)?.status === 'ENDED'), [...new Set([...rows.values()].map((r) => r.status))].join(','));
  const present = await rt.sentinelsPresent(kube, sentinels!);
  report.check('foreign-owner sentinels (unrelated runtime resources) survived every teardown and sweep', present.container && present.namespace, JSON.stringify(present));
  const after = await startOutcomes();
  report.check('metrics: every End recorded as success, none pending or failed', delta(after, outcomes, 'end_success') === ends && delta(after, outcomes, 'end_pending') === 0 && delta(after, outcomes, 'end_failed') === 0, `success +${delta(after, outcomes, 'end_success')} of ${ends}`);
  try {
    await until('Prometheus to see 0 active sessions', async () => ((await prom('sum(jtt_sessions_active) or vector(0)')) === 0 ? true : undefined), 90_000, 5000);
    report.pass('Prometheus: active sessions back to 0');
  } catch {
    report.fail('Prometheus: active sessions back to 0', String(await prom('sum(jtt_sessions_active)')));
  }
  report.observe('resources.afterEnd', await resourceSample('all ended'));
}

async function reuse() {
  report.phase('13 · a student who ended starts again (simulated AWS lab)');
  const [result] = await startMany([REUSE_PLAN]);
  if (!report.check(`${REUSE_PLAN.student} starts ${REUSE_PLAN.labId} after ending their earlier session`, result!.reply.status === 200, `${result!.reply.status} ${result!.reply.body.error?.code ?? ''}`)) return;
  const live = result!.live!;
  await connectTerminal(live);
  const typed = await live.terminal!.run(REUSE_PLAN.solution, 60_000);
  const verdict = await check(live);
  const satisfied = (verdict.body.data.checks as Array<{ label: string; status: string }>).find((c) => c.label === REUSE_PLAN.satisfiedCheckLabel);
  report.check('the simulated AWS task is done in the terminal and the verifier sees it', typed.exitCode === 0 && satisfied?.status === 'pass', `${satisfied?.label}: ${satisfied?.status}`);
  const ended = await endSession(live);
  report.check('the reused session ends', ended.status === 200);
  await until('the reused sandbox to disappear', async () => ((await rt.ownedContainers(owner)).length === 0 ? true : undefined), 120_000, 2000).catch(() => undefined);
  report.check('the reused sandbox is removed', (await rt.ownedContainers(owner)).length === 0 && (await occupyingRows()) === 0);
}

async function races() {
  report.phase(`14 · concurrent-start races × ${raceIterations}`);
  for (let n = 1; n <= raceIterations; n += 1) {
    const six = await startMany(HARNESS_STUDENTS.map((student) => ({ student: student as never, labId: RACE_LAB, provider: 'linux' })));
    const admitted = six.flatMap((r) => (r.live ? [r.live] : []));
    const persisted = await owners(admitted.map((l) => l.sessionId));
    report.expectNone(
      `race ${n}: six distinct students at once → exactly 5 admitted, one 503, no 429, no duplicates`,
      concurrentStartViolations(
        six.map((r) => ({ student: r.plan.student, status: r.reply.status, code: r.reply.body?.error?.code, sessionId: r.live?.sessionId, sandboxRef: r.live?.sandboxRef, ownerSubject: r.live ? persisted.get(r.live.sessionId)?.subject : undefined })),
        { admitted: 5, capacityRejections: 1, studentLimitRejections: 0 },
      ),
      `refused: ${six.filter((r) => !r.live).map((r) => r.plan.student).join(',')}`,
    );
    const snap = await snapshot();
    report.check(`race ${n}: 5 sandboxes, 5 occupying rows, nothing orphaned`, snap.containers === admitted.length && admitted.length === 5 && snap.unattributed.length === 0 && (await occupyingRows()) === 5, `${snap.containers} containers`);
    const ends = await Promise.all(admitted.map((l) => endSession(l)));
    report.check(`race ${n}: five simultaneous End Lab → all 200`, ends.every((e) => e.status === 200));
    const clean = await until(`race ${n} cleanup`, async () => ((await rt.ownedContainers(owner)).length === 0 && (await occupyingRows()) === 0 ? true : undefined), 120_000, 2000).catch(() => false);
    report.check(`race ${n}: runtime and database back to empty`, clean === true);

    const twice = await startMany([
      { student: 'beta-student-3', labId: RACE_LAB, provider: 'linux' },
      { student: 'beta-student-3', labId: RACE_SECOND_LAB, provider: 'linux' },
    ]);
    report.expectNone(
      `race ${n}: one student pressing Start twice at once → exactly one 200 and one 429`,
      concurrentStartViolations(
        twice.map((r) => ({ student: r.plan.student, status: r.reply.status, code: r.reply.body?.error?.code, sessionId: r.live?.sessionId, sandboxRef: r.live?.sandboxRef })),
        { admitted: 1, capacityRejections: 0, studentLimitRejections: 1 },
      ),
    );
    await Promise.all(twice.flatMap((r) => (r.live ? [endSession(r.live)] : [])));
    const clean2 = await until(`race ${n} duplicate cleanup`, async () => ((await rt.ownedContainers(owner)).length === 0 && (await occupyingRows()) === 0 ? true : undefined), 120_000, 2000).catch(() => false);
    report.check(`race ${n}: duplicate-start cleanup complete`, clean2 === true);
  }
}

async function cleanup() {
  for (const live of held.values()) live.terminal?.dispose();
  const open = [...held.values()].filter((l) => !l.ended);
  for (const live of open) {
    const reply = await endSession(live).catch(() => undefined);
    console.log(`cleanup: ended ${live.plan.student} ${live.sessionId} → ${reply?.status ?? 'error'}`);
  }
  if (sentinels) await rt.removeSentinels(kube, sentinels, runId).catch((e) => console.log(`cleanup: sentinels ${(e as Error).message}`));
}

let interrupted = false;
// Whatever escapes, the sessions this run holds are ended before exit.
process.on('uncaughtException', (error) => {
  if (interrupted) return;
  interrupted = true;
  console.log(`FAIL harness crashed — ${error.stack?.split('\n').slice(0, 3).join(' | ')}`);
  void cleanup().finally(() => process.exit(1));
});
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log('\ninterrupted — ending every session this run started, then exiting');
  void cleanup().finally(() => process.exit(130));
});

async function main(): Promise<number> {
  console.log(`BETA-P0-019 five-student private-beta validation · run ${runId} · ${new Date().toISOString()}`);
  console.log(`students ${SYNTHETIC_STUDENTS.join(', ')} (+ ${SIXTH_STUDENT}) · labs ${LAB_PLAN.map((p) => p.labId).join(', ')}`);
  let refused = false;
  try {
    if (!(await preflight())) {
      refused = true;
      return 2;
    }
    const live = await concurrentStart();
    if (live.length === LAB_PLAN.length && (await terminals(live))) {
      await verifierBaseline(live);
      await capacity(live);
      await isolation(live);
      await workAndVerify(live);
      await reset(live);
      await observabilityAtFive(live);
      await soak(live);
      await recovery(live);
      await endAll(live);
      await reuse();
      await races();
      report.phase('15 · final');
      report.expectNone('no unexpected alert at the end of the run', await alertViolations());
      report.observe('alertsFiringAtEnd', await firingAlerts());
      report.observe('provokedAlertsExcusedByGuard', [...provoked]);
    } else {
      report.fail('scenario could not proceed past start/attach');
    }
  } catch (error) {
    report.fail('harness error', (error as Error).stack?.split('\n').slice(0, 4).join(' | ') ?? String(error));
  } finally {
    await cleanup();
    const residue = (await rt.ownedContainers(owner)).length + (await kube.ownedNamespaces(owner).then((n) => n.length).catch(() => 0));
    if (!refused) report.check('harness left no runtime resource behind', residue === 0, `${residue} remaining`);
  }
  return report.passed ? 0 : 1;
}

const code = await main();
mkdirSync(args['report-dir']!, { recursive: true });
const file = path.join(args['report-dir']!, `five-student-${runId}.json`);
writeFileSync(
  file,
  redact(JSON.stringify({ runId, commit: validated.commit, trackedFilesClean: validated.clean, startedAt: new Date(started).toISOString(), durationSeconds: Math.round((Date.now() - started) / 1000), passed: code === 0, findings: report.findings, observations: report.observations }, null, 2), secrets),
);
const failed = report.failed;
console.log(`\n${'='.repeat(78)}`);
console.log(`${report.findings.filter((f) => f.verdict === 'PASS').length} passed · ${failed.length} failed · ${report.findings.filter((f) => f.verdict === 'SKIP').length} skipped · ${Math.round((Date.now() - started) / 60000)} min`);
for (const f of failed) console.log(redact(`FAIL [${f.phase}] ${f.id} — ${f.detail}`, secrets));
console.log(`report: ${file}`);
console.log(code === 0 ? 'RESULT: PASS — five-student private-beta gate' : code === 2 ? 'RESULT: REFUSED — nothing was started' : 'RESULT: FAIL — five-student private-beta gate');
process.exit(code);
