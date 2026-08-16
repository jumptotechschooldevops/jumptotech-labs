/**
 * Deployment requirement handlers.
 *
 * "Available" and "rolled out" are distinct questions and both matter: a
 * Deployment can report the new image in its spec while old Pods are still
 * serving, and a scale-up can be accepted by the API server long before the
 * new replicas are actually available. Labs check the state they mean.
 */
import { imageMatches } from '../image.js';
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import { selectContainer } from './pods.js';

export const deploymentExists: VerifierHandler<'deployment_exists'> = {
  type: 'deployment_exists',
  label: (r) => `Deployment ${r.name} exists`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);
    if (deployment.deleting) return fail(`Deployment '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const deploymentImage: VerifierHandler<'deployment_image'> = {
  type: 'deployment_image',
  label: (r) => `Deployment ${r.name} uses image ${r.image}`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);

    if (!r.container) {
      if (deployment.containers.length === 0) return fail('Deployment declares no containers');
      if (deployment.containers.some((c) => imageMatches(r.image, c.image))) return pass();
      const observed = deployment.containers.map((c) => c.image).join(', ');
      return fail(`Incorrect image — found '${observed}', expected '${r.image}'`);
    }

    const { container, detail } = selectContainer(deployment, r.container);
    if (!container) return fail(`Deployment '${r.name}' has ${detail}`);
    return imageMatches(r.image, container.image)
      ? pass()
      : fail(
          `Incorrect image — container '${container.name}' is set to '${container.image}', expected '${r.image}'`,
        );
  },
};

export const deploymentReplicas: VerifierHandler<'deployment_replicas'> = {
  type: 'deployment_replicas',
  label: (r) => `Deployment ${r.name} is configured for ${r.replicas} replica${r.replicas === 1 ? '' : 's'}`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);
    return deployment.desiredReplicas === r.replicas
      ? pass()
      : fail(
          `Expected ${r.replicas} replica${r.replicas === 1 ? '' : 's'}; the Deployment currently requests ${deployment.desiredReplicas}`,
        );
  },
};

export const deploymentAvailable: VerifierHandler<'deployment_available'> = {
  type: 'deployment_available',
  label: (r) =>
    r.min_available === undefined
      ? `Deployment ${r.name} is available`
      : `Deployment ${r.name} has at least ${r.min_available} available replica${r.min_available === 1 ? '' : 's'}`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);

    const required = r.min_available ?? deployment.desiredReplicas;
    if (deployment.availableReplicas >= required && required > 0) return pass();

    const condition = deployment.conditions.find((c) => c.type === 'Available');
    const reason = condition?.reason ? ` (${condition.reason})` : '';
    return fail(
      `Deployment is not fully available — ${deployment.availableReplicas} of ${required} replica${required === 1 ? '' : 's'} available${reason}`,
    );
  },
};

export const deploymentRolloutComplete: VerifierHandler<'deployment_rollout_complete'> = {
  type: 'deployment_rollout_complete',
  label: (r) => `Deployment ${r.name} rollout is complete`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);

    // The same four conditions `kubectl rollout status` waits on.
    if (deployment.observedGeneration < deployment.generation) {
      return fail('The Deployment controller has not observed the latest change yet');
    }
    const desired = deployment.desiredReplicas;
    if (deployment.updatedReplicas < desired) {
      return fail(
        `Rollout in progress — ${deployment.updatedReplicas} of ${desired} replica${desired === 1 ? '' : 's'} updated to the current template`,
      );
    }
    if (deployment.currentReplicas > deployment.updatedReplicas) {
      return fail(
        `Rollout in progress — ${deployment.currentReplicas - deployment.updatedReplicas} replica(s) from the previous version are still running`,
      );
    }
    if (deployment.availableReplicas < desired) {
      return fail(
        `Rollout in progress — ${deployment.availableReplicas} of ${desired} updated replica${desired === 1 ? '' : 's'} available`,
      );
    }
    return pass();
  },
};
