/**
 * PLATFORM-003 — the generic verification engine.
 *
 * Story test requirements 16–26: Pod checks still work, and Deployment,
 * Service, ConfigMap, Secret, Job, CronJob, probe and resource checks work
 * too — plus the troubleshooting lab failing while broken and passing once
 * repaired.
 *
 * Requirements 27–29 (cross-session isolation) are at the bottom.
 *
 * Every check here runs through the real registry against the shared in-memory
 * Kubernetes fake. What the fake cannot prove — that the API server actually
 * enforces anything — is asserted against real kind in the orchestrator's
 * integration suite instead.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LabRegistry,
  type ConfigReference,
  type LoadedLabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import {
  FakeDockerDaemon,
  FakeKubernetes,
  cronJobSnapshot,
  deploymentSnapshot,
  jobSnapshot,
  podSnapshot,
} from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader, registeredRequirementTypes } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';

let registry: LabRegistry;
beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

/** Run one requirement against a fake cluster and return its result. */
async function check(k8s: FakeKubernetes, requirement: Requirement, namespace = NS) {
  return verifyRequirement(requirement, new VerifyReader(k8s, namespace));
}

/**
 * Run a whole shipped lab against a fake cluster.
 *
 * `verifyLab` picks its reader from the lab's own `environment.provider`, so a
 * Docker lab needs a Docker daemon supplied alongside the cluster. An empty
 * daemon is the honest default here: the point of these tests is that a lab does
 * not pass on state it was not given.
 */
function runLab(
  lab: LoadedLabDefinition,
  k8s: FakeKubernetes,
  namespace = NS,
  docker: FakeDockerDaemon = new FakeDockerDaemon(),
) {
  return verifyLab({ k8s, docker, lab, namespace });
}

const passed = (result: { status: string }) => result.status === 'pass';

// ------------------------------------------------------------------ 16. Pods

describe('verifier — Pod checks still work (test requirement 16)', () => {
  it('passes a correct Pod and fails a wrong image', async () => {
    const ok = new FakeKubernetes({ pods: { [NS]: [podSnapshot()] } });
    const wrong = new FakeKubernetes({
      pods: { [NS]: [podSnapshot({ containers: [{ name: 'nginx', image: 'nginx:1.25', ready: true, restartCount: 0, state: 'running' }] })] },
    });

    const lab = registry.get('K8S-001');
    expect((await runLab(lab, ok)).passed).toBe(true);
    expect((await runLab(lab, wrong)).passed).toBe(false);
  });

  it('checks any Pod phase, not only Running', async () => {
    const k8s = new FakeKubernetes({ pods: { [NS]: [podSnapshot({ phase: 'Succeeded' })] } });

    expect(passed(await check(k8s, { type: 'pod_phase', name: 'nginx', phase: 'Succeeded' }))).toBe(true);
    const wrong = await check(k8s, { type: 'pod_phase', name: 'nginx', phase: 'Running' });
    expect(passed(wrong)).toBe(false);
    expect(wrong.detail).toContain("Pod phase is 'Succeeded'");
  });
});

// ---------------------------------------------------------- 17. Deployments

