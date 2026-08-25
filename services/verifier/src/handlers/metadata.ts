/**
 * Object-metadata checks.
 *
 * One handler so far, and it reads `metadata.annotations` off a workload the
 * reader already fetches. Three properties are worth stating explicitly because
 * they are what make an annotation check safe to hand to lab content:
 *
 *   - **It cannot leave the session.** There is no namespace parameter. The
 *     `VerifyReader` is constructed for exactly one namespace and every read
 *     goes through it, so a lab definition has no way to name another student's
 *     sandbox — the type system does not offer the field.
 *   - **It cannot traverse the API.** `kind` is a closed enum over the three
 *     workloads the reader already exposes, not a group/version/resource
 *     triple, so this is not a general "read any object" primitive.
 *   - **It does not widen anyone's rights.** The verifier reads with the
 *     platform's own credentials, exactly as every other Kubernetes check does.
 *     No student RBAC changes, and nothing here needs cluster scope.
 */
import type { ContainerSnapshot, VolumeSourceSnapshot } from '@jumptotech/lab-orchestrator';
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import { imageMatches } from '../image.js';
import { selectContainer } from './pods.js';

/**
 * How much of an observed annotation value may appear in a failure message.
 *
 * Annotations are a general-purpose store and some of them are large or
 * sensitive — `kubectl.kubernetes.io/last-applied-configuration` holds an
 * entire object, environment variables included. A failing check should still
 * be debuggable, so the value the lab *asked about* is echoed, but truncated,
 * and only ever that one key. The whole annotation map is never rendered, and
 * a value is never echoed for a key the requirement did not name.
 */
const MAX_ECHOED_VALUE = 64;

function echoable(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_ECHOED_VALUE
    ? `${oneLine.slice(0, MAX_ECHOED_VALUE)}… (truncated)`
    : oneLine;
}

const KIND_LABEL = {
  deployment: 'Deployment',
  statefulset: 'StatefulSet',
  daemonset: 'DaemonSet',
} as const;

export const workloadAnnotation: VerifierHandler<'workload_annotation'> = {
  type: 'workload_annotation',
  label: (r) =>
    r.min_int === undefined
      ? `${KIND_LABEL[r.kind]} ${r.name} is annotated ${r.key}=${r.value}`
      : `${KIND_LABEL[r.kind]} ${r.name} annotation ${r.key} is at least ${r.min_int}`,
  async run(r, reader) {
    const workload =
      r.kind === 'deployment'
        ? await reader.deployment(r.name)
        : r.kind === 'statefulset'
          ? await reader.statefulSet(r.name)
          : await reader.daemonSet(r.name);

    if (!workload) return missing(KIND_LABEL[r.kind], r.name, reader.namespace);

    // A reader that does not populate annotations is indistinguishable from an
    // object carrying none. Both mean "the annotation is not there".
    const observed = (workload.annotations ?? {})[r.key];
    if (observed === undefined) {
      return fail(`${KIND_LABEL[r.kind]} '${r.name}' has no '${r.key}' annotation`);
    }

    if (r.value !== undefined) {
      return observed === r.value
        ? pass()
        : fail(`Annotation '${r.key}' is '${echoable(observed)}', expected '${r.value}'`);
    }

    /*
     * Numeric comparison, and the parse is deliberately stricter than `Number`.
     * `Number('0x3')` is 3 and `Number('')` is 0 — both would silently satisfy
     * a floor that the annotation does not actually meet. Requiring plain
     * decimal digits rejects hex, floats, exponents, signs, `Infinity` and the
     * empty string alike. The offending value is not echoed: a non-numeric
     * annotation is the case most likely to be a large or sensitive blob.
     */
    const trimmed = observed.trim();
    if (!/^\d+$/.test(trimmed)) {
      return fail(`Annotation '${r.key}' is not a whole number`);
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
      return fail(`Annotation '${r.key}' is not a whole number`);
    }

    const floor = r.min_int as number;
    return parsed >= floor
      ? pass()
      : fail(`Annotation '${r.key}' is ${parsed}, expected at least ${floor}`);
  },
};

/**
 * One container inside a workload, in whichever list the requirement names.
 *
 * The two collections are kept strictly apart. A Pod may carry the same name in
 * both `containers` and `initContainers`, and "is there an init container called
 * X" is a different question from "is there a container called X" — answering
 * the wrong one would let a lab pass with the app container doing the init
 * container's job.
 *
 * Image comparison reuses `imageMatches`, so this handler inherits exactly the
 * platform's existing normalisation and adds none of its own: registry prefixes
 * for Docker Hub are stripped and a missing tag reads as `:latest`, which makes
 * `nginx`, `nginx:latest` and `docker.io/library/nginx:latest` the same image.
 * A different registry is a different image — `registry.example.com/nginx:latest`
 * does not match `nginx:latest` — and a different tag never matches.
 */
