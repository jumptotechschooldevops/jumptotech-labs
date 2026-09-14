/**
 * The per-session network contract (BETA-P0-015).
 *
 * Every session namespace is deny-by-default in both directions, then gets back
 * exactly what a lab needs:
 *
 *   default-deny          — no ingress, no egress
 *   allow-same-namespace  — this session's Pods to each other
 *   allow-dns             — egress to the cluster DNS Pods, port 53 only
 *   allow-kube-apiserver  — egress to the API server's own endpoints, on their
 *                           port only (K8S-012's in-cluster client needs it)
 *   allow-external-egress — the *public* internet, and only for a lab that
 *                           declares `external_egress` on a platform that
 *                           permits it
 *
 * What this module can and cannot promise: it generates objects. Whether they
 * are enforced is a property of the cluster's network implementation, which is
 * why production admits no student until
 * `network-attestation.ts` finds a behavioural proof for *this* contract on
 * *this* cluster. See docs/kubernetes-network-security.md.
 *
 * Two defects this replaces, both measured on kind (kindnetd, Kubernetes 1.34):
 *
 *   1. External egress was `0.0.0.0/0 except <pod CIDR>, <service CIDR>`, and it
 *      was on by default. Everything else in private address space stayed
 *      reachable: a session Pod opened TCP connections to the development api
 *      container on the kind Docker network (172.19.0.3:4000) and to a second
 *      cluster's API server. It is now off by default, per lab, and excludes all
 *      non-public space.
 *   2. The DNS rule allowed port 53 to *every* Pod in kube-system. It now names
 *      the DNS Pods.
 */
import { createHash } from 'node:crypto';
import type { ApiServerEndpoint, KubernetesManifestObject } from '../k8s/port.js';
import { componentLabels } from '../k8s/labels.js';
import {
  CidrError,
  NON_PUBLIC_IPV4_CIDRS,
  ipv4Complement,
  parseIpv4Address,
  parseIpv4Cidr,
} from '../k8s/cidr.js';
import type { LabCapability } from './isolation.js';
import type { NetworkPolicyConfig, SessionPolicy } from './types.js';

/** Policies every session namespace carries. */
export const NETWORK_POLICY_SUFFIXES = ['default-deny', 'allow-same-namespace', 'allow-dns'] as const;
/** Present whenever the API server's endpoints could be resolved. */
export const KUBE_APISERVER_POLICY_SUFFIX = 'allow-kube-apiserver';
/** Present only for a lab declaring `external_egress` on a platform that permits it. */
export const EXTERNAL_EGRESS_POLICY_SUFFIX = 'allow-external-egress';

/**
 * Bumped whenever the *shape* of the generated policies changes, so an
 * enforcement attestation recorded against the old shape stops being accepted.
 */
export const NETWORK_POLICY_CONTRACT_VERSION = 'beta-p0-015.1';

/** The three policies every session namespace carries. */
export function networkPolicyNames(base: string): string[] {
  return NETWORK_POLICY_SUFFIXES.map((suffix) => `${base}-${suffix}`);
}

/** Every policy name this module can generate, for reset protection. */
export function allNetworkPolicyNames(base: string): string[] {
  return [
    ...networkPolicyNames(base),
    `${base}-${KUBE_APISERVER_POLICY_SUFFIX}`,
    `${base}-${EXTERNAL_EGRESS_POLICY_SUFFIX}`,
  ];
}

export class NetworkPolicyContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyContractError';
  }
}

/**
 * Refuse a configuration that would generate a policy meaning something other
 * than what it says. Called when configuration is loaded, so a typo in a CIDR
 * stops the API rather than silently widening a student's reach.
 */
export function assertValidNetworkPolicyConfig(config: NetworkPolicyConfig): void {
  const cidrs: Array<[string, string]> = [
    ['CLUSTER_POD_CIDR', config.podCidr],
    ['CLUSTER_SERVICE_CIDR', config.serviceCidr],
    ...config.additionalDeniedEgressCidrs.map((cidr): [string, string] => ['CLUSTER_EGRESS_DENY_CIDRS', cidr]),
  ];
  for (const [variable, cidr] of cidrs) {
    try {
      parseIpv4Cidr(cidr);
    } catch (error) {
      const reason = error instanceof CidrError ? error.message : String(error);
      throw new NetworkPolicyContractError(`${variable}: ${reason}`);
    }
  }
  if (config.dnsNamespace.trim() === '') {
    throw new NetworkPolicyContractError('CLUSTER_DNS_NAMESPACE must name the namespace running cluster DNS');
  }
  if (Object.keys(config.dnsPodSelector).length === 0) {
    throw new NetworkPolicyContractError(
      `CLUSTER_DNS_POD_SELECTOR is empty, which would allow port 53 to every Pod in ${config.dnsNamespace}`,
    );
  }
  if (!Number.isInteger(config.attestation.maxAgeSeconds) || config.attestation.maxAgeSeconds <= 0) {
    throw new NetworkPolicyContractError('NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS must be a positive integer');
  }
}

