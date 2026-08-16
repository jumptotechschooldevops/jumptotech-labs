/**
 * Provider behaviour against the in-memory fake.
 *
 * Covers PLATFORM-001 requirements 3 (environment health) and 7 (reset), plus
 * the PLATFORM-002 additions: guardrail application, namespace-scoped
 * credentials, and the cleanup-safety gates on namespace deletion.
 *
 * `integration.test.ts` runs the same ideas against a real kind cluster —
 * anything that depends on the API server actually *enforcing* something
 * (RBAC, quota admission) is proved there, not here.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  KindLabProvider,
  MANAGED_LABEL,
  SESSION_LABEL,
  STUDENT_ROLE,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeKubernetes, podSnapshot } from './fakes.js';
import { loadK8s001, sessionContext } from './helpers.js';

let lab: LoadedLabDefinition;
let CONTEXT: LabSessionContext;

beforeAll(async () => {
  lab = await loadK8s001();
  CONTEXT = sessionContext(lab);
});

/** Provider with `execute()` stubbed so tests never shell out to kubectl. */
function makeProvider(k8s: FakeKubernetes, kubectlOk = true) {
  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
  });
  vi.spyOn(provider, 'execute').mockResolvedValue(
    kubectlOk
      ? { exitCode: 0, stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }), stderr: '', timedOut: false }
      : { exitCode: 127, stdout: '', stderr: 'kubectl: command not found', timedOut: false },
  );
  return provider;
}

/** A fake whose cluster already contains this session's namespace. */
function withSessionNamespace(options: ConstructorParameters<typeof FakeKubernetes>[0] = {}) {
  return new FakeKubernetes({
    ...options,
    namespaces: [
      'default',
      'kube-system',
      [
        CONTEXT.namespace,
        { [MANAGED_LABEL]: 'true', [SESSION_LABEL]: CONTEXT.sessionId },
      ],
      ...(options.namespaces ?? []),
    ],
  });
}

describe('environment health (test requirement 3)', () => {
  it('reports ready when the API is up and all nodes are Ready', async () => {
    const info = await makeProvider(withSessionNamespace()).status(CONTEXT);

    expect(info.phase).toBe('ready');
    expect(info.provider).toBe('kind');
    expect(info.namespace).toBe(CONTEXT.namespace);
    expect(info.sessionId).toBe(CONTEXT.sessionId);
    expect(info.kubernetesVersion).toBe('v1.34.0');
    expect(info.nodes?.[0]?.name).toBe('jumptotech-labs-control-plane');
  });

  it('reports degraded when a node is NotReady', async () => {
    const k8s = withSessionNamespace({
      nodes: [{ name: 'cp', ready: false, roles: ['control-plane'], version: 'v1.34.0' }],
    });

    const info = await makeProvider(k8s).status(CONTEXT);

    expect(info.phase).toBe('degraded');
    expect(info.message).toContain('cp');
  });

  it('reports error with the real transport message when the API is down', async () => {
    const k8s = withSessionNamespace({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });

    const info = await makeProvider(k8s).status(CONTEXT);

    expect(info.phase).toBe('error');
    expect(info.message).toContain('ECONNREFUSED');
  });

  it('reports not_created when the session namespace is missing', async () => {
    const info = await makeProvider(new FakeKubernetes()).status(CONTEXT);

    expect(info.phase).toBe('not_created');
    expect(info.message).toContain(CONTEXT.namespace);
  });
});

