/**
 * CloudFormation templates, parsed and inspected — never string-matched.
 *
 * A template is YAML or JSON with a documented shape, and the same template can
 * be written many equally-correct ways. `!Ref Bucket` and `{"Ref": "Bucket"}`
 * are the same reference; `!GetAtt Bucket.Arn` and
 * `{"Fn::GetAtt": ["Bucket", "Arn"]}` are the same call; resources and
 * properties may appear in any order, and JSON is a subset of YAML. Grading
 * such a document by looking for text would fail correct answers and pass
 * incorrect ones.
 *
 * So parsing normalises the short forms into their canonical `Fn::` shape,
 * which makes a YAML template and the equivalent JSON template *the same
 * object*, and everything below asks questions about meaning.
 *
 * Deliberately **not** a CloudFormation implementation. It does not know which
 * properties a resource type requires, which attributes `Fn::GetAtt` may
 * return, or what a stack would do. It reads the template's own structure and
 * its internal references, which is what a template review and a
 * failed-deployment post-mortem actually turn on. Conditions, Mappings,
 * Transforms and `DependsOn` are not modelled; no lab needs them yet.
 *
 * Written from the CloudFormation template reference.
 */
import { parse as parseYaml } from 'yaml';

/** A resource declaration: its logical ID, its type, and its properties. */
export interface CfnResource {
  logicalId: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface CfnTemplate {
  formatVersion?: string;
  description?: string;
  parameterNames: string[];
  resources: Record<string, CfnResource>;
  outputs: Record<string, unknown>;
}

/** The document could not be understood as a CloudFormation template. */
export class CloudFormationParseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CloudFormationParseError';
  }
}

/**
 * Pseudo parameters CloudFormation resolves itself.
 *
 * A `Ref` to one of these is always resolvable, so reference checking must not
 * report them as dangling.
 */
export const CFN_PSEUDO_PARAMETERS: readonly string[] = [
  'AWS::AccountId',
  'AWS::NoValue',
  'AWS::NotificationARNs',
  'AWS::Partition',
  'AWS::Region',
  'AWS::StackId',
  'AWS::StackName',
  'AWS::URLSuffix',
];

/**
 * YAML short forms, mapped onto the canonical long forms.
 *
 * `!GetAtt` splits on the **first** dot only: the documentation's own example
 * uses `!GetAtt myELB.SourceSecurityGroup.OwnerAlias`, where the logical ID is
 * `myELB` and the attribute name itself contains a dot.
 */
const CFN_TAGS = [
  { tag: '!Ref', resolve: (v: unknown) => ({ Ref: String(v) }) },
  { tag: '!Sub', resolve: (v: unknown) => ({ 'Fn::Sub': v }) },
  { tag: '!Sub', collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ 'Fn::Sub': seq.toJSON() }) },
  {
    tag: '!GetAtt',
    resolve: (v: unknown) => {
      const text = String(v);
      const dot = text.indexOf('.');
      return dot === -1
        ? { 'Fn::GetAtt': [text] }
        : { 'Fn::GetAtt': [text.slice(0, dot), text.slice(dot + 1)] };
    },
  },
  { tag: '!GetAtt', collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ 'Fn::GetAtt': seq.toJSON() }) },
  { tag: '!Join', collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ 'Fn::Join': seq.toJSON() }) },
  { tag: '!Select', collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ 'Fn::Select': seq.toJSON() }) },
  { tag: '!Split', collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ 'Fn::Split': seq.toJSON() }) },
  { tag: '!FindInMap', collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ 'Fn::FindInMap': seq.toJSON() }) },
  { tag: '!Equals', collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ 'Fn::Equals': seq.toJSON() }) },
  { tag: '!If', collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ 'Fn::If': seq.toJSON() }) },
  { tag: '!Base64', resolve: (v: unknown) => ({ 'Fn::Base64': v }) },
  { tag: '!ImportValue', resolve: (v: unknown) => ({ 'Fn::ImportValue': v }) },
];

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a template.
 *
 * YAML is a superset of JSON, so one parser serves both and a JSON template
 * and the equivalent YAML template produce the identical structure.
 */
export function parseCloudFormationTemplate(text: string): CfnTemplate {
  if (text.trim().length === 0) {
    throw new CloudFormationParseError('the template is empty');
  }

  let raw: unknown;
  try {
    raw = parseYaml(text, { customTags: CFN_TAGS as never });
  } catch (cause) {
    throw new CloudFormationParseError(
      `the template is not valid YAML or JSON (${(cause as Error).message})`,
    );
  }

  const root = asObject(raw);
  if (!root) throw new CloudFormationParseError('a template must be a mapping of sections');

  // "The Resources section is required in every CloudFormation template."
  const resourcesRaw = asObject(root.Resources);
  if (root.Resources === undefined) {
    throw new CloudFormationParseError('the template has no Resources section');
  }
  if (!resourcesRaw) {
    throw new CloudFormationParseError('the Resources section must be a mapping of logical IDs');
  }
  if (Object.keys(resourcesRaw).length === 0) {
    throw new CloudFormationParseError('the Resources section is empty');
  }

  const resources: Record<string, CfnResource> = {};
  for (const [logicalId, value] of Object.entries(resourcesRaw)) {
    const declaration = asObject(value);
    if (!declaration) {
      throw new CloudFormationParseError(`resource '${logicalId}' must be a mapping`);
    }
    if (typeof declaration.Type !== 'string' || declaration.Type.trim().length === 0) {
      throw new CloudFormationParseError(`resource '${logicalId}' has no Type`);
    }
    const properties = declaration.Properties === undefined ? {} : asObject(declaration.Properties);
    if (!properties) {
      throw new CloudFormationParseError(`resource '${logicalId}' has non-mapping Properties`);
    }
    resources[logicalId] = { logicalId, type: declaration.Type, properties };
  }

  const parameters = asObject(root.Parameters) ?? {};
  const outputs = asObject(root.Outputs) ?? {};

  return {
    ...(typeof root.AWSTemplateFormatVersion === 'string'
      ? { formatVersion: root.AWSTemplateFormatVersion }
      : {}),
    ...(typeof root.Description === 'string' ? { description: root.Description } : {}),
    parameterNames: Object.keys(parameters),
    resources,
    outputs,
  };
}

