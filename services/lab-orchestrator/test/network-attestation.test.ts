/**
 * BETA-P0-015 — the enforcement attestation, and the verdict rules of the probe
 * that writes it.
 *
 * The probe's *measurements* are real only against a real cluster
 * (`network-policy-enforcement-integration.test.ts`). What can be pinned here is
 * that nothing short of a clean, controlled, current, cluster-bound PASS admits a
 * student — and that a cluster which accepts policies without enforcing them
 * cannot produce one.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  NETWORK_ATTESTATION_NAME,
  NETWORK_ATTESTATION_NAMESPACE,
  attestationConfigMap,
  evaluateAttestation,
  networkPolicyContractDigest,
  probeReportToAttestation,
  probeVerdict,
  readNetworkEnforcementAttestation,
  type ConfigMapSnapshot,
  type NetworkEnforcementAttestation,
  type ProbeCheck,
} from '../src/index.js';
import { FakeKubernetes } from './fakes.js';

const NETWORK = DEFAULT_SESSION_POLICY.network;
const NOW = Date.parse('2026-09-14T12:00:00Z');

function attestation(overrides: Partial<NetworkEnforcementAttestation> = {}): NetworkEnforcementAttestation {
  return {
    verdict: 'PASS',
    clusterUid: 'uid-kube-system',
    policyDigest: networkPolicyContractDigest(NETWORK),
    verifiedAt: '2026-09-14T11:00:00.000Z',
    probeVersion: 'beta-p0-015.1',
    kubernetesVersion: 'v1.34.0',
    checks: 'with-policy assertion session A -> session B pod expected=blocked observed=blocked',
    nodeLocalEgress: 'reachable',
    ...overrides,
  };
}

function configMap(data: NetworkEnforcementAttestation | Record<string, string>): ConfigMapSnapshot {
  const manifest = 'verdict' in data && 'clusterUid' in data
    ? (attestationConfigMap(data as NetworkEnforcementAttestation) as unknown as { data: Record<string, string> })
    : { data: data as Record<string, string> };
  return { name: NETWORK_ATTESTATION_NAME, namespace: NETWORK_ATTESTATION_NAMESPACE, data: manifest.data };
}

const decide = (map: ConfigMapSnapshot | null, overrides: { clusterUid?: string; network?: typeof NETWORK; nowMs?: number } = {}) =>
  evaluateAttestation({
    configMap: map,
    clusterUid: 'clusterUid' in overrides ? overrides.clusterUid : 'uid-kube-system',
    network: overrides.network ?? NETWORK,
    nowMs: overrides.nowMs ?? NOW,
  });

describe('evaluateAttestation', () => {
  it('accepts a current PASS for this cluster and this contract', () => {
    expect(decide(configMap(attestation()))).toMatchObject({ ok: true });
  });

  it.each([
    ['no attestation', null, {}, /no NetworkPolicy enforcement attestation/],
    ['a FAIL', configMap(attestation({ verdict: 'FAIL' })), {}, /reported FAIL, not PASS/],
    ['an INCONCLUSIVE', configMap(attestation({ verdict: 'INCONCLUSIVE' })), {}, /INCONCLUSIVE, not PASS/],
    ['another cluster', configMap(attestation({ clusterUid: 'uid-other' })), {}, /different cluster/],
    ['an unidentifiable cluster', configMap(attestation()), { clusterUid: undefined }, /cannot identify this cluster/],
    ['a changed contract', configMap(attestation()), { network: { ...NETWORK, podCidr: '10.42.0.0/16' } }, /different network policy contract/],
    ['a stale proof', configMap(attestation({ verifiedAt: '2026-09-01T00:00:00Z' })), {}, /older than NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS/],
    ['a future timestamp', configMap(attestation({ verifiedAt: '2026-09-14T13:00:00Z' })), {}, /in the future/],
    ['a garbage timestamp', configMap(attestation({ verifiedAt: 'yesterday' })), {}, /not a timestamp/],
    ['an unknown schema', configMap({ ...attestation(), schema: '0' }), {}, /unsupported attestation schema/],
    ['a missing field', configMap({ schema: '1', verdict: 'PASS' }), {}, /missing 'clusterUid'/],
    ['an invented verdict', configMap({ ...attestation(), schema: '1', verdict: 'OK' }), {}, /not PASS, FAIL or INCONCLUSIVE/],
    ['disabled policies', configMap(attestation()), { network: { ...NETWORK, enabled: false } }, /nothing to attest/],
  ] as const)('refuses %s', (_label, map, overrides, reason) => {
    const decision = decide(map, overrides);
    expect(decision.ok).toBe(false);
    expect(decision.ok ? '' : decision.reason).toMatch(reason);
  });

  it('reads the ConfigMap and the cluster identity through the Kubernetes port', async () => {
    const k8s = new FakeKubernetes({ configMaps: { [NETWORK_ATTESTATION_NAMESPACE]: [configMap(attestation())] } });

    await expect(readNetworkEnforcementAttestation(k8s, NETWORK, NOW)).resolves.toMatchObject({ ok: true });
    await expect(readNetworkEnforcementAttestation(new FakeKubernetes(), NETWORK, NOW)).resolves.toMatchObject({ ok: false });
  });
});

const c = (overrides: Partial<ProbeCheck>): ProbeCheck => ({
  name: 'x',
  phase: 'with-policy',
  role: 'assertion',
  expected: 'blocked',
  observed: 'blocked',
  ...overrides,
});

describe('probeVerdict', () => {
  const clean = [
    c({ name: 'A -> B', phase: 'without-policy', role: 'control', expected: 'reachable', observed: 'reachable' }),
    c({ name: 'A -> own', expected: 'reachable', observed: 'reachable' }),
    c({ name: 'A -> B' }),
    c({ name: 'node', role: 'informational', expected: null, observed: 'reachable' }),
  ];

  it('passes only when every control held and every assertion matched', () => {
    expect(probeVerdict(clean)).toEqual({ verdict: 'PASS', reasons: [] });
  });

  it('fails a cluster that accepts policies but does not enforce them', () => {
    const ignored = clean.map((check) => (check.expected === 'blocked' ? { ...check, observed: 'reachable' as const } : check));

    expect(probeVerdict(ignored)).toMatchObject({ verdict: 'FAIL' });
  });

  it('is inconclusive when the negative control could not connect in the first place', () => {
    const noControl = clean.map((check) => (check.role === 'control' ? { ...check, observed: 'blocked' as const } : check));

    expect(probeVerdict(noControl)).toMatchObject({ verdict: 'INCONCLUSIVE', reasons: [expect.stringMatching(/control failed/)] });
  });

  it('prefers FAIL over INCONCLUSIVE when a leak was observed anyway', () => {
    const both = [...clean.slice(0, 2).map((check) => ({ ...check, observed: 'blocked' as const })), c({ observed: 'reachable' })];

    expect(probeVerdict(both).verdict).toBe('FAIL');
  });

  it('fails a contract that breaks what labs need', () => {
    expect(probeVerdict([...clean, c({ name: 'DNS', expected: 'reachable', observed: 'blocked' })]).verdict).toBe('FAIL');
  });

  it('never passes on informational checks alone', () => {
    expect(probeVerdict([c({ role: 'informational', expected: null })]).verdict).toBe('INCONCLUSIVE');
  });

  it('carries the verdict, cluster and digest into the attestation it writes', () => {
    const written = probeReportToAttestation({
      verdict: 'PASS',
      reasons: [],
      checks: clean,
      clusterUid: 'uid-kube-system',
      kubernetesVersion: 'v1.34.0',
      policyDigest: networkPolicyContractDigest(NETWORK),
      externalEgressPermitted: false,
      nodeLocalEgress: 'reachable',
      namespaces: [],
      startedAt: '2026-09-14T11:59:00.000Z',
      finishedAt: '2026-09-14T11:59:30.000Z',
    });

    expect(decide(configMap(written))).toMatchObject({ ok: true });
    expect(written.checks.split('\n')).toHaveLength(clean.length);
  });
});
