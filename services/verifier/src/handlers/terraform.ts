/**
 * Terraform requirement handlers.
 *
 * The rule these exist to enforce: **`terraform apply` having been typed is not
 * a pass.** Every check below reads what a run actually left behind —
 * `.terraform/` and the dependency lock file for init, `terraform.tfstate` for
 * resources and outputs, the student's own `.tf` files for the things state
 * cannot show — so a student whose apply errored does not pass, and a student
 * who reached the same state a different way does.
 *
 * Three rules every handler here follows:
 *
 *   1. **Never look at what was typed.** A student who writes `main.tf` by
 *      hand, generates it, or applies with `-var` on the command line all reach
 *      the same state, and all pass identically.
 *   2. **Never reveal the solution.** A failure says what was observed — "no
 *      `local_file` resource named `greeting` is in state" — not what to write.
 *   3. **Never hold a secret.** `terraform_output_equals` refuses to compare a
 *      sensitive output rather than reading one into the platform.
 *
 * State and configuration are read, never executed. The verifier does not run
 * `terraform show` in the student's working directory: that would mean
 * executing a directory whose contents the student controls, from the
 * platform's own verification path, for information the state file already
 * contains. The two exceptions — `terraform validate` and `terraform fmt
 * -check` — answer questions no file on disk answers, and are documented
 * read-only subcommands reached through the provider's allow-listed tool port.
 */
import {
  argumentValue,
  attributeMatches,
  blocksOfType,
  countInstancesOfType,
  describeValue,
  findBlock,
  findNestedBlock,
  hasArgument,
  listStateAddresses,
  literalString,
  readAttributePath,
  referencedNames,
  resourceAddress,
  stateContainsAddress,
  type HclBlock,
  type HclDocument,
  type TerraformResource,
  type TerraformState,
} from '@jumptotech/lab-orchestrator';
import {
  fail,
  missingPath,
  pass,
  skip,
  type HandlerOutcome,
  type SandboxVerifierHandler,
} from '../contract.js';
import {
  SandboxCapabilityMissingError,
  TERRAFORM_LOCK_FILE,
  TERRAFORM_STATE_FILE,
  TERRAFORM_WORK_DIR,
  type SandboxReader,
} from '../sandbox-reader.js';

/** Shown whenever a check needs state and nothing has been applied yet. */
const noState = (where: string): string =>
  `No readable Terraform state at '${where}' — nothing has been applied there yet`;

/** Every state-reading requirement carries the same two fields. */
interface StateTarget {
  dir: string;
  state_file?: string | undefined;
}

/**
 * Load state, or explain its absence in the caller's terms.
 *
 * Every state-reading handler starts here so that "you have not applied yet"
 * reads the same everywhere, and so a corrupt state file produces one clear
 * message instead of a different mangled one per check. The message names the
 * file that was actually looked at, which matters once a lab has moved state
 * with a `backend "local"` block.
 */
async function withState(
  reader: SandboxReader,
  target: StateTarget,
  use: (state: TerraformState) => HandlerOutcome | Promise<HandlerOutcome>,
): Promise<HandlerOutcome> {
  const state = await reader.terraformState(target.dir, target.state_file);
  if (state === null) return fail(noState(reader.statePath(target.dir, target.state_file)));
  return use(state);
}

/** Load the scanned configuration, or skip when the sandbox cannot list files. */
async function withConfig(
  reader: SandboxReader,
  dir: string,
  use: (config: HclDocument) => HandlerOutcome | Promise<HandlerOutcome>,
): Promise<HandlerOutcome> {
  try {
    return await use(await reader.terraformConfig(dir));
  } catch (error) {
    if (error instanceof SandboxCapabilityMissingError) return skip(error.message);
    throw error;
  }
}

/** `application` and `module.application` both name the same module. */
function normaliseModule(module: string | undefined): string {
  const value = (module ?? '').trim();
  if (value === '' || value === 'root') return '';
  return value.startsWith('module.') ? value : `module.${value}`;
}

function moduleLabel(module: string | undefined): string {
  const normalised = normaliseModule(module);
  return normalised === '' ? 'the root module' : `'${normalised}'`;
}

function locate(
  state: TerraformState,
  query: { resource_type: string; name: string; mode?: 'managed' | 'data'; module?: string },
): TerraformResource | null {
  const mode = query.mode ?? 'managed';
  const wantedModule = normaliseModule(query.module);
  return (
    state.resources.find(
      (resource) =>
        resource.type === query.resource_type &&
        resource.name === query.name &&
        resource.mode === mode &&
        normaliseModule(resource.module) === wantedModule,
    ) ?? null
  );
}

/** `local_file.greeting`, or `data.local_file.template`. */
function describeTarget(query: {
  resource_type: string;
  name: string;
  mode?: 'managed' | 'data';
  module?: string;
}): string {
  return resourceAddress({
    module: normaliseModule(query.module),
    mode: query.mode ?? 'managed',
    type: query.resource_type,
    name: query.name,
  });
}

/** A short list of what *is* in state, so a failure is actionable. */
function stateHint(state: TerraformState, limit = 6): string {
  const addresses = listStateAddresses(state);
  if (addresses.length === 0) return 'state is empty';
  const shown = addresses.slice(0, limit).join(', ');
  return addresses.length > limit
    ? `state contains: ${shown}, and ${addresses.length - limit} more`
    : `state contains: ${shown}`;
}

