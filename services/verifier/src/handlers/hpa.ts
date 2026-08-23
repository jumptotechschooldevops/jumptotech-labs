import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';

export const hpaExists: VerifierHandler<'hpa_exists'> = {
  type: 'hpa_exists',
  label: (r) => `HorizontalPodAutoscaler ${r.name} exists`,
  async run(r, reader) {
    const hpa = await reader.horizontalPodAutoscaler(r.name);
    if (!hpa) return missing('HorizontalPodAutoscaler', r.name, reader.namespace);
    if (hpa.deleting) return fail(`HPA '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const hpaTarget: VerifierHandler<'hpa_target'> = {
  type: 'hpa_target',
  label: (r) => `HorizontalPodAutoscaler ${r.name} targets ${r.targetKind}/${r.targetName}`,
  async run(r, reader) {
    const hpa = await reader.horizontalPodAutoscaler(r.name);
    if (!hpa) return missing('HorizontalPodAutoscaler', r.name, reader.namespace);
    return hpa.targetKind === r.targetKind && hpa.targetName === r.targetName
      ? pass()
      : fail(`HPA targets ${hpa.targetKind}/${hpa.targetName}, expected ${r.targetKind}/${r.targetName}`);
  },
};

export const hpaReplicas: VerifierHandler<'hpa_replicas'> = {
  type: 'hpa_replicas',
  label: (r) => `HorizontalPodAutoscaler ${r.name} replica bounds are configured`,
  async run(r, reader) {
    const hpa = await reader.horizontalPodAutoscaler(r.name);
    if (!hpa) return missing('HorizontalPodAutoscaler', r.name, reader.namespace);
    const problems: string[] = [];
    if (r.minReplicas !== undefined && hpa.minReplicas !== r.minReplicas) {
      problems.push(`minReplicas is ${hpa.minReplicas ?? 'unset'}, expected ${r.minReplicas}`);
    }
    if (r.maxReplicas !== undefined && hpa.maxReplicas !== r.maxReplicas) {
      problems.push(`maxReplicas is ${hpa.maxReplicas}, expected ${r.maxReplicas}`);
    }
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const hpaMetricCpu: VerifierHandler<'hpa_metric_cpu'> = {
  type: 'hpa_metric_cpu',
  label: (r) => `HorizontalPodAutoscaler ${r.name} scales on CPU utilization`,
  async run(r, reader) {
    const hpa = await reader.horizontalPodAutoscaler(r.name);
    if (!hpa) return missing('HorizontalPodAutoscaler', r.name, reader.namespace);
    if (hpa.cpuAverageUtilization === undefined) {
      return fail('HPA does not declare a CPU utilization metric');
    }
    if (r.averageUtilization !== undefined && hpa.cpuAverageUtilization !== r.averageUtilization) {
      return fail(
        `CPU averageUtilization is ${hpa.cpuAverageUtilization}, expected ${r.averageUtilization}`,
      );
    }
    return pass();
  },
};

export const hpaMetricResource: VerifierHandler<'hpa_metric_resource'> = {
  type: 'hpa_metric_resource',
  label: (r) => `HorizontalPodAutoscaler ${r.name} scales on ${r.resource} utilization`,
  async run(r, reader) {
    const hpa = await reader.horizontalPodAutoscaler(r.name);
    if (!hpa) return missing('HorizontalPodAutoscaler', r.name, reader.namespace);
    const metric = hpa.resourceMetrics.find((entry) => entry.resource === r.resource);
    if (!metric) return fail(`HPA does not declare a ${r.resource} resource metric`);
    if (
      r.averageUtilization !== undefined &&
      metric.averageUtilization !== r.averageUtilization
    ) {
      return fail(
        `${r.resource} averageUtilization is ${metric.averageUtilization ?? 'unset'}, expected ${r.averageUtilization}`,
      );
    }
    return pass();
  },
};
