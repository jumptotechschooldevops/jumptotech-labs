/**
 * BETA-P0-019 — the five-student private-beta contract, as data and pure checks.
 *
 * This module is deliberately free of I/O: no process, no socket, no file. The
 * real validation (`scripts/beta-validation/five-student.ts`) drives a running stack and feeds what it
 * observed through these functions; `apps/api/test/five-student-beta-contract.test.ts`
 * feeds them fabricated observations in ordinary CI. One definition of "pass",
 * exercised both ways, so the release gate and the hermetic test cannot drift.
 */

/** The private-beta capacity policy (docs/runbooks/private-beta-operations.md). */
export const BETA_CONTRACT = Object.freeze({
  maxActiveSessions: 5,
  maxActiveSessionsPerStudent: 1,
});

/**
 * Synthetic identities. Development auth (`Authorization: Developer <name>`)
 * upserts each as a `users` row under the `urn:jumptotech:development` issuer.
 * They are not people, carry no e-mail and no display name beyond the handle.
 */
export const SYNTHETIC_STUDENTS = Object.freeze([
  'beta-student-1',
  'beta-student-2',
  'beta-student-3',
  'beta-student-4',
  'beta-student-5',
] as const);

/** Holds nothing while the five are active, so a refusal is the platform being full. */
export const SIXTH_STUDENT = 'beta-student-6';

export const DEVELOPMENT_ISSUER = 'urn:jumptotech:development';

export interface PlannedLab {
  student: (typeof SYNTHETIC_STUDENTS)[number];
  labId: string;
  provider: string;
  /** What this student's shell types to satisfy the lab's verifier. */
  solution: string;
  why: string;
}

/**
 * One student per runtime shape the private beta actually serves. Every lab
 * here starts with no external credentials: Kubernetes and Docker pull public
 * images, Terraform resolves from the offline mirror baked into its image.
 */
export const LAB_PLAN: readonly PlannedLab[] = Object.freeze([
  {
    student: 'beta-student-1',
    labId: 'LINUX-001',
    provider: 'linux',
    solution: 'mkdir -p ~/project/archive && touch ~/project/config.txt ~/project/archive/app.log',
    why: 'container sandbox brokered by sandboxd; the shape shared by Linux, CS, Networking and simulated AWS (48 labs)',
  },
  {
    student: 'beta-student-2',
    labId: 'DOCKER-001',
    provider: 'docker',
    solution: 'docker run -d --name web nginx:1.27-alpine >/dev/null',
    why: 'per-session Docker daemon (privileged dind) on the sandboxes network; the heaviest sandbox per student',
  },
  {
    student: 'beta-student-3',
    labId: 'K8S-001',
    provider: 'kubernetes',
    solution: 'kubectl run nginx --image=nginx:stable >/dev/null',
    why: 'kind namespace under P0-015 NetworkPolicy and P0-016 Pod Security; the only non-container runtime',
  },
  {
    student: 'beta-student-4',
    labId: 'ANSIBLE-001',
    provider: 'ansible',
    // The project and its ansible.cfg are in ANSIBLE_WORKSPACE_DIR. The shell
    // opens in /home/student, while the account's $HOME *is* the project, so
    // `~/lab` would name /home/student/lab/lab: use the absolute path.
    // `ansible web -m ping` exits 0 when the pattern matches no host at all, so
    // success is two real `SUCCESS` replies, not the exit code.
    solution:
      "( cd /home/student/lab && test -f ansible.cfg && printf '[web]\\nnode1\\nnode2\\n' > inventory.ini && test \"$(ansible web -m ping 2>&1 | grep -c SUCCESS)\" = 2 )",
    why: 'multi-container topology (control node + two managed nodes) on a per-session network',
  },
  {
    student: 'beta-student-5',
    labId: 'TF-001',
    provider: 'terraform',
    solution:
      "( cd ~/terraform && printf '%s\\n' 'resource \"local_file\" \"manifest\" {' '  filename = \"build/manifest.txt\"' '  content  = \"service=ledger-api\"' '}' 'output \"manifest_path\" {' '  value = \"build/manifest.txt\"' '}' > main.tf && terraform init -no-color -input=false >/dev/null && terraform apply -auto-approve -no-color -input=false >/dev/null )",
    why: 'container sandbox running a real terraform init/apply from the offline provider mirror',
  },
]);

