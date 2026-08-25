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
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';

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
