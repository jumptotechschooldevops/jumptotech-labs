/**
 * Terraform state, normalised.
 *
 * The verifier reads `terraform.tfstate` (state format version 4) directly
 * rather than shelling out to `terraform show -json`. Two reasons, both about
 * safety rather than speed:
 *
 *   - **Nothing runs.** Reading a file cannot apply, destroy, refresh, or reach
 *     a provider. A verification pass is incapable of changing the student's
 *     infrastructure, which is a property worth having by construction rather
 *     than by careful flag choice.
 *   - **A broken configuration still verifies.** `terraform show` needs an
 *     initialised, parseable configuration. A troubleshooting lab (TF-010) is
 *     specifically the case where that is not true, and the student still
 *     deserves an honest report of what their state does and does not contain.
 *
 * The shapes below are the documented v4 state format. Anything unrecognised is
 * ignored rather than guessed at.
 */

/** One instance of a resource — `count`/`for_each` produce several. */
export interface TerraformInstance {
  /** `count` index or `for_each` key. Absent for a singleton resource. */
  indexKey?: string | number;
  attributes: Record<string, unknown>;
}

export interface TerraformResource {
  /** `''` for the root module, else `module.name[.module.child…]`. */
  module: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  provider: string;
  instances: TerraformInstance[];
}

export interface TerraformOutput {
  value: unknown;
  sensitive: boolean;
}

export interface TerraformState {
  version: number;
  terraformVersion?: string;
  serial?: number;
  outputs: Record<string, TerraformOutput>;
  resources: TerraformResource[];
}

/** An empty state — what a workspace has before the first apply. */
export const EMPTY_STATE: TerraformState = { version: 4, outputs: {}, resources: [] };