describe('verifier — Deployment checks (test requirement 17)', () => {
  const k8s = () => new FakeKubernetes({ deployments: { [NS]: [deploymentSnapshot()] } });

  it('checks existence, image, replicas and availability', async () => {
    expect(passed(await check(k8s(), { type: 'deployment_exists', name: 'frontend' }))).toBe(true);
    expect(passed(await check(k8s(), { type: 'deployment_image', name: 'frontend', image: 'nginx:stable' }))).toBe(true);
    expect(passed(await check(k8s(), { type: 'deployment_replicas', name: 'frontend', replicas: 3 }))).toBe(true);
    expect(passed(await check(k8s(), { type: 'deployment_available', name: 'frontend', min_available: 3 }))).toBe(true);
    expect(passed(await check(k8s(), { type: 'deployment_rollout_complete', name: 'frontend' }))).toBe(true);
  });

  it('reports the observed replica count when it is wrong', async () => {
    const result = await check(k8s(), { type: 'deployment_replicas', name: 'frontend', replicas: 5 });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain('currently requests 3');
  });

  it('distinguishes "desired" from "available"', async () => {
    // Three requested, two actually up — the distinction K8S-002 turns on.
    const partial = new FakeKubernetes({
      deployments: { [NS]: [deploymentSnapshot({ availableReplicas: 2, readyReplicas: 2 })] },
    });

    expect(passed(await check(partial, { type: 'deployment_replicas', name: 'frontend', replicas: 3 }))).toBe(true);
    const availability = await check(partial, { type: 'deployment_available', name: 'frontend', min_available: 3 });
    expect(passed(availability)).toBe(false);
    expect(availability.detail).toContain('2 of 3');
  });

  it('checks the Deployment selector', async () => {
    expect(passed(await check(k8s(), { type: 'deployment_selector', name: 'frontend', selector: { app: 'frontend' } }))).toBe(true);
    const wrong = await check(k8s(), { type: 'deployment_selector', name: 'frontend', selector: { app: 'other' } });
    expect(passed(wrong)).toBe(false);
  });

  it('runs the shipped K8S-002 lab end to end', async () => {
    const lab = registry.get('K8S-002');

    expect((await runLab(lab, k8s())).passed).toBe(true);
    const empty = await runLab(lab, new FakeKubernetes());
    expect(empty.passed).toBe(false);
    expect(empty.checks.every((c) => c.status === 'fail')).toBe(true);
  });
});

// ------------------------------------------------------------- 18. Services

describe('verifier — Service checks (test requirement 18)', () => {
  const service = {
    name: 'accounts',
    namespace: NS,
    type: 'ClusterIP',
    selector: { app: 'accounts' },
    ports: [{ port: 80, targetPort: 80, protocol: 'TCP' }],
  };
  const ready = () =>
    new FakeKubernetes({
      services: { [NS]: [service] },
      pods: { [NS]: [podSnapshot({ name: 'a' }), podSnapshot({ name: 'b' })] },
    });

  it('checks type, selector, ports and endpoints', async () => {
    expect(passed(await check(ready(), { type: 'service_exists', name: 'accounts' }))).toBe(true);
    expect(passed(await check(ready(), { type: 'service_type', name: 'accounts', expected: 'ClusterIP' }))).toBe(true);
    expect(passed(await check(ready(), { type: 'service_selector', name: 'accounts', selector: { app: 'accounts' } }))).toBe(true);
    expect(passed(await check(ready(), { type: 'service_port', name: 'accounts', port: 80, target_port: 80 }))).toBe(true);
    expect(passed(await check(ready(), { type: 'service_endpoints', name: 'accounts', min_ready: 2 }))).toBe(true);
  });

  it('fails a Service whose selector matches nothing', async () => {
    // A Service with a bad selector is created happily and silently drops
    // traffic — the fault K8S-003 and K8S-010 both teach.
    const orphaned = new FakeKubernetes({
      services: { [NS]: [{ ...service, selector: { app: 'wrong' } }] },
      pods: { [NS]: [] },
    });

    expect(passed(await check(orphaned, { type: 'service_exists', name: 'accounts' }))).toBe(true);
    const endpoints = await check(orphaned, { type: 'service_endpoints', name: 'accounts', min_ready: 2 });
    expect(passed(endpoints)).toBe(false);
  });

  it('runs the shipped K8S-003 lab end to end', async () => {
    expect((await runLab(registry.get('K8S-003'), ready())).passed).toBe(true);
  });
});

// ----------------------------------------------------------- 19. ConfigMaps