/** After everything ends: a used student starts again, on a simulated AWS lab. */
export const REUSE_PLAN = Object.freeze({
  student: 'beta-student-1' as const,
  labId: 'AWS-006',
  provider: 'linux',
  solution: "sed -i 's/^EVENT_NAME=FILL_ME$/EVENT_NAME=RevokeSecurityGroupIngress/' ~/incident-9214/findings.env",
  /** The one requirement that solution satisfies; the lab has more. */
  satisfiedCheckLabel: 'The API call that caused the outage is identified',
});

/** A cheap lab for the repeated concurrent-start races. */
export const RACE_LAB = 'LINUX-001';
export const RACE_SECOND_LAB = 'CS-001';

/** Alerts the scenario is expected to raise, by design. Anything else new is a failure. */
export const EXPECTED_WORKLOAD_ALERTS: ReadonlySet<string> = new Set([
  // The scenario refuses a sixth student on purpose.
  'CapacityExhausted',
  // 5 of 5 held for ten minutes is 100% utilisation, which this warns about.
  'CapacityNearExhausted',
]);

/**
 * Alerts the scenario provokes on purpose, each excused ONLY while its guard —
 * a PromQL expression over the run's window — is 0. The guard is everything
 * that alert could fire for *except* the deliberate cause, so a real failure
 * hiding behind a provoked alert still fails the run.
 */
export const PROVOKED_ALERT_GUARDS: Readonly<Record<string, { cause: string; guard: (window: string) => string }>> = Object.freeze({
  // Phases 4 and 14 refuse students for capacity, and capacity_reached counts
  // as a start failure (recording rule jtt:lab_start_failures:increase10m).
  LabStartFailureRateElevated: {
    cause: 'deliberate LAB_CAPACITY_REACHED refusals',
    guard: (w: string) => `sum(increase(jtt_lab_start_outcome_total{outcome=~"provider_unavailable|provision_failed|unauthorized"}[${w}])) or vector(0)`,
  },
  LabStartsFailingHard: {
    cause: 'deliberate LAB_CAPACITY_REACHED refusals',
    guard: (w: string) => `sum(increase(jtt_lab_start_outcome_total{outcome=~"provider_unavailable|provision_failed|unauthorized"}[${w}])) or vector(0)`,
  },
  // Phase 5 makes 31 cross-student requests, each an unowned_session_access event.
  SecurityEventBurst: {
    cause: 'deliberate cross-student session requests',
    guard: (w: string) => `sum(increase(jtt_security_events_total{event!~"unowned_session_access|dev_identity_in_use"}[${w}])) or vector(0)`,
  },
  AuthzOwnershipDenialSpike: {
    cause: 'deliberate cross-student session requests',
    guard: (w: string) => `sum(increase(jtt_security_events_total{event!~"unowned_session_access|dev_identity_in_use"}[${w}])) or vector(0)`,
  },
  // Phase 5 presents forged tokens (unauthorized); phase 11 presents ended
  // sessions' tokens (no_credentials). Every legitimate attach must reach
  // `ready`, which the scenario asserts separately.
  TerminalConnectionFailures: {
    cause: 'deliberate forged and ended-session terminal tokens',
    guard: (w: string) => `sum(increase(jtt_terminal_connections_total{outcome!~"established|unauthorized|no_credentials"}[${w}])) or vector(0)`,
  },
});

/** Alert families that must never fire because of this workload. */
export const FORBIDDEN_ALERT_PATTERN =
  /^(Session|Reaper|LabReset|LabStart|NetworkIsolation|ScopeDenial|SandboxLeak|Orphans|TerminalPty|TerminalConnection|SandboxdRuntime|ProviderUnavailable)/;

