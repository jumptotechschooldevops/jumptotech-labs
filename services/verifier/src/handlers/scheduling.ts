import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import { labelsMatch, tolerationsMatch } from './k8s-helpers.js';

export const podNodeSelector: VerifierHandler<'pod_node_selector'> = {
  type: 'pod_node_selector',
  label: (r) => `Pod ${r.name} declares the required nodeSelector`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    const problems = labelsMatch(pod.nodeSelector ?? {}, r.nodeSelector);
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const podTolerations: VerifierHandler<'pod_tolerations'> = {
  type: 'pod_tolerations',
  label: (r) => `Pod ${r.name} declares the required tolerations`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    const problems = tolerationsMatch(pod.tolerations ?? [], r.tolerations);
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const podNodeName: VerifierHandler<'pod_node_name'> = {
  type: 'pod_node_name',
  label: (r) => `Pod ${r.name} is pinned to node ${r.nodeName}`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    return pod.nodeName === r.nodeName
      ? pass()
      : fail(`nodeName is '${pod.nodeName ?? 'unset'}', expected '${r.nodeName}'`);
  },
};

export const deploymentNodeSelector: VerifierHandler<'deployment_node_selector'> = {
  type: 'deployment_node_selector',
  label: (r) => `Deployment ${r.name} template declares the required nodeSelector`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);
    const problems = labelsMatch(deployment.nodeSelector ?? {}, r.nodeSelector);
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const deploymentTolerations: VerifierHandler<'deployment_tolerations'> = {
  type: 'deployment_tolerations',
  label: (r) => `Deployment ${r.name} template declares the required tolerations`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);
    const problems = tolerationsMatch(deployment.tolerations ?? [], r.tolerations);
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const podAffinityRequired: VerifierHandler<'pod_affinity_required'> = {
  type: 'pod_affinity_required',
  label: (r) => `Pod ${r.name} declares required pod affinity`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    const match = (pod.requiredAffinity ?? []).some(
      (term) =>
        term.topologyKey === r.topologyKey &&
        labelsMatch(term.matchLabels, r.matchLabels ?? {}).length === 0,
    );
    return match ? pass() : fail('Pod has no matching required pod affinity term');
  },
};

export const podAntiAffinityRequired: VerifierHandler<'pod_anti_affinity_required'> = {
  type: 'pod_anti_affinity_required',
  label: (r) => `Pod ${r.name} declares required pod anti-affinity`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    const match = (pod.requiredAntiAffinity ?? []).some(
      (term) =>
        term.topologyKey === r.topologyKey &&
        labelsMatch(term.matchLabels, r.matchLabels ?? {}).length === 0,
    );
    return match ? pass() : fail('Pod has no matching required pod anti-affinity term');
  },
};

export const podScheduledOnNode: VerifierHandler<'pod_scheduled_on_node'> = {
  type: 'pod_scheduled_on_node',
  label: (r) => `Pod ${r.name} is running on node ${r.nodeName}`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    return pod.scheduledNode === r.nodeName
      ? pass()
      : fail(`Pod is scheduled on '${pod.scheduledNode ?? 'no node yet'}', expected '${r.nodeName}'`);
  },
};