describe('verifier — ConfigMap checks (test requirement 19)', () => {
  const withConfig = (configRefs: ConfigReference[] = [{ source: 'configmap', name: 'statements-config', via: 'envFrom' }]) =>
    new FakeKubernetes({
      configMaps: {
        [NS]: [{ name: 'statements-config', namespace: NS, data: { STATEMENT_FORMAT: 'pdf', RETENTION_DAYS: '90' } }],
      },
      deployments: {
        [NS]: [deploymentSnapshot({ name: 'statements', desiredReplicas: 1, selector: { app: 'statements' }, configRefs })],
      },
    });

  it('checks key presence and value', async () => {
    expect(passed(await check(withConfig(), { type: 'configmap_exists', name: 'statements-config' }))).toBe(true);
    expect(passed(await check(withConfig(), { type: 'configmap_key', name: 'statements-config', key: 'STATEMENT_FORMAT', value: 'pdf' }))).toBe(true);

    const wrong = await check(withConfig(), { type: 'configmap_key', name: 'statements-config', key: 'STATEMENT_FORMAT', value: 'csv' });
    expect(passed(wrong)).toBe(false);
    expect(wrong.detail).toContain("expected 'csv'");
  });

  it('accepts any documented way of consuming a ConfigMap', async () => {
    for (const via of ['envFrom', 'env', 'volume'] as const) {
      const k8s = withConfig([{ source: 'configmap', name: 'statements-config', via, key: via === 'envFrom' ? undefined : 'STATEMENT_FORMAT' }]);
      expect(
        passed(await check(k8s, { type: 'deployment_uses_configmap', name: 'statements', configmap: 'statements-config' })),
        `via ${via}`,
      ).toBe(true);
    }
  });

  it('fails when the Deployment references no ConfigMap at all', async () => {
    const result = await check(withConfig([]), {
      type: 'deployment_uses_configmap',
      name: 'statements',
      configmap: 'statements-config',
    });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain('does not reference any ConfigMap');
  });

  it('treats a whole-object reference as covering every key', async () => {
    // `envFrom` brings in every key, so a key-specific requirement is satisfied.
    const k8s = withConfig([{ source: 'configmap', name: 'statements-config', via: 'envFrom' }]);

    expect(
      passed(await check(k8s, { type: 'deployment_uses_configmap', name: 'statements', configmap: 'statements-config', key: 'RETENTION_DAYS' })),
    ).toBe(true);
  });

  it('runs the shipped K8S-004 lab end to end', async () => {
    expect((await runLab(registry.get('K8S-004'), withConfig())).passed).toBe(true);
  });
});

// -------------------------------------------------------------- 20. Secrets

describe('verifier — Secret checks (test requirement 20)', () => {
  const withSecret = (keys = ['api-token']) =>
    new FakeKubernetes({
      secrets: { [NS]: [{ name: 'payments-api', namespace: NS, type: 'Opaque', keys }] },
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'payments',
            desiredReplicas: 1,
            selector: { app: 'payments' },
            configRefs: [{ source: 'secret', name: 'payments-api', key: 'api-token', via: 'env' }],
          }),
        ],
      },
    });

  it('checks key presence without ever reading a value', async () => {
    expect(passed(await check(withSecret(), { type: 'secret_exists', name: 'payments-api' }))).toBe(true);
    expect(passed(await check(withSecret(), { type: 'secret_key', name: 'payments-api', key: 'api-token' }))).toBe(true);

    const missing = await check(withSecret(['other']), { type: 'secret_key', name: 'payments-api', key: 'api-token' });
    expect(passed(missing)).toBe(false);
    expect(missing.detail).toContain("no key 'api-token'");
  });

  it('has no requirement type that can compare a Secret value', () => {
    // The schema for `secret_key` deliberately has no `value` field, so no lab
    // can be written that would require the verifier to hold a credential.
    expect(registeredRequirementTypes()).toContain('secret_key');
    expect(registeredRequirementTypes()).not.toContain('secret_value');
  });

  it('checks that a Deployment consumes the Secret', async () => {
    expect(
      passed(await check(withSecret(), { type: 'deployment_uses_secret', name: 'payments', secret: 'payments-api', key: 'api-token' })),
    ).toBe(true);
  });

  it('runs the shipped K8S-005 lab end to end', async () => {
    expect((await runLab(registry.get('K8S-005'), withSecret())).passed).toBe(true);
  });
});