describe('create()', () => {
  it('reports every provisioning step in order on success', async () => {
    const result = await makeProvider(new FakeKubernetes()).create(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.id)).toEqual(['environment-created', 'kubernetes-api', 'kubectl']);
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(result.environment.phase).toBe('ready');
    expect(result.error).toBeUndefined();
  });

  it('creates the namespace with the ownership labels cleanup depends on', async () => {
    const k8s = new FakeKubernetes();

    await makeProvider(k8s).create(CONTEXT);

    const ns = await k8s.getNamespace(CONTEXT.namespace);
    expect(ns).not.toBeNull();
    expect(ns?.labels[MANAGED_LABEL]).toBe('true');
    expect(ns?.labels[SESSION_LABEL]).toBe(CONTEXT.sessionId);
    expect(ns?.labels['jumptotech.io/lab-id']).toBe('K8S-001');
    expect(Number(ns?.labels['jumptotech.io/expires-at'])).toBe(CONTEXT.expiresAtMs);
  });

  it('applies quota, limits, network policy and namespace-scoped RBAC', async () => {
    const k8s = new FakeKubernetes();

    await makeProvider(k8s).create(CONTEXT);

    const kinds = k8s.appliedKinds(CONTEXT.namespace).map((o) => o.kind);
    expect(kinds).toContain('ResourceQuota');
    expect(kinds).toContain('LimitRange');
    expect(kinds).toContain('NetworkPolicy');
    expect(kinds).toContain('ServiceAccount');
    expect(kinds).toContain('Role');
    expect(kinds).toContain('RoleBinding');
  });

  it('creates no cluster-scoped object at all', async () => {
    const k8s = new FakeKubernetes();

    await makeProvider(k8s).create(CONTEXT);

    // Every applied object landed in the session namespace, and none of them is
    // a cluster-scoped RBAC kind. A student identity that cannot be bound to a
    // ClusterRole cannot reach cluster scope.
    expect([...k8s.applied.keys()]).toEqual([CONTEXT.namespace]);
    const kinds = k8s.appliedKinds(CONTEXT.namespace).map((o) => o.kind);
    expect(kinds).not.toContain('ClusterRole');
    expect(kinds).not.toContain('ClusterRoleBinding');
  });

  it('binds the Role only to this session’s ServiceAccount', async () => {
    const k8s = new FakeKubernetes();

    await makeProvider(k8s).create(CONTEXT);

    const binding = k8s.appliedKinds(CONTEXT.namespace, 'RoleBinding')[0] as unknown as {
      roleRef: { kind: string; name: string };
      subjects: Array<{ kind: string; name: string; namespace?: string }>;
    };
    expect(binding.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: STUDENT_ROLE,
    });
    expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: 'student' }]);
  });

  it('refuses a namespace that is not a lab sandbox name', async () => {
    const p = makeProvider(new FakeKubernetes());

    await expect(p.create({ ...CONTEXT, namespace: 'kube-system' })).rejects.toThrow(
      /Invalid lab namespace/,
    );
    await expect(p.create({ ...CONTEXT, namespace: 'default' })).rejects.toThrow(
      /Invalid lab namespace/,
    );
  });

  it('fails with the real error — never a fake "ready" — when the API is down', async () => {
    const k8s = new FakeKubernetes({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });

    const result = await makeProvider(k8s).create(CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.environment.phase).toBe('error');
    expect(result.error?.message).toContain('ECONNREFUSED');
    expect(result.steps.some((s) => s.status === 'failed')).toBe(true);
  });

  it('fails when kubectl is unavailable', async () => {
    const result = await makeProvider(new FakeKubernetes(), /* kubectlOk */ false).create(CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('KUBECTL_UNAVAILABLE');
    expect(result.error?.message).toContain('command not found');
  });

  it('is idempotent — a second create still succeeds', async () => {
    const p = makeProvider(new FakeKubernetes());

    expect((await p.create(CONTEXT)).ok).toBe(true);
    expect((await p.create(CONTEXT)).ok).toBe(true);
  });
});

