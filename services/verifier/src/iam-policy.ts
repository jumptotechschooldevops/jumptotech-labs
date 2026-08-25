/**
 * IAM policy documents, parsed and evaluated — never string-matched.
 *
 * An IAM policy is JSON with a documented shape, and the same policy can be
 * written many equally-correct ways: `Action` may be a string or an array,
 * statements may appear in any order, keys may appear in any order, and
 * whitespace is meaningless. Grading such a document by looking for substrings
 * would fail correct answers and pass incorrect ones — a student who writes
 * `"Action": ["s3:GetObject"]` is not more or less right than one who writes
 * `"Action":"s3:GetObject"`.
 *
 * So this module does what the AWS documentation describes: it parses the
 * document into a normalised model and answers questions about *meaning*.
 *
 * Deliberately **not** a full IAM authorization engine. It models a single
 * identity policy: an explicit `Deny` beats an `Allow`, and anything neither
 * allowed nor denied is an implicit deny. It knows nothing about SCPs,
 * permissions boundaries, resource-based policies, or session policies, and no
 * check built on it may claim otherwise.
 *
 * Written from the IAM JSON policy reference and the ARN reference.
 */

/** One condition entry: an operator, a condition key, and its accepted values. */
export interface IamCondition {
  /** e.g. `StringEquals`, `Bool`, `IpAddress`. */
  operator: string;
  /** e.g. `aws:SourceIp`, `s3:x-amz-server-side-encryption`. */
  key: string;
  /** Always an array, even when the document wrote a bare string. */
  values: string[];
}

/** One statement, with every documented shorthand expanded. */
export interface IamStatement {
  /** Position in the original document, for failure detail only. */
  index: number;
  sid?: string;
  effect: 'Allow' | 'Deny';
  /** `Action`, always an array. Empty when the statement used `NotAction`. */
  actions: string[];
  notActions: string[];
  /** `Resource`, always an array. Empty when the statement used `NotResource`. */
  resources: string[];
  notResources: string[];
  conditions: IamCondition[];
}

export interface IamPolicy {
  version?: string;
  statements: IamStatement[];
}

/** The document could not be understood as an IAM policy. */
export class IamPolicyParseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'IamPolicyParseError';
  }
}

function asArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new IamPolicyParseError(`${field} must contain only strings`);
      }
    }
    return [...(value as string[])];
  }
  throw new IamPolicyParseError(`${field} must be a string or an array of strings`);
}

function parseConditions(raw: unknown, index: number): IamCondition[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IamPolicyParseError(`statement ${index}: Condition must be an object`);
  }

  const conditions: IamCondition[] = [];
  for (const [operator, byKey] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof byKey !== 'object' || byKey === null || Array.isArray(byKey)) {
      throw new IamPolicyParseError(
        `statement ${index}: Condition operator '${operator}' must map keys to values`,
      );
    }
    for (const [key, value] of Object.entries(byKey as Record<string, unknown>)) {
      const values =
        typeof value === 'number' || typeof value === 'boolean'
          ? [String(value)]
          : asArray(value, `statement ${index}: Condition ${operator}.${key}`);
      conditions.push({ operator, key, values });
    }
  }
  return conditions;
}