/** A short list of the `.tf` files that were scanned. */
async function configHint(reader: SandboxReader, dir: string): Promise<string> {
  const paths = await reader.terraformConfigPaths(dir);
  if (paths.length === 0) return `no .tf files were found in '${dir}'`;
  return `scanned ${paths.slice(0, 6).join(', ')}`;
}

// ====================================================== working directory

export const terraformInitialized: SandboxVerifierHandler<'terraform_initialized'> = {
  type: 'terraform_initialized',
  label: (r) => `Terraform is initialized in ${r.dir}`,
  async run(requirement, reader) {
    const dir = await reader.path(requirement.dir);
    if (!dir) return missingPath('directory', requirement.dir);
    if (dir.type !== 'directory') {
      return fail(`'${requirement.dir}' is not a directory`);
    }

    const work = await reader.path(reader.join(requirement.dir, TERRAFORM_WORK_DIR));
    if (!work || work.type !== 'directory') {
      return fail(
        `'${requirement.dir}' has no ${TERRAFORM_WORK_DIR} directory — Terraform has not been initialized here`,
      );
    }

    const lock = await reader.path(reader.join(requirement.dir, TERRAFORM_LOCK_FILE));
    if (!lock || lock.type !== 'file') {
      return fail(
        `'${requirement.dir}' has no ${TERRAFORM_LOCK_FILE} — the provider dependencies were not recorded`,
      );
    }
    return pass();
  },
};

export const terraformValid: SandboxVerifierHandler<'terraform_valid'> = {
  type: 'terraform_valid',
  label: (r) => `The configuration in ${r.dir} is valid`,
  async run(requirement, reader) {
    let result;
    try {
      result = await reader.terraformValidate(requirement.dir);
    } catch (error) {
      if (error instanceof SandboxCapabilityMissingError) return skip(error.message);
      throw error;
    }

    if (result.valid) return pass();
    if (result.error) return fail(`terraform validate could not run: ${result.error}`);
    return fail(
      result.diagnostics.length > 0
        ? `terraform validate reported ${result.diagnostics.length} error${result.diagnostics.length === 1 ? '' : 's'}: ${result.diagnostics.join(' | ')}`
        : 'terraform validate reported the configuration as invalid',
    );
  },
};

export const terraformFormatted: SandboxVerifierHandler<'terraform_formatted'> = {
  type: 'terraform_formatted',
  label: (r) => `The configuration in ${r.dir} is canonically formatted`,
  async run(requirement, reader) {
    let result;
    try {
      result = await reader.terraformFormatted(requirement.dir);
    } catch (error) {
      if (error instanceof SandboxCapabilityMissingError) return skip(error.message);
      throw error;
    }

    if (result.formatted) return pass();
    if (result.error) return fail(`terraform fmt could not run: ${result.error}`);
    return fail(
      `terraform fmt would rewrite ${result.files.length} file${result.files.length === 1 ? '' : 's'}: ${result.files.slice(0, 6).join(', ')}`,
    );
  },
};

// ==================================================================== state

export const terraformStateContains: SandboxVerifierHandler<'terraform_state_contains'> = {
  type: 'terraform_state_contains',
  label: (r) => `Terraform state contains ${r.address}`,
  async run(requirement, reader) {
    return withState(reader, requirement, (state) =>
      stateContainsAddress(state, requirement.address)
        ? pass()
        : fail(`'${requirement.address}' is not in the Terraform state — ${stateHint(state)}`),
    );
  },
};

export const terraformStateAbsent: SandboxVerifierHandler<'terraform_state_absent'> = {
  type: 'terraform_state_absent',
  label: (r) => `Terraform state no longer contains ${r.address}`,
  async run(requirement, reader) {
    const state = await reader.terraformState(requirement.dir, requirement.state_file);

    // No state at all trivially contains nothing. Saying so explicitly beats a
    // bare pass, because a student who has not applied yet would otherwise see
    // this check go green for the wrong reason — and a state file that exists
    // but cannot be parsed is not evidence of a removal at all, so that case
    // is reported rather than passed.
    if (state === null) {
      const problem = await reader.stateProblem(requirement.dir, requirement.state_file);
      return problem ? fail(problem) : pass('no state file exists yet');
    }

    return stateContainsAddress(state, requirement.address)
      ? fail(`'${requirement.address}' is still in the Terraform state — ${stateHint(state)}`)
      : pass();
  },
};

export const terraformResourceExists: SandboxVerifierHandler<'terraform_resource_exists'> = {
  type: 'terraform_resource_exists',
  label: (r) =>
    r.mode === 'data'
      ? `Terraform state reads data source ${r.resource_type}.${r.name}`
      : `Terraform state contains ${r.resource_type}.${r.name}`,
  async run(requirement, reader) {
    return withState(reader, requirement, (state) => {
      const resource = locate(state, requirement);
      if (!resource) {
        const present = state.resources
          .filter((r) => r.mode === (requirement.mode ?? 'managed'))
          .map((r) => `${r.type}.${r.name}`);
        return fail(
          present.length > 0
            ? `No ${requirement.mode === 'data' ? 'data source' : 'resource'} '${describeTarget(requirement)}' is in state for ${moduleLabel(requirement.module)} — ${stateHint(state)}`
            : `Terraform state holds no ${requirement.mode === 'data' ? 'data sources' : 'managed resources'} yet`,
        );
      }
      if (
        requirement.instances !== undefined &&
        resource.instances.length !== requirement.instances
      ) {
        return fail(
          `'${describeTarget(requirement)}' has ${resource.instances.length} instance${resource.instances.length === 1 ? '' : 's'} in state, expected ${requirement.instances}`,
        );
      }
      if (requirement.instances === undefined && resource.instances.length === 0) {
        return fail(
          `${describeTarget(requirement)} is declared but has no instance in state — the apply did not create it`,
        );
      }
      return pass();
    });
  },
};

