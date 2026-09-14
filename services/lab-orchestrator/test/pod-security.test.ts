/**
 * BETA-P0-016 — pod security for Kubernetes session namespaces, as data.
 *
 * Before this story no session namespace carried a Pod Security Admission
 * label, the kubelet ran Pods with no seccomp filter, and a student's
 * `kubectl apply` of a `privileged: true`, `hostPID`, `hostPath: /` Pod was
 * admitted. What the platform now asks for is pinned here: the labels, the
 * configuration rules, the ServiceAccount token defaults, the setup-manifest
 * guard, and the kind cluster setting.
 *
 * Whether the API server *enforces* any of it is a property of a live cluster,
 * proved in `pod-security-integration.test.ts`. A fake that "refused" a
 * privileged Pod would prove nothing.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  DEFAULT_POD_SECURITY,
  DEFAULT_SERVICE_ACCOUNT,
  DEFAULT_SESSION_POLICY,
  KindLabProvider,
  MANAGED_LABEL,
  SESSION_LABEL,
  assertPodSecurityConfig,
  defaultServiceAccountManifest,
  loadSetupManifests,
  podSecurityLabels,
  podSecurityViolations,
  podSpecOf,
  sessionGuardrailManifests,
  studentRbacManifests,
  type KubernetesManifestObject,
  type LabSessionContext,
  type LoadedLabDefinition,
  type PodSecurityConfig,
} from '../src/index.js';
import { FakeKubernetes, fakeExec } from './fakes.js';
import { REPO_ROOT, loadK8s001, sessionContext } from './helpers.js';
import { realCatalog } from './real-catalog.js';

const BASELINE_LABELS = {
  'pod-security.kubernetes.io/enforce': 'baseline',
  'pod-security.kubernetes.io/enforce-version': 'v1.34',
  'pod-security.kubernetes.io/warn': 'baseline',
  'pod-security.kubernetes.io/warn-version': 'v1.34',
  'pod-security.kubernetes.io/audit': 'restricted',
  'pod-security.kubernetes.io/audit-version': 'v1.34',
};

// ------------------------------------------------------------ configuration

describe('the Pod Security Admission policy a session namespace carries', () => {
  it('enforces and warns at baseline, audits at restricted, pinned to v1.34', () => {
    expect(DEFAULT_POD_SECURITY).toEqual({
      enforce: 'baseline',
      warn: 'baseline',
      audit: 'restricted',
      version: 'v1.34',
    });
    expect(DEFAULT_SESSION_POLICY.podSecurity).toEqual(DEFAULT_POD_SECURITY);
  });

  it('is written as the six standard namespace labels', () => {
    expect(podSecurityLabels(DEFAULT_POD_SECURITY)).toEqual(BASELINE_LABELS);
  });

  it('pins the same minor version the kind node image runs', () => {
    // Raising the kind image without raising the pin (or the reverse) is a
    // change to which Pods are admitted, and must be made on purpose.
    const cluster = parse(readFileSync(path.join(REPO_ROOT, 'infrastructure/kind/cluster.yaml'), 'utf8')) as {
      nodes: Array<{ image: string }>;
    };
    const minor = /:v(1\.\d+)\.\d+$/.exec(cluster.nodes[0]!.image)?.[1];
    expect(DEFAULT_POD_SECURITY.version).toBe(`v${minor}`);
  });

  it('never accepts privileged, in any mode', () => {
    for (const mode of ['enforce', 'warn', 'audit'] as const) {
      const config = { ...DEFAULT_POD_SECURITY, [mode]: 'privileged' } as unknown as PodSecurityConfig;
      expect(() => assertPodSecurityConfig(config, { production: false }), mode).toThrow(/never permitted/);
    }
  });

  it('refuses a warn or audit level weaker than the enforce level', () => {
    const strict: PodSecurityConfig = { enforce: 'restricted', warn: 'restricted', audit: 'restricted', version: 'v1.34' };
    expect(() => assertPodSecurityConfig(strict, { production: true })).not.toThrow();
    expect(() => assertPodSecurityConfig({ ...strict, warn: 'baseline' }, { production: false })).toThrow(/weaker/);
    expect(() => assertPodSecurityConfig({ ...strict, audit: 'baseline' }, { production: false })).toThrow(/weaker/);
  });

  it('accepts only v1.<minor> or latest as a version', () => {
    for (const version of ['v1.34', 'v1.0', 'v1.40', 'latest']) {
      expect(() => assertPodSecurityConfig({ ...DEFAULT_POD_SECURITY, version }, { production: false }), version).not.toThrow();
    }
    for (const version of ['1.34', 'v1.34.0', 'v2.0', 'v1.', 'LATEST', '']) {
      expect(() => assertPodSecurityConfig({ ...DEFAULT_POD_SECURITY, version }, { production: false }), version).toThrow();
    }
  });

  it('refuses latest in production, where a cluster upgrade would silently change admission', () => {
    const latest = { ...DEFAULT_POD_SECURITY, version: 'latest' };
    expect(() => assertPodSecurityConfig(latest, { production: false })).not.toThrow();
    expect(() => assertPodSecurityConfig(latest, { production: true })).toThrow(/production/);
    expect(() => assertPodSecurityConfig(DEFAULT_POD_SECURITY, { production: true })).not.toThrow();
  });

  it('fails closed when asked for labels from an invalid configuration', () => {
    const privileged = { ...DEFAULT_POD_SECURITY, enforce: 'privileged' } as unknown as PodSecurityConfig;
    expect(() => podSecurityLabels(privileged)).toThrow();
  });
});

// ----------------------------------------------- ServiceAccount token mounts

describe('ServiceAccount tokens are not mounted into Pods by default', () => {
  it('turns automounting off for the student ServiceAccount', () => {
    const student = studentRbacManifests(DEFAULT_SESSION_POLICY).find((m) => m.kind === 'ServiceAccount');
    expect(student?.metadata.name).toBe('student');
    expect(student?.automountServiceAccountToken).toBe(false);
  });

  it('turns automounting off for the namespace default ServiceAccount, and marks it managed', () => {
    const manifest = defaultServiceAccountManifest();
    expect(manifest.metadata.name).toBe(DEFAULT_SERVICE_ACCOUNT);
    expect(manifest.automountServiceAccountToken).toBe(false);
    // The label is what makes `jumptotech-protect-managed-resources` refuse a
    // student edit or delete that would restore the default.
    expect(manifest.metadata.labels?.[MANAGED_LABEL]).toBe('true');
  });

  it('applies both with every session, and never touches a lab-defined ServiceAccount', () => {
    const accounts = sessionGuardrailManifests(DEFAULT_SESSION_POLICY, ['rbac_authoring'])
      .filter((m) => m.kind === 'ServiceAccount')
      .map((m) => m.metadata.name);
    // K8S-012's `inventory-sync` needs its token and is not a platform object.
    expect(accounts.sort()).toEqual(['default', 'student']);
  });

  it('stamps no Namespace object among the guardrails — PSA is labels on the namespace itself', () => {
    const kinds = sessionGuardrailManifests(DEFAULT_SESSION_POLICY).map((m) => m.kind);
    expect(kinds).not.toContain('Namespace');
  });
});

// ------------------------------------------------- setup-manifest workloads

const container = (extra: Record<string, unknown> = {}) => ({ name: 'c', image: 'busybox:1.36', ...extra });
const pod = (spec: Record<string, unknown>): KubernetesManifestObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'probe' },
  spec,
});

const DANGEROUS: Array<[string, Record<string, unknown>, RegExp]> = [
  ['privileged', { containers: [container({ securityContext: { privileged: true } })] }, /container 'c': privileged is true/],
  ['hostPath', { volumes: [{ name: 'root', hostPath: { path: '/' } }], containers: [container()] }, /volume 'root' is a hostPath/],
  ['hostNetwork', { hostNetwork: true, containers: [container()] }, /hostNetwork is true/],
  ['hostPID', { hostPID: true, containers: [container()] }, /hostPID is true/],
  ['hostIPC', { hostIPC: true, containers: [container()] }, /hostIPC is true/],
  ['an added capability', { containers: [container({ securityContext: { capabilities: { add: ['SYS_ADMIN'] } } })] }, /adds capabilities SYS_ADMIN/],
  ['a default capability, added explicitly', { containers: [container({ securityContext: { capabilities: { add: ['CHOWN'] } } })] }, /adds capabilities CHOWN/],
  ['allowPrivilegeEscalation: true', { containers: [container({ securityContext: { allowPrivilegeEscalation: true } })] }, /allowPrivilegeEscalation is true/],
  ['a hostPort', { containers: [container({ ports: [{ containerPort: 80, hostPort: 8080 }] })] }, /hostPort 8080/],
  ['an unconfined pod seccomp profile', { securityContext: { seccompProfile: { type: 'Unconfined' } }, containers: [container()] }, /pod securityContext: seccompProfile is Unconfined/],
  ['an unconfined container seccomp profile', { containers: [container({ securityContext: { seccompProfile: { type: 'Unconfined' } } })] }, /container 'c': seccompProfile is Unconfined/],
  ['an unconfined AppArmor profile', { containers: [container({ securityContext: { appArmorProfile: { type: 'Unconfined' } } })] }, /appArmorProfile is Unconfined/],
  ['an unmasked /proc', { containers: [container({ securityContext: { procMount: 'Unmasked' } })] }, /procMount is Unmasked/],
  ['pod sysctls', { securityContext: { sysctls: [{ name: 'kernel.msgmax', value: '1' }] }, containers: [container()] }, /sets sysctls/],
  ['a host-process container', { containers: [container({ securityContext: { windowsOptions: { hostProcess: true } } })] }, /hostProcess is true/],
  ['a privileged init container', { initContainers: [container({ name: 'init', securityContext: { privileged: true } })], containers: [container()] }, /container 'init': privileged is true/],
  ['a privileged ephemeral container', { containers: [container()], ephemeralContainers: [container({ name: 'debug', securityContext: { privileged: true } })] }, /container 'debug': privileged is true/],
];

describe('setup workloads may not ask for host access or privilege', () => {
  it.each(DANGEROUS)('refuses %s', (_label, spec, message) => {
    const violations = podSecurityViolations(pod(spec));
    expect(violations.join('; ')).toMatch(message);
  });

  it('finds the Pod spec inside every workload kind a lab may ship', () => {
    const spec = { containers: [container({ securityContext: { privileged: true } })] };
    const wrapped: KubernetesManifestObject[] = [
      pod(spec),
      ...['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job'].map((kind) => ({
        apiVersion: 'apps/v1',
        kind,
        metadata: { name: 'probe' },
        spec: { template: { spec } },
      })),
      {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: { name: 'probe' },
        spec: { schedule: '* * * * *', jobTemplate: { spec: { template: { spec } } } },
      },
    ];
    for (const object of wrapped) {
      expect(podSpecOf(object), object.kind).toBeDefined();
      expect(podSecurityViolations(object), object.kind).toEqual(["container 'c': privileged is true"]);
    }
  });

  it('admits an ordinary workload, and a fully restricted one', () => {
    expect(podSecurityViolations(pod({ containers: [{ name: 'nginx', image: 'nginx:stable' }] }))).toEqual([]);
    expect(
      podSecurityViolations(
        pod({
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            container({
              ports: [{ containerPort: 8080, hostPort: 0 }],
              securityContext: {
                allowPrivilegeEscalation: false,
                privileged: false,
                procMount: 'Default',
                capabilities: { drop: ['ALL'] },
              },
            }),
          ],
          volumes: [{ name: 'scratch', emptyDir: {} }],
        }),
      ),
    ).toEqual([]);
  });

  it('ignores kinds that create no Pods', () => {
    for (const kind of ['ConfigMap', 'Secret', 'Service', 'ServiceAccount', 'PersistentVolumeClaim', 'Ingress']) {
      expect(podSecurityViolations({ apiVersion: 'v1', kind, metadata: { name: 'x' }, spec: { hostNetwork: true } })).toEqual([]);
    }
  });

  it('every shipped lab workload passes — and there are enough of them for that to mean something', async () => {
    const registry = await realCatalog();
    let workloads = 0;
    for (const lab of registry.all()) {
      // `loadSetupManifests` refuses a violating workload, so loading is the check.
      for (const object of await loadSetupManifests(lab)) {
        if (!podSpecOf(object)) continue;
        workloads += 1;
        expect(podSecurityViolations(object), `${lab.id} ${object.kind}/${object.metadata.name}`).toEqual([]);
      }
    }
    expect(workloads).toBeGreaterThanOrEqual(15);
  });
});

// ------------------------------------------------------ the provider wiring

describe('KindLabProvider stamps and reconciles the labels', () => {
  let lab: LoadedLabDefinition;
  let context: LabSessionContext;

  beforeAll(async () => {
    lab = await loadK8s001();
    context = sessionContext(lab);
  });

  function makeProvider(k8s: FakeKubernetes): KindLabProvider {
    const provider = new KindLabProvider({
      k8s,
      clusterName: 'jumptotech-labs',
      exec: fakeExec(),
      resetDrainTimeoutMs: 2_000,
      destroyTimeoutMs: 2_000,
      sleep: async () => undefined,
    });
    vi.spyOn(provider, 'execute').mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
      stderr: '',
      timedOut: false,
    });
    return provider;
  }

  it('creates the namespace with the Pod Security labels in the same request', async () => {
    const k8s = new FakeKubernetes();
    const created = vi.spyOn(k8s, 'createNamespace');

    expect((await makeProvider(k8s).create(context)).ok).toBe(true);

    expect(created.mock.calls[0]?.[1]).toMatchObject(BASELINE_LABELS);
    expect((await k8s.getNamespace(context.namespace))?.labels).toMatchObject({
      ...BASELINE_LABELS,
      [MANAGED_LABEL]: 'true',
    });
  });

  it('honours a stricter configured policy', async () => {
    const k8s = new FakeKubernetes();
    const podSecurity: PodSecurityConfig = { enforce: 'restricted', warn: 'restricted', audit: 'restricted', version: 'v1.34' };

    await makeProvider(k8s).create({ ...context, policy: { ...context.policy, podSecurity } });

    expect((await k8s.getNamespace(context.namespace))?.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
  });

  it('labels a namespace that already existed without them before applying anything into it', async () => {
    // The create's 409 path, and a namespace left by a build that predates this.
    const k8s = new FakeKubernetes({
      namespaces: [[context.namespace, { [MANAGED_LABEL]: 'true', [SESSION_LABEL]: context.sessionId }]],
    });
    const order: string[] = [];
    const merge = k8s.mergeNamespaceLabels.bind(k8s);
    const apply = k8s.applyObjects.bind(k8s);
    vi.spyOn(k8s, 'mergeNamespaceLabels').mockImplementation(async (...args) => {
      order.push('labels');
      return merge(...args);
    });
    vi.spyOn(k8s, 'applyObjects').mockImplementation(async (...args) => {
      order.push('objects');
      return apply(...args);
    });

    expect((await makeProvider(k8s).create(context)).ok).toBe(true);

    expect((await k8s.getNamespace(context.namespace))?.labels).toMatchObject(BASELINE_LABELS);
    expect(order[0]).toBe('labels');
  });

  it('restores the labels on reset', async () => {
    const k8s = new FakeKubernetes({
      namespaces: [[context.namespace, { [MANAGED_LABEL]: 'true', [SESSION_LABEL]: context.sessionId }]],
    });

    expect((await makeProvider(k8s).reset(context)).ok).toBe(true);

    expect((await k8s.getNamespace(context.namespace))?.labels).toMatchObject(BASELINE_LABELS);
  });

  it('applies no guardrail objects when the labels cannot be set', async () => {
    const k8s = new FakeKubernetes();
    vi.spyOn(k8s, 'mergeNamespaceLabels').mockRejectedValue(new Error('denied by admission'));

    const result = await makeProvider(k8s).create(context);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('denied by admission');
    expect(k8s.appliedKinds(context.namespace)).toEqual([]);
  });
});

// ---------------------------------------------------------- the kind cluster

describe('the local kind cluster', () => {
  it('turns on kubelet seccompDefault, so Pods naming no profile get RuntimeDefault', () => {
    const cluster = parse(readFileSync(path.join(REPO_ROOT, 'infrastructure/kind/cluster.yaml'), 'utf8')) as {
      nodes: Array<{ kubeadmConfigPatches?: string[] }>;
    };
    const kubelet = (cluster.nodes[0]?.kubeadmConfigPatches ?? [])
      .map((patch) => parse(patch) as { kind?: string; seccompDefault?: unknown })
      .find((patch) => patch.kind === 'KubeletConfiguration');

    expect(kubelet?.seccompDefault).toBe(true);
  });

  it('cluster-up.sh reports a reused cluster that predates the setting', () => {
    const script = readFileSync(path.join(REPO_ROOT, 'scripts/cluster-up.sh'), 'utf8');
    expect(script).toContain('/proxy/configz');
    expect(script).toContain('seccompDefault');
  });
});
