/**
 * PLATFORM-003 integration tests against a REAL kind cluster.
 *
 * This file automates the story's acceptance test. Everything here runs against
 * a live API server with real student credentials, because the properties being
 * claimed belong to Kubernetes rather than to our code: whether an injected
 * fault actually produces ImagePullBackOff, whether a Service with a mismatched
 * selector actually has no endpoints, whether a repair actually makes the
 * verifier pass, and whether two sessions are actually isolated.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1, so `npm test` stays hermetic.
 *
 *   npm run cluster:up
 *   RUN_INTEGRATION_TESTS=1 \
 *   KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
 *     npx vitest run test/labs-integration.test.ts --root services/lab-orchestrator
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
  SessionManager,
  type LabSession,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';
import { scanLabsDirectory } from './catalog-shape.js';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_KUBECONFIG =
  process.env.KUBECONFIG ?? path.join(repoRoot, 'infrastructure/kind/generated/kubeconfig-host.yaml');

const enabled = process.env.RUN_INTEGRATION_TESTS === '1' && existsSync(HOST_KUBECONFIG);
const suite = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    `[labs-integration] skipped — set RUN_INTEGRATION_TESTS=1 and ensure ${HOST_KUBECONFIG} exists`,
  );
}

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
      timeout: 180_000,
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

suite('PLATFORM-003 integration: the lab catalog on real kind', () => {
  let k8s: KubernetesClient;
  let provider: KindLabProvider;
  let registry: LabRegistry;
  let manager: SessionManager;
  let scratchDir: string;
  const createdNamespaces = new Set<string>();

  /** Start a session for a lab and remember its namespace for teardown. */
  async function start(labId: string): Promise<LabSession> {
    const { session } = await manager.start(labId);
    createdNamespaces.add(session.namespace);
    return session;
  }

  /** Write this session's namespace-scoped kubeconfig; returns a kubectl bound to it. */
  async function studentKubectl(session: LabSession): Promise<(...args: string[]) => Promise<Cmd>> {
    const credentials = await manager.issueCredentials(session.sessionId);
    const file = path.join(scratchDir, `${session.sessionId}.kubeconfig`);
    await writeFile(file, credentials.kubeconfig, { mode: 0o600 });
    return (...args: string[]) => kubectlWith(file, ...args);
  }

  /** Run the lab's real verifier against this session's real namespace. */
  async function check(session: LabSession) {
    return verifyLab({ k8s, lab: registry.get(session.labId), namespace: session.namespace });
  }

  /** Poll `check` until it passes, or give up. Rollouts are not instantaneous. */
  async function checkUntilPassed(session: LabSession, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs;
    let result = await check(session);
    while (!result.passed && Date.now() < deadline) {
      await sleep(3_000);
      result = await check(session);
    }
    return result;
  }

  beforeAll(async () => {
    registry = new LabRegistry(path.join(repoRoot, 'labs'));
    await registry.load();
    expect(registry.loadErrors).toEqual([]);
    // Every shipped lab loads. Kubernetes labs are exercised here against a
    // real cluster; Linux, Terraform, and Docker labs load from the same
    // registry and are exercised in their own integration suites. The expected
    // size is read off disk so a new lab in any track does not edit this file.
    const disk = await scanLabsDirectory();
    expect(registry.size).toBe(disk.labCount);
    expect(registry.labsForTrack('kubernetes').map((l) => l.id)).toEqual(
      disk.idsForTrack('kubernetes'),
    );

    scratchDir = await mkdtemp(path.join(tmpdir(), 'jtt-labs-integration-'));
    k8s = new KubernetesClient({ kubeconfigPath: HOST_KUBECONFIG });
    provider = new KindLabProvider({
      k8s,
      clusterName: process.env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
      kubeconfigPath: HOST_KUBECONFIG,
      resetDrainTimeoutMs: 120_000,
      destroyTimeoutMs: 150_000,
      waitForRequirements: (input) => waitForRequirements({ k8s, ...input }),
    });
    manager = new SessionManager({
      registry,
      provider,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: {
        maxSessionSeconds: 3_600,
        idleTimeoutSeconds: 1_800,
        warningSeconds: 300,
        maxActiveSessions: 20,
      },
      namespaceSecret: NAMESPACE_SECRET,
    });
  }, 240_000);

  afterAll(async () => {
    for (const namespace of createdNamespaces) {
      await provider.destroyNamespace(namespace).catch(() => undefined);
    }
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }, 300_000);

  // ------------------------------------------------- K8S-001 still works

  it('K8S-001 still works end to end', async () => {
    const session = await start('K8S-001');
    const kubectl = await studentKubectl(session);

    expect((await check(session)).passed).toBe(false);

    const created = await kubectl('run', 'nginx', '--image=nginx:stable');
    expect(created.code, created.stderr).toBe(0);

    const result = await checkUntilPassed(session);
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
    expect(result.summary).toBe('LAB PASSED');

    await manager.end(session.sessionId);
  }, 300_000);

  // ------------------------------------------------------ K8S-002 lifecycle

  it('K8S-002: fails empty, passes with a real Deployment, and resets', async () => {
    const session = await start('K8S-002');
    const kubectl = await studentKubectl(session);

    // 1. An untouched namespace fails every check.
    const before = await check(session);
    expect(before.passed).toBe(false);
    expect(before.checks.every((c) => c.status === 'fail')).toBe(true);

    // 2. The student solves it with ordinary kubectl.
    const created = await kubectl('create', 'deployment', 'frontend', '--image=nginx:stable', '--replicas=3');
    expect(created.code, created.stderr).toBe(0);

    const after = await checkUntilPassed(session);
    expect(after.passed, JSON.stringify(after.checks)).toBe(true);

    // 3. Reset returns the namespace to the lab's starting state — for K8S-002
    //    that is empty, because the lab declares no setup manifests.
    const { result: reset } = await manager.reset(session.sessionId);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
    expect(reset.removed.join(',')).toContain('deployments/frontend');

    const afterReset = await check(session);
    expect(afterReset.passed).toBe(false);

    await manager.end(session.sessionId);
  }, 420_000);

  it('K8S-002 grades state, not commands: a manifest passes identically', async () => {
    const session = await start('K8S-002');
    const kubectl = await studentKubectl(session);

    const manifest = path.join(scratchDir, 'frontend.yaml');
    await writeFile(
      manifest,
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
spec:
  replicas: 3
  selector:
    matchLabels: { app: frontend }
  template:
    metadata:
      labels: { app: frontend }
    spec:
      containers:
        - name: web
          image: nginx:stable
`,
      'utf8',
    );

    const applied = await kubectl('apply', '-f', manifest);
    expect(applied.code, applied.stderr).toBe(0);

    const result = await checkUntilPassed(session);
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);

    await manager.end(session.sessionId);
  }, 300_000);

  // --------------------------------------------- K8S-010 broken → repaired

  it('K8S-010: starts broken, fails, passes after repair, and resets to broken', async () => {
    const session = await start('K8S-010');
    const kubectl = await studentKubectl(session);

    // 1. Provisioning really did inject the fault.
    const deployment = await kubectl('get', 'deployment', 'ledger-api', '-o', 'jsonpath={.spec.template.spec.containers[0].image}');
    expect(deployment.stdout).toBe('nginx:stabel');

    const service = await kubectl('get', 'service', 'ledger-api', '-o', 'jsonpath={.spec.selector.app}');
    expect(service.stdout).toBe('ledger');

    // 2. Check Solution initially FAILS.
    const broken = await check(session);
    expect(broken.passed).toBe(false);
    const brokenByLabel = Object.fromEntries(broken.checks.map((c) => [c.label, c.status]));
    expect(brokenByLabel['Deployment ledger-api exists']).toBe('pass');
    expect(brokenByLabel['Deployment runs the correct application image']).toBe('fail');
    expect(brokenByLabel['Both replicas are available']).toBe('fail');
    expect(brokenByLabel['Service selects the ledger-api Pods']).toBe('fail');

    // The image really cannot be pulled — this is the symptom the student sees.
    // Poll for it: a Pod passes through ContainerCreating before the kubelet
    // has attempted the pull, so reading once immediately after provisioning
    // would race the kubelet rather than test anything.
    const waitingReason = async (): Promise<string> =>
      (
        await kubectl(
          'get',
          'pods',
          '-o',
          'jsonpath={.items[*].status.containerStatuses[*].state.waiting.reason}',
        )
      ).stdout;

    const pullDeadline = Date.now() + 120_000;
    let reason = await waitingReason();
    while (!/ImagePullBackOff|ErrImagePull/.test(reason) && Date.now() < pullDeadline) {
      await sleep(3_000);
      reason = await waitingReason();
    }
    expect(reason).toMatch(/ImagePullBackOff|ErrImagePull/);

    // 3. The student repairs both faults, using whatever commands they like.
    const fixImage = await kubectl('set', 'image', 'deployment/ledger-api', 'ledger-api=nginx:stable');
    expect(fixImage.code, fixImage.stderr).toBe(0);
    const fixSelector = await kubectl(
      'patch',
      'service',
      'ledger-api',
      '-p',
      '{"spec":{"selector":{"app":"ledger-api"}}}',
    );
    expect(fixSelector.code, fixSelector.stderr).toBe(0);

    // 4. Check Solution now PASSES.
    const repaired = await checkUntilPassed(session);
    expect(repaired.passed, JSON.stringify(repaired.checks)).toBe(true);
    expect(repaired.summary).toBe('LAB PASSED');

    // 5. Reset restores the original broken scenario, so it can be replayed.
    const { result: reset } = await manager.reset(session.sessionId);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
    expect(reset.restored).toEqual(['setup/ledger-api.yaml']);

    const afterReset = await check(session);
    expect(afterReset.passed).toBe(false);

    const imageAfterReset = await kubectl('get', 'deployment', 'ledger-api', '-o', 'jsonpath={.spec.template.spec.containers[0].image}');
    expect(imageAfterReset.stdout).toBe('nginx:stabel');
    const selectorAfterReset = await kubectl('get', 'service', 'ledger-api', '-o', 'jsonpath={.spec.selector.app}');
    expect(selectorAfterReset.stdout).toBe('ledger');

    await manager.end(session.sessionId);
  }, 600_000);

  // ------------------------------------------------------ K8S-013 lifecycle

  it('K8S-013: fails on the old image, passes after a real rolling update, and resets', async () => {
    const session = await start('K8S-013');
    const kubectl = await studentKubectl(session);

    const imageNow = async (): Promise<string> =>
      (
        await kubectl(
          'get',
          'deployment',
          'payments-api',
          '-o',
          'jsonpath={.spec.template.spec.containers[0].image}',
        )
      ).stdout;

    // 1. Provisioning left the previous release in place, settled and serving.
    expect(await imageNow()).toBe('nginx:1.27-alpine');
    const rolledOut = await kubectl(
      'rollout',
      'status',
      'deployment/payments-api',
      '--timeout=180s',
    );
    expect(rolledOut.code, rolledOut.stderr).toBe(0);

    // 2. Check Solution initially FAILS, and only on the image.
    const before = await check(session);
    expect(before.passed).toBe(false);
    const beforeByLabel = Object.fromEntries(before.checks.map((c) => [c.label, c.status]));
    expect(beforeByLabel['Deployment payments-api still exists']).toBe('pass');
    expect(beforeByLabel['The original Deployment was updated, not replaced']).toBe('pass');
    expect(beforeByLabel['Three replicas are still requested']).toBe('pass');
    expect(beforeByLabel['Image is now nginx:1.28-alpine']).toBe('fail');
    expect(beforeByLabel['Rollout finished — no replica from the old version remains']).toBe('pass');
    expect(beforeByLabel['All three replicas are available']).toBe('pass');

    // 3. The student performs the rolling update in place.
    const setImage = await kubectl(
      'set',
      'image',
      'deployment/payments-api',
      'api=nginx:1.28-alpine',
    );
    expect(setImage.code, setImage.stderr).toBe(0);

    // 4. Check Solution now PASSES, once the rollout actually finishes.
    const after = await checkUntilPassed(session);
    expect(after.passed, JSON.stringify(after.checks)).toBe(true);
    expect(after.summary).toBe('LAB PASSED');

    // The old ReplicaSet really was drained rather than left running.
    const replicaSets = await kubectl(
      'get',
      'replicasets',
      '-o',
      'jsonpath={range .items[*]}{.spec.replicas}{"\\n"}{end}',
    );
    expect(replicaSets.stdout.trim().split('\n').filter((n) => n !== '0')).toEqual(['3']);

    // 5. Breaking one requirement fails the lab again. Rolling the image back
    //    is the honest way to break exactly one check and nothing else.
    const revert = await kubectl('set', 'image', 'deployment/payments-api', 'api=nginx:1.27-alpine');
    expect(revert.code, revert.stderr).toBe(0);

    const brokenDeadline = Date.now() + 60_000;
    let broken = await check(session);
    while (broken.passed && Date.now() < brokenDeadline) {
      await sleep(2_000);
      broken = await check(session);
    }
    expect(broken.passed).toBe(false);
    expect(
      broken.checks.filter((c) => c.status !== 'pass').map((c) => c.label),
    ).toContain('Image is now nginx:1.28-alpine');

    // 6. Repairing it passes again.
    const repair = await kubectl('set', 'image', 'deployment/payments-api', 'api=nginx:1.28-alpine');
    expect(repair.code, repair.stderr).toBe(0);
    expect((await checkUntilPassed(session)).passed).toBe(true);

    // 7. Reset restores the previous release, so the lab can be replayed.
    const { result: reset } = await manager.reset(session.sessionId);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
    expect(reset.restored).toEqual(['setup/payments-api.yaml']);

    expect(await imageNow()).toBe('nginx:1.27-alpine');
    const afterReset = await check(session);
    expect(afterReset.passed).toBe(false);

    await manager.end(session.sessionId);
  }, 600_000);

  // -------------------------------------- K8S-013 cannot be solved by recreating

  it('K8S-013 rejects a deleted-and-recreated Deployment, because the selector differs', async () => {
    const session = await start('K8S-013');
    const kubectl = await studentKubectl(session);

    const deleted = await kubectl('delete', 'deployment', 'payments-api');
    expect(deleted.code, deleted.stderr).toBe(0);

    // Right name, right image, right replica count — but `kubectl create
    // deployment` can only produce a single-label selector, and a Deployment's
    // selector is immutable, so the object cannot be made equivalent.
    const recreated = await kubectl(
      'create',
      'deployment',
      'payments-api',
      '--image=nginx:1.28-alpine',
      '--replicas=3',
    );
    expect(recreated.code, recreated.stderr).toBe(0);

    const result = await checkUntilPassed(session, 60_000);
    expect(result.passed).toBe(false);
    expect(result.checks.filter((c) => c.status !== 'pass').map((c) => c.label)).toEqual([
      'The original Deployment was updated, not replaced',
    ]);

    await manager.end(session.sessionId);
  }, 300_000);

  // ------------------------------------------------ setup lands in one place

  it('applies a lab fixture into the starting session namespace only', async () => {
    const a = await start('K8S-003');
    const b = await start('K8S-002');

    const kubectlA = await studentKubectl(a);
    const kubectlB = await studentKubectl(b);

    // K8S-003 seeds `accounts`; K8S-002 seeds nothing.
    expect((await kubectlA('get', 'deployment', 'accounts', '-o', 'name')).stdout.trim()).toBe(
      'deployment.apps/accounts',
    );
    const inB = await kubectlB('get', 'deployment', 'accounts');
    expect(inB.code).not.toBe(0);
    expect(inB.stderr).toMatch(/not found/i);

    await manager.end(a.sessionId);
    await manager.end(b.sessionId);
  }, 420_000);

  // --------------------------------------- 27–29. cross-session isolation

  it('K8S-002 session A cannot affect session B (test requirement 27)', async () => {
    const a = await start('K8S-002');
    const b = await start('K8S-002');

    expect(a.namespace).not.toBe(b.namespace);

    const kubectlA = await studentKubectl(a);
    const kubectlB = await studentKubectl(b);

    const created = await kubectlA('create', 'deployment', 'frontend', '--image=nginx:stable', '--replicas=3');
    expect(created.code, created.stderr).toBe(0);

    // B cannot see A's work, and cannot reach into A's namespace at all.
    expect((await kubectlB('get', 'deployment', 'frontend')).code).not.toBe(0);
    const crossRead = await kubectlB('get', 'deployments', '-n', a.namespace);
    expect(crossRead.code).not.toBe(0);
    expect(crossRead.stderr).toMatch(/forbidden/i);

    const crossWrite = await kubectlB('delete', 'deployment', 'frontend', '-n', a.namespace);
    expect(crossWrite.code).not.toBe(0);
    expect(crossWrite.stderr).toMatch(/forbidden/i);

    // A passes; B does not. (test requirement 29)
    const resultA = await checkUntilPassed(a);
    expect(resultA.passed, JSON.stringify(resultA.checks)).toBe(true);
    expect((await check(b)).passed).toBe(false);

    // A's Deployment survived B's attempt.
    expect((await kubectlA('get', 'deployment', 'frontend', '-o', 'name')).stdout.trim()).toBe(
      'deployment.apps/frontend',
    );

    await manager.end(a.sessionId);
    await manager.end(b.sessionId);
  }, 600_000);

  it('K8S-010 reset in session A does not modify session B (test requirement 28)', async () => {
    const a = await start('K8S-010');
    const b = await start('K8S-010');

    const kubectlA = await studentKubectl(a);
    const kubectlB = await studentKubectl(b);

    // Both students repair their own copy.
    for (const kubectl of [kubectlA, kubectlB]) {
      expect((await kubectl('set', 'image', 'deployment/ledger-api', 'ledger-api=nginx:stable')).code).toBe(0);
      expect(
        (await kubectl('patch', 'service', 'ledger-api', '-p', '{"spec":{"selector":{"app":"ledger-api"}}}')).code,
      ).toBe(0);
    }

    const repairedB = await checkUntilPassed(b);
    expect(repairedB.passed, JSON.stringify(repairedB.checks)).toBe(true);

    // A resets — which restores A's fault, and must leave B's repair alone.
    const { result: reset } = await manager.reset(a.sessionId);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    expect((await kubectlA('get', 'deployment', 'ledger-api', '-o', 'jsonpath={.spec.template.spec.containers[0].image}')).stdout).toBe('nginx:stabel');
    expect((await kubectlB('get', 'deployment', 'ledger-api', '-o', 'jsonpath={.spec.template.spec.containers[0].image}')).stdout).toBe('nginx:stable');

    expect((await check(a)).passed).toBe(false);
    expect((await check(b)).passed).toBe(true);

    await manager.end(a.sessionId);
    await manager.end(b.sessionId);
  }, 600_000);

  // ------------------------------------------------- PLATFORM-002 intact

  it('every lab gets the full PLATFORM-002 guardrail set', async () => {
    // One session per lab would be slow and pointless; a lab with setup and a
    // lab without it cover both provisioning paths.
    for (const labId of ['K8S-006', 'K8S-009']) {
      const session = await start(labId);

      const namespace = await k8s.getNamespace(session.namespace);
      expect(namespace?.labels['jumptotech.io/managed']).toBe('true');
      expect(namespace?.labels['jumptotech.io/lab-id']).toBe(labId);
      expect(session.namespace.startsWith('lab-')).toBe(true);

      const quota = await kubectlWith(HOST_KUBECONFIG, 'get', 'resourcequota', '-n', session.namespace, '-o', 'name');
      expect(quota.stdout).toContain('jumptotech-session-quota');
      const limits = await kubectlWith(HOST_KUBECONFIG, 'get', 'limitrange', '-n', session.namespace, '-o', 'name');
      expect(limits.stdout).toContain('jumptotech-session-limits');
      const netpol = await kubectlWith(HOST_KUBECONFIG, 'get', 'networkpolicy', '-n', session.namespace, '-o', 'name');
      expect(netpol.stdout).toContain('jumptotech-session-isolation');
      const rbac = await kubectlWith(HOST_KUBECONFIG, 'get', 'role,rolebinding,serviceaccount', '-n', session.namespace, '-o', 'name');
      expect(rbac.stdout).toContain('jumptotech-student');
      expect(rbac.stdout).toContain('serviceaccount/student');

      // Still no cluster-scoped grant anywhere in the session path.
      const kubectl = await studentKubectl(session);
      expect((await kubectl('get', 'nodes')).code).not.toBe(0);
      expect((await kubectl('get', 'namespaces')).code).not.toBe(0);

      await manager.end(session.sessionId);

      // End Lab really deletes the namespace.
      expect(await k8s.getNamespace(session.namespace)).toBeNull();
    }
  }, 600_000);
});
