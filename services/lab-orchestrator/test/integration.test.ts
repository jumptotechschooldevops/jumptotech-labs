/**
 * Integration tests against a REAL kind cluster.
 *
 * These exist because the properties PLATFORM-002 claims are properties of the
 * *Kubernetes API server*, not of our code: whether RBAC actually forbids a
 * cross-namespace read, whether a ResourceQuota actually rejects a Pod, whether
 * a namespace actually disappears. A mock that returned "Forbidden" would prove
 * nothing at all, so nothing in this file is faked.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1, so `npm test` stays hermetic.
 *
 *   npm run cluster:up
 *   RUN_INTEGRATION_TESTS=1 \
 *   KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
 *     npx vitest run test/integration.test.ts --root services/lab-orchestrator
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
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  KubernetesClient,
  LabRegistry,
  RBAC_PRACTICE_ROLE,
  RBAC_PRACTICE_ROLE_BINDING,
  SessionManager,
  SessionReaper,
  STUDENT_ROLE,
  networkPolicyNames,
  type LabSession,
  type SessionPolicy,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_KUBECONFIG =
  process.env.KUBECONFIG ?? path.join(repoRoot, 'infrastructure/kind/generated/kubeconfig-host.yaml');

const enabled = process.env.RUN_INTEGRATION_TESTS === '1' && existsSync(HOST_KUBECONFIG);
const suite = enabled ? describe : describe.skip;

const NAMESPACE_SECRET = 'integration-namespace-derivation-secret';

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
      timeout: 120_000,
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

/** Admin kubectl, for setting up and inspecting the cluster. */
const admin = (...args: string[]) => kubectlWith(HOST_KUBECONFIG, ...args);

function isForbidden(result: Cmd): boolean {
  return result.code !== 0 && /forbidden|cannot (list|get|create|delete|patch|update)/i.test(result.stderr);
}

