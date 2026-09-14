/**
 * The lab admission policies, checked as data.
 *
 * `infrastructure/kind/admission/lab-rbac-policy.yaml` is applied by
 * `scripts/cluster-up.sh` and is the second line of the student isolation
 * boundary — RBAC is the first. It had been silently broken since it was
 * written: `matchConditions` sat one level too deep, nested inside
 * `matchConstraints` instead of beside it, and the API server rejects the whole
 * object for an unknown field under strict decoding. Both policies therefore
 * failed to install on every `cluster-up.sh` run, while their *bindings* were
 * created successfully and pointed at policies that did not exist. Nothing
 * reported an error loudly enough to notice, because `kubectl apply` had
 * already printed two successful "created" lines first.
 *
 * A second defect was hiding behind the first: `operations` listed `PATCH`,
 * which is not an admission operation. The API server normalises an HTTP PATCH
 * to UPDATE before admission runs, so the entry bought nothing and made the
 * object invalid.
 *
 * These tests are structural rather than behavioural on purpose. Whether the
 * policies *enforce* is a property of a live API server and is asserted against
 * real kind; what a hermetic test can do is guarantee the manifest still says
 * what we think it says, so neither class of silent breakage can return.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MANIFEST = path.join(repoRoot, 'infrastructure/kind/admission/lab-rbac-policy.yaml');

/** The only operations `admissionregistration.k8s.io/v1` accepts in a rule. */
const VALID_OPERATIONS = new Set(['*', 'CONNECT', 'CREATE', 'DELETE', 'UPDATE']);

interface Doc {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  spec?: Record<string, unknown>;
}

function documents(): Doc[] {
  const parsed = parseAllDocuments(readFileSync(MANIFEST, 'utf8'));
  for (const doc of parsed) expect(doc.errors, 'manifest must be valid YAML').toEqual([]);
  return parsed.map((d) => d.toJS() as Doc).filter((d) => d !== null && d !== undefined);
}

const policies = () => documents().filter((d) => d.kind === 'ValidatingAdmissionPolicy');
const bindings = () => documents().filter((d) => d.kind === 'ValidatingAdmissionPolicyBinding');

/** The two policies that act only on what a student's ServiceAccount does. */
const STUDENT_SCOPED = ['jumptotech-deny-clusterrole-bindings', 'jumptotech-protect-managed-resources'];
/** BETA-P0-016: applies to every caller, so the platform cannot unfence a namespace either. */
const REQUIRE_POD_SECURITY = 'jumptotech-require-pod-security';