/** What external egress never reaches: non-public space, the cluster's ranges, and any extra. */
export function externalEgressDeniedCidrs(config: NetworkPolicyConfig): string[] {
  return [
    ...NON_PUBLIC_IPV4_CIDRS,
    config.podCidr,
    config.serviceCidr,
    ...config.additionalDeniedEgressCidrs,
  ];
}

/** The public IPv4 internet, as plain CIDR blocks — never an `except`. */
export function externalEgressAllowedCidrs(config: NetworkPolicyConfig): string[] {
  return ipv4Complement(externalEgressDeniedCidrs(config));
}

export interface NetworkPolicyBuildOptions {
  capabilities?: readonly LabCapability[];
  /** The `default/kubernetes` endpoints, resolved from the cluster at apply time. */
  apiServerEndpoints?: readonly ApiServerEndpoint[];
}

function endpointCidr(ip: string): string {
  if (ip.includes(':')) {
    if (!/^[0-9a-f:]+$/i.test(ip)) throw new NetworkPolicyContractError(`API server endpoint '${ip}' is not an IP address`);
    return `${ip}/128`;
  }
  try {
    parseIpv4Address(ip);
  } catch {
    throw new NetworkPolicyContractError(`API server endpoint '${ip}' is not an IP address`);
  }
  return `${ip}/32`;
}

/**
 * The session's NetworkPolicies.
 *
 * Throws `NetworkPolicyContractError` for a lab that declares external egress on
 * a platform that does not permit it: starting that lab without the access it
 * declares would hand the student a broken environment and call it ready.
 */
export function networkPolicyManifests(
  policy: SessionPolicy,
  options: NetworkPolicyBuildOptions = {},
): KubernetesManifestObject[] {
  const network = policy.network;
  const [denyName, sameNsName, dnsName] = networkPolicyNames(network.name) as [string, string, string];
  const labels = componentLabels('network');

  const policies: KubernetesManifestObject[] = [
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: denyName, labels },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: sameNsName, labels },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: [{ podSelector: {} }] }],
        egress: [{ to: [{ podSelector: {} }] }],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: dnsName, labels },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [
          {
            // One peer carrying both selectors means namespace AND pod — the
            // DNS Pods, not everything that happens to run in kube-system.
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': network.dnsNamespace },
                },
                podSelector: { matchLabels: { ...network.dnsPodSelector } },
              },
            ],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
        ],
      },
    },
  ];

  const endpoints = options.apiServerEndpoints ?? [];
  if (endpoints.length > 0) {
    const portsByCidr = new Map<string, Set<number>>();
    for (const endpoint of endpoints) {
      const cidr = endpointCidr(endpoint.ip);
      const ports = portsByCidr.get(cidr) ?? new Set<number>();
      ports.add(endpoint.port);
      portsByCidr.set(cidr, ports);
    }
    policies.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: `${network.name}-${KUBE_APISERVER_POLICY_SUFFIX}`, labels },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [...portsByCidr].map(([cidr, ports]) => ({
          to: [{ ipBlock: { cidr } }],
          ports: [...ports].sort((a, b) => a - b).map((port) => ({ protocol: 'TCP', port })),
        })),
      },
    });
  }

  if (options.capabilities?.includes('external_egress')) {
    if (!network.allowExternalEgress) {
      throw new NetworkPolicyContractError(
        'this lab declares environment.capabilities: [external_egress], but the platform does not permit external egress (ALLOW_EXTERNAL_EGRESS is not true)',
      );
    }
    policies.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: `${network.name}-${EXTERNAL_EGRESS_POLICY_SUFFIX}`, labels },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [{ to: externalEgressAllowedCidrs(network).map((cidr) => ({ ipBlock: { cidr } })) }],
      },
    });
  }

  return policies;
}

/**
 * A stable fingerprint of everything that decides what the policies say.
 *
 * An enforcement attestation records it, so changing a CIDR, the DNS selector,
 * or the policy shape itself invalidates the proof instead of inheriting it.
 */
export function networkPolicyContractDigest(config: NetworkPolicyConfig): string {
  const canonical = {
    contract: NETWORK_POLICY_CONTRACT_VERSION,
    name: config.name,
    dnsNamespace: config.dnsNamespace,
    dnsPodSelector: Object.fromEntries(
      Object.entries(config.dnsPodSelector).sort(([a], [b]) => a.localeCompare(b)),
    ),
    podCidr: config.podCidr,
    serviceCidr: config.serviceCidr,
    allowExternalEgress: config.allowExternalEgress,
    additionalDeniedEgressCidrs: [...config.additionalDeniedEgressCidrs].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