describe('reset() (test requirement 7)', () => {
  it('removes student resources and reports what went', async () => {
    const k8s = withSessionNamespace({
      pods: { [`lab-0000000000aa`]: [podSnapshot(), podSnapshot({ name: 'extra' })] },
      resources: {
        'lab-0000000000aa/deployments': [{ resource: 'deployments', name: 'web' }],
        'lab-0000000000aa/services': [{ resource: 'services', name: 'kubernetes' }],
        'lab-0000000000aa/configmaps': [{ resource: 'configmaps', name: 'kube-root-ca.crt' }],
      },
    });

    const result = await makeProvider(k8s).reset(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual(['pods/nginx', 'pods/extra', 'deployments/web']);
    expect(await k8s.countPods(CONTEXT.namespace)).toBe(0);
  });

  it('never deletes protected cluster-managed objects', async () => {
    const k8s = withSessionNamespace({
      resources: {
        'lab-0000000000aa/services': [{ resource: 'services', name: 'kubernetes' }],
        'lab-0000000000aa/configmaps': [{ resource: 'configmaps', name: 'kube-root-ca.crt' }],
      },
    });

    await makeProvider(k8s).reset(CONTEXT);

    expect(k8s.deleted).toEqual([]);
    expect(await k8s.listNamespacedResources(CONTEXT.namespace, 'services')).toHaveLength(1);
  });

  it('never strips the session of its own guardrails', async () => {
    // A reset that could delete the quota, the RBAC, or the network policy
    // would silently un-isolate the second half of a lab.
    const k8s = withSessionNamespace({
      resources: {
        'lab-0000000000aa/resourcequotas': [
          { resource: 'resourcequotas', name: 'jumptotech-session-quota' },
        ],
        'lab-0000000000aa/limitranges': [
          { resource: 'limitranges', name: 'jumptotech-session-limits' },
        ],
        'lab-0000000000aa/serviceaccounts': [{ resource: 'serviceaccounts', name: 'student' }],
        'lab-0000000000aa/roles': [{ resource: 'roles', name: STUDENT_ROLE }],
        'lab-0000000000aa/rolebindings': [{ resource: 'rolebindings', name: STUDENT_ROLE }],
        'lab-0000000000aa/networkpolicies': [
          { resource: 'networkpolicies', name: 'jumptotech-session-isolation-default-deny' },
        ],
      },
    });

    // Ask reset to purge exactly the kinds the guardrails live in.
    const greedy = {
      ...CONTEXT,
      lab: {
        ...lab,
        reset: {
          ...lab.reset,
          purge_namespaced_resources: [
            'resourcequotas',
            'limitranges',
            'serviceaccounts',
            'roles',
            'rolebindings',
            'networkpolicies',
          ],
        },
      },
    } as LabSessionContext;

    const result = await makeProvider(k8s).reset(greedy);

    expect(result.ok).toBe(true);
    expect(k8s.deleted).toEqual([]);
  });

  it('succeeds on an already-clean namespace', async () => {
    const result = await makeProvider(withSessionNamespace()).reset(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('confirms cluster health as part of the reset', async () => {
    const result = await makeProvider(withSessionNamespace()).reset(CONTEXT);

    expect(result.steps.find((s) => s.id === 'health')?.status).toBe('ok');
    expect(result.environment.phase).toBe('ready');
  });

  it('reports failure when the cluster is unreachable', async () => {
    const k8s = withSessionNamespace({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });

    const result = await makeProvider(k8s).reset(CONTEXT);

    expect(result.ok).toBe(false);
    // A connectivity failure is reported as such wherever it surfaces, so the
    // UI can say "the cluster is down" rather than "your reset failed".
    expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
    expect(result.error?.message).toContain('ECONNREFUSED');
  });

  it('lets the lab be attempted repeatedly', async () => {
    const k8s = withSessionNamespace();
    const p = makeProvider(k8s);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      k8s.pods.set(CONTEXT.namespace, [podSnapshot()]);
      expect(await k8s.countPods(CONTEXT.namespace)).toBe(1);
      expect((await p.reset(CONTEXT)).ok).toBe(true);
      expect(await k8s.countPods(CONTEXT.namespace)).toBe(0);
    }
  });
});

describe('issueCredentials()', () => {
  it('mints a namespace-scoped kubeconfig for the session ServiceAccount', async () => {
    const k8s = withSessionNamespace();

    const credentials = await makeProvider(k8s).issueCredentials(CONTEXT);

    expect(k8s.tokenRequests).toHaveLength(1);
    expect(k8s.tokenRequests[0]?.namespace).toBe(CONTEXT.namespace);
    expect(k8s.tokenRequests[0]?.serviceAccount).toBe('student');

    expect(credentials.namespace).toBe(CONTEXT.namespace);
    expect(credentials.serviceAccountName).toBe('student');
    // The context defaults to the session namespace, which is why the student
    // never has to type `-n lab-…`.
    expect(credentials.kubeconfig).toContain(`namespace: ${CONTEXT.namespace}`);
    expect(credentials.kubeconfig).toContain('token: fake-token');
  });

  it('never outlives the session', async () => {
    const k8s = withSessionNamespace();
    const p = makeProvider(k8s);

    // Ten minutes of session left, but a two-hour configured credential TTL.
    await p.issueCredentials({
      ...CONTEXT,
      expiresAtMs: Date.now() + 10 * 60_000,
      policy: { ...CONTEXT.policy, credentialTtlSeconds: 7_200 },
    });

    expect(k8s.tokenRequests[0]?.expirationSeconds).toBeLessThanOrEqual(601);
  });

  it('contains no client-certificate or cluster-admin material', async () => {
    const credentials = await makeProvider(withSessionNamespace()).issueCredentials(CONTEXT);

    expect(credentials.kubeconfig).not.toContain('client-certificate');
    expect(credentials.kubeconfig).not.toContain('client-key');
    expect(credentials.kubeconfig).not.toContain('kubernetes-admin');
  });
});

describe('destroyNamespace() cleanup safety', () => {
  const protectedNames = ['default', 'kube-system', 'kube-public', 'kube-node-lease'];

  it.each(protectedNames)('refuses to delete %s', async (name) => {
    const k8s = new FakeKubernetes({
      namespaces: [[name, { [MANAGED_LABEL]: 'true', [SESSION_LABEL]: CONTEXT.sessionId }]],
    });

    const result = await makeProvider(k8s).destroyNamespace(name);

    expect(result.ok).toBe(false);
    expect(result.namespaceGone).toBe(false);
    expect(result.error?.message).toMatch(/Refusing to delete/);
    // Even carrying the managed label by hand does not make it deletable.
    expect(k8s.deletedNamespaces).toEqual([]);
    expect(await k8s.getNamespace(name)).not.toBeNull();
  });

  it('refuses a lab-shaped namespace that is not labelled as managed', async () => {
    const k8s = new FakeKubernetes({ namespaces: [['lab-deadbeef0001', {}]] });

    const result = await makeProvider(k8s).destroyNamespace('lab-deadbeef0001');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/not labelled jumptotech.io\/managed=true/);
    expect(k8s.deletedNamespaces).toEqual([]);
  });

  it('refuses a managed namespace belonging to a different session', async () => {
    const k8s = new FakeKubernetes({
      namespaces: [['lab-deadbeef0001', { [MANAGED_LABEL]: 'true', [SESSION_LABEL]: 'sess-aaaaaaaaaaaaaaaa' }]],
    });

    const result = await makeProvider(k8s).destroyNamespace('lab-deadbeef0001', 'sess-bbbbbbbbbbbbbbbb');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/belongs to sess-aaaa/);
    expect(k8s.deletedNamespaces).toEqual([]);
  });

  it('deletes a namespace it owns, and confirms it is gone', async () => {
    const k8s = withSessionNamespace();

    const result = await makeProvider(k8s).destroy(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.namespaceGone).toBe(true);
    expect(k8s.deletedNamespaces).toEqual([CONTEXT.namespace]);
    expect(await k8s.getNamespace(CONTEXT.namespace)).toBeNull();
  });

  it('is idempotent — deleting twice succeeds and deletes once', async () => {
    const k8s = withSessionNamespace();
    const p = makeProvider(k8s);

    const first = await p.destroy(CONTEXT);
    const second = await p.destroy(CONTEXT);

    expect(first.namespaceGone).toBe(true);
    expect(second.namespaceGone).toBe(true);
    expect(second.ok).toBe(true);
    expect(k8s.deletedNamespaces).toEqual([CONTEXT.namespace]);
  });
});

describe('listManagedNamespaces()', () => {
  it('returns only managed, lab-shaped namespaces', async () => {
    const k8s = new FakeKubernetes({
      namespaces: [
        'default',
        // Managed label hand-applied to a system namespace: still excluded,
        // because the name is not a sandbox name.
        ['kube-system', { [MANAGED_LABEL]: 'true' }],
        // Lab-shaped but unmanaged.
        ['lab-000000000001', {}],
        [
          'lab-000000000002',
          {
            [MANAGED_LABEL]: 'true',
            [SESSION_LABEL]: 'sess-000000000000000b',
            'jumptotech.io/lab-id': 'K8S-001',
            'jumptotech.io/expires-at': '1700000000000',
          },
        ],
      ],
    });

    const managed = await makeProvider(k8s).listManagedNamespaces();

    expect(managed.map((m) => m.namespace)).toEqual(['lab-000000000002']);
    expect(managed[0]?.sessionId).toBe('sess-000000000000000b');
    expect(managed[0]?.expiresAtMs).toBe(1_700_000_000_000);
  });
});

describe('execute() command allow-list', () => {
  it('refuses a binary that is not allow-listed', async () => {
    const p = new KindLabProvider({ k8s: new FakeKubernetes(), clusterName: 'jumptotech-labs' });

    await expect(p.execute(CONTEXT, { command: 'sh', args: ['-c', 'id'] })).rejects.toThrow(
      /not allow-listed/,
    );
    await expect(p.execute(CONTEXT, { command: '/bin/bash', args: [] })).rejects.toThrow(
      /not allow-listed/,
    );
  });

  it('requires args to be an array of strings', async () => {
    const p = new KindLabProvider({ k8s: new FakeKubernetes(), clusterName: 'jumptotech-labs' });

    await expect(
      p.execute(CONTEXT, { command: 'kubectl', args: [42 as unknown as string] }),
    ).rejects.toThrow(/array of strings/);
  });
});