export const terraformResourceCount: SandboxVerifierHandler<'terraform_resource_count'> = {
  type: 'terraform_resource_count',
  label: (r) => `${r.count} ${r.resource_type} resource${r.count === 1 ? '' : 's'} exist`,
  async run(requirement, reader) {
    return withState(reader, requirement, (state) => {
      const observed = countInstancesOfType(state, requirement.resource_type);
      if (observed === requirement.count) return pass();
      return fail(
        `State holds ${observed} '${requirement.resource_type}' instance${observed === 1 ? '' : 's'}, expected ${requirement.count} — ${stateHint(state)}`,
      );
    });
  },
};

export const terraformResourceAttribute: SandboxVerifierHandler<'terraform_resource_attribute'> = {
  type: 'terraform_resource_attribute',
  label: (r) => `${r.resource_type}.${r.name} has the expected ${r.attribute}`,
  async run(requirement, reader) {
    return withState(reader, requirement, (state) => {
      const resource = locate(state, requirement);
      if (!resource) {
        return fail(
          `No resource '${describeTarget(requirement)}' is in state for ${moduleLabel(requirement.module)} — ${stateHint(state)}`,
        );
      }

      const instance =
        requirement.index === undefined
          ? resource.instances[0]
          : resource.instances.find((candidate) => candidate.indexKey === requirement.index);
      if (!instance) {
        return fail(
          requirement.index === undefined
            ? `'${describeTarget(requirement)}' is in state but has no instances`
            : `'${describeTarget(requirement)}' has no instance with index ${describeValue(requirement.index)}`,
        );
      }

      const { found, value } = readAttributePath(instance.attributes, requirement.attribute);
      if (!found) {
        const available = Object.keys(instance.attributes).slice(0, 8).join(', ');
        return fail(
          `'${describeTarget(requirement)}' has no attribute '${requirement.attribute}'${available ? ` (it has: ${available})` : ''}`,
        );
      }

      if (requirement.contains !== undefined) {
        const text = typeof value === 'string' ? value : describeValue(value, 4096);
        return text.includes(requirement.contains)
          ? pass()
          : fail(
              `'${requirement.attribute}' is ${describeValue(value)}, which does not contain '${requirement.contains}'`,
            );
      }

      if (requirement.equals !== undefined) {
        return attributeMatches(value, requirement.equals)
          ? pass()
          : fail(
              `'${requirement.attribute}' is ${describeValue(value)}, expected ${describeValue(requirement.equals)}`,
            );
      }

      // No comparison declared: presence is the whole requirement.
      return pass(`${requirement.attribute} = ${describeValue(value)}`);
    });
  },
};

// =================================================================== outputs

export const terraformOutputExists: SandboxVerifierHandler<'terraform_output_exists'> = {
  type: 'terraform_output_exists',
  label: (r) => `Terraform output ${r.name} is defined`,
  async run(requirement, reader) {
    return withState(reader, requirement, (state) => {
      if (Object.hasOwn(state.outputs, requirement.name)) return pass();
      const names = Object.keys(state.outputs);
      return fail(
        names.length > 0
          ? `Terraform state declares outputs ${names.join(', ')}, but not '${requirement.name}'`
          : `Terraform state declares no outputs`,
      );
    });
  },
};

export const terraformOutputEquals: SandboxVerifierHandler<'terraform_output_equals'> = {
  type: 'terraform_output_equals',
  label: (r) => `Terraform output ${r.name} has the expected value`,
  async run(requirement, reader) {
    return withState(reader, requirement, (state) => {
      const output = state.outputs[requirement.name];
      if (!output) {
        const names = Object.keys(state.outputs);
        return fail(
          names.length > 0
            ? `Terraform state declares outputs ${names.join(', ')}, but not '${requirement.name}'`
            : `Terraform state declares no outputs`,
        );
      }

      /*
       * A sensitive output's value is never read into the platform.
       *
       * The requirement schema cannot express "compare this secret" — but a
       * *student* can mark any output sensitive, so the refusal has to live
       * here too, at the point where the value would otherwise be touched.
       */
      if (output.sensitive) {
        return fail(
          `Output '${requirement.name}' is marked sensitive, so its value is not read or compared. Remove the sensitive marking if this output is meant to be checked.`,
        );
      }

      // Outputs are compared as their string form: a lab that wants a number
      // and a lab that wants the digits of one mean the same thing to a
      // student, and the state file's JSON typing is not what the exercise is
      // teaching.
      //
      // The failure reports what the output *is* and never what it should be.
      // The expected value is the answer to the exercise, and a checklist that
      // prints it turns "read your state" into "copy this line".
      const actual = renderOutput(output.value);
      if (actual !== String(requirement.value)) {
        return fail(`Output '${requirement.name}' is ${actual === '' ? 'empty' : `'${actual}'`}`);
      }
      return pass();
    });
  },
};

function renderOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

// ============================================================= configuration

export const terraformVariableDeclared: SandboxVerifierHandler<'terraform_variable_declared'> = {
  type: 'terraform_variable_declared',
  label: (r) => `Variable ${r.name} is declared`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const block = findBlock(config, 'variable', requirement.name);
      if (!block) {
        const declared = blocksOfType(config, 'variable')
          .map((candidate) => candidate.labels[0])
          .filter(Boolean);
        return fail(
          declared.length > 0
            ? `No 'variable "${requirement.name}"' block — the configuration declares: ${declared.join(', ')}`
            : `No 'variable "${requirement.name}"' block — the configuration declares no variables (${await configHint(reader, requirement.dir)})`,
        );
      }

      if (requirement.has_type === true && !hasArgument(block, 'type')) {
        return fail(`variable "${requirement.name}" does not declare a type`);
      }
      if (requirement.type_contains !== undefined) {
        const declaredType = argumentValue(block, 'type');
        if (declaredType === null) {
          return fail(`variable "${requirement.name}" does not declare a type`);
        }
        // The scanner already collapsed runs of whitespace inside an
        // expression; collapsing the *expected* substring the same way is what
        // makes `map(object(` match a type the student wrote across three
        // lines. Nothing is evaluated on either side.
        const normalised = declaredType.replace(/\s+/g, ' ');
        const wanted = requirement.type_contains.replace(/\s+/g, ' ');
        if (!normalised.includes(wanted)) {
          return fail(
            `variable "${requirement.name}" is declared as ${describeValue(declaredType)}, which is not the complex type this lab asks for`,
          );
        }
      }
      if (requirement.has_default !== undefined) {
        const declared = hasArgument(block, 'default');
        if (declared !== requirement.has_default) {
          return fail(
            requirement.has_default
              ? `variable "${requirement.name}" has no default value`
              : `variable "${requirement.name}" declares a default value, but this lab requires it to be supplied explicitly`,
          );
        }
      }
      return pass();
    });
  },
};

export const terraformLocalsDeclared: SandboxVerifierHandler<'terraform_locals_declared'> = {
  type: 'terraform_locals_declared',
  label: (r) => `Local values ${r.names.join(', ')} are defined`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      // `locals` may legitimately appear several times; the union is what the
      // student effectively defined.
      const defined = new Set(
        blocksOfType(config, 'locals').flatMap((block) => block.arguments.map((arg) => arg.name)),
      );
      const missing = requirement.names.filter((name) => !defined.has(name));
      if (missing.length === 0) return pass();

      return fail(
        defined.size > 0
          ? `No local value named ${missing.map((n) => `'${n}'`).join(', ')} — the locals block defines: ${[...defined].join(', ')}`
          : `The configuration defines no locals block (${await configHint(reader, requirement.dir)})`,
      );
    });
  },
};

export const terraformDataSourceDeclared: SandboxVerifierHandler<'terraform_data_source_declared'> =
  {
    type: 'terraform_data_source_declared',
    label: (r) => `Data source ${r.data_type}.${r.name} is declared`,
    async run(requirement, reader) {
      return withConfig(reader, requirement.dir, async (config) => {
        const block = findBlock(config, 'data', requirement.data_type, requirement.name);
        if (block) return pass();

        const declared = blocksOfType(config, 'data')
          .map((candidate) => candidate.labels.join('.'))
          .filter(Boolean);
        return fail(
          declared.length > 0
            ? `No 'data "${requirement.data_type}" "${requirement.name}"' block — the configuration declares: ${declared.join(', ')}`
            : `The configuration declares no data sources (${await configHint(reader, requirement.dir)})`,
        );
      });
    },
  };

export const terraformResourceLifecycle: SandboxVerifierHandler<'terraform_resource_lifecycle'> = {
  type: 'terraform_resource_lifecycle',
  label: (r) => `${r.resource_type}.${r.name} declares lifecycle ${r.setting}`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const resource = findResourceBlock(config, requirement.resource_type, requirement.name);
      if (!resource) {
        return fail(
          `No 'resource "${requirement.resource_type}" "${requirement.name}"' block in the configuration (${await configHint(reader, requirement.dir)})`,
        );
      }

      const lifecycle = findNestedBlock(resource, 'lifecycle');
      if (!lifecycle) {
        return fail(
          `resource "${requirement.resource_type}" "${requirement.name}" has no lifecycle block`,
        );
      }

      const raw = argumentValue(lifecycle, requirement.setting);
      if (raw === null) {
        const present = lifecycle.arguments.map((arg) => arg.name);
        return fail(
          present.length > 0
            ? `The lifecycle block does not set '${requirement.setting}' (it sets: ${present.join(', ')})`
            : `The lifecycle block is empty — it does not set '${requirement.setting}'`,
        );
      }

      if (requirement.setting === 'ignore_changes') {
        if (!requirement.attributes) return pass();
        const mentioned = new Set(referencedNames(raw));
        const missing = requirement.attributes.filter((attribute) => !mentioned.has(attribute));
        return missing.length === 0
          ? pass()
          : fail(`ignore_changes is ${raw}, which does not mention ${missing.join(', ')}`);
      }

      const expected = requirement.expected ?? true;
      const normalised = raw.trim().toLowerCase();
      if (normalised !== 'true' && normalised !== 'false') {
        // The value is an expression rather than a literal. Report it rather
        // than evaluating it — the scanner does not evaluate expressions.
        return fail(
          `${requirement.setting} is set to '${raw}', which is not a literal true or false. This lab expects '${requirement.setting} = ${expected}'.`,
        );
      }
      return (normalised === 'true') === expected
        ? pass()
        : fail(`${requirement.setting} is ${normalised}, expected ${expected}`);
    });
  },
};

