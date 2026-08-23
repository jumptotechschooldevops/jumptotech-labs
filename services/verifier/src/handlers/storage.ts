import type { VolumeMountSnapshot } from '@jumptotech/lab-orchestrator';
import { quantitiesEqual } from '../quantity.js';
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import type { VerifyReader } from '../reader.js';

export const pvcExists: VerifierHandler<'pvc_exists'> = {
  type: 'pvc_exists',
  label: (r) => `PersistentVolumeClaim ${r.name} exists`,
  async run(r, reader) {
    const pvc = await reader.persistentVolumeClaim(r.name);
    if (!pvc) return missing('PersistentVolumeClaim', r.name, reader.namespace);
    if (pvc.deleting) return fail(`PVC '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const pvcBound: VerifierHandler<'pvc_bound'> = {
  type: 'pvc_bound',
  label: (r) => `PersistentVolumeClaim ${r.name} is Bound`,
  async run(r, reader) {
    const pvc = await reader.persistentVolumeClaim(r.name);
    if (!pvc) return missing('PersistentVolumeClaim', r.name, reader.namespace);
    return pvc.phase === 'Bound' ? pass() : fail(`PVC phase is '${pvc.phase}', expected 'Bound'`);
  },
};

export const pvcStorageClass: VerifierHandler<'pvc_storage_class'> = {
  type: 'pvc_storage_class',
  label: (r) => `PersistentVolumeClaim ${r.name} uses StorageClass ${r.storageClassName || '(default)'}`,
  async run(r, reader) {
    const pvc = await reader.persistentVolumeClaim(r.name);
    if (!pvc) return missing('PersistentVolumeClaim', r.name, reader.namespace);
    const actual = pvc.storageClassName ?? '';
    return actual === r.storageClassName
      ? pass()
      : fail(`StorageClass is '${actual || '(default)'}', expected '${r.storageClassName || '(default)'}'`);
  },
};

export const pvcAccessModes: VerifierHandler<'pvc_access_modes'> = {
  type: 'pvc_access_modes',
  label: (r) => `PersistentVolumeClaim ${r.name} has access mode ${r.accessModes.join(', ')}`,
  async run(r, reader) {
    const pvc = await reader.persistentVolumeClaim(r.name);
    if (!pvc) return missing('PersistentVolumeClaim', r.name, reader.namespace);
    const missingMode = r.accessModes.find((mode) => !pvc.accessModes.includes(mode));
    return missingMode
      ? fail(`Access mode '${missingMode}' not found — PVC has ${pvc.accessModes.join(', ') || 'none'}`)
      : pass();
  },
};

export const pvcStorageRequest: VerifierHandler<'pvc_storage_request'> = {
  type: 'pvc_storage_request',
  label: (r) => `PersistentVolumeClaim ${r.name} requests ${r.storage} storage`,
  async run(r, reader) {
    const pvc = await reader.persistentVolumeClaim(r.name);
    if (!pvc) return missing('PersistentVolumeClaim', r.name, reader.namespace);
    if (!pvc.storage) return fail('PVC declares no storage request');
    return quantitiesEqual(pvc.storage, r.storage)
      ? pass()
      : fail(`Storage request is '${pvc.storage}', expected '${r.storage}'`);
  },
};

export const pvcVolumeMode: VerifierHandler<'pvc_volume_mode'> = {
  type: 'pvc_volume_mode',
  label: (r) => `PersistentVolumeClaim ${r.name} uses volumeMode ${r.volumeMode}`,
  async run(r, reader) {
    const pvc = await reader.persistentVolumeClaim(r.name);
    if (!pvc) return missing('PersistentVolumeClaim', r.name, reader.namespace);
    const actual = pvc.volumeMode ?? 'Filesystem';
    return actual === r.volumeMode
      ? pass()
      : fail(`Volume mode is '${actual}', expected '${r.volumeMode}'`);
  },
};

export const storageClassExists: VerifierHandler<'storageclass_exists'> = {
  type: 'storageclass_exists',
  label: (r) => `StorageClass ${r.name} exists`,
  async run(r, reader) {
    const sc = await reader.storageClass(r.name);
    return sc ? pass() : fail(`No StorageClass named '${r.name}' found in the cluster`);
  },
};

export const workloadMountsPvc: VerifierHandler<'workload_mounts_pvc'> = {
  type: 'workload_mounts_pvc',
  label: (r) => `${titleCase(r.kind)} ${r.name} mounts PVC ${r.claim} at ${r.mountPath}`,
  async run(r, reader) {
    const mounts = await volumeMountsFor(reader, r.kind, r.name);
    if (!mounts) return missing(titleCase(r.kind), r.name, reader.namespace);

    const match = mounts.filter((m) => m.claimName === r.claim && m.mountPath === r.mountPath);
    if (match.length === 0) {
      const observed = mounts
        .filter((m) => m.claimName)
        .map((m) => `${m.claimName} at ${m.mountPath}`)
        .join(', ');
      return fail(
        observed.length === 0
          ? `${titleCase(r.kind)} '${r.name}' does not mount any PVC`
          : `${titleCase(r.kind)} '${r.name}' does not mount PVC '${r.claim}' at '${r.mountPath}' — found ${observed}`,
      );
    }
    return pass();
  },
};

async function volumeMountsFor(
  reader: VerifyReader,
  kind: 'pod' | 'deployment' | 'statefulset',
  name: string,
): Promise<VolumeMountSnapshot[] | null> {
  if (kind === 'pod') {
    const pod = await reader.pod(name);
    return pod ? (pod.volumeMounts ?? []) : null;
  }
  if (kind === 'deployment') {
    const deployment = await reader.deployment(name);
    return deployment ? (deployment.volumeMounts ?? []) : null;
  }
  const sts = await reader.statefulSet(name);
  return sts ? (sts.volumeMounts ?? []) : null;
}

function titleCase(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