// ----------------------------------------------------------------- 21. Jobs

describe('verifier — Job checks (test requirement 21)', () => {
  it('passes a completed Job', async () => {
    const k8s = new FakeKubernetes({ jobs: { [NS]: [jobSnapshot()] } });

    expect(passed(await check(k8s, { type: 'job_exists', name: 'ledger-migration' }))).toBe(true);
    expect(passed(await check(k8s, { type: 'job_completed', name: 'ledger-migration' }))).toBe(true);
  });

  it('fails a Job that is still running', async () => {
    const running = new FakeKubernetes({
      jobs: { [NS]: [jobSnapshot({ complete: false, succeeded: 0, active: 1 })] },
    });
    const result = await check(running, { type: 'job_completed', name: 'ledger-migration' });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain('still running');
  });

  it('fails a Job that exhausted its backoff limit, naming the reason', async () => {
    const failed = new FakeKubernetes({
      jobs: {
        [NS]: [
          jobSnapshot({
            complete: false,
            succeeded: 0,
            failed: 3,
            failedCondition: true,
            failureReason: 'BackoffLimitExceeded',
          }),
        ],
      },
    });
    const result = await check(failed, { type: 'job_completed', name: 'ledger-migration' });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain('BackoffLimitExceeded');
  });

  it('runs the shipped K8S-006 lab end to end', async () => {
    const done = new FakeKubernetes({ jobs: { [NS]: [jobSnapshot()] } });
    expect((await runLab(registry.get('K8S-006'), done)).passed).toBe(true);
    expect((await runLab(registry.get('K8S-006'), new FakeKubernetes())).passed).toBe(false);
  });
});

// ------------------------------------------------------------- 22. CronJobs

describe('verifier — CronJob checks (test requirement 22)', () => {
  const k8s = (overrides = {}) =>
    new FakeKubernetes({ cronJobs: { [NS]: [cronJobSnapshot(overrides)] } });

  it('checks the schedule and the suspend flag', async () => {
    expect(passed(await check(k8s(), { type: 'cronjob_exists', name: 'reconciliation' }))).toBe(true);
    expect(passed(await check(k8s(), { type: 'cronjob_schedule', name: 'reconciliation', schedule: '*/5 * * * *' }))).toBe(true);
    expect(passed(await check(k8s(), { type: 'cronjob_suspended', name: 'reconciliation', expected: false }))).toBe(true);
  });

  it('ignores whitespace differences in a schedule', async () => {
    const spaced = k8s({ schedule: '*/5  *   * * *' });
    expect(passed(await check(spaced, { type: 'cronjob_schedule', name: 'reconciliation', schedule: '*/5 * * * *' }))).toBe(true);
  });

  it('fails a wrong schedule and reports what was found', async () => {
    const hourly = k8s({ schedule: '0 * * * *' });
    const result = await check(hourly, { type: 'cronjob_schedule', name: 'reconciliation', schedule: '*/5 * * * *' });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain("Schedule is '0 * * * *'");
  });

  it('fails a suspended CronJob, explaining that it will never run', async () => {
    const result = await check(k8s({ suspend: true }), { type: 'cronjob_suspended', name: 'reconciliation', expected: false });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain('never run');
  });

  it('runs the shipped K8S-007 lab end to end', async () => {
    expect((await runLab(registry.get('K8S-007'), k8s())).passed).toBe(true);
    expect((await runLab(registry.get('K8S-007'), k8s({ suspend: true }))).passed).toBe(false);
  });
});

// --------------------------------------------------------------- 23. Probes

