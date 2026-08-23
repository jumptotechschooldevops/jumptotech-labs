import { imageMatches } from '../image.js';
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import { selectContainer } from './pods.js';
import { labelsMatch } from './k8s-helpers.js';

export const daemonSetExists: VerifierHandler<'daemonset_exists'> = {
  type: 'daemonset_exists',
  label: (r) => `DaemonSet ${r.name} exists`,
  async run(r, reader) {
    const ds = await reader.daemonSet(r.name);
    if (!ds) return missing('DaemonSet', r.name, reader.namespace);
    if (ds.deleting) return fail(`DaemonSet '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const daemonSetImage: VerifierHandler<'daemonset_image'> = {
  type: 'daemonset_image',
  label: (r) => `DaemonSet ${r.name} uses image ${r.image}`,
  async run(r, reader) {
    const ds = await reader.daemonSet(r.name);
    if (!ds) return missing('DaemonSet', r.name, reader.namespace);
    const { container, detail } = selectContainer(ds, r.container);
    if (!container) return fail(`DaemonSet '${r.name}' has ${detail}`);
    return imageMatches(r.image, container.image)
      ? pass()
      : fail(`Container '${container.name}' uses '${container.image}', expected '${r.image}'`);
  },
};

export const daemonSetSelector: VerifierHandler<'daemonset_selector'> = {
  type: 'daemonset_selector',
  label: (r) => `DaemonSet ${r.name} selects the intended Pods`,
  async run(r, reader) {
    const ds = await reader.daemonSet(r.name);
    if (!ds) return missing('DaemonSet', r.name, reader.namespace);
    const problems = labelsMatch(ds.selector, r.selector);
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const daemonSetScheduled: VerifierHandler<'daemonset_scheduled'> = {
  type: 'daemonset_scheduled',
  label: (r) => `DaemonSet ${r.name} is scheduled on nodes`,
  async run(r, reader) {
    const ds = await reader.daemonSet(r.name);
    if (!ds) return missing('DaemonSet', r.name, reader.namespace);
    const required = r.min_scheduled ?? 1;
    return ds.desiredScheduled >= required
      ? pass()
      : fail(`${ds.desiredScheduled} Pod(s) scheduled, expected at least ${required}`);
  },
};

export const daemonSetReady: VerifierHandler<'daemonset_ready'> = {
  type: 'daemonset_ready',
  label: (r) => `DaemonSet ${r.name} has ready Pods`,
  async run(r, reader) {
    const ds = await reader.daemonSet(r.name);
    if (!ds) return missing('DaemonSet', r.name, reader.namespace);
    const required = r.min_ready ?? 1;
    return ds.numberReady >= required
      ? pass()
      : fail(`${ds.numberReady} Pod(s) ready, expected at least ${required}`);
  },
};
