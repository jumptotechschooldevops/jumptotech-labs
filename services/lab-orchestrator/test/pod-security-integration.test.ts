/**
 * BETA-P0-016 — pod security against a REAL kind cluster.
 *
 * Every property claimed here belongs to the API server and the kubelet, not to
 * our code: whether PodSecurity admission refuses a privileged Pod, whether a
 * Deployment can launder one through its ReplicaSet, whether a Pod really runs
 * under a seccomp filter, whether the platform's own credential can strip a
 * namespace of its labels. A fake that returned "Forbidden" would prove none of
 * it, so nothing here is faked. The data-level half is `pod-security.test.ts`.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1, so `npm test` stays hermetic.
 *
 *   npm run cluster:up
 *   RUN_INTEGRATION_TESTS=1 \
 *   KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
 *     npx vitest run test/pod-security-integration.test.ts --root services/lab-orchestrator
 *
 * The cluster must have been *created* from infrastructure/kind/cluster.yaml
 * with the admission manifest applied, which is what `cluster:up` does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POD_SECURITY,
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  KubernetesClient,
  LabRegistry,
  SessionManager,
  podSecurityLabels,
  type LabSession,
} from '../src/index.js';
import { waitForRequirements } from '@jumptotech/verifier';
import { testRunId } from '@jumptotech/test-support/run-id';
import { realCatalog } from './real-catalog.js';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_KUBECONFIG =
  process.env.KUBECONFIG ?? path.join(repoRoot, 'infrastructure/kind/generated/kubeconfig-host.yaml');

const enabled = process.env.RUN_INTEGRATION_TESTS === '1' && existsSync(HOST_KUBECONFIG);
const suite = enabled ? describe : describe.skip;

const RUN = testRunId();
const NAMESPACE_SECRET = `pod-security-integration-${RUN}`;
const BASELINE_REFUSAL = /violates PodSecurity "baseline:v1\.34"/;

interface Cmd {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run kubectl with a given kubeconfig. Never throws — the exit code is data. */
async function kubectlWith(kubeconfig: string, ...args: string[]): Promise<Cmd> {
  try {
    const { stdout, stderr } = await execFileAsync('kubectl', args, {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', KUBECONFIG: kubeconfig },
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

const admin = (...args: string[]) => kubectlWith(HOST_KUBECONFIG, ...args);

function isForbidden(result: Cmd): boolean {
  return result.code !== 0 && /forbidden|cannot (list|get|create|delete|patch|update)/i.test(result.stderr);
}

const box = (extra: Record<string, unknown> = {}) => ({
  name: 'c',
  image: 'busybox:1.36',
  command: ['sleep', '3600'],
  ...extra,
});

/** Bit 21 of a /proc/<pid>/status capability mask is CAP_SYS_ADMIN. */
function hasSysAdmin(status: string, field: 'CapBnd' | 'CapEff'): boolean {
  const hex = new RegExp(`${field}:\\s*([0-9a-f]+)`).exec(status)?.[1] ?? '';
  expect(hex, `${field} missing from /proc/1/status`).not.toBe('');
  return ((Number.parseInt(hex.slice(-8), 16) >>> 21) & 1) === 1;
}

async function eventually(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

suite('pod security: real kind cluster (BETA-P0-016)', () => {
  let k8s: KubernetesClient;
  let registry: LabRegistry;
  let manager: SessionManager;
  let session: LabSession;
  let kubeconfig: string;
  let scratchDir: string;
  const sessions: LabSession[] = [];
  const scratchNamespaces: string[] = [];

  /** Write a manifest into the scratch directory; returns its path. */
  async function manifestFile(name: string, object: Record<string, unknown>): Promise<string> {
    const file = path.join(scratchDir, `${name}.json`);
    await writeFile(file, JSON.stringify(object), 'utf8');
    return file;
  }

  /** `kubectl apply` a manifest as the session's student. */
  async function studentApply(name: string, object: Record<string, unknown>): Promise<Cmd> {
    return kubectlWith(kubeconfig, 'apply', '-f', await manifestFile(name, object));
  }

  const student = (...args: string[]) => kubectlWith(kubeconfig, ...args);

  beforeAll(async () => {
    registry = await realCatalog();
    expect(registry.loadErrors).toEqual([]);

    scratchDir = await mkdtemp(path.join(tmpdir(), `jtt-podsec-${RUN}-`));
    k8s = new KubernetesClient({ kubeconfigPath: HOST_KUBECONFIG });
    const provider = new KindLabProvider({
      k8s,
      clusterName: process.env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
      kubeconfigPath: HOST_KUBECONFIG,
      resetDrainTimeoutMs: 90_000,
      destroyTimeoutMs: 120_000,
      waitForRequirements: (input) => waitForRequirements({ k8s, ...input }),
    });
    manager = new SessionManager({
      registry,
      provider,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: {
        maxSessionSeconds: 3_600,
        idleTimeoutSeconds: 1_200,
        warningSeconds: 300,
        maxActiveSessions: 20,
      },
      namespaceSecret: NAMESPACE_SECRET,
    });

    session = (await manager.start('K8S-001')).session;
    sessions.push(session);
    const credentials = await manager.issueCredentials(session.sessionId);
    kubeconfig = path.join(scratchDir, 'student.kubeconfig');
    await writeFile(kubeconfig, credentials.kubeconfig, { mode: 0o600 });
  }, 300_000);

  afterAll(async () => {
    for (const s of sessions) await manager?.end(s.sessionId).catch(() => undefined);
    for (const namespace of scratchNamespaces) {
      await admin('delete', 'namespace', namespace, '--ignore-not-found', '--wait=false');
    }
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }, 300_000);

  // --------------------------------------------------------- the namespace

  describe('the session namespace', () => {
    it('carries the configured Pod Security Admission labels', async () => {
      const namespace = await k8s.getNamespace(session.namespace);
      expect(namespace?.labels).toMatchObject(podSecurityLabels(DEFAULT_POD_SECURITY));
    }, 60_000);

    it('is backed by all three admission policies on this cluster', async () => {
      for (const kind of ['validatingadmissionpolicies', 'validatingadmissionpolicybindings']) {
        const listed = await admin('get', kind, '-o', 'name');
        expect(listed.code).toBe(0);
        for (const name of [
          'jumptotech-deny-clusterrole-bindings',
          'jumptotech-protect-managed-resources',
          'jumptotech-require-pod-security',
        ]) {
          expect(listed.stdout, `${kind}/${name} — apply infrastructure/kind/admission/lab-rbac-policy.yaml`).toContain(`/${name}`);
        }
      }
    }, 60_000);

    it('runs on kubelets that give Pods without a profile RuntimeDefault seccomp', async () => {
      const nodes = await admin('get', 'nodes', '-o', 'jsonpath={.items[*].metadata.name}');
      expect(nodes.code).toBe(0);
      for (const node of nodes.stdout.trim().split(/\s+/)) {
        const configz = await admin('get', '--raw', `/api/v1/nodes/${node}/proxy/configz`);
        expect(configz.code).toBe(0);
        const kubelet = (JSON.parse(configz.stdout) as { kubeletconfig: { seccompDefault?: boolean } }).kubeletconfig;
        expect(
          kubelet.seccompDefault,
          `${node}: kubelet seccompDefault is off — this cluster predates infrastructure/kind/cluster.yaml; recreate it with npm run cluster:down && npm run cluster:up`,
        ).toBe(true);
      }
    }, 60_000);
  });

  // ------------------------------------------------ what a student may run

  describe('ordinary student workloads are admitted', () => {
    it('K8S-001’s own command runs, under a seccomp filter, without CAP_SYS_ADMIN or a mounted token', async () => {
      const run = await student('run', 'web', '--image=nginx:stable');
      expect(run.code, run.stderr).toBe(0);
      // warn=baseline: an admitted Pod prints no PodSecurity warning.
      expect(run.stderr).not.toMatch(/PodSecurity/);

      const ready = await student('wait', '--for=condition=Ready', 'pod/web', '--timeout=180s');
      expect(ready.code, ready.stderr).toBe(0);

      const status = await student('exec', 'web', '--', 'cat', '/proc/1/status');
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toMatch(/Seccomp:\s*2/);
      expect(hasSysAdmin(status.stdout, 'CapBnd')).toBe(false);

      const volumes = await admin('get', 'pod', 'web', '-n', session.namespace, '-o', 'jsonpath={.spec.volumes[*].name}');
      expect(volumes.code).toBe(0);
      expect(volumes.stdout).not.toContain('kube-api-access');
    }, 300_000);

    it('allowPrivilegeEscalation: true alone is admitted by baseline, and still gains no CAP_SYS_ADMIN', async () => {
      // Documented, not hidden: baseline does not forbid it, and an unset field
      // behaves the same. What bounds it is the capability set and seccomp.
      const applied = await studentApply('escalation', {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'escalation' },
        spec: { containers: [box({ securityContext: { allowPrivilegeEscalation: true } })] },
      });
      expect(applied.code, applied.stderr).toBe(0);

      expect((await student('wait', '--for=condition=Ready', 'pod/escalation', '--timeout=180s')).code).toBe(0);
      const status = await student('exec', 'escalation', '--', 'cat', '/proc/1/status');
      expect(status.stdout).toMatch(/Seccomp:\s*2/);
      expect(hasSysAdmin(status.stdout, 'CapBnd')).toBe(false);
      expect(hasSysAdmin(status.stdout, 'CapEff')).toBe(false);
    }, 300_000);
  });

  // ---------------------------------------------- what nobody may run

  const REFUSED: Array<[string, Record<string, unknown>, RegExp]> = [
    ['privileged', { containers: [box({ securityContext: { privileged: true } })] }, /privileged/],
    ['hostpath', { volumes: [{ name: 'host', hostPath: { path: '/' } }], containers: [box({ volumeMounts: [{ name: 'host', mountPath: '/host' }] })] }, /hostPath volumes/],
    ['hostnetwork', { hostNetwork: true, containers: [box()] }, /hostNetwork=true/],
    ['hostpid', { hostPID: true, containers: [box()] }, /hostPID=true/],
    ['hostipc', { hostIPC: true, containers: [box()] }, /hostIPC=true/],
    ['cap-sys-admin', { containers: [box({ securityContext: { capabilities: { add: ['SYS_ADMIN'] } } })] }, /SYS_ADMIN/],
    ['cap-net-admin', { containers: [box({ securityContext: { capabilities: { add: ['NET_ADMIN'] } } })] }, /NET_ADMIN/],
    ['cap-sys-ptrace', { containers: [box({ securityContext: { capabilities: { add: ['SYS_PTRACE'] } } })] }, /SYS_PTRACE/],
    ['hostport', { containers: [box({ ports: [{ containerPort: 80, hostPort: 18080 }] })] }, /hostPort/],
    ['seccomp-unconfined', { containers: [box({ securityContext: { seccompProfile: { type: 'Unconfined' } } })] }, /seccompProfile/],
    ['unsafe-sysctl', { securityContext: { sysctls: [{ name: 'kernel.msgmax', value: '1' }] }, containers: [box()] }, /forbidden sysctls/],
    ['privileged-init', { initContainers: [box({ name: 'init', command: ['true'], securityContext: { privileged: true } })], containers: [box()] }, /privileged/],
  ];

  describe('dangerous Pods are refused by admission', () => {
    it.each(REFUSED)('refuses a %s Pod from the student', async (label, spec, detail) => {
      const name = `psa-${label}`;
      const result = await studentApply(name, { apiVersion: 'v1', kind: 'Pod', metadata: { name }, spec });
      if (result.code === 0) await student('delete', 'pod', name, '--wait=false');

      expect(result.code, `${label} was admitted`).not.toBe(0);
      expect(result.stderr).toMatch(BASELINE_REFUSAL);
      expect(result.stderr).toMatch(detail);
    }, 60_000);

    it('refuses the same Pod from cluster-admin — PodSecurity has no exemption for the platform', async () => {
      const file = await manifestFile('admin-privileged', {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'psa-admin-privileged' },
        spec: { hostPID: true, containers: [box({ securityContext: { privileged: true } })] },
      });
      const result = await admin('apply', '-n', session.namespace, '-f', file);
      if (result.code === 0) await admin('delete', 'pod', 'psa-admin-privileged', '-n', session.namespace, '--wait=false');

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(BASELINE_REFUSAL);
    }, 60_000);
  });

  describe('a workload controller cannot launder a refused Pod', () => {
    const template = (app: string) => ({
      metadata: { labels: { app } },
      spec: { containers: [box({ securityContext: { privileged: true } })] },
    });

    it.each([
      ['Deployment', 'apps/v1', (app: string) => ({ replicas: 1, selector: { matchLabels: { app } }, template: template(app) })],
      ['DaemonSet', 'apps/v1', (app: string) => ({ selector: { matchLabels: { app } }, template: template(app) })],
      ['Job', 'batch/v1', (app: string) => ({ backoffLimit: 0, template: { ...template(app), spec: { ...template(app).spec, restartPolicy: 'Never' } } })],
    ] as const)('a privileged %s is accepted with a warning, and none of its Pods ever exist', async (kind, apiVersion, spec) => {
      const name = `psa-launder-${kind.toLowerCase()}`;
      const applied = await studentApply(name, { apiVersion, kind, metadata: { name }, spec: spec(name) });
      try {
        expect(applied.code, applied.stderr).toBe(0);
        // warn=baseline is what tells the author, since the object itself is accepted.
        expect(applied.stderr).toMatch(/Warning: would violate PodSecurity "baseline:v1\.34"/);

        const refused = await eventually(async () => {
          const events = await admin(
            'get', 'events', '-n', session.namespace,
            '--field-selector', 'reason=FailedCreate',
            '-o', 'jsonpath={range .items[*]}{.message}{"\\n"}{end}',
          );
          return events.stdout.split('\n').some((m) => m.includes(name) && BASELINE_REFUSAL.test(m));
        }, 90_000);
        expect(refused, `no FailedCreate PodSecurity event for ${kind}/${name}`).toBe(true);

        const pods = await student('get', 'pods', '-l', `app=${name}`, '-o', 'name');
        expect(pods.code).toBe(0);
        expect(pods.stdout.trim()).toBe('');
      } finally {
        await student('delete', kind.toLowerCase(), name, '--wait=false');
      }
    }, 180_000);
  });

  // --------------------------------------------- nobody can remove the fence

  describe('the student cannot weaken the namespace', () => {
    it('cannot relabel or unlabel its own namespace', async () => {
      const weaken = await student('label', 'namespace', session.namespace, 'pod-security.kubernetes.io/enforce=privileged', '--overwrite');
      expect(isForbidden(weaken), weaken.stderr).toBe(true);

      const remove = await student('label', 'namespace', session.namespace, 'pod-security.kubernetes.io/enforce-');
      expect(isForbidden(remove), remove.stderr).toBe(true);
    }, 60_000);

    it('cannot restore token automounting on the default ServiceAccount, or delete it', async () => {
      const patch = await student('patch', 'serviceaccount', 'default', '-p', '{"automountServiceAccountToken":true}');
      expect(patch.code).not.toBe(0);
      expect(patch.stderr).toMatch(/Platform-managed resources cannot be modified/);

      const remove = await student('delete', 'serviceaccount', 'default');
      expect(remove.code).not.toBe(0);
      expect(remove.stderr).toMatch(/Platform-managed resources cannot be modified/);
    }, 60_000);

    it('cannot attach an ephemeral debug container', async () => {
      // `--subresource`, not `pods/ephemeralcontainers`: kubectl reads the
      // latter as a Pod *named* ephemeralcontainers, and the student may update
      // Pods, so it answers "yes" to a question nobody asked.
      const canI = await student('auth', 'can-i', 'update', 'pods', '--subresource=ephemeralcontainers');
      expect(canI.stdout.trim()).toBe('no');

      // And the real thing, against the Pod created above: `--profile=sysadmin`
      // asks for a privileged debug container.
      const debug = await student('debug', 'web', '--image=busybox:1.36', '--profile=sysadmin', '--', 'true');
      expect(isForbidden(debug), debug.stderr).toBe(true);
    }, 60_000);
  });

  describe('the platform credential cannot weaken it either (jumptotech-require-pod-security)', () => {
    it('refuses a managed namespace created without Pod Security labels', async () => {
      const name = `jtt-psa-${RUN}-unfenced`.slice(0, 63);
      scratchNamespaces.push(name);
      const file = await manifestFile('unfenced-namespace', {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name, labels: { 'jumptotech.io/managed': 'true' } },
      });

      const created = await admin('create', '-f', file);
      expect(created.code).not.toBe(0);
      expect(created.stderr).toMatch(/jumptotech-require-pod-security/);
    }, 60_000);

    it('refuses downgrading or removing the enforce label on a live session namespace', async () => {
      const downgrade = await admin('label', 'namespace', session.namespace, 'pod-security.kubernetes.io/enforce=privileged', '--overwrite');
      expect(downgrade.code).not.toBe(0);
      expect(downgrade.stderr).toMatch(/jumptotech-require-pod-security/);

      const remove = await admin('label', 'namespace', session.namespace, 'pod-security.kubernetes.io/enforce-');
      expect(remove.code).not.toBe(0);

      const escape = await admin('label', 'namespace', session.namespace, 'jumptotech.io/managed-', 'pod-security.kubernetes.io/enforce-');
      expect(escape.code).not.toBe(0);

      expect((await k8s.getNamespace(session.namespace))?.labels['pod-security.kubernetes.io/enforce']).toBe('baseline');
    }, 60_000);

    it('still lets the platform merge labels into the namespace through the real client', async () => {
      await k8s.mergeNamespaceLabels(session.namespace, { 'jumptotech.io/psa-probe': RUN });
      const labels = (await k8s.getNamespace(session.namespace))?.labels ?? {};
      expect(labels['jumptotech.io/psa-probe']).toBe(RUN);
      expect(labels).toMatchObject(podSecurityLabels(DEFAULT_POD_SECURITY));
    }, 60_000);
  });

  // ------------------------------------------- why baseline, not restricted

  describe('the measured reason the enforce level is baseline', () => {
    it('restricted refuses K8S-001’s first command, which baseline admits', async () => {
      const name = `jtt-psa-${RUN}-restricted`.slice(0, 63);
      scratchNamespaces.push(name);
      expect((await admin('create', 'namespace', name)).code).toBe(0);
      expect((await admin('label', 'namespace', name, 'pod-security.kubernetes.io/enforce=restricted', 'pod-security.kubernetes.io/enforce-version=v1.34')).code).toBe(0);

      const restricted = await admin('run', 'nginx', '--image=nginx:stable', '-n', name, '--dry-run=server');
      expect(restricted.code).not.toBe(0);
      expect(restricted.stderr).toMatch(/violates PodSecurity "restricted:v1\.34"/);

      const baseline = await student('run', 'nginx-dry', '--image=nginx:stable', '--dry-run=server');
      expect(baseline.code, baseline.stderr).toBe(0);
    }, 60_000);
  });

  // ---------------------------------------------- labs that need a token

  describe('a lab workload that genuinely needs its ServiceAccount token', () => {
    it('K8S-012’s inventory-sync still has its token mounted, and reaches the API with it', async () => {
      const started = await manager.start('K8S-012');
      sessions.push(started.session);
      const namespace = started.session.namespace;
      expect(started.steps.find((s) => s.id === 'lab-initial-state')?.status).toBe('ok');

      const pods = await admin('get', 'pods', '-n', namespace, '-l', 'app=inventory-sync', '-o', 'jsonpath={.items[0].spec.volumes[*].name}');
      expect(pods.stdout).toContain('kube-api-access');

      // 403 — authenticated but not yet authorized — is the lab's starting
      // state. 401 would mean the token never arrived.
      const reached = await eventually(async () => {
        const logs = await admin('logs', 'deployment/inventory-sync', '-n', namespace, '--tail=20');
        return logs.stdout.includes('inventory-config API status: 403');
      }, 90_000);
      expect(reached).toBe(true);
    }, 400_000);
  });

  // ------------------------------------------------------------ reset

  describe('reset', () => {
    it('keeps the namespace fenced', async () => {
      const { result } = await manager.reset(session.sessionId);
      expect(result.ok, JSON.stringify(result.error)).toBe(true);

      expect((await k8s.getNamespace(session.namespace))?.labels).toMatchObject(podSecurityLabels(DEFAULT_POD_SECURITY));
      const privileged = await studentApply('after-reset', {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'psa-after-reset' },
        spec: { containers: [box({ securityContext: { privileged: true } })] },
      });
      expect(privileged.code).not.toBe(0);
      expect(privileged.stderr).toMatch(BASELINE_REFUSAL);
    }, 300_000);
  });
});

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    `[pod-security-integration] skipped — set RUN_INTEGRATION_TESTS=1 and ensure ${HOST_KUBECONFIG} exists`,
  );
}