// ---------------------------------------------------------------------------
// Target safety
// ---------------------------------------------------------------------------

export interface TargetFacts {
  apiUrl: string;
  terminalUrl: string;
  metricsUrl: string;
  kubeServer: string;
  kubeContext: string;
  runtimeOwner: string;
  /** `GET /health` → data.sessions */
  health: { active: number; maxActive: number } | undefined;
  /** `jtt_sessions_per_student_limit` from the API's metrics listener. */
  perStudentLimit: number | undefined;
  /** HTTP status of `GET /api/me` with a Developer credential. */
  developerAuthStatus: number;
  /** Containers and namespaces already labelled with this runtime owner. */
  preexistingOwnedResources: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

const RUNTIME_OWNER_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

/**
 * Every reason this target must not be driven. Empty means go.
 *
 * The harness creates and destroys sandboxes and ends every session it made.
 * That is exactly what must never happen to a stack real students are using,
 * so it refuses anything that is not an idle, loopback, development-auth beta
 * stack on a local kind cluster.
 */
export function targetRefusals(facts: TargetFacts): string[] {
  const refusals: string[] = [];
  for (const [name, url] of [
    ['API', facts.apiUrl],
    ['terminal', facts.terminalUrl],
    ['metrics', facts.metricsUrl],
  ] as const) {
    if (!isLoopbackUrl(url)) refusals.push(`${name} URL is not a loopback address; this harness only drives a local stack`);
  }
  if (!isLoopbackUrl(facts.kubeServer) && !/^https:\/\/[a-z0-9-]+-control-plane:6443$/.test(facts.kubeServer)) {
    refusals.push('the kubeconfig does not point at a local kind API server');
  }
  if (!facts.kubeContext.startsWith('kind-')) {
    refusals.push(`the kubeconfig context is not a kind context`);
  }
  if (!RUNTIME_OWNER_PATTERN.test(facts.runtimeOwner)) {
    refusals.push('the runtime owner is not a valid RUNTIME_OWNER_ID');
  }
  if (!facts.health) {
    refusals.push('GET /health did not report session capacity');
  } else {
    if (facts.health.maxActive !== BETA_CONTRACT.maxActiveSessions) {
      refusals.push(
        `MAX_ACTIVE_SESSIONS is ${facts.health.maxActive}, not the beta's ${BETA_CONTRACT.maxActiveSessions}`,
      );
    }
    if (facts.health.active !== 0) {
      refusals.push(`the target already has ${facts.health.active} active session(s); run only against an idle stack`);
    }
  }
  if (facts.perStudentLimit !== BETA_CONTRACT.maxActiveSessionsPerStudent) {
    refusals.push(
      `MAX_ACTIVE_SESSIONS_PER_STUDENT is ${facts.perStudentLimit ?? 'unreadable'}, not the beta's ${BETA_CONTRACT.maxActiveSessionsPerStudent}`,
    );
  }
  if (facts.developerAuthStatus !== 200) {
    refusals.push(
      `the API refused a Developer credential (HTTP ${facts.developerAuthStatus}); production (OIDC) targets are refused`,
    );
  }
  if (facts.preexistingOwnedResources !== 0) {
    refusals.push(
      `${facts.preexistingOwnedResources} runtime resource(s) already carry this runtime owner; clean them up first (docs/runbooks/five-student-beta-validation.md §6)`,
    );
  }
  return refusals;
}

// ---------------------------------------------------------------------------
// Concurrent start
// ---------------------------------------------------------------------------

export interface StartObservation {
  student: string;
  status: number;
  code?: string;
  sessionId?: string;
  sandboxRef?: string;
  /** `users.subject` of the persisted session's owner, when admitted. */
  ownerSubject?: string;
}

export interface StartExpectation {
  admitted: number;
  capacityRejections: number;
  studentLimitRejections: number;
  /** Students who already held a live session before the batch fired. */
  alreadyHolding?: readonly string[];
}

/** Every way a batch of simultaneous starts broke the contract. */
export function concurrentStartViolations(results: readonly StartObservation[], expected: StartExpectation): string[] {
  const violations: string[] = [];
  const admitted = results.filter((r) => r.status === 200);
  const capacity = results.filter((r) => r.status === 503 && r.code === 'LAB_CAPACITY_REACHED');
  const limit = results.filter((r) => r.status === 429 && r.code === 'STUDENT_SESSION_LIMIT_REACHED');
  const other = results.filter((r) => !admitted.includes(r) && !capacity.includes(r) && !limit.includes(r));

  if (admitted.length !== expected.admitted) {
    violations.push(`${admitted.length} start(s) admitted, expected exactly ${expected.admitted}`);
  }
  if (admitted.length > BETA_CONTRACT.maxActiveSessions) {
    violations.push(`capacity race: ${admitted.length} sessions admitted past MAX_ACTIVE_SESSIONS=${BETA_CONTRACT.maxActiveSessions}`);
  }
  if (capacity.length !== expected.capacityRejections) {
    violations.push(`${capacity.length} LAB_CAPACITY_REACHED refusal(s), expected ${expected.capacityRejections}`);
  }
  if (limit.length !== expected.studentLimitRejections) {
    violations.push(`${limit.length} STUDENT_SESSION_LIMIT_REACHED refusal(s), expected ${expected.studentLimitRejections}`);
  }
  for (const r of other) {
    violations.push(`${r.student}: unexpected HTTP ${r.status}${r.code ? ` ${r.code}` : ''}`);
  }

  const perStudent = new Map<string, number>();
  for (const r of admitted) perStudent.set(r.student, (perStudent.get(r.student) ?? 0) + 1);
  const holding = new Set(expected.alreadyHolding ?? []);
  for (const [student, count] of perStudent) {
    if (count > BETA_CONTRACT.maxActiveSessionsPerStudent || (holding.has(student) && count > 0)) {
      violations.push(`duplicate ownership: ${student} was admitted ${count} time(s)${holding.has(student) ? ' while already holding a session' : ''}`);
    }
  }
  for (const r of limit) {
    if (!perStudent.has(r.student) && !holding.has(r.student)) {
      violations.push(`unexpected 429 for ${r.student}, who holds no other session`);
    }
  }

  const duplicates = (values: Array<string | undefined>) => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const v of values) {
      if (v === undefined) continue;
      if (seen.has(v)) dup.add(v);
      seen.add(v);
    }
    return [...dup];
  };
  for (const r of admitted) {
    if (!r.sessionId) violations.push(`${r.student}: admitted without a session id`);
    if (!r.sandboxRef) violations.push(`${r.student}: admitted without a runtime identifier`);
    if (r.ownerSubject !== undefined && r.ownerSubject !== r.student) {
      violations.push(`${r.student}: session persisted as owned by '${r.ownerSubject}'`);
    }
  }
  for (const d of duplicates(admitted.map((r) => r.sessionId))) violations.push(`duplicate session id ${d}`);
  for (const d of duplicates(admitted.map((r) => r.sandboxRef))) violations.push(`duplicate runtime identifier ${d}`);
  return violations;
}

