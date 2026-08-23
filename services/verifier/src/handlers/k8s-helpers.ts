/** Compare two label maps for exact equality on expected keys. */
export function labelsMatch(
  actual: Record<string, string>,
  expected: Record<string, string>,
): string[] {
  const problems: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (got === undefined) problems.push(`selector is missing '${key}'`);
    else if (got !== want) problems.push(`selector '${key}' is '${got}', expected '${want}'`);
  }
  return problems;
}

export function describeLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

/** Does a Role contain a rule covering the expected apiGroups/resources/verbs? */
export function roleHasRule(
  rules: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>,
  expected: { apiGroups: string[]; resources: string[]; verbs: string[] },
): boolean {
  return rules.some((rule) => {
    const apiGroups = rule.apiGroups.length === 0 ? [''] : rule.apiGroups;
    const expectedGroups = expected.apiGroups.length === 0 ? [''] : expected.apiGroups;
    const groupsOk = expectedGroups.every((group) => apiGroups.includes(group));
    const resourcesOk = expected.resources.every((resource) => rule.resources.includes(resource));
    const verbsOk = expected.verbs.every((verb) => rule.verbs.includes(verb));
    return groupsOk && resourcesOk && verbsOk;
  });
}

/** Do two toleration lists match exactly (order-sensitive)? */
export function tolerationsMatch(
  actual: Array<{ key: string; operator: string; effect?: string; value?: string }>,
  expected: Array<{ key: string; operator: string; effect?: string; value?: string }>,
): string[] {
  if (actual.length !== expected.length) {
    return [`expected ${expected.length} toleration(s), found ${actual.length}`];
  }
  const problems: string[] = [];
  for (const [index, want] of expected.entries()) {
    const got = actual[index];
    if (!got) continue;
    if (got.key !== want.key) problems.push(`toleration ${index + 1} key is '${got.key}', expected '${want.key}'`);
    if (got.operator !== want.operator) {
      problems.push(`toleration ${index + 1} operator is '${got.operator}', expected '${want.operator}'`);
    }
    if (want.effect !== undefined && got.effect !== want.effect) {
      problems.push(`toleration ${index + 1} effect is '${got.effect ?? 'unset'}', expected '${want.effect}'`);
    }
    if (want.value !== undefined && got.value !== want.value) {
      problems.push(`toleration ${index + 1} value is '${got.value ?? 'unset'}', expected '${want.value}'`);
    }
  }
  return problems;
}
