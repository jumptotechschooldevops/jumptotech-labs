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
const noState = (dir: string): string =>
  `No readable Terraform state in '${dir}' — nothing has been applied there yet`;

/**
 * Load state, or explain its absence in the caller's terms.
 *
 * Every state-reading handler starts here so that "you have not applied yet"
 * reads the same everywhere, and so a corrupt state file produces one clear
 * message instead of a different mangled one per check.
 */
async function withState(
  reader: SandboxReader,
  dir: string,
  use: (state: TerraformState) => HandlerOutcome | Promise<HandlerOutcome>,
): Promise<HandlerOutcome> {
  const state = await reader.terraformState(dir);
  if (state === null) return fail(noState(dir));
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
    return withState(reader, requirement.dir, (state) =>
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
    const state = await reader.terraformState(requirement.dir);

    // No state at all trivially contains nothing. Saying so explicitly beats a
    // bare pass, because a student who has not applied yet would otherwise see
    // this check go green for the wrong reason — and a state file that exists
    // but cannot be parsed is not evidence of a removal at all, so that case
    // is reported rather than passed.
    if (state === null) {
      const problem = await reader.stateProblem(requirement.dir);
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
    return withState(reader, requirement.dir, (state) => {
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
    return withState(reader, requirement.dir, (state) => {
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
    return withState(reader, requirement.dir, (state) => {
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
    return withState(reader, requirement.dir, (state) => {
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
    return withState(reader, requirement.dir, (state) => {
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

export { TERRAFORM_STATE_FILE };