function parseStatement(raw: unknown, index: number): IamStatement {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IamPolicyParseError(`statement ${index} must be an object`);
  }
  const source = raw as Record<string, unknown>;

  const effectRaw = source.Effect;
  if (typeof effectRaw !== 'string') {
    throw new IamPolicyParseError(`statement ${index} has no Effect`);
  }
  // AWS accepts only Allow and Deny. Case is normalised so a lower-case answer
  // is graded on its meaning rather than its capitalisation.
  const normalised = effectRaw.trim().toLowerCase();
  if (normalised !== 'allow' && normalised !== 'deny') {
    throw new IamPolicyParseError(
      `statement ${index} has Effect '${effectRaw}', which is neither Allow nor Deny`,
    );
  }

  const actions = asArray(source.Action, `statement ${index}: Action`);
  const notActions = asArray(source.NotAction, `statement ${index}: NotAction`);
  if (actions.length > 0 && notActions.length > 0) {
    throw new IamPolicyParseError(
      `statement ${index} has both Action and NotAction, which is not allowed`,
    );
  }
  if (actions.length === 0 && notActions.length === 0) {
    throw new IamPolicyParseError(`statement ${index} has neither Action nor NotAction`);
  }

  const resources = asArray(source.Resource, `statement ${index}: Resource`);
  const notResources = asArray(source.NotResource, `statement ${index}: NotResource`);
  if (resources.length > 0 && notResources.length > 0) {
    throw new IamPolicyParseError(
      `statement ${index} has both Resource and NotResource, which is not allowed`,
    );
  }

  // "Statements must include either a Resource or a NotResource element."
  // — IAM JSON policy elements: Resource. This module models identity
  // policies, where that rule holds; saying so gives a student a precise error
  // instead of a statement that silently grants nothing.
  if (resources.length === 0 && notResources.length === 0) {
    throw new IamPolicyParseError(
      `statement ${index} has neither Resource nor NotResource`,
    );
  }

  const sid = typeof source.Sid === 'string' ? source.Sid : undefined;

  return {
    index,
    ...(sid !== undefined ? { sid } : {}),
    effect: normalised === 'allow' ? 'Allow' : 'Deny',
    actions,
    notActions,
    resources,
    notResources,
    conditions: parseConditions(source.Condition, index),
  };
}

/**
 * Parse a policy document.
 *
 * Throws `IamPolicyParseError` with a student-readable reason for anything that
 * is not a well-formed policy — including text that is not JSON at all.
 */
export function parseIamPolicy(text: string): IamPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new IamPolicyParseError(`the document is not valid JSON (${(cause as Error).message})`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IamPolicyParseError('a policy document must be a JSON object');
  }
  const source = raw as Record<string, unknown>;

  if (source.Statement === undefined) {
    throw new IamPolicyParseError('the document has no Statement');
  }
  // A single statement may be written as an object rather than an array.
  const rawStatements = Array.isArray(source.Statement) ? source.Statement : [source.Statement];
  if (rawStatements.length === 0) {
    throw new IamPolicyParseError('the document has an empty Statement list');
  }

  const version = typeof source.Version === 'string' ? source.Version : undefined;

  return {
    ...(version !== undefined ? { version } : {}),
    statements: rawStatements.map((statement, index) => parseStatement(statement, index)),
  };
}

/**
 * Does an IAM pattern match a literal value?
 *
 * IAM supports two wildcards: `*` for any sequence of characters and `?` for
 * exactly one. Everything else is literal, so regular-expression
 * metacharacters in an ARN (`.`, `+`, `$`, `(`) must not be treated as syntax.
 *
 * **Deliberately not implemented with a regular expression.** The pattern here
 * comes out of a file the *student* wrote, and translating `*` into `.*`
 * produces expressions like `^a.*a.*a.*b$` whose backtracking is catastrophic:
 * a short, entirely reasonable-looking policy can pin a CPU for minutes. The
 * verifier runs in the API process, so that is not a slow check — it is a
 * denial of service against every other student on the box.
 *
 * This is the classic linear wildcard match instead: one pass with a single
 * remembered `*` position, backtracking only to that position. No input can
 * make it take more than O(pattern × value) steps.
 */
export function matchesIamPattern(
  pattern: string,
  value: string,
  options: { caseSensitive?: boolean } = {},
): boolean {
  const p = options.caseSensitive ? pattern : pattern.toLowerCase();
  const v = options.caseSensitive ? value : value.toLowerCase();

  let pi = 0;
  let vi = 0;
  let starAt = -1;
  let matchAt = 0;

  while (vi < v.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === v[vi])) {
      pi += 1;
      vi += 1;
    } else if (pi < p.length && p[pi] === '*') {
      starAt = pi;
      matchAt = vi;
      pi += 1;
    } else if (starAt !== -1) {
      // The last `*` must swallow one more character.
      pi = starAt + 1;
      matchAt += 1;
      vi = matchAt;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === '*') pi += 1;
  return pi === p.length;
}

