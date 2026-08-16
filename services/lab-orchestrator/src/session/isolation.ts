/**
 * Per-session isolation guardrails.
 *
 * Every sandbox is one namespace in one shared cluster. That namespace carries
 * four things before the student ever sees a prompt:
 *
 *   ServiceAccount  — the identity the student's kubectl authenticates as
 *   RBAC            — a Role/RoleBinding whose rights stop at the namespace edge
 *   ResourceQuota   — a hard ceiling on what the session may consume
 *   LimitRange      — per-container defaults, so an unqualified `kubectl run`
 *                     still satisfies the quota, plus min/max bounds
 *   NetworkPolicy   — deny-by-default, with intra-namespace traffic and DNS
 *                     explicitly re-allowed
 *
 * Cost rule: this is the *whole* per-session footprint. No cluster, no node,
 * no load balancer, no public IP, and no database is created for a lab.
 *
 * **No cluster-scoped object is created per session.** There is deliberately no
 * ClusterRole and no ClusterRoleBinding here: the student's identity is
 * namespace-scoped and nothing else. `kubectl get nodes`, `kubectl get ns`, and
 * every other cluster-level read are therefore Forbidden — see README →
 * Multi-student architecture for why that is a decision and not an oversight.
 *
 * The functions below are pure builders. They take a policy and return manifest
 * objects, which makes the entire guardrail set assertable in a unit test
 * without a cluster.
 */
import type { KubernetesManifestObject } from '../k8s/port.js';
import { componentLabels } from '../k8s/labels.js';
import type { SessionPolicy } from './types.js';

/** ServiceAccount the student's shell authenticates as. */
export const STUDENT_SERVICE_ACCOUNT = 'student';
export const STUDENT_ROLE = 'jumptotech-student';
export const STUDENT_ROLE_BINDING = 'jumptotech-student';

export const DEFAULT_RESOURCE_QUOTA_NAME = 'jumptotech-session-quota';
export const DEFAULT_LIMIT_RANGE_NAME = 'jumptotech-session-limits';
export const DEFAULT_NETWORK_POLICY_NAME = 'jumptotech-session-isolation';

/** Suffixes appended to the configured NetworkPolicy base name. */
export const NETWORK_POLICY_SUFFIXES = ['default-deny', 'allow-same-namespace', 'allow-dns'] as const;

export function networkPolicyNames(base: string): string[] {
  return NETWORK_POLICY_SUFFIXES.map((suffix) => `${base}-${suffix}`);
}

/**
 * Platform-owned objects inside a session namespace.
 *
 * Reset purges student resources; these must survive it, or the second half of
 * a lab would run without a quota, without RBAC, or without its network policy.
 */
export function protectedResources(policy: SessionPolicy): string[] {
  return [
    `resourcequotas/${policy.quotaName}`,
    `limitranges/${policy.limitRange.name}`,
    `serviceaccounts/${policy.serviceAccountName}`,
    'serviceaccounts/default',
    `roles/${STUDENT_ROLE}`,
    `rolebindings/${STUDENT_ROLE_BINDING}`,
    ...networkPolicyNames(policy.network.name).map((name) => `networkpolicies/${name}`),
    'configmaps/kube-root-ca.crt',
    'services/kubernetes',
  ];
}

export function resourceQuotaManifest(policy: SessionPolicy): KubernetesManifestObject {
  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name: policy.quotaName, labels: componentLabels('quota') },
    spec: { hard: { ...policy.quota } },
  };
}

/**
 * Per-container defaults and bounds.
 *
 * The defaults matter as much as the ceilings: because the ResourceQuota
 * constrains `requests.cpu`/`requests.memory`, Kubernetes rejects any Pod
 * without requests. `kubectl run nginx --image=nginx:stable` sets none, so the
 * LimitRange supplies them and the first lab still works exactly as taught.
 */
export function limitRangeManifest(policy: SessionPolicy): KubernetesManifestObject {
  const limit: Record<string, unknown> = {
    type: 'Container',
    default: { ...policy.limitRange.default },
    defaultRequest: { ...policy.limitRange.defaultRequest },
  };
  if (policy.limitRange.max) limit.max = { ...policy.limitRange.max };

  return {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: { name: policy.limitRange.name, labels: componentLabels('limits') },
    spec: { limits: [limit] },
  };
}

