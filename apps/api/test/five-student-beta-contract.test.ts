/**
 * BETA-P0-019 — the five-student private-beta contract, checked hermetically.
 *
 * The real validation (`make beta-validate`, scripts/beta-validation/five-student.ts)
 * needs a running stack, kind and PostgreSQL, so it is a release gate and not
 * part of CI. This suite runs in ordinary `npm test` and pins what that gate
 * decides with — the synthetic students, the lab plan, the target refusals and
 * the concurrent-start verdict — against fabricated observations and the real
 * catalog. It starts nothing and reaches no host process.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { issueSessionToken, verifySessionToken, type LabRegistry } from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import {
  BETA_CONTRACT,
  EXPECTED_WORKLOAD_ALERTS,
  LAB_PLAN,
  PROVOKED_ALERT_GUARDS,
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
  parsePromtool,
  provokedAlertGuards,
  redact,
  targetRefusals,
  unexpectedAlerts,
  type StartObservation,
  type TargetFacts,
} from '@jumptotech/test-support/beta-contract';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
}, 60_000);

describe('the private-beta contract the gate enforces', () => {
  it('matches the beta capacity policy the runbook and compose defaults state', () => {
    expect(BETA_CONTRACT).toEqual({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });
    expect(read('docs/runbooks/private-beta-operations.md')).toContain('`MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`');
  });

  it('uses five distinct synthetic students and a sixth who is none of them', () => {
    expect(new Set(SYNTHETIC_STUDENTS).size).toBe(5);
    expect(SYNTHETIC_STUDENTS).not.toContain(SIXTH_STUDENT);
    for (const handle of [...SYNTHETIC_STUDENTS, SIXTH_STUDENT]) {
      // The development resolver's handle shape, and nothing that looks like a person.
      expect(handle).toMatch(/^beta-student-\d$/);
    }
  });

  it('plans one lab per student across distinct runtime providers, each real in the catalog', () => {
    expect(LAB_PLAN.map((p) => p.student)).toEqual([...SYNTHETIC_STUDENTS]);
    expect(new Set(LAB_PLAN.map((p) => p.provider)).size).toBe(5);
    for (const plan of LAB_PLAN) {
      const def = registry.get(plan.labId);
      expect(def.environment.provider, plan.labId).toBe(plan.provider);
      expect(plan.solution.length).toBeGreaterThan(0);
    }
  });

  it('never plans a lab that needs real AWS credentials: the AWS lab is the simulated Linux one', () => {
    expect(LAB_PLAN.some((p) => p.provider === 'aws')).toBe(false);
    const aws = registry.get(REUSE_PLAN.labId);
    expect(aws.track).toBe('aws');
    expect(aws.environment.provider).toBe('linux');
    expect(aws.requirements.map((r) => r.label)).toContain(REUSE_PLAN.satisfiedCheckLabel);
    expect(read('labs/aws/track.yaml')).toMatch(/SIMULATED/);
  });

  it('races on cheap Linux-provider labs', () => {
    for (const id of [RACE_LAB, RACE_SECOND_LAB]) expect(registry.get(id).environment.provider).toBe('linux');
  });
});

describe('target refusals', () => {
  const safe: TargetFacts = {
    apiUrl: 'http://127.0.0.1:4000',
    terminalUrl: 'ws://127.0.0.1:4001',
    metricsUrl: 'http://127.0.0.1:9400',
    kubeServer: 'https://127.0.0.1:16443',
    kubeContext: 'kind-jumptotech-labs',
    runtimeOwner: 'beta-gate',
    health: { active: 0, maxActive: 5 },
    perStudentLimit: 1,
    developerAuthStatus: 200,
    preexistingOwnedResources: 0,
  };

  it('accepts an idle loopback development stack at 5/1', () => {
    expect(targetRefusals(safe)).toEqual([]);
  });

  it.each<[string, Partial<TargetFacts>, RegExp]>([
    ['a public API', { apiUrl: 'https://labs.example.com' }, /API URL is not a loopback/],
    ['a remote terminal', { terminalUrl: 'wss://labs.example.com' }, /terminal URL/],
    ['a remote metrics listener', { metricsUrl: 'http://10.0.0.5:9400' }, /metrics URL/],
    ['an EKS kubeconfig', { kubeServer: 'https://ABC.gr7.eu-west-1.eks.amazonaws.com', kubeContext: 'arn:aws:eks:eu-west-1:1:cluster/prod' }, /kind/],
    ['production OIDC auth', { developerAuthStatus: 401 }, /production \(OIDC\) targets are refused/],
    ['a stack with live sessions', { health: { active: 2, maxActive: 5 } }, /already has 2 active/],
    ['a different global limit', { health: { active: 0, maxActive: 20 } }, /MAX_ACTIVE_SESSIONS is 20/],
    ['a different per-student limit', { perStudentLimit: 3 }, /MAX_ACTIVE_SESSIONS_PER_STUDENT is 3/],
    ['an unreadable per-student limit', { perStudentLimit: undefined }, /unreadable/],
    ['leftover owned sandboxes', { preexistingOwnedResources: 4 }, /already carry this runtime owner/],
    ['an invalid owner', { runtimeOwner: 'no spaces allowed' }, /not a valid RUNTIME_OWNER_ID/],
  ])('refuses %s', (_name, change, reason) => {
    const refusals = targetRefusals({ ...safe, ...change });
    expect(refusals.join('\n')).toMatch(reason);
  });
});

describe('concurrent start verdict', () => {
  const five = (overrides: Partial<StartObservation>[] = []): StartObservation[] =>
    SYNTHETIC_STUDENTS.map((student, i) => ({
      student,
      status: 200,
      sessionId: `sess-${String(i).padStart(16, '0')}`,
      sandboxRef: `jtt-lab-${String(i).padStart(12, '0')}`,
      ownerSubject: student,
      ...overrides[i],
    }));

  it('passes five distinct admissions', () => {
    expect(concurrentStartViolations(five(), { admitted: 5, capacityRejections: 0, studentLimitRejections: 0 })).toEqual([]);
  });

  it('catches a capacity race that admits a sixth', () => {
    const six = [...five(), { student: SIXTH_STUDENT, status: 200, sessionId: 'sess-00000000000000ff', sandboxRef: 'jtt-lab-0000000000ff', ownerSubject: SIXTH_STUDENT }];
    expect(concurrentStartViolations(six, { admitted: 5, capacityRejections: 1, studentLimitRejections: 0 }).join('\n')).toMatch(
      /6 start\(s\) admitted[\s\S]*capacity race: 6 sessions admitted past MAX_ACTIVE_SESSIONS=5[\s\S]*0 LAB_CAPACITY_REACHED/,
    );
  });

  it('catches duplicate ownership, duplicate runtime identifiers and a misattributed owner', () => {
    const results = five([{}, { student: 'beta-student-1' }, { sandboxRef: 'jtt-lab-000000000000' }, { ownerSubject: 'beta-student-9' }]);
    const text = concurrentStartViolations(results, { admitted: 5, capacityRejections: 0, studentLimitRejections: 0 }).join('\n');
    expect(text).toMatch(/duplicate ownership: beta-student-1 was admitted 2 time/);
    expect(text).toMatch(/duplicate runtime identifier jtt-lab-000000000000/);
    expect(text).toMatch(/beta-student-4: session persisted as owned by 'beta-student-9'/);
  });

  it('catches an unexpected 429 for a student who holds nothing, and any other status', () => {
    const results = five([{}, { status: 429, code: 'STUDENT_SESSION_LIMIT_REACHED', sessionId: undefined, sandboxRef: undefined }, { status: 500, code: 'INTERNAL', sessionId: undefined, sandboxRef: undefined }]);
    const text = concurrentStartViolations(results, { admitted: 5, capacityRejections: 0, studentLimitRejections: 0 }).join('\n');
    expect(text).toMatch(/unexpected 429 for beta-student-2, who holds no other session/);
    expect(text).toMatch(/beta-student-3: unexpected HTTP 500 INTERNAL/);
  });

  it('accepts the expected refusals of a full platform', () => {
    const results: StartObservation[] = [
      { student: SIXTH_STUDENT, status: 503, code: 'LAB_CAPACITY_REACHED' },
      { student: 'beta-student-2', status: 429, code: 'STUDENT_SESSION_LIMIT_REACHED' },
    ];
    expect(concurrentStartViolations(results, { admitted: 0, capacityRejections: 1, studentLimitRejections: 1, alreadyHolding: [...SYNTHETIC_STUDENTS] })).toEqual([]);
    // …and a student already holding a session who is admitted again is a violation.
    const admittedAgain: StartObservation[] = [{ student: 'beta-student-2', status: 200, sessionId: 'sess-00000000000000aa', sandboxRef: 'jtt-lab-0000000000aa' }];
    expect(concurrentStartViolations(admittedAgain, { admitted: 1, capacityRejections: 0, studentLimitRejections: 0, alreadyHolding: ['beta-student-2'] }).join('\n')).toMatch(/while already holding a session/);
  });
});

describe('observability and output helpers', () => {
  it('reads Prometheus text by name and label subset', () => {
    const text = [
      '# HELP jtt_sessions_active x',
      'jtt_sessions_active{provider="linux",status="ACTIVE"} 3',
      'jtt_sessions_active{provider="kubernetes",status="ACTIVE"} 1',
      'jtt_sessions_active{provider="linux",status="ENDING"} 1',
      'jtt_sessions_active_total 99',
    ].join('\n');
    expect(metricSum(text, 'jtt_sessions_active')).toBe(5);
    expect(metricSum(text, 'jtt_sessions_active', { status: 'ACTIVE' })).toBe(4);
    expect(metricSum(text, 'jtt_sessions_capacity_limit')).toBeUndefined();
  });

  it('reads promtool output for aggregates, labelled series and label-less recording rules', () => {
    // Captured from promtool 2.54 against the beta stack.
    expect(parsePromtool('{} => 5 @[1789437003.738]')).toEqual([{ labels: '{}', value: 5 }]);
    expect(parsePromtool('jtt:sessions_headroom:count => 0 @[1789438322.863]')).toEqual([{ labels: 'jtt:sessions_headroom:count', value: 0 }]);
    expect(
      parsePromtool('ALERTS{alertname="X", alertstate="firing"} => 1 @[1]\nALERTS{alertname="Y", alertstate="firing"} => 1 @[1]').map((s) => s.value),
    ).toEqual([1, 1]);
    expect(parsePromtool('')).toEqual([]);
  });

  it('allows only the alerts the workload is expected to raise, and never a lifecycle or isolation alert', () => {
    const output = [
      'ALERTS{alertname="CapacityExhausted", alertstate="firing"} => 1 @[1]',
      'ALERTS{alertname="BackupNeverSucceeded", alertstate="firing"} => 1 @[1]',
      'ALERTS{alertname="SessionTeardownStuck", alertstate="firing"} => 1 @[1]',
    ].join('\n');
    expect(alertNames(output)).toEqual(['CapacityExhausted', 'BackupNeverSucceeded', 'SessionTeardownStuck']);
    // Backup was already firing before the run: environment, not workload.
    expect(unexpectedAlerts(alertNames(output), ['BackupNeverSucceeded'])).toEqual(['SessionTeardownStuck']);
    // A lifecycle alert is never excused by having fired before.
    expect(unexpectedAlerts(['ReaperStalled'], ['ReaperStalled'])).toEqual(['ReaperStalled']);
    for (const never of ['ScopeDenialDetected', 'SandboxLeakSuspected', 'NetworkIsolationNotAttested', 'SessionResetStuck', 'ProviderUnavailable']) {
      expect(unexpectedAlerts([never], [never]), never).toEqual([never]);
    }
    expect([...EXPECTED_WORKLOAD_ALERTS].sort()).toEqual(['CapacityExhausted', 'CapacityNearExhausted']);
  });

  it('excuses a provoked alert only through a guard that excludes the deliberate cause', () => {
    const firing = ['LabStartFailureRateElevated', 'SecurityEventBurst', 'TerminalConnectionFailures', 'ReaperStalled'];
    // Provoked alerts leave the unconditional list and are judged by their guards…
    expect(unexpectedAlerts(firing, [])).toEqual(['ReaperStalled']);
    const guards = provokedAlertGuards(firing, '30m');
    expect(guards.map((g) => g.name)).toEqual(['LabStartFailureRateElevated', 'SecurityEventBurst', 'TerminalConnectionFailures']);
    // …each of which counts every cause except the one the scenario creates.
    const byName = Object.fromEntries(guards.map((g) => [g.name, g.expr]));
    expect(byName.LabStartFailureRateElevated).toMatch(/outcome=~"provider_unavailable\|provision_failed\|unauthorized"\}\[30m\]/);
    expect(byName.LabStartFailureRateElevated).not.toMatch(/capacity_reached/);
    expect(byName.SecurityEventBurst).toMatch(/event!~"unowned_session_access\|dev_identity_in_use"/);
    expect(byName.TerminalConnectionFailures).toMatch(/outcome!~"established\|unauthorized\|no_credentials"/);
    expect(Object.keys(PROVOKED_ALERT_GUARDS).sort()).toEqual([
      'AuthzOwnershipDenialSpike',
      'LabStartFailureRateElevated',
      'LabStartsFailingHard',
      'SecurityEventBurst',
      'TerminalConnectionFailures',
    ]);
  });

  it('redacts secrets from everything it prints', () => {
    expect(redact('Bearer abcdef0123456789 and abcdef0123456789', ['abcdef0123456789'])).toBe('Bearer [REDACTED] and [REDACTED]');
  });

  it('forges a token for another session that the real verifier rejects', () => {
    const secret = 'unit-test-terminal-session-secret';
    const { token } = issueSessionToken({ sessionId: 'sess-aaaaaaaaaaaaaaaa', ownerUserId: 'u-a', labId: 'LINUX-001', namespace: 'jtt-lab-a', secret, ttlSeconds: 60 });
    const forged = forgeTokenForSession(token, 'sess-bbbbbbbbbbbbbbbb');
    expect(JSON.parse(Buffer.from(forged.split('.')[0]!, 'base64url').toString())).toMatchObject({ sid: 'sess-bbbbbbbbbbbbbbbb' });
    expect(() => verifySessionToken(forged, secret)).toThrow(/signature mismatch/);
    expect(verifySessionToken(token, secret).sid).toBe('sess-aaaaaaaaaaaaaaaa');
  });

  it('fails a report with any FAIL and passes only with at least one PASS', () => {
    const report = new ValidationReport();
    expect(report.passed).toBe(false);
    report.pass('a');
    expect(report.passed).toBe(true);
    report.expectNone('b', ['broken']);
    expect(report.passed).toBe(false);
  });
});

describe('the gate is runnable as documented, and not from CI', () => {
  it('is wired as `make beta-validate` → `npm run beta:validate`', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['beta:validate']).toBe('tsx scripts/beta-validation/five-student.ts');
    expect(pkg.scripts.test).not.toMatch(/beta/);
    expect(read('Makefile')).toMatch(/^beta-validate: ## /m);
    expect(read('docs/runbooks/five-student-beta-validation.md')).toContain('make beta-validate');
  });

  it('never runs in a GitHub workflow', () => {
    const dir = path.join(repoRoot, '.github/workflows');
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(path.join(dir, file), 'utf8'), file).not.toMatch(/beta-validate|beta:validate|five-student/);
    }
  });
});