/** A `resource "type" "name"` block, in the root module's configuration. */
function findResourceBlock(config: HclDocument, type: string, name: string): HclBlock | null {
  return findBlock(config, 'resource', type, name);
}

// =================================================================== modules

export const terraformModuleExists: SandboxVerifierHandler<'terraform_module_exists'> = {
  type: 'terraform_module_exists',
  label: (r) => `Module ${r.name} is defined and used`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const call = findBlock(config, 'module', requirement.name);
      if (!call) {
        const declared = blocksOfType(config, 'module')
          .map((candidate) => candidate.labels[0])
          .filter(Boolean);
        return fail(
          declared.length > 0
            ? `No 'module "${requirement.name}"' block — the configuration calls: ${declared.join(', ')}`
            : `The root configuration calls no modules (${await configHint(reader, requirement.dir)})`,
        );
      }

      const source = literalString(argumentValue(call, 'source'));
      if (source === null) {
        return fail(`module "${requirement.name}" does not declare a literal source`);
      }
      if (requirement.source !== undefined && source !== requirement.source) {
        return fail(
          `module "${requirement.name}" has source '${source}', expected '${requirement.source}'`,
        );
      }

      // A module call pointing at a directory that does not exist is a call to
      // nothing; checking both halves is what makes this a modules check rather
      // than a "did you type the word module" check.
      const directory = requirement.directory ?? localSourceToPath(requirement.dir, source);
      if (directory) {
        const read = await reader.path(directory);
        if (!read || read.type !== 'directory') {
          return fail(
            read === null
              ? `module "${requirement.name}" sources '${source}', but '${directory}' does not exist in the lab environment`
              : `module "${requirement.name}" sources '${source}', but '${directory}' is a ${read.type}, not a directory`,
          );
        }
      }

      return pass();
    });
  },
};

/**
 * Turn a local module source into a sandbox path, relative to the home.
 *
 * Returns null for a registry or remote source, which this platform's offline
 * sandbox cannot fetch anyway — so there is nothing on disk to check — and for
 * anything that would climb out of the working directory.
 */
function localSourceToPath(dir: string, source: string): string | null {
  if (!source.startsWith('./')) return null;
  const trimmed = source.slice(2).replace(/\/+$/, '');
  if (trimmed.length === 0 || trimmed.split('/').includes('..')) return null;
  return dir === '.' ? trimmed : `${dir.replace(/\/+$/, '')}/${trimmed}`;
}

export const terraformModuleInput: SandboxVerifierHandler<'terraform_module_input'> = {
  type: 'terraform_module_input',
  label: (r) => `Module ${r.module} is passed ${r.input}`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const call = findBlock(config, 'module', requirement.module);
      if (!call) {
        return fail(
          `No 'module "${requirement.module}"' block in the configuration (${await configHint(reader, requirement.dir)})`,
        );
      }
      if (hasArgument(call, requirement.input)) return pass();

      const passed = call.arguments.map((arg) => arg.name).filter((name) => name !== 'source');
      return fail(
        passed.length > 0
          ? `module "${requirement.module}" does not pass '${requirement.input}' (it passes: ${passed.join(', ')})`
          : `module "${requirement.module}" passes no input variables`,
      );
    });
  },
};

// ================================================================= providers

/** The `required_providers` block, wherever the student put their `terraform` block. */
function findRequiredProviders(config: HclDocument): HclBlock | null {
  for (const block of blocksOfType(config, 'terraform')) {
    const nested = findNestedBlock(block, 'required_providers');
    if (nested) return nested;
  }
  return null;
}

/**
 * Read one `required_providers` entry.
 *
 * The entry is an object expression (`{ source = "…", version = "…" }`) rather
 * than a nested block, so it arrives as raw argument text. Pulling the two
 * fields out with a narrow match is enough here and keeps the scanner free of
 * an object-literal evaluator it does not otherwise need.
 */
function readProviderEntry(raw: string): { source?: string; version?: string } {
  const source = /\bsource\s*=\s*"([^"]+)"/.exec(raw)?.[1];
  const version = /\bversion\s*=\s*"([^"]+)"/.exec(raw)?.[1];
  return { ...(source ? { source } : {}), ...(version ? { version } : {}) };
}

/** `hashicorp/local` and `registry.terraform.io/hashicorp/local` are the same provider. */
function sameProviderSource(a: string, b: string): boolean {
  const strip = (value: string): string => value.trim().toLowerCase().split('/').slice(-2).join('/');
  return strip(a) === strip(b);
}

function sameConstraint(a: string, b: string): boolean {
  const normalise = (value: string): string => value.replace(/\s+/g, '').trim();
  return normalise(a) === normalise(b);
}

