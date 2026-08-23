import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import { labelsMatch } from './k8s-helpers.js';

export const networkPolicyExists: VerifierHandler<'networkpolicy_exists'> = {
  type: 'networkpolicy_exists',
  label: (r) => `NetworkPolicy ${r.name} exists`,
  async run(r, reader) {
    const policy = await reader.networkPolicy(r.name);
    if (!policy) return missing('NetworkPolicy', r.name, reader.namespace);
    if (policy.deleting) return fail(`NetworkPolicy '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const networkPolicyPodSelector: VerifierHandler<'networkpolicy_pod_selector'> = {
  type: 'networkpolicy_pod_selector',
  label: (r) => `NetworkPolicy ${r.name} selects the intended Pods`,
  async run(r, reader) {
    const policy = await reader.networkPolicy(r.name);
    if (!policy) return missing('NetworkPolicy', r.name, reader.namespace);
    const problems = labelsMatch(policy.podSelector, r.matchLabels);
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const networkPolicyPolicyTypes: VerifierHandler<'networkpolicy_policy_types'> = {
  type: 'networkpolicy_policy_types',
  label: (r) => `NetworkPolicy ${r.name} applies to ${r.policyTypes.join(' and ')} traffic`,
  async run(r, reader) {
    const policy = await reader.networkPolicy(r.name);
    if (!policy) return missing('NetworkPolicy', r.name, reader.namespace);
    const missingType = r.policyTypes.find((type) => !policy.policyTypes.includes(type));
    return missingType
      ? fail(`Policy type '${missingType}' not found — NetworkPolicy has ${policy.policyTypes.join(', ') || 'none'}`)
      : pass();
  },
};

export const networkPolicyIngressRule: VerifierHandler<'networkpolicy_ingress_rule'> = {
  type: 'networkpolicy_ingress_rule',
  label: (r) => `NetworkPolicy ${r.name} allows the required ingress traffic`,
  async run(r, reader) {
    const policy = await reader.networkPolicy(r.name);
    if (!policy) return missing('NetworkPolicy', r.name, reader.namespace);
    const match = policy.ingress.some((rule) => ingressRuleMatches(rule, r));
    return match ? pass() : fail('NetworkPolicy has no matching ingress rule');
  },
};

export const networkPolicyEgressRule: VerifierHandler<'networkpolicy_egress_rule'> = {
  type: 'networkpolicy_egress_rule',
  label: (r) => `NetworkPolicy ${r.name} allows the required egress traffic`,
  async run(r, reader) {
    const policy = await reader.networkPolicy(r.name);
    if (!policy) return missing('NetworkPolicy', r.name, reader.namespace);
    const match = policy.egress.some((rule) => egressRuleMatches(rule, r));
    return match ? pass() : fail('NetworkPolicy has no matching egress rule');
  },
};

export const networkPolicyAllowsDns: VerifierHandler<'networkpolicy_allows_dns'> = {
  type: 'networkpolicy_allows_dns',
  label: (r) => `NetworkPolicy ${r.name} allows DNS egress on port 53`,
  async run(r, reader) {
    const policy = await reader.networkPolicy(r.name);
    if (!policy) return missing('NetworkPolicy', r.name, reader.namespace);

    const allowsDns = policy.egress.some((rule) =>
      rule.ports.some(
        (port) =>
          port.port === 53 &&
          (port.protocol === 'UDP' || port.protocol === 'TCP' || port.protocol === undefined),
      ),
    );
    return allowsDns ? pass() : fail('NetworkPolicy does not allow egress to port 53 for DNS');
  },
};

function ingressRuleMatches(
  rule: {
    peers: Array<{ podSelector?: Record<string, string>; namespaceSelector?: Record<string, string> }>;
    ports: Array<{ port?: number; protocol?: string }>;
  },
  want: {
    fromPodSelector?: Record<string, string>;
    fromNamespaceSelector?: Record<string, string>;
    port?: number;
    protocol?: string;
  },
): boolean {
  const peerOk =
    want.fromPodSelector === undefined &&
    want.fromNamespaceSelector === undefined
      ? true
      : rule.peers.some(
          (peer) =>
            (want.fromPodSelector === undefined ||
              labelsMatch(peer.podSelector ?? {}, want.fromPodSelector).length === 0) &&
            (want.fromNamespaceSelector === undefined ||
              labelsMatch(peer.namespaceSelector ?? {}, want.fromNamespaceSelector).length === 0),
        );
  const portOk =
    want.port === undefined
      ? true
      : rule.ports.some(
          (port) =>
            port.port === want.port &&
            (want.protocol === undefined || port.protocol === want.protocol),
        );
  return peerOk && portOk;
}

function egressRuleMatches(
  rule: {
    peers: Array<{ podSelector?: Record<string, string>; namespaceSelector?: Record<string, string> }>;
    ports: Array<{ port?: number; protocol?: string }>;
  },
  want: {
    toPodSelector?: Record<string, string>;
    toNamespaceSelector?: Record<string, string>;
    port?: number;
    protocol?: string;
  },
): boolean {
  return ingressRuleMatches(rule, {
    fromPodSelector: want.toPodSelector,
    fromNamespaceSelector: want.toNamespaceSelector,
    port: want.port,
    protocol: want.protocol,
  });
}