describe('lab admission policies — the manifest is structurally valid', () => {
  it('ships all three policies and their bindings', () => {
    const expected = [...STUDENT_SCOPED, REQUIRE_POD_SECURITY].sort();
    expect(policies().map((p) => p.metadata?.name).sort()).toEqual(expected);
    expect(bindings().map((b) => b.metadata?.name).sort()).toEqual(expected);
  });

  it('every binding names a policy that exists in the same manifest', () => {
    // The exact failure mode that hid the bug: bindings applied cleanly and
    // referenced policies the API server had refused.
    const names = new Set(policies().map((p) => p.metadata?.name));
    for (const binding of bindings()) {
      expect(names, `binding ${binding.metadata?.name}`).toContain(binding.spec?.policyName);
    }
  });

  it('puts matchConditions on the spec, never inside matchConstraints', () => {
    /*
     * This is the regression. `matchConditions` is a field of
     * ValidatingAdmissionPolicySpec; `matchConstraints` is a MatchResources and
     * has no such field. Nested there, strict decoding rejects the object.
     */
    for (const policy of policies()) {
      const spec = policy.spec ?? {};
      const constraints = (spec.matchConstraints ?? {}) as Record<string, unknown>;

      expect(constraints.matchConditions, `${policy.metadata?.name}: matchConditions must not be nested inside matchConstraints`).toBeUndefined();
      expect(Array.isArray(spec.matchConditions), `${policy.metadata?.name}: spec.matchConditions must be a list`).toBe(true);
      expect((spec.matchConditions as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('uses only operations the admission API accepts', () => {
    // `PATCH` is the trap: a real HTTP verb, not an admission operation, and
    // listing it invalidates the whole policy.
    for (const policy of policies()) {
      const constraints = (policy.spec?.matchConstraints ?? {}) as {
        resourceRules?: Array<{ operations?: string[] }>;
      };
      for (const rule of constraints.resourceRules ?? []) {
        for (const operation of rule.operations ?? []) {
          expect(VALID_OPERATIONS, `${policy.metadata?.name}: operation ${operation}`).toContain(operation);
        }
      }
    }
  });

  it('still covers modification as well as deletion of managed resources', () => {
    /*
     * Removing `PATCH` must not have narrowed the policy. UPDATE is what a
     * PATCH arrives as, so UPDATE plus DELETE is the full intended coverage —
     * asserted here so a later "cleanup" cannot quietly drop one of them.
     */
    const policy = policies().find((p) => p.metadata?.name === 'jumptotech-protect-managed-resources');
    const rules = ((policy?.spec?.matchConstraints ?? {}) as { resourceRules?: Array<{ operations?: string[] }> })
      .resourceRules ?? [];
    const operations = new Set(rules.flatMap((r) => r.operations ?? []));

    expect(operations.has('UPDATE') || operations.has('*')).toBe(true);
    expect(operations.has('DELETE') || operations.has('*')).toBe(true);
  });
});

describe('lab admission policies — no policy is weakened', () => {
  it('every policy fails closed', () => {
    for (const policy of policies()) {
      expect(policy.spec?.failurePolicy, policy.metadata?.name).toBe('Fail');
    }
  });

  it('the student-facing policies scope themselves to lab service accounts', () => {
    for (const policy of policies().filter((p) => STUDENT_SCOPED.includes(p.metadata?.name ?? ''))) {
      const conditions = (policy.spec?.matchConditions ?? []) as Array<{ expression?: string }>;
      const expressions = conditions.map((c) => c.expression ?? '').join(' ');
      expect(expressions, policy.metadata?.name).toContain('system:serviceaccount:lab-');
    }
  });

  it('keeps a validation on every policy', () => {
    for (const policy of policies()) {
      const validations = (policy.spec?.validations ?? []) as Array<{ expression?: string; message?: string }>;
      expect(validations.length, policy.metadata?.name).toBeGreaterThan(0);
      for (const validation of validations) {
        expect(validation.expression?.trim()).toBeTruthy();
        expect(validation.message?.trim()).toBeTruthy();
      }
    }
  });

  it('still refuses RoleBindings that reference a ClusterRole', () => {
    const policy = policies().find((p) => p.metadata?.name === 'jumptotech-deny-clusterrole-bindings');
    const validations = (policy?.spec?.validations ?? []) as Array<{ expression?: string }>;

    expect(validations.some((v) => /roleRef\.kind\s*!=\s*'ClusterRole'/.test(v.expression ?? ''))).toBe(true);
  });

  it('still keys protection off the jumptotech.io/managed label', () => {
    const policy = policies().find((p) => p.metadata?.name === 'jumptotech-protect-managed-resources');
    const validations = (policy?.spec?.validations ?? []) as Array<{ expression?: string }>;

    expect(validations.some((v) => (v.expression ?? '').includes('jumptotech.io/managed'))).toBe(true);
  });

  it('binds every policy with Deny', () => {
    for (const binding of bindings()) {
      expect(binding.spec?.validationActions, binding.metadata?.name).toEqual(['Deny']);
    }
  });

  it('binds the student-facing policies only in managed namespaces', () => {
    for (const binding of bindings().filter((b) => STUDENT_SCOPED.includes(b.metadata?.name ?? ''))) {
      const matchResources = (binding.spec?.matchResources ?? {}) as {
        namespaceSelector?: { matchLabels?: Record<string, string> };
      };
      expect(matchResources.namespaceSelector?.matchLabels).toEqual({ 'jumptotech.io/managed': 'true' });
    }
  });
});

describe('lab admission policies — every managed namespace enforces Pod Security (BETA-P0-016)', () => {
  const policy = () => policies().find((p) => p.metadata?.name === REQUIRE_POD_SECURITY)!;
  const expressions = (field: 'matchConditions' | 'validations') =>
    ((policy().spec?.[field] ?? []) as Array<{ expression?: string }>).map((e) => e.expression ?? '');

  it('checks Namespace creates and updates', () => {
    const rules = (policy().spec?.matchConstraints as { resourceRules: Array<Record<string, string[]>> }).resourceRules;
    expect(rules).toEqual([
      { apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['namespaces'] },
    ]);
  });

  it('is not limited to students — the platform credential is held to it too', () => {
    expect(expressions('matchConditions').join(' ')).not.toContain('system:serviceaccount');
  });

  it('cannot be escaped by removing the managed label in the same update', () => {
    // A namespaceSelector on a Namespace reads the *new* labels; the policy
    // must look at the old object itself, and must forbid dropping the label.
    const binding = bindings().find((b) => b.metadata?.name === REQUIRE_POD_SECURITY);
    expect(binding?.spec?.matchResources).toBeUndefined();
    expect(expressions('matchConditions').join(' ')).toContain('oldObject');
    expect(expressions('validations').some((e) => e.includes("object.metadata.labels['jumptotech.io/managed'] == 'true'"))).toBe(true);
  });

  it('requires an enforce label of baseline or restricted, never privileged', () => {
    const enforce = expressions('validations').find((e) => e.includes('pod-security.kubernetes.io/enforce'));
    expect(enforce).toBeDefined();
    expect(enforce).toContain("in ['baseline', 'restricted']");
    expect(enforce).not.toContain('privileged');
  });
});

describe('lab admission policies — cluster-up applies them', () => {
  it('is referenced by the bootstrap script, before the StorageClass step', () => {
    /*
     * Ordering matters because the script runs under `set -e`: while the apply
     * failed, everything after it — including installing the StorageClass —
     * never ran. That is why one broken indent disabled two unrelated things.
     */
    const script = readFileSync(path.join(repoRoot, 'scripts/cluster-up.sh'), 'utf8');
    const applyIndex = script.indexOf('lab-rbac-policy.yaml');
    const storageIndex = script.indexOf('local-path-provisioner');

    expect(applyIndex, 'cluster-up.sh must apply the admission manifest').toBeGreaterThan(-1);
    expect(storageIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(storageIndex);
  });
});