describe('verifier — probe checks (test requirement 23)', () => {
  const withProbe = (probes: unknown[]) =>
    new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'notifications',
            desiredReplicas: 2,
            selector: { app: 'notifications' },
            containers: [
              {
                name: 'notifications',
                image: 'nginx:stable',
                ready: true,
                restartCount: 0,
                state: 'running',
                probes: probes as never,
              },
            ],
          }),
        ],
      },
      // K8S-008's setup ships the Service alongside the Deployment, and the
      // lab checks that both replicas end up behind it.
      services: {
        [NS]: [
          {
            name: 'notifications',
            namespace: NS,
            type: 'ClusterIP',
            selector: { app: 'notifications' },
            ports: [{ port: 80, targetPort: 80, protocol: 'TCP' }],
          },
        ],
      },
      pods: { [NS]: [podSnapshot({ name: 'a' }), podSnapshot({ name: 'b' })] },
    });

  const READINESS = { kind: 'readiness', handler: 'httpGet', path: '/', port: 80 };

  it('passes a matching readiness probe', async () => {
    const k8s = withProbe([READINESS]);

    expect(
      passed(await check(k8s, { type: 'deployment_probe', name: 'notifications', container: 'notifications', probe: 'readiness', handler: 'httpGet', path: '/', port: 80 })),
    ).toBe(true);
  });

  it('fails when no probe is configured at all', async () => {
    const result = await check(withProbe([]), {
      type: 'deployment_probe',
      name: 'notifications',
      container: 'notifications',
      probe: 'readiness',
    });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain('defines no probes');
  });

  it('fails when only a different probe kind is configured', async () => {
    const livenessOnly = withProbe([{ kind: 'liveness', handler: 'httpGet', path: '/', port: 80 }]);
    const result = await check(livenessOnly, {
      type: 'deployment_probe',
      name: 'notifications',
      container: 'notifications',
      probe: 'readiness',
    });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain('no readiness probe');
  });

  it('reports a probe pointing at the wrong path or port', async () => {
    const k8s = withProbe([{ kind: 'readiness', handler: 'httpGet', path: '/healthz', port: 8080 }]);
    const result = await check(k8s, {
      type: 'deployment_probe',
      name: 'notifications',
      container: 'notifications',
      probe: 'readiness',
      path: '/',
      port: 80,
    });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain("probe path is '/healthz'");
    expect(result.detail).toContain("probe port is '8080'");
  });

  it('accepts a named port as well as a numeric one', async () => {
    const named = withProbe([{ kind: 'readiness', handler: 'httpGet', path: '/', port: 'http' }]);

    expect(
      passed(await check(named, { type: 'deployment_probe', name: 'notifications', container: 'notifications', probe: 'readiness', port: 'http' })),
    ).toBe(true);
  });

  it('runs the shipped K8S-008 lab end to end', async () => {
    expect((await runLab(registry.get('K8S-008'), withProbe([READINESS]))).passed).toBe(true);
    expect((await runLab(registry.get('K8S-008'), withProbe([]))).passed).toBe(false);
  });
});

// ------------------------------------------------------------ 24. Resources

