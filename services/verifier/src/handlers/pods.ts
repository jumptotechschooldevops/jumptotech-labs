/**
 * Pod requirement handlers.
 *
 * Each handler answers one question about live cluster state and explains a
 * failure in terms of what was *observed*, never in terms of what to type.
 */
import type { ContainerSnapshot, PodSnapshot } from '@jumptotech/lab-orchestrator';
import { imageMatches } from '../image.js';
import { quantitiesEqual } from '../quantity.js';
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';

/** Pick the container a requirement targets, or report why it could not. */
export function selectContainer(
  pod: { containers: ContainerSnapshot[] },
  container: string | undefined,
): { container?: ContainerSnapshot; detail?: string } {
  if (pod.containers.length === 0) return { detail: 'the workload declares no containers' };
  if (!container) return { container: pod.containers[0]! };
  const found = pod.containers.find((c) => c.name === container);
  return found
    ? { container: found }
    : {
        detail: `no container named '${container}' — found ${pod.containers.map((c) => `'${c.name}'`).join(', ')}`,
      };
}

/** Describe why a Pod is not in the expected phase, including the blocking reason. */
function describePhase(pod: PodSnapshot): string {
  const blocked = pod.containers.find((c) => c.reason);
  const suffix = blocked ? ` (${blocked.name}: ${blocked.reason})` : '';
  return `Pod phase is '${pod.phase}', expected 'Running'${suffix}`;
}

export const podExists: VerifierHandler<'pod_exists'> = {
  type: 'pod_exists',
  label: (r) => `Pod ${r.name} exists`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    if (pod.deleting) return fail(`Pod '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const podImage: VerifierHandler<'pod_image'> = {
  type: 'pod_image',
  label: (r) => `Pod ${r.name} uses image ${r.image}`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);

    // Without an explicit container, any container carrying the image passes —
    // a multi-container Pod that includes the required image is still correct.
    if (!r.container) {
      if (pod.containers.length === 0) return fail('Pod declares no containers');
      if (pod.containers.some((c) => imageMatches(r.image, c.image))) return pass();
      const observed = pod.containers.map((c) => c.image).join(', ');
      return fail(`Incorrect image — found '${observed}', expected '${r.image}'`);
    }

    const { container, detail } = selectContainer(pod, r.container);
    if (!container) return fail(`Pod '${r.name}' has ${detail}`);
    return imageMatches(r.image, container.image)
      ? pass()
      : fail(`Incorrect image — container '${container.name}' runs '${container.image}', expected '${r.image}'`);
  },
};

export const podRunning: VerifierHandler<'pod_running'> = {
  type: 'pod_running',
  label: (r) => `Pod ${r.name} is Running`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    return pod.phase === 'Running' ? pass() : fail(describePhase(pod));
  },
};

export const podReady: VerifierHandler<'pod_ready'> = {
  type: 'pod_ready',
  label: (r) => `Pod ${r.name} is Ready`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);
    if (pod.containers.length === 0) return fail('Pod declares no containers');

    const notReady = pod.containers.filter((c) => !c.ready);
    if (notReady.length === 0) return pass();
    const detail = notReady
      .map((c) => `${c.name} (${c.state}${c.reason ? `: ${c.reason}` : ''})`)
      .join(', ');
    return fail(`Container not Ready — ${detail}`);
  },
};

export const podLabel: VerifierHandler<'pod_label'> = {
  type: 'pod_label',
  label: (r) =>
    `Pod ${r.name} has labels ${Object.entries(r.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);

    const problems: string[] = [];
    for (const [key, expected] of Object.entries(r.labels)) {
      const actual = pod.labels[key];
      if (actual === undefined) problems.push(`missing label '${key}'`);
      else if (actual !== expected) {
        problems.push(`label '${key}' is '${actual}', expected '${expected}'`);
      }
    }
    // Extra labels are fine: the lab asks for these labels, not for only these.
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const podResources: VerifierHandler<'pod_resources'> = {
  type: 'pod_resources',
  label: (r) => {
    const parts: string[] = [];
    if (r.requests) parts.push('requests');
    if (r.limits) parts.push('limits');
    return `Pod ${r.name} declares CPU and memory ${parts.join(' and ')}`;
  },
  async run(r, reader) {
    const pod = await reader.pod(r.name);
    if (!pod) return missing('Pod', r.name, reader.namespace);

    const { container, detail } = selectContainer(pod, r.container);
    if (!container) return fail(`Pod '${r.name}' has ${detail}`);

    const problems: string[] = [];
    for (const kind of ['requests', 'limits'] as const) {
      const expected = r[kind];
      if (!expected) continue;
      const actual = container.resources?.[kind];
      if (!actual) {
        problems.push(`container '${container.name}' declares no resource ${kind}`);
        continue;
      }
      for (const resource of ['cpu', 'memory'] as const) {
        const want = expected[resource];
        if (want === undefined) continue;
        const got = actual[resource];
        if (got === undefined) problems.push(`${kind}.${resource} is not set`);
        else if (!quantitiesEqual(want, got)) {
          problems.push(`${kind}.${resource} is '${got}', expected '${want}'`);
        }
      }
    }

    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};
