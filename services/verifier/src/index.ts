/**
 * Lab verifier.
 *
 * Reads the *desired state* from the lab definition and the *actual state*
 * from the live Kubernetes API, then reports each check independently.
 *
 * Explicit non-goals:
 *   - It never looks at command history, shell buffers, or terminal output.
 *     A student who creates the Pod from a manifest, from `kubectl run`, or
 *     from a CI job they wrote themselves all pass identically.
 *   - It never reveals the solution. Failure details describe *what is wrong*
 *     with the observed state, not what to type.
 */
import type {
  KubernetesPort,
  LabDefinition,
  PodSnapshot,
} from '@jumptotech/lab-orchestrator';
import { KubernetesUnreachableError } from '@jumptotech/lab-orchestrator';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  /** Why it failed / what was observed. Never the solution. */
  detail?: string;
}

export interface VerificationResult {
  labId: string;
  passed: boolean;
  /** `LAB PASSED` / `LAB NOT COMPLETE` — the headline the UI renders. */
  summary: 'LAB PASSED' | 'LAB NOT COMPLETE';
  checks: CheckResult[];
  checkedAt: string;
  /** Set when verification could not run at all (cluster unreachable). */
  error?: { code: string; message: string };
}

export interface VerifyOptions {
  k8s: KubernetesPort;
  lab: LabDefinition;
  now?: () => Date;
}

/** Parse `repo:tag` / `repo@digest`, defaulting a missing tag to `latest`. */
export function normalizeImageReference(image: string): string {
  const trimmed = image.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes('@')) return trimmed;

  // A colon before the last slash belongs to a registry port, not a tag.
  const lastColon = trimmed.lastIndexOf(':');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastColon > lastSlash) return trimmed;
  return `${trimmed}:latest`;
}

/**
 * True when the observed image satisfies the required image.
 *
 * Tolerates the registry prefixes a kubelet may report (`docker.io/library/…`)
 * while still rejecting a genuinely different image or tag.
 */
export function imageMatches(required: string, observed: string): boolean {
  const norm = (value: string) => {
    let v = normalizeImageReference(value);
    for (const prefix of ['docker.io/library/', 'index.docker.io/library/', 'docker.io/', 'index.docker.io/']) {
      if (v.startsWith(prefix)) {
        v = v.slice(prefix.length);
        break;
      }
    }
    return v;
  };
  return norm(required) === norm(observed);
}

export async function verifyLab(options: VerifyOptions): Promise<VerificationResult> {
  const { lab, k8s } = options;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const requirements = lab.requirements;

  let pod: PodSnapshot | null = null;
  try {
    pod = await k8s.getPod(requirements.namespace, requirements.pod_name);
  } catch (error) {
    const message =
      error instanceof KubernetesUnreachableError || error instanceof Error
        ? error.message
        : String(error);
    return {
      labId: lab.id,
      passed: false,
      summary: 'LAB NOT COMPLETE',
      checkedAt,
      checks: lab.verification.checks.map((c) => ({
        id: c.id,
        label: c.label,
        status: 'skipped' as const,
        detail: 'Could not read cluster state',
      })),
      error: { code: 'ENVIRONMENT_UNREACHABLE', message },
    };
  }

  const checks: CheckResult[] = lab.verification.checks.map((definition) =>
    runCheck(definition.type, {
      id: definition.id,
      label: definition.label,
      pod,
      requirements,
    }),
  );

  const passed = checks.every((c) => c.status === 'pass');
  return {
    labId: lab.id,
    passed,
    summary: passed ? 'LAB PASSED' : 'LAB NOT COMPLETE',
    checks,
    checkedAt,
  };
}

interface CheckInput {
  id: string;
  label: string;
  pod: PodSnapshot | null;
  requirements: LabDefinition['requirements'];
}

function runCheck(type: string, input: CheckInput): CheckResult {
  const { id, label, pod, requirements } = input;
  const base = { id, label };

  // Every check downstream of existence is a plain failure when the Pod is
  // absent — we report each one so the student sees the full picture.
  if (!pod) {
    return {
      ...base,
      status: 'fail',
      detail:
        type === 'pod_exists'
          ? `No Pod named '${requirements.pod_name}' found in namespace '${requirements.namespace}'`
          : 'Pod not found',
    };
  }

  switch (type) {
    case 'pod_exists':
      return pod.deleting
        ? { ...base, status: 'fail', detail: 'Pod exists but is terminating' }
        : { ...base, status: 'pass' };

    case 'pod_namespace':
      return pod.namespace === requirements.namespace
        ? { ...base, status: 'pass' }
        : {
            ...base,
            status: 'fail',
            detail: `Pod is in namespace '${pod.namespace}', expected '${requirements.namespace}'`,
          };

    case 'container_image': {
      if (pod.containers.length === 0) {
        return { ...base, status: 'fail', detail: 'Pod declares no containers' };
      }
      const match = pod.containers.find((c) => imageMatches(requirements.image, c.image));
      if (match) return { ...base, status: 'pass' };
      const observed = pod.containers.map((c) => c.image).join(', ');
      return {
        ...base,
        status: 'fail',
        detail: `Incorrect image — found '${observed}', expected '${requirements.image}'`,
      };
    }

    case 'pod_phase':
      if (pod.phase === requirements.status) return { ...base, status: 'pass' };
      return {
        ...base,
        status: 'fail',
        detail: describePhaseFailure(pod, requirements.status),
      };

    case 'container_ready': {
      if (pod.containers.length === 0) {
        return { ...base, status: 'fail', detail: 'Pod declares no containers' };
      }
      const notReady = pod.containers.filter((c) => !c.ready);
      if (notReady.length === 0) return { ...base, status: 'pass' };
      const detail = notReady
        .map((c) => `${c.name} (${c.state}${c.reason ? `: ${c.reason}` : ''})`)
        .join(', ');
      return { ...base, status: 'fail', detail: `Container not Ready — ${detail}` };
    }

    default:
      return { ...base, status: 'skipped', detail: `Unsupported check type '${type}'` };
  }
}

function describePhaseFailure(pod: PodSnapshot, expected: string): string {
  const blocked = pod.containers.find((c) => c.reason);
  const suffix = blocked ? ` (${blocked.name}: ${blocked.reason})` : '';
  return `Pod phase is '${pod.phase}', expected '${expected}'${suffix}`;
}
