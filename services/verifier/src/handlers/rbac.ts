import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import { roleHasRule } from './k8s-helpers.js';

export const roleExists: VerifierHandler<'role_exists'> = {
  type: 'role_exists',
  label: (r) => `Role ${r.name} exists`,
  async run(r, reader) {
    const role = await reader.role(r.name);
    if (!role) return missing('Role', r.name, reader.namespace);
    if (role.deleting) return fail(`Role '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const roleRule: VerifierHandler<'role_rule'> = {
  type: 'role_rule',
  label: (r) => `Role ${r.name} grants the required permissions`,
  async run(r, reader) {
    const role = await reader.role(r.name);
    if (!role) return missing('Role', r.name, reader.namespace);
    return roleHasRule(role.rules, {
      apiGroups: r.apiGroups,
      resources: r.resources,
      verbs: r.verbs,
    })
      ? pass()
      : fail(
          `Role '${r.name}' does not include a rule for ${r.verbs.join(', ')} on ${r.resources.join(', ')}`,
        );
  },
};

export const roleBindingExists: VerifierHandler<'rolebinding_exists'> = {
  type: 'rolebinding_exists',
  label: (r) => `RoleBinding ${r.name} exists`,
  async run(r, reader) {
    const binding = await reader.roleBinding(r.name);
    if (!binding) return missing('RoleBinding', r.name, reader.namespace);
    if (binding.deleting) return fail(`RoleBinding '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const roleBindingSubject: VerifierHandler<'rolebinding_subject'> = {
  type: 'rolebinding_subject',
  label: (r) => `RoleBinding ${r.name} binds ${r.kind} ${r.subjectName}`,
  async run(r, reader) {
    const binding = await reader.roleBinding(r.name);
    if (!binding) return missing('RoleBinding', r.name, reader.namespace);
    const match = binding.subjects.some((s) => s.kind === r.kind && s.name === r.subjectName);
    return match
      ? pass()
      : fail(
          `RoleBinding '${r.name}' does not bind ${r.kind} '${r.subjectName}' — found ${binding.subjects.map((s) => `${s.kind}/${s.name}`).join(', ') || 'no subjects'}`,
        );
  },
};

export const roleBindingRoleRef: VerifierHandler<'rolebinding_role_ref'> = {
  type: 'rolebinding_role_ref',
  label: (r) => `RoleBinding ${r.name} references ${r.roleKind} ${r.roleName}`,
  async run(r, reader) {
    const binding = await reader.roleBinding(r.name);
    if (!binding) return missing('RoleBinding', r.name, reader.namespace);
    if (binding.roleRef.kind !== r.roleKind || binding.roleRef.name !== r.roleName) {
      return fail(
        `RoleBinding references ${binding.roleRef.kind}/${binding.roleRef.name}, expected ${r.roleKind}/${r.roleName}`,
      );
    }
    return pass();
  },
};

export const serviceAccountExists: VerifierHandler<'serviceaccount_exists'> = {
  type: 'serviceaccount_exists',
  label: (r) => `ServiceAccount ${r.name} exists`,
  async run(r, reader) {
    const sa = await reader.serviceAccount(r.name);
    if (!sa) return missing('ServiceAccount', r.name, reader.namespace);
    if (sa.deleting) return fail(`ServiceAccount '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const authAllowed: VerifierHandler<'auth_allowed'> = {
  type: 'auth_allowed',
  label: (r) =>
    r.name
      ? `ServiceAccount ${r.serviceAccount} may ${r.verb} ${r.resource}/${r.name}`
      : `ServiceAccount ${r.serviceAccount} may ${r.verb} ${r.resource}`,
  async run(r, reader) {
    const result = await reader.checkAuthorization({
      serviceAccount: r.serviceAccount,
      verb: r.verb,
      resource: r.resource,
      apiGroup: r.apiGroup,
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.subresource !== undefined ? { subresource: r.subresource } : {}),
    });
    return result.allowed
      ? pass()
      : fail(result.reason ?? `Authorization denied for ${r.serviceAccount}`);
  },
};

export const authForbidden: VerifierHandler<'auth_forbidden'> = {
  type: 'auth_forbidden',
  label: (r) =>
    r.name
      ? `ServiceAccount ${r.serviceAccount} must not ${r.verb} ${r.resource}/${r.name}`
      : `ServiceAccount ${r.serviceAccount} must not ${r.verb} ${r.resource}`,
  async run(r, reader) {
    const result = await reader.checkAuthorization({
      serviceAccount: r.serviceAccount,
      verb: r.verb,
      resource: r.resource,
      apiGroup: r.apiGroup,
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.subresource !== undefined ? { subresource: r.subresource } : {}),
    });
    return result.allowed
      ? fail(`Authorization unexpectedly allowed for ${r.serviceAccount}`)
      : pass();
  },
};