// ---------------------------------------------------------------------------
// Alerts, metrics text, redaction
// ---------------------------------------------------------------------------

/**
 * Alerts firing now that were not firing before the run and are not expected
 * of it. Provoked alerts are left out here and judged by their guards
 * (`provokedAlertGuards`); a lifecycle, isolation or runtime alert is never
 * excused by having already been firing.
 */
export function unexpectedAlerts(firingNow: readonly string[], firingBefore: readonly string[]): string[] {
  const before = new Set(firingBefore);
  return [...new Set(firingNow)].filter(
    (name) =>
      !EXPECTED_WORKLOAD_ALERTS.has(name) &&
      !(name in PROVOKED_ALERT_GUARDS) &&
      (!before.has(name) || FORBIDDEN_ALERT_PATTERN.test(name)),
  );
}

/** The guards to evaluate for the provoked alerts that are firing. */
export function provokedAlertGuards(firingNow: readonly string[], window: string) {
  return [...new Set(firingNow)]
    .filter((name) => name in PROVOKED_ALERT_GUARDS)
    .map((name) => ({ name, cause: PROVOKED_ALERT_GUARDS[name]!.cause, expr: PROVOKED_ALERT_GUARDS[name]!.guard(window) }));
}

/**
 * Sum of every sample of `name` in a Prometheus text exposition whose labels
 * include all of `labels`. `undefined` when no sample matched.
 */