export const terraformRequiredProvider: SandboxVerifierHandler<'terraform_required_provider'> = {
  type: 'terraform_required_provider',
  label: (r) => `required_providers declares ${r.name}`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const block = findRequiredProviders(config);
      if (!block) {
        return fail(
          `The configuration has no required_providers block inside a terraform block (${await configHint(reader, requirement.dir)})`,
        );
      }

      const raw = argumentValue(block, requirement.name);
      if (raw === null) {
        const declared = block.arguments.map((arg) => arg.name);
        return fail(
          declared.length > 0
            ? `required_providers does not declare '${requirement.name}' (it declares: ${declared.join(', ')})`
            : 'The required_providers block is empty',
        );
      }

      const entry = readProviderEntry(raw);
      if (requirement.source !== undefined) {
        if (!entry.source) {
          return fail(`The '${requirement.name}' entry does not declare a source`);
        }
        if (!sameProviderSource(entry.source, requirement.source)) {
          return fail(
            `The '${requirement.name}' entry has source '${entry.source}', which is a different provider`,
          );
        }
      }
      if (requirement.version_constraint !== undefined) {
        if (!entry.version) {
          return fail(`The '${requirement.name}' entry does not declare a version constraint`);
        }
        if (!sameConstraint(entry.version, requirement.version_constraint)) {
          return fail(
            `The '${requirement.name}' entry constrains the version to '${entry.version}', which is not the constraint this lab asks for`,
          );
        }
      }
      return pass();
    });
  },
};

export const terraformProviderConfigured: SandboxVerifierHandler<'terraform_provider_configured'> = {
  type: 'terraform_provider_configured',
  label: (r) =>
    r.alias
      ? `A '${r.provider}' provider configuration aliased ${r.alias} exists`
      : `A default '${r.provider}' provider configuration exists`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const candidates = blocksOfType(config, 'provider').filter(
        (block) => block.labels[0] === requirement.provider,
      );
      if (candidates.length === 0) {
        const declared = blocksOfType(config, 'provider').map((block) => block.labels[0]);
        return fail(
          declared.length > 0
            ? `No 'provider "${requirement.provider}"' block — the configuration configures: ${declared.join(', ')}`
            : `The configuration has no provider blocks (${await configHint(reader, requirement.dir)})`,
        );
      }

      const aliases = candidates.map((block) => literalString(argumentValue(block, 'alias')));
      if (requirement.alias === undefined) {
        return aliases.includes(null)
          ? pass()
          : fail(
              `Every '${requirement.provider}' provider block declares an alias (${aliases.filter(Boolean).join(', ')}), so there is no default configuration`,
            );
      }
      if (aliases.includes(requirement.alias)) return pass();
      const named = aliases.filter((alias): alias is string => alias !== null);
      return fail(
        named.length > 0
          ? `No '${requirement.provider}' provider block is aliased '${requirement.alias}' (aliases present: ${named.join(', ')})`
          : `The '${requirement.provider}' provider is configured once, with no alias`,
      );
    });
  },
};

export const terraformResourceProvider: SandboxVerifierHandler<'terraform_resource_provider'> = {
  type: 'terraform_resource_provider',
  label: (r) =>
    r.alias
      ? `${r.resource_type}.${r.name} uses the ${r.alias} provider configuration`
      : `${r.resource_type}.${r.name} uses the default provider configuration`,
  async run(requirement, reader) {
    return withState(reader, requirement, (state) => {
      const resource = locate(state, requirement);
      if (!resource) {
        return fail(
          `No resource '${describeTarget(requirement)}' is in state for ${moduleLabel(requirement.module)} — ${stateHint(state)}`,
        );
      }

      // State writes the reference as
      // `provider["registry.terraform.io/hashicorp/local"].reports`; the alias,
      // when there is one, is whatever follows the closing bracket.
      const observed = /\]\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(resource.provider)?.[1] ?? null;
      if (requirement.alias === undefined) {
        return observed === null
          ? pass()
          : fail(
              `'${describeTarget(requirement)}' was created with the '${observed}' provider configuration, not the default one`,
            );
      }
      if (observed === requirement.alias) return pass();
      return fail(
        observed === null
          ? `'${describeTarget(requirement)}' was created with the default provider configuration`
          : `'${describeTarget(requirement)}' was created with the '${observed}' provider configuration`,
      );
    });
  },
};

export const terraformLockProvider: SandboxVerifierHandler<'terraform_lock_provider'> = {
  type: 'terraform_lock_provider',
  label: (r) => `The dependency lock file records ${r.source}`,
  async run(requirement, reader) {
    const lock = await reader.terraformLock(requirement.dir);
    if (!lock) {
      return fail(
        `'${requirement.dir}' has no ${TERRAFORM_LOCK_FILE} — run terraform init to record the providers it resolved`,
      );
    }

    const entries = blocksOfType(lock, 'provider');
    const match = entries.find((block) =>
      sameProviderSource(block.labels[0] ?? '', requirement.source),
    );
    if (!match) {
      const recorded = entries.map((block) => block.labels[0]).filter(Boolean);
      return fail(
        recorded.length > 0
          ? `The lock file records ${recorded.join(', ')}, but not '${requirement.source}'`
          : 'The lock file records no providers',
      );
    }

    if (requirement.version !== undefined) {
      const version = literalString(argumentValue(match, 'version'));
      if (version === null) {
        return fail(`The lock entry for '${requirement.source}' records no version`);
      }
      if (!sameConstraint(version, requirement.version)) {
        return fail(
          `The lock file resolved '${requirement.source}' to ${version}, which is not the version this lab expects`,
        );
      }
    }
    return pass();
  },
};

