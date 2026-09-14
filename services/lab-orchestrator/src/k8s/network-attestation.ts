/**
 * Proof that a cluster enforces the session network contract (BETA-P0-015).
 *
 * A cluster accepts NetworkPolicy objects whether or not anything enforces
 * them. So "the policies were applied" is not evidence of isolation, and the
 * platform does not treat it as such where it matters: with
 * `NETWORK_POLICY_ATTESTATION_REQUIRED` (forced on under NODE_ENV=production)
 * the Kubernetes provider admits no student until it finds an attestation that
 *
 *   - was written by the behavioural probe (`network-enforcement-probe.ts`,
 *     run by `npm run verify:network-policy -- --write-attestation`),
 *   - has verdict PASS — a failed or inconclusive probe is not a pass,
 *   - belongs to *this* cluster (the kube-system namespace UID),
 *   - was measured against *this* contract (the policy digest), and
 *   - is not older than the configured maximum age.
 *
 * What it does not prove: anything the probe does not measure. Pod-to-node
 * traffic is outside NetworkPolicy on common CNIs, and the attestation says so
 * rather than implying otherwise. Anyone able to write ConfigMaps in
 * kube-system can forge one — that is cluster-admin, which is already
 * everything.
 */
import type { ConfigMapSnapshot, KubernetesManifestObject, KubernetesPort } from './port.js';
import { networkPolicyContractDigest } from '../session/network-policy.js';
import type { NetworkPolicyConfig } from '../session/types.js';

export const NETWORK_ATTESTATION_NAMESPACE = 'kube-system';
export const NETWORK_ATTESTATION_NAME = 'jumptotech-network-policy-enforcement';
export const NETWORK_ATTESTATION_SCHEMA = '1';

/** How far in the future a timestamp may be before it is refused as forged or skewed. */
const CLOCK_SKEW_MS = 5 * 60_000;

export const NETWORK_ATTESTATION_REMEDIATION =
  'Run `npm run verify:network-policy -- --write-attestation` against this cluster with the deployment\'s network configuration.';

export type EnforcementVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface NetworkEnforcementAttestation {
  verdict: EnforcementVerdict;
  clusterUid: string;
  policyDigest: string;
  verifiedAt: string;
  probeVersion: string;
  kubernetesVersion: string;
  /** One line per check, `name expected=… observed=…`. */
  checks: string;
  /** Measured and reported, never part of the verdict — see the module header. */
  nodeLocalEgress: string;
}

export type AttestationDecision =
  | { ok: true; attestation: NetworkEnforcementAttestation }
  | { ok: false; reason: string };

export function attestationConfigMap(attestation: NetworkEnforcementAttestation): KubernetesManifestObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: NETWORK_ATTESTATION_NAME,
      labels: { 'app.kubernetes.io/managed-by': 'jumptotech-network-policy-probe' },
    },
    data: { schema: NETWORK_ATTESTATION_SCHEMA, ...attestation },
  } as KubernetesManifestObject;
}

const REQUIRED_KEYS = [
  'verdict',
  'clusterUid',
  'policyDigest',
  'verifiedAt',
  'probeVersion',
  'kubernetesVersion',
  'checks',
  'nodeLocalEgress',
] as const;

export function parseAttestationData(
  data: Record<string, string>,
): NetworkEnforcementAttestation | { error: string } {
  if (data.schema !== NETWORK_ATTESTATION_SCHEMA) {
    return { error: `unsupported attestation schema '${data.schema ?? '<missing>'}'` };
  }
  for (const key of REQUIRED_KEYS) {
    if (typeof data[key] !== 'string' || data[key] === '') return { error: `attestation is missing '${key}'` };
  }
  if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(data.verdict!)) {
    return { error: `attestation verdict '${data.verdict}' is not PASS, FAIL or INCONCLUSIVE` };
  }
  return Object.fromEntries(REQUIRED_KEYS.map((key) => [key, data[key]!])) as unknown as NetworkEnforcementAttestation;
}

export function evaluateAttestation(input: {
  configMap: ConfigMapSnapshot | null;
  clusterUid: string | undefined;
  network: NetworkPolicyConfig;
  nowMs: number;
}): AttestationDecision {
  const { configMap, clusterUid, network, nowMs } = input;
  const where = `${NETWORK_ATTESTATION_NAMESPACE}/${NETWORK_ATTESTATION_NAME}`;

  if (!network.enabled) {
    return { ok: false, reason: 'NetworkPolicy is disabled (NETWORK_POLICY_ENABLED=false), so there is nothing to attest' };
  }
  if (!configMap) {
    return { ok: false, reason: `no NetworkPolicy enforcement attestation found at ${where}` };
  }
  const parsed = parseAttestationData(configMap.data);
  if ('error' in parsed) return { ok: false, reason: `${where}: ${parsed.error}` };

  if (parsed.verdict !== 'PASS') {
    return { ok: false, reason: `the last enforcement probe on this cluster reported ${parsed.verdict}, not PASS` };
  }
  if (!clusterUid) {
    return { ok: false, reason: 'cannot identify this cluster (kube-system has no UID), so the attestation cannot be bound to it' };
  }
  if (parsed.clusterUid !== clusterUid) {
    return { ok: false, reason: 'the attestation was recorded on a different cluster (kube-system UID mismatch)' };
  }
  const expectedDigest = networkPolicyContractDigest(network);
  if (parsed.policyDigest !== expectedDigest) {
    return {
      ok: false,
      reason: 'the attestation was measured against a different network policy contract than this deployment generates',
    };
  }
  const verifiedAtMs = Date.parse(parsed.verifiedAt);
  if (Number.isNaN(verifiedAtMs)) {
    return { ok: false, reason: `attestation verifiedAt '${parsed.verifiedAt}' is not a timestamp` };
  }
  if (verifiedAtMs > nowMs + CLOCK_SKEW_MS) {
    return { ok: false, reason: `attestation verifiedAt ${parsed.verifiedAt} is in the future` };
  }
  const ageSeconds = Math.floor((nowMs - verifiedAtMs) / 1000);
  if (ageSeconds > network.attestation.maxAgeSeconds) {
    return {
      ok: false,
      reason: `the attestation is ${ageSeconds}s old, older than NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS=${network.attestation.maxAgeSeconds}`,
    };
  }
  return { ok: true, attestation: parsed };
}

/** Read and evaluate this cluster's attestation. Never throws for a missing object. */
export async function readNetworkEnforcementAttestation(
  k8s: KubernetesPort,
  network: NetworkPolicyConfig,
  nowMs: number,
): Promise<AttestationDecision> {
  const [configMap, kubeSystem] = await Promise.all([
    k8s.getConfigMap(NETWORK_ATTESTATION_NAMESPACE, NETWORK_ATTESTATION_NAME),
    k8s.getNamespace(NETWORK_ATTESTATION_NAMESPACE),
  ]);
  return evaluateAttestation({ configMap, clusterUid: kubeSystem?.uid, network, nowMs });
}
