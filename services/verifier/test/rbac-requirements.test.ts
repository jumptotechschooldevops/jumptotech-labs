import { describe, expect, it } from 'vitest';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { verifyRequirement, VerifyReader } from '../src/index.js';

const NS = 'lab-00000000000a';

describe('verifier — RBAC requirements', () => {
  it('checks Role, RoleBinding, and authorization together', async () => {
    const k8s = new FakeKubernetes({
      roles: {
        [NS]: [
          {
            name: 'inventory-reader',
            namespace: NS,
            rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'watch'] }],
            deleting: false,
          },
        ],
      },
      roleBindings: {
        [NS]: [
          {
            name: 'inventory-reader-binding',
            namespace: NS,
            roleRef: { kind: 'Role', name: 'inventory-reader', apiGroup: 'rbac.authorization.k8s.io' },
            subjects: [{ kind: 'ServiceAccount', name: 'inventory-sync' }],
            deleting: false,
          },
        ],
      },
      sarResults: {
        [`system:serviceaccount:${NS}:inventory-sync|${NS}|get||configmaps|inventory-config|`]: {
          allowed: true,
        },
        [`system:serviceaccount:${NS}:inventory-sync|${NS}|delete||configmaps|inventory-config|`]: {
          allowed: false,
          reason: 'Forbidden',
        },
      },
    });
    const reader = new VerifyReader(k8s, NS);

    expect(
      (await verifyRequirement({ type: 'role_exists', name: 'inventory-reader' }, reader)).status,
    ).toBe('pass');
    expect(
      (
        await verifyRequirement(
          {
            type: 'role_rule',
            name: 'inventory-reader',
            apiGroups: [''],
            resources: ['configmaps'],
            verbs: ['get', 'list', 'watch'],
          },
          reader,
        )
      ).status,
    ).toBe('pass');
    expect(
      (
        await verifyRequirement(
          {
            type: 'rolebinding_subject',
            name: 'inventory-reader-binding',
            kind: 'ServiceAccount',
            subjectName: 'inventory-sync',
          },
          reader,
        )
      ).status,
    ).toBe('pass');
    expect(
      (
        await verifyRequirement(
          {
            type: 'auth_allowed',
            serviceAccount: 'inventory-sync',
            verb: 'get',
            resource: 'configmaps',
            apiGroup: '',
            name: 'inventory-config',
          },
          reader,
        )
      ).status,
    ).toBe('pass');
    expect(
      (
        await verifyRequirement(
          {
            type: 'auth_forbidden',
            serviceAccount: 'inventory-sync',
            verb: 'delete',
            resource: 'configmaps',
            apiGroup: '',
            name: 'inventory-config',
          },
          reader,
        )
      ).status,
    ).toBe('pass');
  });

  it('fails when Role rule is missing', async () => {
    const k8s = new FakeKubernetes({
      roles: {
        [NS]: [
          {
            name: 'inventory-reader',
            namespace: NS,
            rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }],
            deleting: false,
          },
        ],
      },
    });
    const result = await verifyRequirement(
      {
        type: 'role_rule',
        name: 'inventory-reader',
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get'],
      },
      new VerifyReader(k8s, NS),
    );
    expect(result.status).toBe('fail');
  });

  it('does not see Roles in another namespace', async () => {
    const k8s = new FakeKubernetes({
      roles: { 'lab-other': [{ name: 'inventory-reader', namespace: 'lab-other', rules: [], deleting: false }] },
    });
    const result = await verifyRequirement(
      { type: 'role_exists', name: 'inventory-reader' },
      new VerifyReader(k8s, NS),
    );
    expect(result.status).toBe('fail');
  });
});