// ============================================= dependencies and conditions

export const terraformResourceDependsOn: SandboxVerifierHandler<'terraform_resource_depends_on'> = {
  type: 'terraform_resource_depends_on',
  label: (r) => `${r.resource_type}.${r.name} declares an explicit depends_on`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const resource = findBlock(config, 'resource', requirement.resource_type, requirement.name);
      if (!resource) {
        return fail(
          `No 'resource "${requirement.resource_type}" "${requirement.name}"' block in the configuration (${await configHint(reader, requirement.dir)})`,
        );
      }

      const raw = argumentValue(resource, 'depends_on');
      if (raw === null) {
        return fail(
          `resource "${requirement.resource_type}" "${requirement.name}" does not set depends_on`,
        );
      }

      // `depends_on` takes bare references, so the list's text is matched
      // against the addresses the lab named rather than evaluated. An address
      // is only satisfied when it appears whole, so `null_resource.db` does not
      // accidentally match `null_resource.db_backup`.
      const missing = requirement.references.filter(
        (address) => !new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(address)}([^A-Za-z0-9_-]|$)`).test(raw),
      );
      return missing.length === 0
        ? pass()
        : fail(`depends_on is ${describeValue(raw)}, which does not name ${missing.join(', ')}`);
    });
  },
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const terraformResourceCondition: SandboxVerifierHandler<'terraform_resource_condition'> = {
  type: 'terraform_resource_condition',
  label: (r) => `${r.resource_type}.${r.name} declares a ${r.condition}`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const blockType = requirement.mode === 'data' ? 'data' : 'resource';
      const owner = findBlock(config, blockType, requirement.resource_type, requirement.name);
      if (!owner) {
        return fail(
          `No '${blockType} "${requirement.resource_type}" "${requirement.name}"' block in the configuration (${await configHint(reader, requirement.dir)})`,
        );
      }

      const lifecycle = findNestedBlock(owner, 'lifecycle');
      if (!lifecycle) {
        return fail(
          `${blockType} "${requirement.resource_type}" "${requirement.name}" has no lifecycle block, so it declares no ${requirement.condition}`,
        );
      }

      const conditions = lifecycle.blocks.filter((block) => block.type === requirement.condition);
      if (conditions.length === 0) {
        const present = lifecycle.blocks.map((block) => block.type);
        return fail(
          present.length > 0
            ? `The lifecycle block declares ${present.join(', ')}, but no ${requirement.condition}`
            : `The lifecycle block declares no ${requirement.condition}`,
        );
      }

      // Both halves are required by the language, and a rule with no message is
      // a rule whose failure tells the next engineer nothing.
      const withoutMessage = conditions.filter((block) => !hasArgument(block, 'error_message'));
      if (withoutMessage.length === conditions.length) {
        return fail(`The ${requirement.condition} does not set an error_message`);
      }

      if (requirement.condition_mentions) {
        const mentioned = new Set(
          conditions.flatMap((block) => referencedNames(argumentValue(block, 'condition') ?? '')),
        );
        const missing = requirement.condition_mentions.filter((name) => !mentioned.has(name));
        if (missing.length > 0) {
          return fail(
            `The ${requirement.condition} does not refer to ${missing.join(', ')}`,
          );
        }
      }
      return pass();
    });
  },
};

export const terraformCheckDeclared: SandboxVerifierHandler<'terraform_check_declared'> = {
  type: 'terraform_check_declared',
  label: (r) => `A check block named ${r.name} is declared`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const block = findBlock(config, 'check', requirement.name);
      if (!block) {
        const declared = blocksOfType(config, 'check')
          .map((candidate) => candidate.labels[0])
          .filter(Boolean);
        return fail(
          declared.length > 0
            ? `No 'check "${requirement.name}"' block — the configuration declares: ${declared.join(', ')}`
            : `The configuration declares no check blocks (${await configHint(reader, requirement.dir)})`,
        );
      }

      const assertions = block.blocks.filter((nested) => nested.type === 'assert');
      if (assertions.length < requirement.min_assertions) {
        return fail(
          `check "${requirement.name}" declares ${assertions.length} assert block${assertions.length === 1 ? '' : 's'}, expected at least ${requirement.min_assertions}`,
        );
      }
      if (assertions.some((assertion) => !hasArgument(assertion, 'condition'))) {
        return fail(`An assert block in check "${requirement.name}" sets no condition`);
      }
      if (assertions.some((assertion) => !hasArgument(assertion, 'error_message'))) {
        return fail(`An assert block in check "${requirement.name}" sets no error_message`);
      }
      return pass();
    });
  },
};

export const terraformVariableValidation: SandboxVerifierHandler<'terraform_variable_validation'> = {
  type: 'terraform_variable_validation',
  label: (r) => `Variable ${r.name} declares a validation rule`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const block = findBlock(config, 'variable', requirement.name);
      if (!block) {
        return fail(
          `No 'variable "${requirement.name}"' block in the configuration (${await configHint(reader, requirement.dir)})`,
        );
      }

      const rules = block.blocks.filter((nested) => nested.type === 'validation');
      if (rules.length < requirement.min_rules) {
        return fail(
          `variable "${requirement.name}" declares ${rules.length} validation block${rules.length === 1 ? '' : 's'}, expected at least ${requirement.min_rules}`,
        );
      }
      if (rules.some((rule) => !hasArgument(rule, 'condition'))) {
        return fail(`A validation block on "${requirement.name}" sets no condition`);
      }
      if (rules.some((rule) => !hasArgument(rule, 'error_message'))) {
        return fail(`A validation block on "${requirement.name}" sets no error_message`);
      }

      if (requirement.condition_mentions) {
        const mentioned = new Set(
          rules.flatMap((rule) => referencedNames(argumentValue(rule, 'condition') ?? '')),
        );
        const missing = requirement.condition_mentions.filter((name) => !mentioned.has(name));
        if (missing.length > 0) {
          return fail(`The validation conditions do not use ${missing.join(', ')}`);
        }
      }
      return pass();
    });
  },
};

export const terraformVariableSensitive: SandboxVerifierHandler<'terraform_variable_sensitive'> = {
  type: 'terraform_variable_sensitive',
  label: (r) =>
    r.expected ? `Variable ${r.name} is marked sensitive` : `Variable ${r.name} is not sensitive`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const block = findBlock(config, 'variable', requirement.name);
      if (!block) {
        return fail(
          `No 'variable "${requirement.name}"' block in the configuration (${await configHint(reader, requirement.dir)})`,
        );
      }

      const raw = argumentValue(block, 'sensitive');
      const declared = raw === null ? false : raw.trim().toLowerCase();
      if (declared !== false && declared !== 'true' && declared !== 'false') {
        return fail(
          `variable "${requirement.name}" sets sensitive to '${raw}', which is not a literal true or false`,
        );
      }
      const isSensitive = declared === 'true';
      if (isSensitive === requirement.expected) return pass();
      return fail(
        requirement.expected
          ? `variable "${requirement.name}" is not marked sensitive`
          : `variable "${requirement.name}" is marked sensitive, but this lab needs its value to be readable`,
      );
    });
  },
};

export const terraformOutputSensitive: SandboxVerifierHandler<'terraform_output_sensitive'> = {
  type: 'terraform_output_sensitive',
  label: (r) =>
    r.expected ? `Output ${r.name} is marked sensitive` : `Output ${r.name} is not sensitive`,
  async run(requirement, reader) {
    return withState(reader, requirement, (state) => {
      const output = state.outputs[requirement.name];
      if (!output) {
        const names = Object.keys(state.outputs);
        return fail(
          names.length > 0
            ? `Terraform state declares outputs ${names.join(', ')}, but not '${requirement.name}'`
            : 'Terraform state declares no outputs',
        );
      }
      // Read from state, not configuration: this is the flag Terraform applied,
      // and the value behind it is never touched either way.
      if (output.sensitive === requirement.expected) return pass();
      return fail(
        requirement.expected
          ? `Output '${requirement.name}' is not marked sensitive, so its value is printed in full by terraform output`
          : `Output '${requirement.name}' is marked sensitive`,
      );
    });
  },
};

// ================================================ backends and refactoring

export const terraformBackendConfigured: SandboxVerifierHandler<'terraform_backend_configured'> = {
  type: 'terraform_backend_configured',
  label: (r) => `The terraform block configures the ${r.backend} backend`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const backends = blocksOfType(config, 'terraform')
        .flatMap((block) => block.blocks)
        .filter((nested) => nested.type === 'backend');

      const match = backends.find((block) => block.labels[0] === requirement.backend);
      if (!match) {
        const declared = backends.map((block) => block.labels[0]).filter(Boolean);
        return fail(
          declared.length > 0
            ? `The terraform block configures the ${declared.join(', ')} backend, not '${requirement.backend}'`
            : `The terraform block configures no backend (${await configHint(reader, requirement.dir)})`,
        );
      }

      for (const [name, expected] of Object.entries(requirement.arguments ?? {})) {
        const actual = literalString(argumentValue(match, name));
        if (actual === null) {
          return fail(`The backend block does not set '${name}' to a literal value`);
        }
        if (actual !== expected) {
          return fail(`The backend block sets ${name} = ${describeValue(actual)}`);
        }
      }
      return pass();
    });
  },
};

export const terraformMovedDeclared: SandboxVerifierHandler<'terraform_moved_declared'> = {
  type: 'terraform_moved_declared',
  label: (r) => `A moved block records ${r.from} → ${r.to}`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const moves = blocksOfType(config, 'moved');
      if (moves.length === 0) {
        return fail(
          `The configuration declares no moved blocks (${await configHint(reader, requirement.dir)})`,
        );
      }

      const describe = (block: HclBlock): string =>
        `${argumentValue(block, 'from') ?? '?'} → ${argumentValue(block, 'to') ?? '?'}`;

      const match = moves.find(
        (block) =>
          (argumentValue(block, 'from') ?? '').trim() === requirement.from &&
          (argumentValue(block, 'to') ?? '').trim() === requirement.to,
      );
      return match
        ? pass()
        : fail(`No moved block records that rename — the configuration declares: ${moves.map(describe).join(', ')}`);
    });
  },
};

export { TERRAFORM_STATE_FILE };