suite('integration: real kind cluster', () => {
  let k8s: KubernetesClient;
  let provider: KindLabProvider;
  let registry: LabRegistry;
  let scratchDir: string;
  const createdNamespaces = new Set<string>();

  /** Build a session manager with an optional policy / lifetime override. */
  function managerWith(options: {
    policy?: SessionPolicy;
    maxSessionSeconds?: number;
    idleTimeoutSeconds?: number;
    maxActiveSessions?: number;
    now?: () => number;
    terminated?: string[];
  } = {}): SessionManager {
    return new SessionManager({
      registry,
      provider,
      store: new InMemorySessionStore(),
      policy: options.policy ?? DEFAULT_SESSION_POLICY,
      lifetimes: {
        maxSessionSeconds: options.maxSessionSeconds ?? 3_600,
        idleTimeoutSeconds: options.idleTimeoutSeconds ?? 1_200,
        warningSeconds: 300,
        maxActiveSessions: options.maxActiveSessions ?? 20,
      },
      namespaceSecret: NAMESPACE_SECRET,
      ...(options.terminated
        ? {
            terminal: {
              async terminate(sessionId: string) {
                options.terminated?.push(sessionId);
              },
            },
          }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async function start(manager: SessionManager, labId = 'K8S-001'): Promise<LabSession> {
    const { session } = await manager.start(labId);
    createdNamespaces.add(session.namespace);
    return session;
  }

  /** Write this session's student kubeconfig to disk; returns its path. */
  async function studentKubeconfig(manager: SessionManager, session: LabSession): Promise<string> {
    const credentials = await manager.issueCredentials(session.sessionId);
    const file = path.join(scratchDir, `${session.sessionId}.kubeconfig`);
    await writeFile(file, credentials.kubeconfig, { mode: 0o600 });
    return file;
  }

  beforeAll(async () => {
    registry = new LabRegistry(path.join(repoRoot, 'labs'));
    await registry.load();
    expect(registry.loadErrors).toEqual([]);

    scratchDir = await mkdtemp(path.join(tmpdir(), 'jtt-integration-'));
    k8s = new KubernetesClient({ kubeconfigPath: HOST_KUBECONFIG });
    provider = new KindLabProvider({
      k8s,
      clusterName: process.env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
      kubeconfigPath: HOST_KUBECONFIG,
      resetDrainTimeoutMs: 90_000,
      destroyTimeoutMs: 120_000,
      waitForRequirements: (input) => waitForRequirements({ k8s, ...input }),
    });
  }, 180_000);

  afterAll(async () => {
    // Best-effort teardown of anything this suite created.
    for (const namespace of createdNamespaces) {
      await provider.destroyNamespace(namespace).catch(() => undefined);
    }
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }, 300_000);

  // ---------------------------------------------------------------- health

  it('reports a healthy cluster', async () => {
    const manager = managerWith();
    const session = await start(manager);
    const info = await manager.status(session);

    expect(info.phase).toBe('ready');
    expect(info.nodes?.length).toBeGreaterThan(0);
    expect(info.nodes?.every((n) => n.ready)).toBe(true);
    expect(info.kubernetesVersion).toMatch(/^v1\./);

    await manager.end(session.sessionId);
  }, 180_000);

  // -------------------------------------------- namespace + guardrails

  describe('session provisioning', () => {
    let manager: SessionManager;
    let session: LabSession;

    beforeAll(async () => {
      manager = managerWith();
      session = await start(manager);
    }, 180_000);

    afterAll(async () => {
      await manager.end(session.sessionId).catch(() => undefined);
    }, 180_000);

    it('creates a real, uniquely named namespace with ownership labels', async () => {
      const ns = await k8s.getNamespace(session.namespace);

      expect(ns).not.toBeNull();
      expect(ns?.phase).toBe('Active');
      expect(session.namespace).toMatch(/^lab-[0-9a-f]{12}$/);
      expect(ns?.labels['jumptotech.io/managed']).toBe('true');
      expect(ns?.labels['jumptotech.io/session-id']).toBe(session.sessionId);
      expect(ns?.labels['jumptotech.io/lab-id']).toBe('K8S-001');
    }, 60_000);

    it('creates a per-session ServiceAccount, Role and RoleBinding', async () => {
      const sa = await admin('get', 'serviceaccount', 'student', '-n', session.namespace, '-o', 'name');
      const role = await admin('get', 'role', STUDENT_ROLE, '-n', session.namespace, '-o', 'name');
      const binding = await admin('get', 'rolebinding', STUDENT_ROLE, '-n', session.namespace, '-o', 'name');

      expect(sa.code).toBe(0);
      expect(role.code).toBe(0);
      expect(binding.code).toBe(0);
    }, 60_000);

    it('creates a ResourceQuota (story test 11)', async () => {
      const result = await admin(
        'get', 'resourcequota', DEFAULT_SESSION_POLICY.quotaName,
        '-n', session.namespace, '-o', 'jsonpath={.spec.hard}',
      );

      expect(result.code).toBe(0);
      const hard = JSON.parse(result.stdout) as Record<string, string>;
      expect(hard.pods).toBe('15');
      expect(hard['requests.cpu']).toBe('2');
      expect(hard['limits.memory']).toBe('4Gi');
      expect(hard['services.loadbalancers']).toBe('0');
    }, 60_000);

    it('creates a LimitRange (story test 12)', async () => {
      const result = await admin(
        'get', 'limitrange', DEFAULT_SESSION_POLICY.limitRange.name,
        '-n', session.namespace, '-o', 'jsonpath={.spec.limits[0]}',
      );

      expect(result.code).toBe(0);
      const limit = JSON.parse(result.stdout) as { defaultRequest: Record<string, string> };
      expect(limit.defaultRequest.cpu).toBe('50m');
      expect(limit.defaultRequest.memory).toBe('64Mi');
    }, 60_000);

    it('creates NetworkPolicies (story test 13)', async () => {
      const result = await admin(
        'get', 'networkpolicy', '-n', session.namespace, '-o', 'jsonpath={.items[*].metadata.name}',
      );

      expect(result.code).toBe(0);
      for (const name of networkPolicyNames(DEFAULT_SESSION_POLICY.network.name)) {
        expect(result.stdout).toContain(name);
      }
    }, 60_000);

    it('creates no ClusterRoleBinding for the session', async () => {
      const result = await admin(
        'get', 'clusterrolebinding', '-o', 'jsonpath={.items[*].metadata.name}',
      );

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(session.namespace);
      expect(result.stdout).not.toContain(session.sessionId);
    }, 60_000);
  });

  // ------------------------------------------------------ student RBAC

  describe('student credentials and RBAC denial', () => {
    let manager: SessionManager;
    let sessionA: LabSession;
    let sessionB: LabSession;
    let kubeconfigA: string;

    beforeAll(async () => {
      manager = managerWith();
      sessionA = await start(manager);
      sessionB = await start(manager);
      kubeconfigA = await studentKubeconfig(manager, sessionA);
    }, 240_000);

    afterAll(async () => {
      await manager.end(sessionA.sessionId).catch(() => undefined);
      await manager.end(sessionB.sessionId).catch(() => undefined);
    }, 240_000);

    it('authenticates as the session ServiceAccount, not as cluster-admin', async () => {
      const who = await kubectlWith(kubeconfigA, 'auth', 'whoami', '-o', 'jsonpath={.status.userInfo.username}');

      // system:serviceaccount:<ns>:student — emphatically not kubernetes-admin.
      expect(who.stdout).toBe(`system:serviceaccount:${sessionA.namespace}:student`);
      expect(who.stdout).not.toContain('kubernetes-admin');
      expect(who.stdout).not.toContain('system:masters');
    }, 60_000);

    it('holds no cluster-admin rights', async () => {
      const canDoAnything = await kubectlWith(kubeconfigA, 'auth', 'can-i', '*', '*', '--all-namespaces');

      expect(canDoAnything.stdout.trim()).toBe('no');
    }, 60_000);

    it('defaults to the session namespace, so no -n flag is needed (story test 10)', async () => {
      const created = await kubectlWith(kubeconfigA, 'run', 'rbac-probe', '--image=nginx:stable');
      expect(created.code).toBe(0);

      const listed = await kubectlWith(kubeconfigA, 'get', 'pods', '-o', 'name');
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain('pod/rbac-probe');

      await kubectlWith(kubeconfigA, 'delete', 'pod', 'rbac-probe', '--grace-period=0', '--force');
    }, 180_000);

    it('can perform the K8S-001 operations in its own namespace (story test 10)', async () => {
      for (const args of [
        ['get', 'pods'],
        ['get', 'deployments'],
        ['get', 'services'],
        ['get', 'configmaps'],
        ['get', 'secrets'],
        ['get', 'events'],
        ['get', 'resourcequotas'],
      ]) {
        const result = await kubectlWith(kubeconfigA, ...args);
        expect({ args, code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      }
    }, 180_000);

    // --- the explicit Forbidden proofs -----------------------------------

    it('gets Forbidden reading another student’s namespace (story test 4)', async () => {
      const result = await kubectlWith(kubeconfigA, 'get', 'pods', '-n', sessionB.namespace);

      expect(result.code).not.toBe(0);
      expect(isForbidden(result)).toBe(true);
      expect(result.stderr).toMatch(/forbidden/i);
    }, 60_000);

    it('gets Forbidden writing into another student’s namespace (story test 5)', async () => {
      const create = await kubectlWith(
        kubeconfigA, 'run', 'intruder', '--image=nginx:stable', '-n', sessionB.namespace,
      );
      const del = await kubectlWith(
        kubeconfigA, 'delete', 'pod', '--all', '-n', sessionB.namespace,
      );

      expect(isForbidden(create)).toBe(true);
      expect(isForbidden(del)).toBe(true);
    }, 120_000);

    it('gets Forbidden reading kube-system (story test 8)', async () => {
      const pods = await kubectlWith(kubeconfigA, 'get', 'pods', '-n', 'kube-system');
      const secrets = await kubectlWith(kubeconfigA, 'get', 'secrets', '-n', 'kube-system');

      expect(isForbidden(pods)).toBe(true);
      expect(isForbidden(secrets)).toBe(true);
      expect(pods.stderr).toMatch(/forbidden/i);
    }, 60_000);

    it('gets Forbidden on node and other cluster-level reads', async () => {
      // K8S-001 does not need `kubectl get nodes`, so it is not granted. The
      // lab brief and the README document this rather than the demo command
      // silently keeping cluster-wide read alive.
      const nodes = await kubectlWith(kubeconfigA, 'get', 'nodes');
      const namespaces = await kubectlWith(kubeconfigA, 'get', 'namespaces');
      const pvs = await kubectlWith(kubeconfigA, 'get', 'persistentvolumes');

      expect(isForbidden(nodes)).toBe(true);
      expect(isForbidden(namespaces)).toBe(true);
      expect(isForbidden(pvs)).toBe(true);
    }, 60_000);

    it('cannot create or delete namespaces (story test 7)', async () => {
      const create = await kubectlWith(kubeconfigA, 'create', 'namespace', 'student-made-this');
      const del = await kubectlWith(kubeconfigA, 'delete', 'namespace', sessionB.namespace);

      expect(isForbidden(create)).toBe(true);
      expect(isForbidden(del)).toBe(true);
      // And nothing was created.
      expect((await k8s.getNamespace('student-made-this'))).toBeNull();
    }, 60_000);

    it('cannot modify nodes (story test 9)', async () => {
      const nodeName = (await k8s.listNodes())[0]?.name ?? 'jumptotech-labs-control-plane';
      const label = await kubectlWith(kubeconfigA, 'label', 'node', nodeName, 'pwned=true');

      expect(isForbidden(label)).toBe(true);
    }, 60_000);

    it('cannot modify RBAC or escalate its own privileges', async () => {
      const clusterRole = await kubectlWith(
        kubeconfigA, 'create', 'clusterrole', 'pwn', '--verb=*', '--resource=*',
      );
      const clusterBinding = await kubectlWith(
        kubeconfigA, 'create', 'clusterrolebinding', 'pwn',
        '--clusterrole=cluster-admin', `--serviceaccount=${sessionA.namespace}:student`,
      );
      const localBinding = await kubectlWith(
        kubeconfigA, 'create', 'rolebinding', 'pwn-local',
        '--clusterrole=cluster-admin', `--serviceaccount=${sessionA.namespace}:student`,
      );
      const editRole = await kubectlWith(
        kubeconfigA, 'delete', 'role', STUDENT_ROLE,
      );

      expect(isForbidden(clusterRole)).toBe(true);
      expect(isForbidden(clusterBinding)).toBe(true);
      expect(isForbidden(localBinding)).toBe(true);
      expect(isForbidden(editRole)).toBe(true);
    }, 120_000);

    it('cannot raise its own quota or remove its own isolation', async () => {
      const quota = await kubectlWith(
        kubeconfigA, 'patch', 'resourcequota', DEFAULT_SESSION_POLICY.quotaName,
        '--type=merge', '-p', '{"spec":{"hard":{"pods":"500"}}}',
      );
      const [denyPolicy] = networkPolicyNames(DEFAULT_SESSION_POLICY.network.name);
      const netpol = await kubectlWith(kubeconfigA, 'delete', 'networkpolicy', denyPolicy!);

      expect(isForbidden(quota)).toBe(true);
      expect(isForbidden(netpol)).toBe(true);
    }, 60_000);
  });

  describe('RBAC lab security boundary', () => {
    let manager: SessionManager;
    let session: LabSession;
    let kubeconfig: string;

    beforeAll(async () => {
      manager = managerWith();
      session = await start(manager, 'K8S-012');
      kubeconfig = await studentKubeconfig(manager, session);
    }, 240_000);

    afterAll(async () => {
      await manager.end(session.sessionId).catch(() => undefined);
    }, 240_000);

    it('can create a namespaced Role and RoleBinding to a namespaced Role', async () => {
      const role = await kubectlWith(
        kubeconfig,
        'create',
        'role',
        'lab-role',
        '--verb=get',
        '--resource=configmaps',
      );
      const binding = await kubectlWith(
        kubeconfig,
        'create',
        'rolebinding',
        'lab-binding',
        `--role=lab-role`,
        `--serviceaccount=${session.namespace}:inventory-sync`,
      );

      expect(role.code).toBe(0);
      expect(binding.code).toBe(0);
    }, 120_000);

    it('cannot bind any ClusterRole through a RoleBinding', async () => {
      for (const clusterRole of ['cluster-admin', 'admin', 'edit', 'view']) {
        const binding = await kubectlWith(
          kubeconfig,
          'create',
          'rolebinding',
          `deny-${clusterRole}`,
          `--clusterrole=${clusterRole}`,
          `--serviceaccount=${session.namespace}:inventory-sync`,
        );
        expect(isForbidden(binding)).toBe(true);
      }
    }, 180_000);

    it('cannot create ClusterRole or ClusterRoleBinding', async () => {
      const clusterRole = await kubectlWith(
        kubeconfig,
        'create',
        'clusterrole',
        'student-cr',
        '--verb=get',
        '--resource=pods',
      );
      const clusterBinding = await kubectlWith(
        kubeconfig,
        'create',
        'clusterrolebinding',
        'student-crb',
        '--clusterrole=view',
        `--serviceaccount=${session.namespace}:inventory-sync`,
      );

      expect(isForbidden(clusterRole)).toBe(true);
      expect(isForbidden(clusterBinding)).toBe(true);
    }, 120_000);

    it('cannot modify platform-managed RBAC objects', async () => {
      for (const args of [
        ['patch', 'role', STUDENT_ROLE, '--type=merge', '-p', '{"rules":[]}'],
        ['delete', 'role', STUDENT_ROLE],
        ['delete', 'rolebinding', RBAC_PRACTICE_ROLE_BINDING],
        ['patch', 'role', RBAC_PRACTICE_ROLE, '--type=merge', '-p', '{"rules":[]}'],
      ] as const) {
        const result = await kubectlWith(kubeconfig, ...args);
        expect(isForbidden(result)).toBe(true);
      }
    }, 120_000);
  });

  // ------------------------------------- quota + limitrange enforcement

  describe('resource controls actually bite (story test 14)', () => {
    let manager: SessionManager;
    let session: LabSession;
    let kubeconfig: string;

    beforeAll(async () => {
      // A deliberately tiny quota, so "excessive" is two Pods rather than
      // sixteen and the test stays fast.
      manager = managerWith({
        policy: {
          ...DEFAULT_SESSION_POLICY,
          quota: { ...DEFAULT_SESSION_POLICY.quota, pods: '1' },
        },
      });
      session = await start(manager);
      kubeconfig = await studentKubeconfig(manager, session);
    }, 180_000);

    afterAll(async () => {
      await manager.end(session.sessionId).catch(() => undefined);
    }, 180_000);

    it('rejects excessive resource creation', async () => {
      const first = await kubectlWith(kubeconfig, 'run', 'quota-a', '--image=nginx:stable');
      const second = await kubectlWith(kubeconfig, 'run', 'quota-b', '--image=nginx:stable');

      expect(first.code).toBe(0);
      expect(second.code).not.toBe(0);
      expect(second.stderr).toMatch(/exceeded quota/i);
    }, 180_000);

    it('defaults container requests from the LimitRange, so a plain kubectl run still works', async () => {
      // This is the interaction that would otherwise break K8S-001: the quota
      // constrains requests.cpu, so an unqualified Pod would be rejected if the
      // LimitRange did not supply defaults.
      const requests = await admin(
        'get', 'pod', 'quota-a', '-n', session.namespace,
        '-o', 'jsonpath={.spec.containers[0].resources.requests}',
      );

      expect(requests.code).toBe(0);
      const parsed = JSON.parse(requests.stdout) as Record<string, string>;
      expect(parsed.cpu).toBe('50m');
      expect(parsed.memory).toBe('64Mi');
    }, 60_000);
  });

  // ------------------------------- verifier / reset / end-lab isolation

  describe('two-session isolation end to end', () => {
    let manager: SessionManager;
    let sessionA: LabSession;
    let sessionB: LabSession;
    let kubeconfigA: string;
    let kubeconfigB: string;

    beforeAll(async () => {
      manager = managerWith();
      sessionA = await start(manager);
      sessionB = await start(manager);
      kubeconfigA = await studentKubeconfig(manager, sessionA);
      kubeconfigB = await studentKubeconfig(manager, sessionB);

      // A solves the lab; B does nothing.
      const run = await kubectlWith(kubeconfigA, 'run', 'nginx', '--image=nginx:stable');
      expect(run.code).toBe(0);
      const ready = await kubectlWith(
        kubeconfigA, 'wait', '--for=condition=Ready', 'pod/nginx', '--timeout=240s',
      );
      expect(ready.code).toBe(0);
    }, 420_000);

    afterAll(async () => {
      await manager.end(sessionA.sessionId).catch(() => undefined);
      await manager.end(sessionB.sessionId).catch(() => undefined);
    }, 240_000);

    it('A sees its own Pod; B sees nothing (story test 6)', async () => {
      const listA = await kubectlWith(kubeconfigA, 'get', 'pods', '-o', 'name');
      const listB = await kubectlWith(kubeconfigB, 'get', 'pods', '-o', 'name');

      expect(listA.stdout).toContain('pod/nginx');
      expect(listB.code).toBe(0);
      expect(listB.stdout.trim()).toBe('');
    }, 60_000);

    it('Check Solution passes for A and fails for B (story tests 15 and 16)', async () => {
      const lab = registry.get('K8S-001');

      const resultA = await verifyLab({ k8s, lab, namespace: sessionA.namespace });
      const resultB = await verifyLab({ k8s, lab, namespace: sessionB.namespace });

      expect(resultA.passed).toBe(true);
      expect(resultA.summary).toBe('LAB PASSED');
      expect(resultB.passed).toBe(false);
      expect(resultB.summary).toBe('LAB NOT COMPLETE');
    }, 120_000);

    it('resetting B leaves A untouched (story tests 17 and 18)', async () => {
      const result = await manager.reset(sessionB.sessionId);
      expect(result.result.ok).toBe(true);

      // A's Pod is still there and still passes.
      expect(await k8s.getPod(sessionA.namespace, 'nginx')).not.toBeNull();
      const lab = registry.get('K8S-001');
      expect((await verifyLab({ k8s, lab, namespace: sessionA.namespace })).passed).toBe(true);
    }, 180_000);

    it('resetting A clears A and keeps its guardrails and namespace', async () => {
      const result = await manager.reset(sessionA.sessionId);

      expect(result.result.ok).toBe(true);
      expect(result.result.removed).toContain('pods/nginx');
      expect(await k8s.getPod(sessionA.namespace, 'nginx')).toBeNull();

      // The namespace, the quota and the RBAC all survived the reset.
      expect(await k8s.getNamespace(sessionA.namespace)).not.toBeNull();
      expect(
        (await admin('get', 'resourcequota', DEFAULT_SESSION_POLICY.quotaName, '-n', sessionA.namespace)).code,
      ).toBe(0);
      expect((await admin('get', 'role', STUDENT_ROLE, '-n', sessionA.namespace)).code).toBe(0);
      // And the student can still work.
      expect((await kubectlWith(kubeconfigA, 'get', 'pods')).code).toBe(0);
    }, 240_000);

    it('End Lab deletes A’s namespace and leaves B running (story tests 19 and 20)', async () => {
      const outcome = await manager.end(sessionA.sessionId);

      expect(outcome.destroy.namespaceGone).toBe(true);
      expect(outcome.session.status).toBe('ENDED');
      expect(await k8s.getNamespace(sessionA.namespace)).toBeNull();

      // B is completely unaffected.
      expect(await k8s.getNamespace(sessionB.namespace)).not.toBeNull();
      expect((await manager.get(sessionB.sessionId))?.status).toBe('ACTIVE');
      expect((await kubectlWith(kubeconfigB, 'get', 'pods')).code).toBe(0);
    }, 240_000);
  });

  // -------------------------------------------------- automatic cleanup

  describe('automatic cleanup against the real cluster', () => {
    it('reaps a session past its absolute deadline (story test 21)', async () => {
      const clock = { now: Date.now() };
      const terminated: string[] = [];
      const manager = managerWith({ maxSessionSeconds: 60, now: () => clock.now, terminated });
      const reaper = new SessionReaper({
        sessions: manager,
        provider,
        intervalMs: 60_000,
        now: () => clock.now,
        log: () => undefined,
      });

      const session = await start(manager);
      expect(await k8s.getNamespace(session.namespace)).not.toBeNull();

      clock.now += 120_000;
      const result = await reaper.sweep();

      expect(result.removed).toContain(session.namespace);
      expect(result.reasons[session.namespace]).toBe('expired');
      expect(await k8s.getNamespace(session.namespace)).toBeNull();
      expect((await manager.get(session.sessionId))?.status).toBe('EXPIRED');
      expect(terminated).toEqual([session.sessionId]);
    }, 300_000);

    it('reaps an idle session and spares an active one (story tests 22 and 23)', async () => {
      const clock = { now: Date.now() };
      const manager = managerWith({ idleTimeoutSeconds: 60, now: () => clock.now });
      const reaper = new SessionReaper({
        sessions: manager,
        provider,
        intervalMs: 60_000,
        now: () => clock.now,
        log: () => undefined,
      });

      const idle = await start(manager);
      const active = await start(manager);

      clock.now += 120_000;
      // The active session is being used; the idle one is not.
      await manager.touch(active.sessionId, 'terminal');

      const result = await reaper.sweep();

      expect(result.removed).toEqual([idle.namespace]);
      expect(result.reasons[idle.namespace]).toBe('idle');
      expect(result.retained).toBe(1);
      expect(await k8s.getNamespace(idle.namespace)).toBeNull();
      expect(await k8s.getNamespace(active.namespace)).not.toBeNull();

      await manager.end(active.sessionId);
    }, 420_000);

    it('is idempotent — a second sweep changes nothing (story test 24)', async () => {
      const clock = { now: Date.now() };
      const manager = managerWith({ maxSessionSeconds: 60, now: () => clock.now });
      const reaper = new SessionReaper({
        sessions: manager,
        provider,
        intervalMs: 60_000,
        now: () => clock.now,
        log: () => undefined,
      });
      const session = await start(manager);

      clock.now += 120_000;
      const first = await reaper.sweep();
      const second = await reaper.sweep();

      expect(first.removed).toContain(session.namespace);
      expect(second.removed).toEqual([]);
      expect(second.errors).toEqual([]);
      expect((await manager.get(session.sessionId))?.status).toBe('EXPIRED');
    }, 300_000);

    it('refuses to delete an unmanaged namespace (story test 25)', async () => {
      // A real namespace, lab-shaped, that this platform did not create.
      const foreign = 'lab-ffffffffff01';
      await admin('create', 'namespace', foreign);

      try {
        const outcome = await provider.destroyNamespace(foreign);

        expect(outcome.ok).toBe(false);
        expect(outcome.namespaceGone).toBe(false);
        expect(outcome.error?.message).toMatch(/not labelled jumptotech.io\/managed=true/);
        expect(await k8s.getNamespace(foreign)).not.toBeNull();
      } finally {
        await admin('delete', 'namespace', foreign, '--wait=false');
      }
    }, 180_000);

    it.each(['default', 'kube-system', 'kube-public', 'kube-node-lease'])(
      'refuses to delete the protected namespace %s',
      async (name) => {
        const outcome = await provider.destroyNamespace(name);

        expect(outcome.ok).toBe(false);
        expect(outcome.error?.message).toMatch(/Refusing to delete/);
        // Still there, unharmed.
        expect(await k8s.getNamespace(name)).not.toBeNull();
      },
      120_000,
    );
  });

  // ------------------------------------------------------- concurrency

  describe('concurrency', () => {
    it('runs five simultaneous, fully isolated sessions (story test 26)', async () => {
      const manager = managerWith({ maxActiveSessions: 10 });

      const sessions = await Promise.all(
        Array.from({ length: 5 }, async () => {
          const { session } = await manager.start('K8S-001');
          createdNamespaces.add(session.namespace);
          return session;
        }),
      );

      try {
        // Unique session ids and namespaces.
        expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(5);
        expect(new Set(sessions.map((s) => s.namespace)).size).toBe(5);

        // Every namespace really exists, with its own guardrails.
        for (const session of sessions) {
          expect(await k8s.getNamespace(session.namespace)).not.toBeNull();
          expect(
            (await admin('get', 'serviceaccount', 'student', '-n', session.namespace)).code,
          ).toBe(0);
          expect(
            (await admin('get', 'resourcequota', DEFAULT_SESSION_POLICY.quotaName, '-n', session.namespace)).code,
          ).toBe(0);
        }

        // Unique credentials: five distinct ServiceAccount tokens.
        const kubeconfigs = await Promise.all(
          sessions.map((session) => studentKubeconfig(manager, session)),
        );
        expect(new Set(kubeconfigs).size).toBe(5);

        const identities = await Promise.all(
          kubeconfigs.map((kc) =>
            kubectlWith(kc, 'auth', 'whoami', '-o', 'jsonpath={.status.userInfo.username}'),
          ),
        );
        expect(new Set(identities.map((i) => i.stdout)).size).toBe(5);

        // Each student works in their own namespace only.
        await Promise.all(
          kubeconfigs.map(async (kc, index) => {
            const own = await kubectlWith(kc, 'get', 'pods');
            expect(own.code).toBe(0);

            const neighbour = sessions[(index + 1) % sessions.length]!;
            const cross = await kubectlWith(kc, 'get', 'pods', '-n', neighbour.namespace);
            expect(isForbidden(cross)).toBe(true);
          }),
        );

        // Independent verifier: one solves, the others still fail.
        const lab = registry.get('K8S-001');
        const solver = sessions[0]!;
        const solverKubeconfig = kubeconfigs[0]!;
        expect((await kubectlWith(solverKubeconfig, 'run', 'nginx', '--image=nginx:stable')).code).toBe(0);
        expect(
          (await kubectlWith(solverKubeconfig, 'wait', '--for=condition=Ready', 'pod/nginx', '--timeout=240s')).code,
        ).toBe(0);

        for (const session of sessions) {
          const result = await verifyLab({ k8s, lab, namespace: session.namespace });
          expect(result.passed).toBe(session.sessionId === solver.sessionId);
        }

        // Independent reset: resetting one leaves the solver's Pod alone.
        await manager.reset(sessions[1]!.sessionId);
        expect(await k8s.getPod(solver.namespace, 'nginx')).not.toBeNull();

        // Independent cleanup: ending one leaves the other four alive.
        await manager.end(sessions[4]!.sessionId);
        expect(await k8s.getNamespace(sessions[4]!.namespace)).toBeNull();
        for (const session of sessions.slice(0, 4)) {
          expect(await k8s.getNamespace(session.namespace)).not.toBeNull();
        }
      } finally {
        await Promise.all(
          sessions.map((session) => manager.end(session.sessionId).catch(() => undefined)),
        );
      }
    }, 900_000);

    it('enforces MAX_ACTIVE_SESSIONS without creating a namespace (story test 27)', async () => {
      const manager = managerWith({ maxActiveSessions: 2 });
      const a = await start(manager);
      const b = await start(manager);

      try {
        const before = (await k8s.listNamespaces('jumptotech.io/managed=true')).length;

        await expect(manager.start('K8S-001')).rejects.toMatchObject({
          code: 'LAB_CAPACITY_REACHED',
        });

        const after = (await k8s.listNamespaces('jumptotech.io/managed=true')).length;
        expect(after).toBe(before);
      } finally {
        await manager.end(a.sessionId).catch(() => undefined);
        await manager.end(b.sessionId).catch(() => undefined);
      }
    }, 300_000);
  });

  // ------------------------------------------- PLATFORM-001 regression

  describe('PLATFORM-001 regression, inside a session namespace', () => {
    let manager: SessionManager;
    let session: LabSession;
    let kubeconfig: string;

    beforeAll(async () => {
      manager = managerWith();
      session = await start(manager);
      kubeconfig = await studentKubeconfig(manager, session);
    }, 240_000);

    afterAll(async () => {
      await manager.end(session.sessionId).catch(() => undefined);
    }, 240_000);

    it('a freshly created sandbox has no Pod (requirement 4)', async () => {
      expect(await k8s.getPod(session.namespace, 'nginx')).toBeNull();
    }, 60_000);

    it('observes a real Pod reaching Running/Ready (requirement 6)', async () => {
      expect((await kubectlWith(kubeconfig, 'run', 'nginx', '--image=nginx:stable')).code).toBe(0);
      expect(
        (await kubectlWith(kubeconfig, 'wait', '--for=condition=Ready', 'pod/nginx', '--timeout=240s')).code,
      ).toBe(0);

      const pod = await k8s.getPod(session.namespace, 'nginx');

      expect(pod?.name).toBe('nginx');
      expect(pod?.namespace).toBe(session.namespace);
      expect(pod?.phase).toBe('Running');
      expect(pod?.containers[0]?.image).toBe('nginx:stable');
      expect(pod?.containers[0]?.ready).toBe(true);

      const lab = registry.get('K8S-001');
      expect((await verifyLab({ k8s, lab, namespace: session.namespace })).passed).toBe(true);
    }, 420_000);

    it('the wrong image fails only the image check (requirement 5)', async () => {
      await kubectlWith(kubeconfig, 'delete', 'pod', 'nginx', '--grace-period=0', '--force');
      expect((await kubectlWith(kubeconfig, 'run', 'nginx', '--image=nginx:1.25')).code).toBe(0);

      const lab = registry.get('K8S-001');
      const result = await verifyLab({ k8s, lab, namespace: session.namespace });

      expect(result.passed).toBe(false);
      expect(result.checks.find((c) => c.id.includes('pod_exists'))?.status).toBe('pass');
      expect(result.checks.find((c) => c.id.includes('pod_image'))?.status).toBe('fail');
      expect(result.checks.find((c) => c.id.includes('pod_image'))?.detail).toContain('nginx:1.25');
    }, 300_000);

    it('reset removes the student Pod and leaves the sandbox healthy (requirement 7)', async () => {
      const result = await manager.reset(session.sessionId);

      expect(result.result.ok).toBe(true);
      expect(result.result.removed).toContain('pods/nginx');
      expect(await k8s.getPod(session.namespace, 'nginx')).toBeNull();
      expect(result.result.environment.phase).toBe('ready');

      // The cluster-managed kubernetes Service must survive.
      const services = await k8s.listNamespacedResources(session.namespace, 'services');
      expect(services.map((s) => s.name)).not.toContain('nginx');
    }, 300_000);
  });

  describe('K8S-011 initial state provisioning', () => {
    it('applies setup manifests when the namespace uses the canonical lab-<hex> form', async () => {
      const manager = managerWith();
      const started = await manager.start('K8S-011');

      createdNamespaces.add(started.session.namespace);
      expect(started.session.namespace).toMatch(/^lab-[0-9a-f]{12}$/);
      expect(started.steps.find((s) => s.id === 'environment-created')?.status).toBe('ok');
      expect(started.steps.find((s) => s.id === 'kubernetes-api')?.status).toBe('ok');
      expect(started.steps.find((s) => s.id === 'lab-initial-state')?.status).toBe('ok');

      const deployment = await k8s.getDeployment(started.session.namespace, 'ledger');
      expect(deployment).not.toBeNull();
      expect(deployment?.availableReplicas).toBeGreaterThanOrEqual(1);

      const credentials = await manager.issueCredentials(started.session.sessionId);
      expect(credentials.namespace).toBe(started.session.namespace);

      await manager.end(started.session.sessionId).catch(() => undefined);
    }, 300_000);
  });
});

if (!enabled) {
  // Make the skip reason visible in CI output rather than silently passing.
  // eslint-disable-next-line no-console
  console.log(
    `[integration] skipped — set RUN_INTEGRATION_TESTS=1 and ensure ${HOST_KUBECONFIG} exists`,
  );
}