/**
 * Read a dotted property path.
 *
 * Two tolerances, both of which reflect what CloudFormation itself accepts:
 * a numeric segment indexes an array, and `0` against a non-array yields the
 * value itself — a policy document with one statement may be written as an
 * object rather than a one-element list.
 */
export function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    const object = asObject(current);
    if (!object) return undefined;
    if (/^\d+$/.test(segment)) {
      // `0` against a mapping means "this single element".
      if (segment === '0') continue;
      return undefined;
    }
    current = object[segment];
  }
  return current;
}

/**
 * Compare a template value with an expected scalar.
 *
 * A one-element list is treated as the scalar it wraps, because
 * `Action: sts:AssumeRole` and `Action: [sts:AssumeRole]` are the same policy.
 */
export function valueEquals(actual: unknown, expected: string): boolean {
  if (Array.isArray(actual)) {
    return actual.length === 1 && valueEquals(actual[0], expected);
  }
  if (typeof actual === 'string') return actual === expected;
  if (typeof actual === 'number' || typeof actual === 'boolean') return String(actual) === expected;
  return false;
}

/** One `Ref`, `Fn::GetAtt` or `Fn::Sub` variable found in the template. */
export interface CfnReference {
  kind: 'Ref' | 'GetAtt' | 'Sub';
  /** The logical ID or parameter name being referenced. */
  target: string;
  /** Present for `GetAtt`, and for `Sub` variables written `${Thing.Attr}`. */
  attribute?: string;
  /** Where in the template it was found, for failure detail. */
  where: string;
}

/** `${Foo}` and `${Foo.Bar}` inside a Sub string. `${!Literal}` is escaped. */
function subVariables(template: string, where: string): CfnReference[] {
  const found: CfnReference[] = [];
  for (const match of template.matchAll(/\$\{([^}]*)\}/g)) {
    const body = match[1] ?? '';
    if (body.startsWith('!')) continue;
    const dot = body.indexOf('.');
    found.push(
      dot === -1
        ? { kind: 'Sub', target: body, where }
        : { kind: 'Sub', target: body.slice(0, dot), attribute: body.slice(dot + 1), where },
    );
  }
  return found;
}

/** Every reference in a value, recursively. */
function walk(value: unknown, where: string, into: CfnReference[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${where}[${index}]`, into));
    return;
  }
  const object = asObject(value);
  if (!object) return;

  if (typeof object.Ref === 'string') {
    into.push({ kind: 'Ref', target: object.Ref, where });
    return;
  }
  const getAtt = object['Fn::GetAtt'];
  if (getAtt !== undefined) {
    const parts = Array.isArray(getAtt) ? getAtt.map(String) : [String(getAtt)];
    const target = parts[0] ?? '';
    const attribute = parts.slice(1).join('.');
    into.push({ kind: 'GetAtt', target, ...(attribute ? { attribute } : {}), where });
    return;
  }
  const sub = object['Fn::Sub'];
  if (sub !== undefined) {
    // `Fn::Sub` is either a string, or [string, {vars}] — only the string half
    // carries references to the rest of the template.
    const body = Array.isArray(sub) ? sub[0] : sub;
    if (typeof body === 'string') into.push(...subVariables(body, where));
    if (Array.isArray(sub) && sub[1] !== undefined) walk(sub[1], where, into);
    return;
  }

  for (const [key, entry] of Object.entries(object)) walk(entry, `${where}.${key}`, into);
}

/** Every reference the template makes, from Resources and Outputs. */
export function collectReferences(template: CfnTemplate): CfnReference[] {
  const found: CfnReference[] = [];
  for (const resource of Object.values(template.resources)) {
    walk(resource.properties, `Resources.${resource.logicalId}.Properties`, found);
  }
  walk(template.outputs, 'Outputs', found);
  return found;
}

/**
 * References that point at nothing the template declares.
 *
 * This is the check a failed deployment usually needed: a typo in a logical ID
 * or a `Sub` variable naming a parameter that was never declared.
 */
export function unresolvedReferences(template: CfnTemplate): CfnReference[] {
  const known = new Set<string>([
    ...Object.keys(template.resources),
    ...template.parameterNames,
    ...CFN_PSEUDO_PARAMETERS,
  ]);
  return collectReferences(template).filter((reference) => !known.has(reference.target));
}

/** The reference at one property path, if the value there is one. */
export function referenceAt(
  template: CfnTemplate,
  logicalId: string,
  path: string,
): CfnReference | null {
  const resource = template.resources[logicalId];
  if (!resource) return null;
  const value = readPath(resource.properties, path);
  const found: CfnReference[] = [];
  walk(value, `Resources.${logicalId}.Properties.${path}`, found);
  return found[0] ?? null;
}

/** The reference an output's `Value` makes, if any. */
export function outputReference(template: CfnTemplate, name: string): CfnReference | null {
  const output = asObject(template.outputs[name]);
  if (!output) return null;
  const found: CfnReference[] = [];
  walk(output.Value, `Outputs.${name}.Value`, found);
  return found[0] ?? null;
}
