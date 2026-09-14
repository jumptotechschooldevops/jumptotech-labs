/**
 * BETA-P0-015 — the session network contract, asserted as data.
 *
 * These tests prove what the platform *generates*. They cannot prove that a
 * cluster enforces it — that is `network-enforcement-probe` against a real
 * cluster, with its negative controls (`network-policy-enforcement-integration.test.ts`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_SESSION_POLICY,
  EXTERNAL_EGRESS_POLICY_SUFFIX,
  KUBE_APISERVER_POLICY_SUFFIX,
  LAB_CAPABILITIES,
  NetworkPolicyContractError,
  assertValidNetworkPolicyConfig,
  ipv4CidrContains,
  networkPolicyContractDigest,
  networkPolicyManifests,
  networkPolicyNames,
  parseLabDefinition,
  protectedResources,
  sessionGuardrailManifests,
  type KubernetesManifestObject,
  type NetworkPolicyConfig,
  type SessionPolicy,
} from '../src/index.js';
import { REPO_ROOT } from './helpers.js';

const POLICY: SessionPolicy = DEFAULT_SESSION_POLICY;
const NETWORK = POLICY.network;
const ENDPOINTS = [{ ip: '172.19.0.5', port: 6443 }];
const withNetwork = (overrides: Partial<NetworkPolicyConfig>): SessionPolicy => ({
  ...POLICY,
  network: { ...NETWORK, ...overrides },
});

type Peer = {
  podSelector?: { matchLabels?: Record<string, string> };
  namespaceSelector?: { matchLabels?: Record<string, string> };
  ipBlock?: { cidr: string; except?: string[] };
};
type Rule = { to?: Peer[]; from?: Peer[]; ports?: Array<{ protocol: string; port: number }> };
type Spec = { podSelector: object; policyTypes: string[]; ingress?: Rule[]; egress?: Rule[] };
const spec = (m: KubernetesManifestObject | undefined) => m!.spec as Spec;
const named = (policies: KubernetesManifestObject[], suffix: string) =>
  policies.find((p) => p.metadata.name === `${NETWORK.name}-${suffix}`);

describe('deny by default', () => {
  it('generates exactly the base policies plus the API server allowance', () => {
    const names = networkPolicyManifests(POLICY, { apiServerEndpoints: ENDPOINTS }).map((p) => p.metadata.name);

    expect(names).toEqual([...networkPolicyNames(NETWORK.name), `${NETWORK.name}-${KUBE_APISERVER_POLICY_SUFFIX}`]);
  });

  it('selects every Pod and denies both directions with no rules', () => {
    const deny = spec(networkPolicyManifests(POLICY)[0]);

    expect(deny).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
  });

  it('re-allows only same-namespace Pods, in both directions', () => {
    const same = spec(named(networkPolicyManifests(POLICY), 'allow-same-namespace'));

    expect(same.ingress).toEqual([{ from: [{ podSelector: {} }] }]);
    expect(same.egress).toEqual([{ to: [{ podSelector: {} }] }]);
  });

  it('grants no external egress by default', () => {
    expect(NETWORK.allowExternalEgress).toBe(false);
    const all = networkPolicyManifests(POLICY, { apiServerEndpoints: ENDPOINTS });

    expect(named(all, EXTERNAL_EGRESS_POLICY_SUFFIX)).toBeUndefined();
    // No ipBlock anywhere except the API server's own /32.
    const blocks = all.flatMap((p) => (spec(p).egress ?? []).flatMap((r) => r.to ?? [])).filter((peer) => peer.ipBlock);
    expect(blocks.map((b) => b.ipBlock!.cidr)).toEqual(['172.19.0.5/32']);
  });
});

describe('DNS', () => {
  it('allows port 53 to the DNS Pods only — namespace AND pod selector in one peer', () => {
    const rule = spec(named(networkPolicyManifests(POLICY), 'allow-dns')).egress!;

    expect(rule).toHaveLength(1);
    expect(rule[0]!.to).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ]);
    expect(rule[0]!.ports).toEqual([
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ]);
  });

  it('follows the configured DNS namespace and selector', () => {
    const rule = spec(
      named(
        networkPolicyManifests(withNetwork({ dnsNamespace: 'dns', dnsPodSelector: { app: 'coredns' } })),
        'allow-dns',
      ),
    ).egress![0]!;

    expect(rule.to![0]!.namespaceSelector!.matchLabels).toEqual({ 'kubernetes.io/metadata.name': 'dns' });
    expect(rule.to![0]!.podSelector!.matchLabels).toEqual({ app: 'coredns' });
  });
});

describe('API server allowance', () => {
  it('allows each endpoint on its own port only', () => {
    const rules = spec(
      named(
        networkPolicyManifests(POLICY, {
          apiServerEndpoints: [
            { ip: '10.0.0.10', port: 6443 },
            { ip: '10.0.0.11', port: 6443 },
            { ip: 'fd00::10', port: 443 },
          ],
        }),
        KUBE_APISERVER_POLICY_SUFFIX,
      ),
    ).egress!;

    expect(rules).toEqual([
      { to: [{ ipBlock: { cidr: '10.0.0.10/32' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
      { to: [{ ipBlock: { cidr: '10.0.0.11/32' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
      { to: [{ ipBlock: { cidr: 'fd00::10/128' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ]);
  });

  it('is omitted when no endpoint is known, and refuses a non-address', () => {
    expect(named(networkPolicyManifests(POLICY), KUBE_APISERVER_POLICY_SUFFIX)).toBeUndefined();
    expect(() => networkPolicyManifests(POLICY, { apiServerEndpoints: [{ ip: '0.0.0.0/0', port: 1 }] })).toThrow(
      NetworkPolicyContractError,
    );
  });
});

describe('external egress', () => {
  const permitted = withNetwork({ allowExternalEgress: true, additionalDeniedEgressCidrs: ['203.0.112.0/24'] });

  it('needs both the platform switch and the lab capability', () => {
    expect(named(networkPolicyManifests(permitted), EXTERNAL_EGRESS_POLICY_SUFFIX)).toBeUndefined();
    expect(
      named(networkPolicyManifests(permitted, { capabilities: ['external_egress'] }), EXTERNAL_EGRESS_POLICY_SUFFIX),
    ).toBeDefined();
  });

  it('refuses a lab that declares it on a platform that does not permit it', () => {
    expect(() => networkPolicyManifests(POLICY, { capabilities: ['external_egress'] })).toThrow(
      /declares environment\.capabilities: \[external_egress\].*ALLOW_EXTERNAL_EGRESS/,
    );
    expect(() => sessionGuardrailManifests(POLICY, ['external_egress'])).toThrow(NetworkPolicyContractError);
  });

  it('reaches public addresses and nothing private, as plain CIDRs', () => {
    const rule = spec(
      named(networkPolicyManifests(permitted, { capabilities: ['external_egress'] }), EXTERNAL_EGRESS_POLICY_SUFFIX),
    ).egress!;
    expect(rule).toHaveLength(1);
    expect(rule[0]!.ports).toBeUndefined();
    const cidrs = rule[0]!.to!.map((peer) => {
      expect(Object.keys(peer)).toEqual(['ipBlock']);
      expect(peer.ipBlock!.except).toBeUndefined();
      return peer.ipBlock!.cidr;
    });
    const reaches = (address: string) => cidrs.some((cidr) => ipv4CidrContains(cidr, address));

    for (const address of ['1.1.1.1', '8.8.8.8', '140.82.112.3']) expect(reaches(address), address).toBe(true);
    for (const address of [
      '10.244.3.7', // another session's Pod
      '10.96.0.1', // a Service
      '172.19.0.3', // the kind Docker network — measured reachable under the old rule
      '169.254.169.254', // instance metadata
      '192.168.1.10',
      '100.64.0.1',
      '203.0.112.9', // CLUSTER_EGRESS_DENY_CIDRS
    ]) {
      expect(reaches(address), address).toBe(false);
    }
    expect(cidrs).not.toContain('0.0.0.0/0');
  });

  it('never generates an ipBlock.except in any configuration', () => {
    for (const policy of [POLICY, permitted]) {
      for (const capabilities of [[], ['external_egress']] as const) {
        if (capabilities.length > 0 && !policy.network.allowExternalEgress) continue;
        const text = JSON.stringify(networkPolicyManifests(policy, { capabilities, apiServerEndpoints: ENDPOINTS }));
        expect(text).not.toContain('except');
      }
    }
  });
});

describe('configuration validation', () => {
  it('accepts the defaults', () => {
    expect(() => assertValidNetworkPolicyConfig(NETWORK)).not.toThrow();
  });

  it.each([
    [{ podCidr: '10.244.0.0' }, /CLUSTER_POD_CIDR/],
    [{ serviceCidr: '10.96.1.0/16' }, /CLUSTER_SERVICE_CIDR.*host bits/],
    [{ additionalDeniedEgressCidrs: ['nope'] }, /CLUSTER_EGRESS_DENY_CIDRS/],
    [{ dnsPodSelector: {} }, /every Pod in kube-system/],
    [{ dnsNamespace: ' ' }, /CLUSTER_DNS_NAMESPACE/],
    [{ attestation: { required: true, maxAgeSeconds: 0 } }, /MAX_AGE_SECONDS/],
  ] as Array<[Partial<NetworkPolicyConfig>, RegExp]>)('refuses %j', (overrides, message) => {
    expect(() => assertValidNetworkPolicyConfig({ ...NETWORK, ...overrides })).toThrow(message);
  });
});

describe('contract digest', () => {
  const digest = networkPolicyContractDigest(NETWORK);

  it('is stable across selector key order and deny-list order', () => {
    expect(
      networkPolicyContractDigest({ ...NETWORK, dnsPodSelector: { b: '2', a: '1' }, additionalDeniedEgressCidrs: ['2.0.0.0/8', '1.0.0.0/8'] }),
    ).toBe(
      networkPolicyContractDigest({ ...NETWORK, dnsPodSelector: { a: '1', b: '2' }, additionalDeniedEgressCidrs: ['1.0.0.0/8', '2.0.0.0/8'] }),
    );
  });

  it('changes with anything that changes what the policies say', () => {
    for (const overrides of [
      { podCidr: '10.42.0.0/16' },
      { serviceCidr: '10.43.0.0/16' },
      { allowExternalEgress: true },
      { additionalDeniedEgressCidrs: ['172.31.0.0/16'] },
      { dnsPodSelector: { 'k8s-app': 'coredns' } },
      { name: 'other' },
    ] as Array<Partial<NetworkPolicyConfig>>) {
      expect(networkPolicyContractDigest({ ...NETWORK, ...overrides }), JSON.stringify(overrides)).not.toBe(digest);
    }
  });

  it('ignores settings that do not change the policies', () => {
    expect(networkPolicyContractDigest({ ...NETWORK, attestation: { required: true, maxAgeSeconds: 60 } })).toBe(digest);
  });
});

describe('reset protection and lab capabilities', () => {
  it('protects the API server and external egress policies too', () => {
    const protectedSet = protectedResources(POLICY);

    expect(protectedSet).toContain(`networkpolicies/${NETWORK.name}-${KUBE_APISERVER_POLICY_SUFFIX}`);
    expect(protectedSet).toContain(`networkpolicies/${NETWORK.name}-${EXTERNAL_EGRESS_POLICY_SUFFIX}`);
  });

  it('offers external_egress, and no shipped lab declares it', () => {
    expect(LAB_CAPABILITIES).toContain('external_egress');

    const labFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === 'lab.yaml') labFiles.push(full);
      }
    };
    walk(path.join(REPO_ROOT, 'labs'));

    expect(labFiles.length).toBeGreaterThanOrEqual(114);
    const declaring = labFiles.filter((file) => /external_egress/.test(readFileSync(file, 'utf8')));
    expect(declaring).toEqual([]);
  });

  it('lets only the kubernetes provider declare external_egress', () => {
    // A shipped lab of each provider, so the schema is satisfied and the only
    // difference is the declared capability.
    const problems = (labFile: string): string => {
      const definition = parseYaml(readFileSync(path.join(REPO_ROOT, labFile), 'utf8')) as {
        environment: Record<string, unknown>;
      };
      definition.environment = { ...definition.environment, capabilities: ['external_egress'] };
      try {
        parseLabDefinition(JSON.stringify(definition), labFile);
        return '';
      } catch (error) {
        const issues = (error as { issues?: unknown }).issues;
        return `${(error as Error).message} ${JSON.stringify(issues ?? [])}`;
      }
    };

    expect(problems('labs/linux/linux-001-files/lab.yaml')).toMatch(
      /'external_egress' is only available to the 'kubernetes' provider, not 'linux'/,
    );
    expect(problems('labs/kubernetes/k8s-001-pods/lab.yaml')).toBe('');
  });
});
