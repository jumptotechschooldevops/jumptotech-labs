import { imageMatches } from '../image.js';
import { quantitiesEqual } from '../quantity.js';
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import { selectContainer } from './pods.js';

export const statefulSetExists: VerifierHandler<'statefulset_exists'> = {
  type: 'statefulset_exists',
  label: (r) => `StatefulSet ${r.name} exists`,
  async run(r, reader) {
    const sts = await reader.statefulSet(r.name);
    if (!sts) return missing('StatefulSet', r.name, reader.namespace);
    if (sts.deleting) return fail(`StatefulSet '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const statefulSetReplicas: VerifierHandler<'statefulset_replicas'> = {
  type: 'statefulset_replicas',
  label: (r) => `StatefulSet ${r.name} requests ${r.replicas} replica${r.replicas === 1 ? '' : 's'}`,
  async run(r, reader) {
    const sts = await reader.statefulSet(r.name);
    if (!sts) return missing('StatefulSet', r.name, reader.namespace);
    return sts.desiredReplicas === r.replicas
      ? pass()
      : fail(`Expected ${r.replicas} replicas; StatefulSet currently requests ${sts.desiredReplicas}`);
  },
};

export const statefulSetReady: VerifierHandler<'statefulset_ready'> = {
  type: 'statefulset_ready',
  label: (r) => `StatefulSet ${r.name} has ready replicas`,
  async run(r, reader) {
    const sts = await reader.statefulSet(r.name);
    if (!sts) return missing('StatefulSet', r.name, reader.namespace);
    const required = r.min_ready ?? sts.desiredReplicas;
    return sts.readyReplicas >= required
      ? pass()
      : fail(`${sts.readyReplicas} of ${required} replica${required === 1 ? '' : 's'} ready`);
  },
};

export const statefulSetImage: VerifierHandler<'statefulset_image'> = {
  type: 'statefulset_image',
  label: (r) => `StatefulSet ${r.name} uses image ${r.image}`,
  async run(r, reader) {
    const sts = await reader.statefulSet(r.name);
    if (!sts) return missing('StatefulSet', r.name, reader.namespace);
    const { container, detail } = selectContainer(sts, r.container);
    if (!container) return fail(`StatefulSet '${r.name}' has ${detail}`);
    return imageMatches(r.image, container.image)
      ? pass()
      : fail(`Container '${container.name}' uses '${container.image}', expected '${r.image}'`);
  },
};

export const statefulSetServiceName: VerifierHandler<'statefulset_service_name'> = {
  type: 'statefulset_service_name',
  label: (r) => `StatefulSet ${r.name} uses serviceName ${r.serviceName}`,
  async run(r, reader) {
    const sts = await reader.statefulSet(r.name);
    if (!sts) return missing('StatefulSet', r.name, reader.namespace);
    return sts.serviceName === r.serviceName
      ? pass()
      : fail(`serviceName is '${sts.serviceName ?? 'unset'}', expected '${r.serviceName}'`);
  },
};

export const statefulSetVolumeClaimTemplate: VerifierHandler<'statefulset_volume_claim_template'> = {
  type: 'statefulset_volume_claim_template',
  label: (r) => `StatefulSet ${r.name} declares volumeClaimTemplate ${r.claimName}`,
  async run(r, reader) {
    const sts = await reader.statefulSet(r.name);
    if (!sts) return missing('StatefulSet', r.name, reader.namespace);
    const template = sts.volumeClaimTemplates.find((claim) => claim.name === r.claimName);
    if (!template) {
      const names = sts.volumeClaimTemplates.map((claim) => claim.name).join(', ');
      return fail(
        names.length === 0
          ? 'StatefulSet declares no volumeClaimTemplates'
          : `No volumeClaimTemplate named '${r.claimName}' — found ${names}`,
      );
    }

    const problems: string[] = [];
    if (r.storageClassName !== undefined && template.storageClassName !== r.storageClassName) {
      problems.push(
        `storageClassName is '${template.storageClassName ?? '(default)'}', expected '${r.storageClassName || '(default)'}'`,
      );
    }
    if (r.accessModes !== undefined) {
      const missingMode = r.accessModes.find((mode) => !template.accessModes.includes(mode));
      if (missingMode) problems.push(`access mode '${missingMode}' not found`);
    }
    if (r.storage !== undefined) {
      if (!template.storage) problems.push('storage request is not set');
      else if (!quantitiesEqual(template.storage, r.storage)) {
        problems.push(`storage request is '${template.storage}', expected '${r.storage}'`);
      }
    }
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};