export const workloadContainer: VerifierHandler<'workload_container'> = {
  type: 'workload_container',
  label: (r) => {
    const where = r.collection === 'initContainers' ? 'init container' : 'container';
    const kind = r.kind === 'pod' ? 'Pod' : 'Deployment';
    if (r.restartPolicy) return `${kind} ${r.name} runs ${r.container} as a native sidecar`;
    if (r.image) return `${kind} ${r.name} has ${where} ${r.container} running ${r.image}`;
    return `${kind} ${r.name} has ${where} ${r.container}`;
  },
  async run(r, reader) {
    const workload =
      r.kind === 'pod' ? await reader.pod(r.name) : await reader.deployment(r.name);
    if (!workload) return missing(r.kind === 'pod' ? 'Pod' : 'Deployment', r.name, reader.namespace);

    const list: ContainerSnapshot[] =
      r.collection === 'initContainers' ? (workload.initContainers ?? []) : workload.containers;
    const where = r.collection === 'initContainers' ? 'init container' : 'container';

    if (list.length === 0) {
      return fail(`${r.name} declares no ${where}s`);
    }

    // `selectContainer` already formats "no container named X — found ..." and
    // is reused so both messages read the same way across the track.
    const { container, detail } = selectContainer({ containers: list }, r.container);
    if (!container) return fail(`No ${where} named '${r.container}' — ${detail ?? 'not found'}`);

    const problems: string[] = [];

    if (r.image !== undefined && !imageMatches(r.image, container.image)) {
      problems.push(`image is '${container.image}', expected '${r.image}'`);
    }

    if (r.restartPolicy !== undefined && container.restartPolicy !== r.restartPolicy) {
      /*
       * Deliberately reads the container's own field. A Deployment's Pod
       * template always sets `restartPolicy: Always` at Pod level, so reading
       * that instead would report every init container as a native sidecar.
       */
      problems.push(
        container.restartPolicy === undefined
          ? `restartPolicy is not set on the container, expected '${r.restartPolicy}'`
          : `restartPolicy is '${container.restartPolicy}', expected '${r.restartPolicy}'`,
      );
    }

    const listsMatch = (a: string[] | undefined, b: string[]): boolean =>
      a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

    if (r.command !== undefined && !listsMatch(container.command, r.command)) {
      problems.push(`command is ${describeArgv(container.command)}, expected ${describeArgv(r.command)}`);
    }
    if (r.args !== undefined && !listsMatch(container.args, r.args)) {
      problems.push(`args are ${describeArgv(container.args)}, expected ${describeArgv(r.args)}`);
    }

    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

/** Render an argv for a failure message, bounded so a long one cannot flood it. */
function describeArgv(argv: string[] | undefined): string {
  if (argv === undefined) return 'unset';
  const rendered = JSON.stringify(argv);
  return rendered.length > 120 ? `${rendered.slice(0, 120)}… (truncated)` : rendered;
}

/**
 * One container's mount of one volume.
 *
 * Three things have to line up, and the handler keeps them separate so a
 * failure says which one is wrong:
 *
 *   1. the named container exists in the named list;
 *   2. *that container* mounts a volume of the given name — not the workload
 *      somewhere, and not a different container;
 *   3. it mounts it at the required path.
 *
 * A volume declared in `spec.volumes` and mounted by nobody fails, which is the
 * point: an unmounted volume changes nothing about how the Pod runs.
 */
export const workloadVolumeMount: VerifierHandler<'workload_volume_mount'> = {
  type: 'workload_volume_mount',
  label: (r) => {
    const where = r.collection === 'initContainers' ? 'init container' : 'container';
    const kind = r.kind === 'pod' ? 'Pod' : 'Deployment';
    return `${kind} ${r.name} mounts volume ${r.volume} at ${r.mountPath} in ${where} ${r.container}`;
  },
  async run(r, reader) {
    const workload =
      r.kind === 'pod' ? await reader.pod(r.name) : await reader.deployment(r.name);
    if (!workload) return missing(r.kind === 'pod' ? 'Pod' : 'Deployment', r.name, reader.namespace);

    const list: ContainerSnapshot[] =
      r.collection === 'initContainers' ? (workload.initContainers ?? []) : workload.containers;
    const where = r.collection === 'initContainers' ? 'init container' : 'container';

    if (list.length === 0) return fail(`${r.name} declares no ${where}s`);

    const { container } = selectContainer({ containers: list }, r.container);
    if (!container) {
      const names = list.map((c) => `'${c.name}'`).join(', ');
      return fail(`No ${where} named '${r.container}' — found ${names}`);
    }

    const mounts = container.volumeMounts ?? [];
    const mount = mounts.find((m) => m.name === r.volume);
    if (!mount) {
      /*
       * Distinguish "the volume is not mounted here" from "the volume does not
       * exist at all". A student who declared the volume but forgot the mount
       * gets told that, rather than being sent hunting for a typo.
       */
      const declared = (workload.volumes ?? []).some((v) => v.name === r.volume);
      const mounted = mounts.map((m) => `'${m.name}'`).join(', ') || 'nothing';
      return fail(
        declared
          ? `Volume '${r.volume}' exists on the Pod but ${where} '${r.container}' does not mount it — it mounts ${mounted}`
          : `${where} '${r.container}' does not mount a volume named '${r.volume}' — it mounts ${mounted}`,
      );
    }

    const problems: string[] = [];
    if (mount.mountPath !== r.mountPath) {
      problems.push(`mounted at '${mount.mountPath}', expected '${r.mountPath}'`);
    }
    if (r.readOnly !== undefined && (mount.readOnly ?? false) !== r.readOnly) {
      problems.push(`readOnly is ${mount.readOnly ?? false}, expected ${r.readOnly}`);
    }
    if (r.subPath !== undefined && mount.subPath !== r.subPath) {
      problems.push(`subPath is ${mount.subPath === undefined ? 'unset' : `'${mount.subPath}'`}, expected '${r.subPath}'`);
    }

    if (r.source !== undefined) {
      // Resolved through the Pod's own volume list, so "mounts a volume called
      // logs" cannot be satisfied by a Secret that happens to share the name.
      const volume: VolumeSourceSnapshot | undefined = (workload.volumes ?? []).find(
        (v) => v.name === r.volume,
      );
      if (!volume) {
        problems.push(`no volume named '${r.volume}' is declared on the Pod`);
      } else if (volume.source !== r.source) {
        problems.push(`volume '${r.volume}' is a ${volume.source}, expected ${r.source}`);
      }
    }

    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};