/** IAM action names are matched without regard to case. */
export function statementCoversAction(statement: IamStatement, action: string): boolean {
  if (statement.actions.length > 0) {
    return statement.actions.some((pattern) => matchesIamPattern(pattern, action));
  }
  if (statement.notActions.length > 0) {
    return !statement.notActions.some((pattern) => matchesIamPattern(pattern, action));
  }
  return false;
}

/** ARNs are matched case-sensitively, as AWS documents them. */
export function statementCoversResource(statement: IamStatement, resource: string): boolean {
  if (statement.resources.length > 0) {
    return statement.resources.some((pattern) =>
      matchesIamPattern(pattern, resource, { caseSensitive: true }),
    );
  }
  if (statement.notResources.length > 0) {
    return !statement.notResources.some((pattern) =>
      matchesIamPattern(pattern, resource, { caseSensitive: true }),
    );
  }
  /* istanbul ignore next — parsing rejects a statement with neither element. */
  return false;
}

export interface ConditionSelector {
  operator: string;
  key: string;
  /** When omitted, only the operator and key must be present. */
  value?: string;
}

/** Condition operators and keys are compared without regard to case, as AWS does. */
export function statementHasCondition(
  statement: IamStatement,
  selector: ConditionSelector,
): boolean {
  return statement.conditions.some((condition) => {
    if (condition.operator.toLowerCase() !== selector.operator.toLowerCase()) return false;
    if (condition.key.toLowerCase() !== selector.key.toLowerCase()) return false;
    if (selector.value === undefined) return true;
    return condition.values.includes(selector.value);
  });
}

export interface StatementSelector {
  effect?: 'Allow' | 'Deny';
  /** The statement must cover every action listed. */
  actions?: string[];
  /** The statement must cover every resource listed. */
  resources?: string[];
  condition?: ConditionSelector;
  sid?: string;
}

/** Every statement satisfying the selector, in document order. */
export function findStatements(policy: IamPolicy, selector: StatementSelector): IamStatement[] {
  return policy.statements.filter((statement) => {
    if (selector.effect !== undefined && statement.effect !== selector.effect) return false;
    if (selector.sid !== undefined && statement.sid !== selector.sid) return false;
    if (selector.actions?.some((action) => !statementCoversAction(statement, action))) return false;
    if (selector.resources?.some((resource) => !statementCoversResource(statement, resource))) {
      return false;
    }
    if (selector.condition !== undefined && !statementHasCondition(statement, selector.condition)) {
      return false;
    }
    return true;
  });
}

export type IamDecision = 'allow' | 'explicitDeny' | 'implicitDeny';

/**
 * Evaluate one identity policy for one action on one resource.
 *
 * The documented rule, and only that rule: an explicit `Deny` wins, otherwise a
 * matching `Allow` grants, otherwise the request is implicitly denied.
 */
export function evaluateIamPolicy(
  policy: IamPolicy,
  request: { action: string; resource: string },
): IamDecision {
  const matching = policy.statements.filter(
    (statement) =>
      statementCoversAction(statement, request.action) &&
      statementCoversResource(statement, request.resource),
  );

  if (matching.some((statement) => statement.effect === 'Deny')) return 'explicitDeny';
  if (matching.some((statement) => statement.effect === 'Allow')) return 'allow';
  return 'implicitDeny';
}

/** Statements whose `Action`/`Resource` is the bare `*` wildcard. */
export function wildcardStatements(
  policy: IamPolicy,
  field: 'Action' | 'Resource',
  effect?: 'Allow' | 'Deny',
): IamStatement[] {
  return policy.statements.filter((statement) => {
    if (effect !== undefined && statement.effect !== effect) return false;
    const values = field === 'Action' ? statement.actions : statement.resources;
    return values.includes('*');
  });
}