export function metricSum(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  let total: number | undefined;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!match || match[1] !== name) continue;
    const found: Record<string, string> = {};
    for (const pair of (match[3] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      found[pair[1]!] = pair[2]!;
    }
    if (!Object.entries(labels).every(([k, v]) => found[k] === v)) continue;
    const value = Number(match[4]);
    if (Number.isNaN(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Parse `promtool query instant` output: one value per series, labels kept
 * verbatim. An aggregate prints `{} => 5`; a recording rule with no labels
 * prints its bare name, `jtt:sessions_headroom:count => 0`.
 */
export function parsePromtool(output: string): Array<{ labels: string; value: number }> {
  const series: Array<{ labels: string; value: number }> = [];
  for (const line of output.split('\n')) {
    const match = /^(.*?)\s+=>\s+(\S+)\s+@\[/.exec(line.trim());
    if (match) series.push({ labels: match[1]!, value: Number(match[2]) });
  }
  return series;
}

export function alertNames(promtoolOutput: string): string[] {
  return parsePromtool(promtoolOutput)
    .map((s) => /alertname="([^"]+)"/.exec(s.labels)?.[1])
    .filter((n): n is string => n !== undefined);
}

/** Replace every secret occurrence; secrets shorter than 8 characters are ignored as unsafe to match. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/**
 * A terminal token is `base64url(claims).signature`. Re-point its claims at
 * another session while keeping the original signature — the forgery a
 * student holding their own token could attempt.
 */
export function forgeTokenForSession(token: string, sessionId: string): string {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('not a terminal session token');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  claims.sid = sessionId;
  return `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;
}

// ---------------------------------------------------------------------------
// Result recording
// ---------------------------------------------------------------------------

export type Verdict = 'PASS' | 'FAIL' | 'SKIP' | 'INFO';

export interface Finding {
  phase: string;
  id: string;
  verdict: Verdict;
  detail: string;
  at: string;
}

export class ValidationReport {
  readonly findings: Finding[] = [];
  readonly observations: Record<string, unknown> = {};
  #phase = 'preflight';
  #sink: (line: string) => void;

  constructor(sink: (line: string) => void = () => undefined) {
    this.#sink = sink;
  }

  phase(name: string): void {
    this.#phase = name;
    this.#sink(`\n=== ${name}`);
  }

  record(verdict: Verdict, id: string, detail = ''): boolean {
    const finding = { phase: this.#phase, id, verdict, detail, at: new Date().toISOString() };
    this.findings.push(finding);
    this.#sink(`${verdict.padEnd(4)} ${id}${detail ? ` — ${detail}` : ''}`);
    return verdict !== 'FAIL';
  }

  pass(id: string, detail = ''): true {
    this.record('PASS', id, detail);
    return true;
  }

  fail(id: string, detail = ''): false {
    this.record('FAIL', id, detail);
    return false;
  }

  /** PASS when there are no violations, otherwise one FAIL listing them. */
  expectNone(id: string, violations: readonly string[], passDetail = ''): boolean {
    return violations.length === 0 ? this.pass(id, passDetail) : this.fail(id, violations.join('; '));
  }

  check(id: string, ok: boolean, detail = ''): boolean {
    return ok ? this.pass(id, detail) : this.fail(id, detail);
  }

  observe(key: string, value: unknown): void {
    this.observations[key] = value;
  }

  get failed(): Finding[] {
    return this.findings.filter((f) => f.verdict === 'FAIL');
  }

  get passed(): boolean {
    return this.failed.length === 0 && this.findings.some((f) => f.verdict === 'PASS');
  }
}