describe('verifier — resource request/limit checks (test requirement 24)', () => {
  const withResources = (resources?: unknown) =>
    new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'reporting',
            desiredReplicas: 1,
            selector: { app: 'reporting' },
            containers: [
              {
                name: 'reporting',
                image: 'nginx:stable',
                ready: true,
                restartCount: 0,
                state: 'running',
                ...(resources ? { resources: resources as never } : {}),
              },
            ],
          }),
        ],
      },
    });

  const DECLARED = {
    requests: { cpu: '100m', memory: '128Mi' },
    limits: { cpu: '250m', memory: '256Mi' },
  };

  it('passes when the template declares the required requests and limits', async () => {
    const k8s = withResources(DECLARED);

    expect(passed(await check(k8s, { type: 'deployment_resources', name: 'reporting', container: 'reporting', requests: { cpu: '100m', memory: '128Mi' } }))).toBe(true);
    expect(passed(await check(k8s, { type: 'deployment_resources', name: 'reporting', container: 'reporting', limits: { cpu: '250m', memory: '256Mi' } }))).toBe(true);
  });

  it('fails when the template declares nothing', async () => {
    // The namespace LimitRange defaults a *Pod's* resources, so this is exactly
    // why K8S-009 reads the Deployment template rather than a running Pod.
    const result = await check(withResources(), {
      type: 'deployment_resources',
      name: 'reporting',
      container: 'reporting',
      requests: { cpu: '100m', memory: '128Mi' },
    });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain('declares no resource requests');
  });

  it('compares quantities by value, not by spelling', async () => {
    // 0.1 CPU and 100m are the same quantity.
    const equivalent = withResources({ requests: { cpu: '0.1', memory: '128Mi' } });

    expect(
      passed(await check(equivalent, { type: 'deployment_resources', name: 'reporting', container: 'reporting', requests: { cpu: '100m', memory: '128Mi' } })),
    ).toBe(true);
  });

  it('reports the observed quantity when it is wrong', async () => {
    const tooSmall = withResources({ requests: { cpu: '50m', memory: '64Mi' } });
    const result = await check(tooSmall, {
      type: 'deployment_resources',
      name: 'reporting',
      container: 'reporting',
      requests: { cpu: '100m', memory: '128Mi' },
    });

    expect(passed(result)).toBe(false);
    expect(result.detail).toContain("requests.cpu is '50m'");
  });

  it('runs the shipped K8S-009 lab end to end', async () => {
    expect((await runLab(registry.get('K8S-009'), withResources(DECLARED))).passed).toBe(true);
    expect((await runLab(registry.get('K8S-009'), withResources())).passed).toBe(false);
  });
});

// ------------------------------------------------- 25/26. troubleshooting

/** The exact broken state K8S-010's setup manifest produces. */
function brokenLedger(namespace = NS): FakeKubernetes {
  return new FakeKubernetes({
    deployments: {
      [namespace]: [
        deploymentSnapshot({
          name: 'ledger-api',
          namespace,
          desiredReplicas: 2,
          availableReplicas: 0,
          readyReplicas: 0,
          updatedReplicas: 2,
          currentReplicas: 2,
          selector: { app: 'ledger-api' },
          podLabels: { app: 'ledger-api' },
          containers: [
            { name: 'ledger-api', image: 'nginx:stabel', ready: false, restartCount: 0, state: 'waiting', reason: 'ImagePullBackOff' },
          ],
          conditions: [{ type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' }],
        }),
      ],
    },
    services: {
      [namespace]: [
        { name: 'ledger-api', namespace, type: 'ClusterIP', selector: { app: 'ledger' }, ports: [{ port: 80, targetPort: 80, protocol: 'TCP' }] },
      ],
    },
    pods: { [namespace]: [] },
  });
}

/** The same workload once the student has repaired both faults. */
function repairedLedger(namespace = NS): FakeKubernetes {
  return new FakeKubernetes({
    deployments: {
      [namespace]: [
        deploymentSnapshot({
          name: 'ledger-api',
          namespace,
          desiredReplicas: 2,
          selector: { app: 'ledger-api' },
          podLabels: { app: 'ledger-api' },
          containers: [{ name: 'ledger-api', image: 'nginx:stable', ready: true, restartCount: 0, state: 'running' }],
        }),
      ],
    },
    services: {
      [namespace]: [
        { name: 'ledger-api', namespace, type: 'ClusterIP', selector: { app: 'ledger-api' }, ports: [{ port: 80, targetPort: 80, protocol: 'TCP' }] },
      ],
    },
    pods: {
      [namespace]: [
        podSnapshot({ name: 'ledger-api-1', namespace, labels: { app: 'ledger-api' } }),
        podSnapshot({ name: 'ledger-api-2', namespace, labels: { app: 'ledger-api' } }),
      ],
    },
  });
}

describe('verifier — troubleshooting lab fails while broken (test requirement 25)', () => {
  it('fails, and names both faults through observed state', async () => {
    const result = await runLab(registry.get('K8S-010'), brokenLedger());

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');

    const byLabel = Object.fromEntries(result.checks.map((c) => [c.label, c]));
    expect(byLabel['Deployment ledger-api exists']?.status).toBe('pass');
    expect(byLabel['Deployment runs the correct application image']?.status).toBe('fail');
    expect(byLabel['Both replicas are available']?.status).toBe('fail');
    expect(byLabel['Service selects the ledger-api Pods']?.status).toBe('fail');
    expect(byLabel['Service has two ready endpoints behind it']?.status).toBe('fail');
  });

  it('describes what is wrong without printing the fix', async () => {
    const result = await runLab(registry.get('K8S-010'), brokenLedger());
    const detail = result.checks.map((c) => c.detail ?? '').join(' ');

    // Reporting the observed wrong value is the point; reporting the command
    // that repairs it would end the exercise.
    expect(detail).toContain('nginx:stabel');
    expect(detail).not.toMatch(/kubectl (set|edit|patch|apply)/i);
  });

  it('still fails when only one of the two faults is repaired', async () => {
    // Image fixed, selector still wrong.
    const halfFixed = repairedLedger();
    halfFixed.services.set(NS, [
      { name: 'ledger-api', namespace: NS, type: 'ClusterIP', selector: { app: 'ledger' }, ports: [{ port: 80, targetPort: 80, protocol: 'TCP' }] },
    ]);

    const result = await runLab(registry.get('K8S-010'), halfFixed);
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.label === 'Service selects the ledger-api Pods')?.status).toBe('fail');
  });
});