/**
 * Deny-by-default, then re-allow exactly what a lab genuinely needs: traffic
 * between the session's own Pods, and DNS.
 *
 * Three policies rather than one, because NetworkPolicies are additive and
 * splitting them keeps each one readable — and lets a lab-facing test assert
 * "the deny-all exists" independently of the allow rules.
 *
 * What this does NOT do: image pulls are performed by the kubelet, not by the
 * Pod, so they are unaffected. Enforcement depends on the CNI — see
 * README → Known limitations.
 */
export function networkPolicyManifests(policy: SessionPolicy): KubernetesManifestObject[] {
  const [denyName, sameNsName, dnsName] = networkPolicyNames(policy.network.name) as [
    string,
    string,
    string,
  ];
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
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': policy.network.dnsNamespace },
                },
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

  if (policy.network.allowExternalEgress) {
    // Everything outside the cluster's own Pod/Service ranges. This keeps
    // `curl https://…` working from a lab Pod while still cutting pod-to-pod
    // traffic to other students' namespaces.
    policies.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: `${policy.network.name}-allow-external-egress`, labels },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                ipBlock: {
                  cidr: '0.0.0.0/0',
                  except: [policy.network.podCidr, policy.network.serviceCidr],
                },
              },
            ],
          },
        ],
      },
    });
  }

  return policies;
}

/**
 * Namespace-scoped rights for the student.
 *
 * Two deliberate read-only carve-outs: the quota/limit objects and the network
 * policies are visible but not editable, so a student cannot raise their own
 * budget or remove their own isolation. There is no `rbac.authorization.k8s.io`
 * write access, so the ServiceAccount cannot grant itself anything further, and
 * no rule mentions namespaces, nodes, or any cluster-scoped resource.
 */
export function studentRbacManifests(policy: SessionPolicy): KubernetesManifestObject[] {
  const write = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];
  const read = ['get', 'list', 'watch'];
  const labels = componentLabels('rbac');

  return [
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: policy.serviceAccountName, labels },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: STUDENT_ROLE, labels },
      rules: [
        {
          apiGroups: [''],
          resources: [
            'pods',
            'pods/log',
            'pods/exec',
            'pods/attach',
            'pods/portforward',
            'pods/status',
            'services',
            'configmaps',
            'secrets',
            'serviceaccounts',
            'events',
            'endpoints',
            'persistentvolumeclaims',
            'replicationcontrollers',
          ],
          verbs: write,
        },
        { apiGroups: [''], resources: ['resourcequotas', 'limitranges'], verbs: read },
        {
          apiGroups: ['apps'],
          resources: [
            'deployments',
            'deployments/scale',
            'deployments/status',
            'replicasets',
            'replicasets/scale',
            'statefulsets',
            'statefulsets/scale',
            'daemonsets',
            'controllerrevisions',
          ],
          verbs: write,
        },
        { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: write },
        { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: write },
        { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: write },
        { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: read },
        { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: read },
        { apiGroups: ['metrics.k8s.io'], resources: ['pods'], verbs: read },
        { apiGroups: ['events.k8s.io'], resources: ['events'], verbs: read },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: STUDENT_ROLE_BINDING, labels },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: STUDENT_ROLE },
      subjects: [{ kind: 'ServiceAccount', name: policy.serviceAccountName }],
    },
  ];
}

/**
 * Everything applied into a fresh session namespace, in dependency order.
 *
 * LimitRange before ResourceQuota, so that the first Pod created after the
 * quota lands already has defaulted requests to satisfy it.
 */
export function sessionGuardrailManifests(policy: SessionPolicy): KubernetesManifestObject[] {
  return [
    limitRangeManifest(policy),
    resourceQuotaManifest(policy),
    ...(policy.network.enabled ? networkPolicyManifests(policy) : []),
    ...studentRbacManifests(policy),
  ];
}
