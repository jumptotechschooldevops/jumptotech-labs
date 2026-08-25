/**
 * Deployment requirement handlers.
 *
 * "Available" and "rolled out" are distinct questions and both matter: a
 * Deployment can report the new image in its spec while old Pods are still
 * serving, and a scale-up can be accepted by the API server long before the
 * new replicas are actually available. Labs check the state they mean.
 */
import type { ConfigReference, DeploymentSnapshot } from '@jumptotech/lab-orchestrator';
import { imageMatches } from '../image.js';
import { quantitiesEqual } from '../quantity.js';
import type { HandlerOutcome, VerifierHandler } from '../contract.js';
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

/**
 * Kubernetes IntOrString, parsed into something comparable.
 *
 * `1`, `"1"` and `"25%"` are all valid spellings on the wire. The first two
 * mean the same thing — one Pod — and must compare equal however the manifest
 * happened to write them. The third means a proportion of `replicas` and must
 * never compare equal to an absolute count, because `1` and `"1%"` are
 * different instructions.
 */
type SurgeValue = { kind: 'pods' | 'percent'; value: number };

function parseIntOrPercent(raw: number | string | undefined): SurgeValue | null {
  if (raw === undefined) return null;
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? { kind: 'pods', value: raw } : null;

  const text = raw.trim();
  if (/^\d+$/.test(text)) return { kind: 'pods', value: Number(text) };
  if (/^\d+%$/.test(text)) return { kind: 'percent', value: Number(text.slice(0, -1)) };
  return null;
}

const describeSurge = (raw: number | string | undefined): string =>
  raw === undefined ? 'unset' : typeof raw === 'number' ? String(raw) : raw;

export const deploymentStrategy: VerifierHandler<'deployment_strategy'> = {
  type: 'deployment_strategy',
  label: (r) => {
    const bounds = [
      r.maxSurge !== undefined ? `maxSurge ${describeSurge(r.maxSurge)}` : undefined,
      r.maxUnavailable !== undefined ? `maxUnavailable ${describeSurge(r.maxUnavailable)}` : undefined,
    ].filter(Boolean);
    return bounds.length === 0
      ? `Deployment ${r.name} uses the ${r.strategy} strategy`
      : `Deployment ${r.name} uses ${r.strategy} with ${bounds.join(' and ')}`;
  },
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);

    /*
     * An unset strategy is RollingUpdate — that is the API's own default, and a
     * live object always carries it explicitly. Treating a missing snapshot
     * field the same way keeps a reader that does not populate strategy from
     * silently reporting the wrong type.
     */
    const observedType = deployment.strategy?.type ?? 'RollingUpdate';
    if (observedType !== r.strategy) {
      return fail(`Strategy is '${observedType}', expected '${r.strategy}'`);
    }

    if (r.maxSurge === undefined && r.maxUnavailable === undefined) return pass();

    // Recreate has no rollingUpdate block at all; the schema already refuses a
    // requirement that asks for one, so this is a belt-and-braces guard.
    if (observedType !== 'RollingUpdate') {
      return fail(`Strategy is '${observedType}', which has no rolling update settings`);
    }

    const problems: string[] = [];
    const compare = (field: 'maxSurge' | 'maxUnavailable', expected: number | string): void => {
      const observedRaw = deployment.strategy?.[field];
      const observed = parseIntOrPercent(observedRaw);
      const wanted = parseIntOrPercent(expected);

      if (!observed) {
        problems.push(`${field} is ${describeSurge(observedRaw)}, expected ${describeSurge(expected)}`);
        return;
      }
      if (!wanted || observed.kind !== wanted.kind || observed.value !== wanted.value) {
        problems.push(`${field} is ${describeSurge(observedRaw)}, expected ${describeSurge(expected)}`);
      }
    };

    if (r.maxSurge !== undefined) compare('maxSurge', r.maxSurge);
    if (r.maxUnavailable !== undefined) compare('maxUnavailable', r.maxUnavailable);

    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const deploymentSelector: VerifierHandler<'deployment_selector'> = {
  type: 'deployment_selector',
  label: (r) => `Deployment ${r.name} selects ${describeLabels(r.selector)}`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);

    const problems: string[] = [];
    for (const [key, expected] of Object.entries(r.selector)) {
      const actual = deployment.selector[key];
      if (actual === undefined) problems.push(`selector is missing '${key}'`);
      else if (actual !== expected) {
        problems.push(`selector '${key}' is '${actual}', expected '${expected}'`);
      }
    }
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

/**
 * Resource requests/limits as declared on the Pod *template*.
 *
 * Reading the template rather than a running Pod is the whole point: the
 * namespace LimitRange defaults every Pod's resources, so a Pod would report
 * requests and limits even for a student who declared none.
 */
export const deploymentResources: VerifierHandler<'deployment_resources'> = {
  type: 'deployment_resources',
  label: (r) => {
    const parts: string[] = [];
    if (r.requests) parts.push('requests');
    if (r.limits) parts.push('limits');
    return `Deployment ${r.name} declares CPU and memory ${parts.join(' and ')}`;
  },
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);

    const { container, detail } = selectContainer(deployment, r.container);
    if (!container) return fail(`Deployment '${r.name}' has ${detail}`);

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