describe('verifier — troubleshooting lab passes after repair (test requirement 26)', () => {
  it('passes once both faults are fixed', async () => {
    const result = await runLab(registry.get('K8S-010'), repairedLedger());

    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
  });
});

// ------------------------------------------------- 27–29. session isolation

describe('verifier — isolation (test requirements 27, 29)', () => {
  it('never passes using another session\'s resources', async () => {
    // Session B did the work; session A did not.
    const k8s = repairedLedger(NS_B);

    expect((await runLab(registry.get('K8S-010'), k8s, NS_B)).passed).toBe(true);
    expect((await runLab(registry.get('K8S-010'), k8s, NS)).passed).toBe(false);
  });

  it('reads only the namespace or sandbox it was given, for every shipped lab', async () => {
    // A single fake holding a correct answer in B must not satisfy A for any
    // lab in the catalog. For Docker labs the reader is bound to one daemon
    // rather than one namespace, and the empty daemon supplied here is session
    // A's — session B's containers are simply not in it to be found.
    for (const lab of registry.all()) {
      const k8s = new FakeKubernetes({
        pods: { [NS_B]: [podSnapshot()] },
        deployments: { [NS_B]: [deploymentSnapshot()] },
        jobs: { [NS_B]: [jobSnapshot()] },
        cronJobs: { [NS_B]: [cronJobSnapshot()] },
      });
      const result = await runLab(lab, k8s, NS);

      expect(result.namespace).toBe(NS);
      expect(result.passed, `${lab.id} must not pass on another namespace's state`).toBe(false);
    }
  });

  it('exposes no way for a requirement to name a namespace', () => {
    // Isolation here is structural: the reader is constructed with one
    // namespace and no handler is ever given the chance to choose another.
    for (const lab of registry.all()) {
      for (const requirement of lab.requirements) {
        expect(Object.keys(requirement)).not.toContain('namespace');
      }
    }
  });
});

// ------------------------------------------------------------- completeness

describe('verifier — registry completeness', () => {
  it('has a handler for every requirement type any shipped lab uses', async () => {
    const registered = new Set(registeredRequirementTypes());

    for (const lab of registry.all()) {
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
        expect(registered.has(requirement.type), `${lab.id} uses ${requirement.type}`).toBe(true);
      }
    }
  });

  it('covers every requirement type in the vocabulary', () => {
    // The registry is a mapped type over RequirementType, so a missing handler
    // is a compile error; this asserts the runtime object agrees.
    expect(registeredRequirementTypes().length).toBeGreaterThanOrEqual(80);
  });
});
