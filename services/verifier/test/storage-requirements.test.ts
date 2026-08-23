import { describe, expect, it } from 'vitest';
import { FakeKubernetes, deploymentSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { verifyRequirement, VerifyReader } from '../src/index.js';

const NS = 'lab-00000000000a';

describe('verifier — storage requirements', () => {
  it('checks PVC fields and deployment mount together', async () => {
    const k8s = new FakeKubernetes({
      persistentVolumeClaims: {
        [NS]: [
          {
            name: 'ledger-data',
            namespace: NS,
            phase: 'Bound',
            storageClassName: 'local-path',
            accessModes: ['ReadWriteOnce'],
            storage: '1Gi',
            volumeMode: 'Filesystem',
            deleting: false,
          },
        ],
      },
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'ledger',
            desiredReplicas: 1,
            availableReplicas: 1,
            readyReplicas: 1,
            volumeMounts: [{ name: 'data', mountPath: '/data', claimName: 'ledger-data' }],
          }),
        ],
      },
      storageClasses: { 'local-path': { name: 'local-path', provisioner: 'rancher.io/local-path' } },
    });
    const reader = new VerifyReader(k8s, NS);

    expect((await verifyRequirement({ type: 'pvc_exists', name: 'ledger-data' }, reader)).status).toBe(
      'pass',
    );
    expect((await verifyRequirement({ type: 'pvc_bound', name: 'ledger-data' }, reader)).status).toBe(
      'pass',
    );
    expect(
      (
        await verifyRequirement(
          { type: 'pvc_access_modes', name: 'ledger-data', accessModes: ['ReadWriteOnce'] },
          reader,
        )
      ).status,
    ).toBe('pass');
    expect(
      (
        await verifyRequirement(
          { type: 'pvc_storage_request', name: 'ledger-data', storage: '1Gi' },
          reader,
        )
      ).status,
    ).toBe('pass');
    expect(
      (
        await verifyRequirement(
          {
            type: 'workload_mounts_pvc',
            kind: 'deployment',
            name: 'ledger',
            claim: 'ledger-data',
            mountPath: '/data',
          },
          reader,
        )
      ).status,
    ).toBe('pass');
    expect(
      (await verifyRequirement({ type: 'storageclass_exists', name: 'local-path' }, reader)).status,
    ).toBe('pass');
  });

  it('fails when PVC is not Bound', async () => {
    const k8s = new FakeKubernetes({
      persistentVolumeClaims: {
        [NS]: [
          {
            name: 'ledger-data',
            namespace: NS,
            phase: 'Pending',
            accessModes: ['ReadWriteOnce'],
            deleting: false,
          },
        ],
      },
    });
    const result = await verifyRequirement(
      { type: 'pvc_bound', name: 'ledger-data' },
      new VerifyReader(k8s, NS),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Pending');
  });

  it('fails when deployment mount is wrong', async () => {
    const k8s = new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'ledger',
            volumeMounts: [{ name: 'data', mountPath: '/var/data', claimName: 'ledger-data' }],
          }),
        ],
      },
    });
    const result = await verifyRequirement(
      {
        type: 'workload_mounts_pvc',
        kind: 'deployment',
        name: 'ledger',
        claim: 'ledger-data',
        mountPath: '/data',
      },
      new VerifyReader(k8s, NS),
    );
    expect(result.status).toBe('fail');
  });
});
