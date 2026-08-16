/**
 * The guardrail manifests, asserted as data.
 *
 * Story tests 11–13 (ResourceQuota / LimitRange / NetworkPolicy exist) and the
 * shape of the RBAC that makes tests 7–9 (no namespaces, no kube-system, no
 * nodes) true. Whether the API server *enforces* them is proved against real
 * kind in `integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  STUDENT_ROLE,
  assertDeletable,
  limitRangeManifest,
  networkPolicyManifests,
  networkPolicyNames,
  ownershipLabels,
  protectedResources,
  resourceQuotaManifest,
  sessionGuardrailManifests,
  studentRbacManifests,
  type SessionPolicy,
} from '../src/index.js';

const POLICY: SessionPolicy = DEFAULT_SESSION_POLICY;

describe('ResourceQuota (story test 11)', () => {
  it('caps pods, services, PVCs, cpu and memory', () => {
    const quota = resourceQuotaManifest(POLICY);
    const hard = (quota.spec as { hard: Record<string, string> }).hard;

    expect(quota.kind).toBe('ResourceQuota');
    expect(hard.pods).toBe('15');
    expect(hard.services).toBe('10');
    expect(hard.persistentvolumeclaims).toBe('5');
    expect(hard['requests.cpu']).toBe('2');
    expect(hard['requests.memory']).toBe('2Gi');
    expect(hard['limits.cpu']).toBe('4');
    expect(hard['limits.memory']).toBe('4Gi');
  });

  it('forbids LoadBalancer and NodePort Services outright (cost safety)', () => {
    const hard = (resourceQuotaManifest(POLICY).spec as { hard: Record<string, string> }).hard;

    expect(hard['services.loadbalancers']).toBe('0');
    expect(hard['services.nodeports']).toBe('0');
  });

  it('is configurable rather than hardcoded', () => {
    const tuned = resourceQuotaManifest({ ...POLICY, quota: { ...POLICY.quota, pods: '3' } });

    expect((tuned.spec as { hard: Record<string, string> }).hard.pods).toBe('3');
  });
});

describe('LimitRange (story test 12)', () => {
  it('supplies container defaults so an unqualified kubectl run still works', () => {
    // The quota constrains requests.cpu/memory, so Kubernetes rejects any Pod
    // without requests. `kubectl run nginx --image=nginx:stable` sets none —
    // these defaults are what keep K8S-001 working exactly as taught.
    const limit = (limitRangeManifest(POLICY).spec as { limits: Array<Record<string, unknown>> })
      .limits[0]!;

    expect(limit.type).toBe('Container');
    expect(limit.defaultRequest).toEqual({ cpu: '50m', memory: '64Mi' });
    expect(limit.default).toEqual({ cpu: '500m', memory: '512Mi' });
    expect(limit.max).toEqual({ cpu: '1', memory: '1Gi' });
  });

  it('is configurable', () => {
    const tuned = limitRangeManifest({
      ...POLICY,
      limitRange: { ...POLICY.limitRange, defaultRequest: { cpu: '10m', memory: '16Mi' } },
    });
    const limit = (tuned.spec as { limits: Array<Record<string, unknown>> }).limits[0]!;

    expect(limit.defaultRequest).toEqual({ cpu: '10m', memory: '16Mi' });
  });
});

describe('NetworkPolicy (story test 13)', () => {
  it('denies by default, then re-allows same-namespace traffic and DNS', () => {
    const policies = networkPolicyManifests(POLICY);
    const byName = new Map(policies.map((p) => [p.metadata.name, p]));
    const [denyName, sameNsName, dnsName] = networkPolicyNames(POLICY.network.name);

    const deny = byName.get(denyName!)!;
    expect((deny.spec as { podSelector: object }).podSelector).toEqual({});
    expect((deny.spec as { policyTypes: string[] }).policyTypes).toEqual(['Ingress', 'Egress']);
    // A deny-all has no ingress/egress rules at all.
    expect((deny.spec as { ingress?: unknown }).ingress).toBeUndefined();
    expect((deny.spec as { egress?: unknown }).egress).toBeUndefined();

    const sameNs = byName.get(sameNsName!)!;
    expect((sameNs.spec as { ingress: Array<{ from: unknown[] }> }).ingress[0]?.from).toEqual([
      { podSelector: {} },
    ]);

    const dns = byName.get(dnsName!)!;
    const dnsPorts = (dns.spec as { egress: Array<{ ports: Array<{ port: number }> }> }).egress[0]
      ?.ports;
    expect(dnsPorts?.map((p) => p.port)).toEqual([53, 53]);
  });

  it('does not cut a student off from the internet by default', () => {
    // Egress to everything except the cluster's own Pod/Service CIDRs, so
    // `curl https://…` works from a lab Pod while pod-to-pod traffic to other
    // students stays blocked.
    const external = networkPolicyManifests(POLICY).find((p) =>
      p.metadata.name.endsWith('allow-external-egress'),
    );
    const rule = (external?.spec as { egress: Array<{ to: Array<{ ipBlock: { cidr: string; except: string[] } }> }> })
      .egress[0]?.to[0]?.ipBlock;

    expect(rule?.cidr).toBe('0.0.0.0/0');
    expect(rule?.except).toEqual([POLICY.network.podCidr, POLICY.network.serviceCidr]);
  });

  it('can be switched off entirely for a cluster whose CNI cannot enforce it', () => {
    const off = sessionGuardrailManifests({
      ...POLICY,
      network: { ...POLICY.network, enabled: false },
    });

    expect(off.some((m) => m.kind === 'NetworkPolicy')).toBe(false);
    // The other guardrails are unaffected.
    expect(off.some((m) => m.kind === 'ResourceQuota')).toBe(true);
  });
});

describe('student RBAC', () => {
  const manifests = studentRbacManifests(POLICY);
  const role = manifests.find((m) => m.kind === 'Role')!;
  const rules = (role as unknown as { rules: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }> })
    .rules;

  it('is namespace-scoped only — no ClusterRole, no ClusterRoleBinding', () => {
    expect(manifests.map((m) => m.kind)).toEqual(['ServiceAccount', 'Role', 'RoleBinding']);
  });

  it('grants the beginner lab operations inside the namespace', () => {
    const podRule = rules.find((r) => r.resources.includes('pods'))!;
    expect(podRule.verbs).toContain('create');
    expect(podRule.verbs).toContain('delete');

    for (const resource of ['services', 'configmaps', 'secrets', 'persistentvolumeclaims']) {
      expect(rules.some((r) => r.resources.includes(resource) && r.verbs.includes('create'))).toBe(
        true,
      );
    }
    for (const resource of ['deployments', 'replicasets', 'statefulsets', 'daemonsets']) {
      expect(
        rules.some(
          (r) => r.apiGroups.includes('apps') && r.resources.includes(resource) && r.verbs.includes('create'),
        ),
      ).toBe(true);
    }
    expect(
      rules.some((r) => r.apiGroups.includes('batch') && r.resources.includes('jobs')),
    ).toBe(true);
  });

  it('grants nothing over namespaces or nodes (story tests 7 and 9)', () => {
    for (const rule of rules) {
      expect(rule.resources).not.toContain('namespaces');
      expect(rule.resources).not.toContain('nodes');
      expect(rule.resources).not.toContain('persistentvolumes');
    }
  });

  it('grants no write access to RBAC, so the student cannot escalate', () => {
    const rbacRules = rules.filter((r) => r.apiGroups.includes('rbac.authorization.k8s.io'));
    expect(rbacRules).toEqual([]);
  });

  it('makes the quota and network policy readable but not editable', () => {
    const quotaRule = rules.find((r) => r.resources.includes('resourcequotas'))!;
    expect(quotaRule.verbs).toEqual(['get', 'list', 'watch']);

    const netRule = rules.find(
      (r) => r.apiGroups.includes('networking.k8s.io') && r.resources.includes('networkpolicies'),
    )!;
    expect(netRule.verbs).toEqual(['get', 'list', 'watch']);
  });
});

describe('reset protection', () => {
  it('protects every platform-owned object in the namespace', () => {
    const protectedSet = protectedResources(POLICY);

    expect(protectedSet).toContain(`resourcequotas/${POLICY.quotaName}`);
    expect(protectedSet).toContain(`limitranges/${POLICY.limitRange.name}`);
    expect(protectedSet).toContain(`serviceaccounts/${POLICY.serviceAccountName}`);
    expect(protectedSet).toContain(`roles/${STUDENT_ROLE}`);
    for (const name of networkPolicyNames(POLICY.network.name)) {
      expect(protectedSet).toContain(`networkpolicies/${name}`);
    }
  });
});

describe('ownership labels and the cleanup gate (story test 25)', () => {
  it('stamps the labels the story specifies', () => {
    const labels = ownershipLabels({
      sessionId: 'sess-a84fc21a',
      labId: 'K8S-001',
      expiresAtMs: 1_700_000_000_000,
    });

    expect(labels['jumptotech.io/managed']).toBe('true');
    expect(labels['jumptotech.io/session-id']).toBe('sess-a84fc21a');
    expect(labels['jumptotech.io/lab-id']).toBe('K8S-001');
    expect(labels['jumptotech.io/expires-at']).toBe('1700000000000');
  });

  it('permits deletion only for a labelled, non-protected, matching namespace', () => {
    const labels = ownershipLabels({ sessionId: 'sess-a84fc21a', labId: 'K8S-001' });

    expect(assertDeletable('lab-0000000000aa', labels, 'sess-a84fc21a').managed).toBe(true);
    // No session constraint: the orphan sweep's case.
    expect(assertDeletable('lab-0000000000aa', labels).managed).toBe(true);
  });

  it.each(['default', 'kube-system', 'kube-public', 'kube-node-lease'])(
    'refuses %s even when hand-labelled as managed',
    (name) => {
      const labels = ownershipLabels({ sessionId: 'sess-a84fc21a', labId: 'K8S-001' });
      const result = assertDeletable(name, labels, 'sess-a84fc21a');

      expect(result.managed).toBe(false);
      expect(result.reason).toMatch(/protected cluster namespace/);
    },
  );

  it('refuses an unlabelled or absent namespace', () => {
    expect(assertDeletable('lab-0000000000aa', {}).managed).toBe(false);
    expect(assertDeletable('lab-0000000000aa', null).managed).toBe(false);
  });

  it('refuses another session’s namespace', () => {
    const labels = ownershipLabels({ sessionId: 'sess-aaaaaaaaaaaaaaaa', labId: 'K8S-001' });
    const result = assertDeletable('lab-0000000000aa', labels, 'sess-bbbbbbbbbbbbbbbb');

    expect(result.managed).toBe(false);
    expect(result.reason).toMatch(/belongs to/);
  });
});
