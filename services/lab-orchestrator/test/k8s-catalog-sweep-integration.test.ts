/**
 * Every Kubernetes lab, started on real kind the way a student starts it.
 *
 * `labs-integration.test.ts` walks a handful of Kubernetes labs to a PASS. This
 * asks the questions a student's first minutes ask, of every lab whose provider
 * is `kubernetes` — the K8S track and the networking labs that run on it:
 *
 *   1. **Start** succeeds: the namespace, guardrails and the lab's fixtures are
 *      applied, and its setup verification held (the provider waits for it).
 *   2. **Check** before any work does not pass: the lab does not begin solved.
 *   3. **Reset** succeeds, and the Check that follows grades exactly as the
 *      first one did: Reset returns the lab to where Start left it.
 *   4. **End Lab** removes the namespace.
 *
 * A Check reads live objects, and a fixture's rollout can still be settling in
 * the seconds after Start or Reset returns, so the post-Reset grades are polled
 * until they match rather than compared once.
 *
 * Tier: E2E. Gated on RUN_INTEGRATION_TESTS=1 and a kind kubeconfig, like the
 * rest of the kind job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  KubernetesClient,
  LabRegistry,
  SessionManager,
} from '../src/index.js';
import { verifyLab, waitForRequirements } from '@jumptotech/verifier';
import { realCatalog } from './real-catalog.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_KUBECONFIG =
  process.env.KUBECONFIG ?? path.join(repoRoot, 'infrastructure/kind/generated/kubeconfig-host.yaml');
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1' && existsSync(HOST_KUBECONFIG);

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    `[k8s-catalog-sweep] skipped — set RUN_INTEGRATION_TESTS=1 and ensure ${HOST_KUBECONFIG} exists`,
  );
}

const NAMESPACE_SECRET = 'k8s-catalog-sweep-namespace-secret';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Kubernetes lab ids, read from disk so a new lab joins the sweep by existing. */
const LAB_IDS = (await realCatalog())
  .all()
  .filter((lab) => lab.environment.provider === 'kubernetes')
  .map((lab) => lab.id)
  .sort();

describe.runIf(ENABLED)('every Kubernetes lab on real kind', () => {
  let k8s: KubernetesClient;
  let provider: KindLabProvider;
  let registry: LabRegistry;
  let manager: SessionManager;
  const created = new Set<string>();

  beforeAll(async () => {
    registry = await realCatalog();
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
    for (const namespace of created) {
      await provider.destroyNamespace(namespace).catch(() => undefined);
    }
  }, 300_000);

  /** Label → status for one Check of a session's namespace. */
  async function grades(labId: string, namespace: string): Promise<{ passed: boolean; byLabel: Record<string, string> }> {
    const result = await verifyLab({ k8s, lab: registry.get(labId), namespace });
    return {
      passed: result.passed,
      byLabel: Object.fromEntries(result.checks.map((c) => [c.label, c.status])),
    };
  }

  it.each(LAB_IDS)(
    '%s starts, does not begin solved, resets to its start, and ends',
    async (labId) => {
      // 1. Start.
      const { session } = await manager.start(labId);
      created.add(session.namespace);

      try {
        // 2. Check before any work.
        const initial = await grades(labId, session.namespace);
        expect(Object.keys(initial.byLabel).length).toBeGreaterThan(0);
        expect(initial.passed, `${labId} passes its Check before any work`).toBe(false);

        // 3. Reset, then — once any rollout settles — the same grades as at Start.
        const { result: reset } = await manager.reset(session.sessionId);
        expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
        const deadline = Date.now() + 90_000;
        let after = await grades(labId, session.namespace);
        while (JSON.stringify(after.byLabel) !== JSON.stringify(initial.byLabel) && Date.now() < deadline) {
          await sleep(3_000);
          after = await grades(labId, session.namespace);
        }
        expect(after.byLabel).toEqual(initial.byLabel);
      } finally {
        // 4. End Lab.
        await manager.end(session.sessionId);
      }

      const gone = Date.now() + 150_000;
      while ((await k8s.namespaceExists(session.namespace)) && Date.now() < gone) await sleep(3_000);
      expect(await k8s.namespaceExists(session.namespace), `${labId} namespace left behind`).toBe(false);
      created.delete(session.namespace);
    },
    900_000,
  );
});