export class TerraformStateParseError extends Error {
  readonly code = 'TERRAFORM_STATE_UNREADABLE';
  constructor(message: string) {
    super(message);
    this.name = 'TerraformStateParseError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a `terraform.tfstate` document.
 *
 * A state file that exists but has never held a resource parses to an empty
 * state rather than an error: "you have not applied anything yet" is a check
 * failure the student can act on, not a broken environment.
 */
export function parseTerraformState(text: string): TerraformState {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ...EMPTY_STATE };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (cause) {
    throw new TerraformStateParseError(
      `terraform.tfstate is not valid JSON: ${(cause as Error).message}`,
    );
  }

  const root = asRecord(raw);
  if (!root) throw new TerraformStateParseError('terraform.tfstate is not a JSON object');

  const version = typeof root.version === 'number' ? root.version : 0;
  if (version !== 0 && version !== 4) {
    throw new TerraformStateParseError(
      `unsupported Terraform state format version ${version} (this platform reads version 4)`,
    );
  }

  return {
    version: version || 4,
    ...(typeof root.terraform_version === 'string' ? { terraformVersion: root.terraform_version } : {}),
    ...(typeof root.serial === 'number' ? { serial: root.serial } : {}),
    outputs: parseOutputs(root.outputs),
    resources: parseResources(root.resources),
  };
}

function parseOutputs(raw: unknown): Record<string, TerraformOutput> {
  const record = asRecord(raw);
  if (!record) return {};

  const outputs: Record<string, TerraformOutput> = {};
  for (const [name, entry] of Object.entries(record)) {
    const body = asRecord(entry);
    if (!body) continue;
    outputs[name] = {
      value: body.value,
      sensitive: body.sensitive === true,
    };
  }
  return outputs;
}

function parseResources(raw: unknown): TerraformResource[] {
  if (!Array.isArray(raw)) return [];

  const resources: TerraformResource[] = [];
  for (const entry of raw) {
    const body = asRecord(entry);
    if (!body) continue;
    if (typeof body.type !== 'string' || typeof body.name !== 'string') continue;

    const mode = body.mode === 'data' ? 'data' : 'managed';
    resources.push({
      module: typeof body.module === 'string' ? body.module : '',
      mode,
      type: body.type,
      name: body.name,
      provider: typeof body.provider === 'string' ? body.provider : '',
      instances: parseInstances(body.instances),
    });
  }
  return resources;
}

function parseInstances(raw: unknown): TerraformInstance[] {
  if (!Array.isArray(raw)) return [];

  const instances: TerraformInstance[] = [];
  for (const entry of raw) {
    const body = asRecord(entry);
    if (!body) continue;
    const attributes = asRecord(body.attributes) ?? {};
    const indexKey = body.index_key;
    instances.push({
      ...(typeof indexKey === 'string' || typeof indexKey === 'number' ? { indexKey } : {}),
      attributes,
    });
  }
  return instances;
}

// --------------------------------------------------------------- addressing

/**
 * The canonical address of a resource, as `terraform state list` prints it.
 *
 * ```text
 *   local_file.greeting
 *   data.local_file.template
 *   module.application.random_pet.name
 *   local_file.report[0]
 * ```
 */
export function resourceAddress(
  resource: Pick<TerraformResource, 'module' | 'mode' | 'type' | 'name'>,
  indexKey?: string | number,
): string {
  const prefix = resource.module ? `${resource.module}.` : '';
  const kind = resource.mode === 'data' ? 'data.' : '';
  const base = `${prefix}${kind}${resource.type}.${resource.name}`;
  if (indexKey === undefined) return base;
  return typeof indexKey === 'number' ? `${base}[${indexKey}]` : `${base}["${indexKey}"]`;
}

/** Every address in the state, in the order `terraform state list` would show. */
export function listStateAddresses(state: TerraformState): string[] {
  const addresses: string[] = [];
  for (const resource of state.resources) {
    if (resource.instances.length === 0) {
      addresses.push(resourceAddress(resource));
      continue;
    }
    for (const instance of resource.instances) {
      addresses.push(resourceAddress(resource, instance.indexKey));
    }
  }
  return addresses.sort((a, b) => a.localeCompare(b));
}

/**
 * Does the state contain this address?
 *
 * A bare address (`local_file.report`) matches any instance of that resource,
 * so a lab can require "the resource is managed" without pinning `count`
 * indexing it never asked for. An indexed address must match exactly.
 */
export function stateContainsAddress(state: TerraformState, address: string): boolean {
  const wanted = address.trim();
  if (wanted.length === 0) return false;

  const all = listStateAddresses(state);
  if (all.includes(wanted)) return true;
  if (/[[\]]/.test(wanted)) return false;
  return all.some((candidate) => candidate.startsWith(`${wanted}[`));
}

export interface FindResourceQuery {
  type: string;
  name: string;
  mode?: 'managed' | 'data';
  /** `module.application`, or `''`/undefined for the root module. */
  module?: string;
}

/** Look up one resource. Returns null when the state does not manage it. */
export function findResource(
  state: TerraformState,
  query: FindResourceQuery,
): TerraformResource | null {
  const mode = query.mode ?? 'managed';
  const wantedModule = normaliseModule(query.module);

  return (
    state.resources.find(
      (resource) =>
        resource.type === query.type &&
        resource.name === query.name &&
        resource.mode === mode &&
        normaliseModule(resource.module) === wantedModule,
    ) ?? null
  );
}

/** Every managed resource of a given type, across all modules. */
export function resourcesOfType(state: TerraformState, type: string): TerraformResource[] {
  return state.resources.filter((r) => r.mode === 'managed' && r.type === type);
}

/** Total instances of a resource type — what a `count` lab needs to compare. */
export function countInstancesOfType(state: TerraformState, type: string): number {
  return resourcesOfType(state, type).reduce((total, r) => total + Math.max(r.instances.length, 0), 0);
}

function normaliseModule(module: string | undefined): string {
  const value = (module ?? '').trim();
  if (value === '' || value === 'root') return '';
  return value.startsWith('module.') ? value : `module.${value}`;
}

// ----------------------------------------------------------- attribute paths

/**
 * Read a dotted attribute path out of an instance's attributes.
 *
 * Supports object traversal and numeric list indexing:
 *
 * ```text
 *   filename
 *   triggers.environment
 *   permissions.0.role
 * ```
 *
 * Deliberately not a full JSONPath: a lab must be able to name a nested
 * attribute, not run a query language supplied from YAML.
 */
export function readAttributePath(attributes: Record<string, unknown>, path: string): {
  found: boolean;
  value: unknown;
} {
  const segments = path.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return { found: false, value: undefined };

  let cursor: unknown = attributes;
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return { found: false, value: undefined };
      }
      cursor = cursor[index];
      continue;
    }
    const record = asRecord(cursor);
    if (!record || !Object.hasOwn(record, segment)) return { found: false, value: undefined };
    cursor = record[segment];
  }
  return { found: true, value: cursor };
}

/**
 * Compare an observed attribute to a lab's expected value.
 *
 * Terraform stores numbers, booleans, and strings with the provider's own
 * typing, and YAML has its own opinions about `3` versus `"3"`. Comparing the
 * string forms means a lab author writing `port: 8080` and a provider storing
 * `"8080"` agree, without the check silently accepting unrelated values.
 */
export function attributeMatches(observed: unknown, expected: string | number | boolean): boolean {
  if (observed === null || observed === undefined) return false;
  if (typeof observed === 'object') return false;
  return String(observed) === String(expected);
}

/** Render an observed value for a failure message, truncated and never huge. */
export function describeValue(value: unknown, maxLength = 120): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