export const deploymentProbe: VerifierHandler<'deployment_probe'> = {
  type: 'deployment_probe',
  label: (r) => `Deployment ${r.name} defines a ${r.probe} probe`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);

    const { container, detail } = selectContainer(deployment, r.container);
    if (!container) return fail(`Deployment '${r.name}' has ${detail}`);

    const probe = (container.probes ?? []).find((p) => p.kind === r.probe);
    if (!probe) {
      const configured = (container.probes ?? []).map((p) => p.kind);
      return fail(
        configured.length === 0
          ? `Container '${container.name}' defines no probes`
          : `Container '${container.name}' has no ${r.probe} probe — it defines ${configured.join(', ')}`,
      );
    }

    const problems: string[] = [];
    if (r.handler && probe.handler !== r.handler) {
      problems.push(`the ${r.probe} probe uses ${probe.handler}, expected ${r.handler}`);
    }
    if (r.path !== undefined && probe.path !== r.path) {
      problems.push(`probe path is '${probe.path ?? 'unset'}', expected '${r.path}'`);
    }
    // A probe may name a port either numerically or by container-port name, and
    // both are correct Kubernetes; compare as strings so neither form is
    // arbitrarily rejected.
    if (r.port !== undefined && String(probe.port ?? '') !== String(r.port)) {
      problems.push(`probe port is '${probe.port ?? 'unset'}', expected '${r.port}'`);
    }

    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const deploymentUsesConfigMap: VerifierHandler<'deployment_uses_configmap'> = {
  type: 'deployment_uses_configmap',
  label: (r) =>
    r.key === undefined
      ? `Deployment ${r.name} reads its configuration from ConfigMap ${r.configmap}`
      : `Deployment ${r.name} reads ${r.key} from ConfigMap ${r.configmap}`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);
    return checkConfigReference(deployment, {
      source: 'configmap',
      kind: 'ConfigMap',
      name: r.configmap,
      ...(r.key !== undefined ? { key: r.key } : {}),
      ...(r.via !== undefined ? { via: r.via } : {}),
    });
  },
};

export const deploymentUsesSecret: VerifierHandler<'deployment_uses_secret'> = {
  type: 'deployment_uses_secret',
  label: (r) =>
    r.key === undefined
      ? `Deployment ${r.name} reads its credentials from Secret ${r.secret}`
      : `Deployment ${r.name} reads ${r.key} from Secret ${r.secret}`,
  async run(r, reader) {
    const deployment = await reader.deployment(r.name);
    if (!deployment) return missing('Deployment', r.name, reader.namespace);
    return checkConfigReference(deployment, {
      source: 'secret',
      kind: 'Secret',
      name: r.secret,
      ...(r.key !== undefined ? { key: r.key } : {}),
      ...(r.via !== undefined ? { via: r.via } : {}),
    });
  },
};

/**
 * Does the workload consume this ConfigMap / Secret?
 *
 * Any mechanism satisfies the check unless the lab pins one: `envFrom`, a
 * single-key `env.valueFrom`, and a volume mount are all legitimate ways to
 * take configuration out of the image, and a lab that graded only one would be
 * grading syntax rather than the concept.
 *
 * A whole-object reference (`envFrom`, or a volume with no `items`) satisfies a
 * key requirement, because it brings every key in with it.
 */
function checkConfigReference(
  workload: Pick<DeploymentSnapshot, 'configRefs'>,
  want: { source: ConfigReference['source']; kind: string; name: string; key?: string; via?: ConfigReference['via'] },
): HandlerOutcome {
  const refs = workload.configRefs ?? [];
  const matching = refs.filter((ref) => ref.source === want.source && ref.name === want.name);

  if (matching.length === 0) {
    const others = refs.filter((ref) => ref.source === want.source).map((ref) => `'${ref.name}'`);
    return fail(
      others.length === 0
        ? `The Deployment does not reference any ${want.kind}`
        : `The Deployment does not reference ${want.kind} '${want.name}' — it references ${[...new Set(others)].join(', ')}`,
    );
  }

  const byMechanism = want.via ? matching.filter((ref) => ref.via === want.via) : matching;
  if (byMechanism.length === 0) {
    const used = [...new Set(matching.map((ref) => ref.via))].join(', ');
    return fail(`${want.kind} '${want.name}' is referenced via ${used}, expected ${want.via}`);
  }

  if (want.key !== undefined) {
    // `key: undefined` on a reference means "the whole object", which includes
    // the key being asked about.
    const hasKey = byMechanism.some((ref) => ref.key === undefined || ref.key === want.key);
    if (!hasKey) {
      const keys = byMechanism.map((ref) => `'${ref.key}'`).join(', ');
      return fail(`${want.kind} '${want.name}' is referenced, but key '${want.key}' is not — found ${keys}`);
    }
  }

  return pass();
}

function describeLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}
