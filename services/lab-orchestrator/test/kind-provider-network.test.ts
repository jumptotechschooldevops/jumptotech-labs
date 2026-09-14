/**
 * BETA-P0-015 — what the Kubernetes provider does with the network contract.
 *
 *   - the API server allowance comes from the cluster's own endpoints;
 *   - with an attestation required, no namespace is created and the track is
 *     unavailable until a current PASS for this contract is on the cluster;
 *   - a lab declaring external egress on a platform that forbids it does not
 *     start.
 *
 * Against the in-memory fake: whether any of this is *enforced* is
 * `network-policy-enforcement-integration.test.ts`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  KindLabProvider,
  NETWORK_ATTESTATION_NAME,
  NETWORK_ATTESTATION_NAMESPACE,
  attestationConfigMap,
  networkPolicyContractDigest,
  type EnforcementVerdict,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeKubernetes, fakeExec } from './fakes.js';
import { loadK8s001, sessionContext } from './helpers.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');

let lab: LoadedLabDefinition;
let CONTEXT: LabSessionContext;

beforeAll(async () => {
  lab = await loadK8s001();
  CONTEXT = sessionContext(lab);
});

function makeProvider(k8s: FakeKubernetes, required: boolean) {
  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    exec: fakeExec(),
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
    now: () => NOW,
    ...(required ? { networkPolicyAttestation: { required: true, network: CONTEXT.policy.network } } : {}),
  });
  vi.spyOn(provider, 'execute').mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false });
  return provider;
}

function clusterWithAttestation(verdict: EnforcementVerdict = 'PASS', digest?: string) {
  const manifest = attestationConfigMap({
    verdict,
    clusterUid: 'uid-kube-system',
    policyDigest: digest ?? networkPolicyContractDigest(CONTEXT.policy.network),
    verifiedAt: new Date(NOW - 60_000).toISOString(),
    probeVersion: 'beta-p0-015.1',
    kubernetesVersion: 'v1.34.0',
    checks: 'with-policy assertion session A -> session B pod expected=blocked observed=blocked',
    nodeLocalEgress: 'reachable',
  }) as unknown as { data: Record<string, string> };
  return new FakeKubernetes({
    configMaps: {
      [NETWORK_ATTESTATION_NAMESPACE]: [
        { name: NETWORK_ATTESTATION_NAME, namespace: NETWORK_ATTESTATION_NAMESPACE, data: manifest.data },
      ],
    },
  });
}

const policyNames = (k8s: FakeKubernetes) =>
  k8s.appliedKinds(CONTEXT.namespace, 'NetworkPolicy').map((p) => p.metadata.name);

describe('guardrails', () => {
  it("allows the API server at the cluster's own endpoints, and grants no external egress", async () => {
    const k8s = new FakeKubernetes({ apiServerEndpoints: [{ ip: '10.1.2.3', port: 6443 }] });

    const result = await makeProvider(k8s, false).create(CONTEXT);

    expect(result.ok).toBe(true);
    expect(policyNames(k8s)).toEqual([
      'jumptotech-session-isolation-default-deny',
      'jumptotech-session-isolation-allow-same-namespace',
      'jumptotech-session-isolation-allow-dns',
      'jumptotech-session-isolation-allow-kube-apiserver',
    ]);
    const apiserver = k8s
      .appliedKinds(CONTEXT.namespace, 'NetworkPolicy')
      .find((p) => p.metadata.name.endsWith('allow-kube-apiserver'))!;
    expect(JSON.stringify(apiserver.spec)).toContain('"cidr":"10.1.2.3/32"');
    expect(JSON.stringify(k8s.appliedKinds(CONTEXT.namespace))).not.toContain('except');
  });

  it('refuses to start a lab declaring external egress on a platform that forbids it', async () => {
    const k8s = new FakeKubernetes();
    const declaring: LabSessionContext = {
      ...CONTEXT,
      lab: { ...lab, environment: { ...lab.environment, capabilities: ['external_egress'] } },
    };

    const result = await makeProvider(k8s, false).create(declaring);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PROVISION_FAILED');
    expect(result.error?.message).toMatch(/ALLOW_EXTERNAL_EGRESS/);
    expect(policyNames(k8s)).toEqual([]);
  });
});

describe('enforcement attestation gate', () => {
  it('admits no student, and creates no namespace, without an attestation', async () => {
    const k8s = new FakeKubernetes();

    const result = await makeProvider(k8s, true).create(CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error?.message).toMatch(/network isolation is not proven.*no NetworkPolicy enforcement attestation/);
    expect(result.error?.remediation).toMatch(/verify:network-policy/);
    expect(result.steps.map((s) => s.id)).toEqual(['network-isolation-verified']);
    expect(await k8s.namespaceExists(CONTEXT.namespace)).toBe(false);
    expect(k8s.applied.size).toBe(0);
  });

  // Factories, not fakes: the table is built at collection time, before
  // `beforeAll` has loaded the lab the digest is computed from.
  it.each([
    ['a FAIL', () => clusterWithAttestation('FAIL'), /reported FAIL/],
    ['an INCONCLUSIVE', () => clusterWithAttestation('INCONCLUSIVE'), /reported INCONCLUSIVE/],
    ['a proof of a different contract', () => clusterWithAttestation('PASS', 'f'.repeat(64)), /different network policy contract/],
  ])('refuses %s', async (_label, cluster, reason) => {
    const k8s = cluster();
    const result = await makeProvider(k8s, true).create(CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(reason);
    expect(await k8s.namespaceExists(CONTEXT.namespace)).toBe(false);
  });

  it('admits once a current PASS for this contract is on the cluster', async () => {
    const k8s = clusterWithAttestation();

    const result = await makeProvider(k8s, true).create(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ id: 'network-isolation-verified', status: 'ok' });
    expect(await k8s.namespaceExists(CONTEXT.namespace)).toBe(true);
  });

  it('reports the track unavailable until proven, and available after', async () => {
    const unproven = JSON.stringify(await makeProvider(new FakeKubernetes(), true).availability());
    const proven = await makeProvider(clusterWithAttestation(), true).availability();
    const ungated = await makeProvider(new FakeKubernetes(), false).availability();

    expect(unproven).toMatch(/network isolation is not proven/);
    expect(unproven).toMatch(/verify:network-policy/);
    expect(proven).toEqual(ungated);
  });

  it('is not consulted when not required (local development)', async () => {
    const result = await makeProvider(new FakeKubernetes(), false).create(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.id)).not.toContain('network-isolation-verified');
  });
});
