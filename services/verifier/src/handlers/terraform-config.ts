/**
 * Terraform *configuration* requirement handlers.
 *
 * The state handlers next door answer "what did the apply produce". These
 * answer "what does the configuration say", which is a different question and
 * the only one that can settle certain things:
 *
 *   · whether a value was declared as a variable or hardcoded — identical state;
 *   · whether a dependency came from a reference or a pasted literal — identical
 *     state, and the distinction an implicit-dependency lab exists to teach;
 *   · whether a validation rule, a precondition or a `check` block exists at
 *     all — none of which leaves a trace in an applied result.
 *
 * ### These read. They never run.
 *
 * Student configuration is untrusted input, and it is treated as text
 * throughout. The scanner is a lexer over source; the reference extractor is a
 * mode machine over an expression. Nothing here evaluates an expression, calls
 * a function, resolves a variable, follows a module, expands a provisioner,
 * reads a data source or contacts anything. `terraform` is never invoked to
 * inspect source. A hostile configuration is, at worst, text that parses oddly.
 *
 * ### Failures never disclose the answer
 *
 * PLATFORM-SEC applies here as it does to the state handlers: a failure names
 * what was looked for and what was found *structurally* — block names, argument
 * names, the files scanned — and never quotes an expected value or the contents
 * of a student's expression back into a payload the browser renders.
 */
import {
  argumentValue,
  blocksOfType,
  extractReferences,
  findBlock,
  findNestedBlock,
  hasArgument,
  referencesTarget,
  type HclBlock,
  type HclDocument,
  type TerraformReference,
} from '@jumptotech/lab-orchestrator';
import { fail, pass, skip, type HandlerOutcome, type SandboxVerifierHandler } from '../contract.js';
import { SandboxCapabilityMissingError, type SandboxReader } from '../sandbox-reader.js';

/**
 * Load the scanned configuration, or skip when the sandbox cannot list files.
 *
 * A provider without the listing capability is a platform gap, not a student
 * mistake, so the check reports `skipped` rather than `fail`.
 */
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

/** A short, value-free note about what was scanned, so a failure is actionable. */
async function scanned(reader: SandboxReader, dir: string): Promise<string> {
  try {
    const paths = await reader.terraformConfigPaths(dir);
    if (paths.length === 0) return `no .tf files were found in '${dir}'`;
    return `scanned ${paths.slice(0, 6).join(', ')}`;
  } catch {
    return `scanned '${dir}'`;
  }
}

/** Collapse whitespace so a multi-line type expression compares sensibly. */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const resourceBlock = (config: HclDocument, type: string, name: string, mode: 'managed' | 'data') =>
  findBlock(config, mode === 'data' ? 'data' : 'resource', type, name);

// ============================================================ references

export const terraformResourceReferences: SandboxVerifierHandler<'terraform_resource_references'> = {
  type: 'terraform_resource_references',
  label: (r) => `${r.resource_type}.${r.name} refers to ${r.references}`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const block = resourceBlock(config, requirement.resource_type, requirement.name, 'managed');
      if (!block) {
        const declared = blocksOfType(config, 'resource')
          .map((candidate) => candidate.labels.join('.'))
          .filter(Boolean);
        return fail(
          declared.length > 0
            ? `No resource '${requirement.resource_type}.${requirement.name}' is declared — the configuration declares: ${declared.slice(0, 6).join(', ')}`
            : `The configuration declares no resources (${await scanned(reader, requirement.dir)})`,
        );
      }

      const expression = argumentValue(block, requirement.attribute);
      if (expression === null) {
        const present = block.arguments.map((argument) => argument.name);
        return fail(
          present.length > 0
            ? `'${requirement.resource_type}.${requirement.name}' sets no '${requirement.attribute}' argument (it sets: ${present.slice(0, 8).join(', ')})`
            : `'${requirement.resource_type}.${requirement.name}' sets no arguments at all`,
        );
      }

      if (!referencesTargetTransitively(config, expression, requirement.references)) {
        /*
         * The message says what is missing, never what the student wrote. A
         * value pasted where a reference belongs is often the very thing the
         * lab is about, and quoting it back would both leak the artefact and
         * hand over the shape of the answer.
         */
        return fail(
          `'${requirement.attribute}' on ${requirement.resource_type}.${requirement.name} does not refer to ${requirement.references}. A value that merely looks like an address is not a reference — Terraform only creates a dependency when the address appears as an expression, bare or inside \${…}.`,
        );
      }

      if (requirement.referenced_attribute !== undefined) {
        const reached = reachableReferences(config, expression).some(
          (reference) =>
            reference.target === requirement.references &&
            reference.attribute === requirement.referenced_attribute,
        );
        if (!reached) {
          return fail(
            `'${requirement.attribute}' refers to ${requirement.references}, but not to its '${requirement.referenced_attribute}' attribute`,
          );
        }
      }
      return pass();
    });
  },
};

// ============================================================== variables

export const terraformVariableDeclared: SandboxVerifierHandler<'terraform_variable_declared'> = {
  type: 'terraform_variable_declared',
  label: (r) => `A variable named ${r.name} is declared`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const block = findBlock(config, 'variable', requirement.name);
      if (!block) {
        const declared = blocksOfType(config, 'variable')
          .map((candidate) => candidate.labels[0])
          .filter(Boolean);
        return fail(
          declared.length > 0
            ? `No 'variable "${requirement.name}"' block — the configuration declares: ${declared.slice(0, 8).join(', ')}`
            : `The configuration declares no variables (${await scanned(reader, requirement.dir)})`,
        );
      }

      if (requirement.has_default !== undefined) {
        const has = hasArgument(block, 'default');
        if (has !== requirement.has_default) {
          return fail(
            requirement.has_default
              ? `Variable '${requirement.name}' declares no default`
              : `Variable '${requirement.name}' declares a default, but this lab asks for one without`,
          );
        }
      }

      const declaredType = argumentValue(block, 'type');
      if (requirement.has_type === true && declaredType === null) {
        return fail(`Variable '${requirement.name}' declares no type constraint`);
      }
      if (requirement.type_contains !== undefined) {
        if (declaredType === null) {
          return fail(`Variable '${requirement.name}' declares no type constraint`);
        }
        if (!collapse(declaredType).includes(collapse(requirement.type_contains))) {
          return fail(
            `Variable '${requirement.name}' does not declare the kind of type this lab asks for`,
          );
        }
      }
      return pass();
    });
  },
};

export const terraformVariableValidation: SandboxVerifierHandler<'terraform_variable_validation'> = {
  type: 'terraform_variable_validation',
  label: (r) => `Variable ${r.name} validates its input`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const block = findBlock(config, 'variable', requirement.name);
      if (!block) return fail(`No 'variable "${requirement.name}"' block is declared`);

      const rules = block.blocks.filter((nested) => nested.type === 'validation');
      if (rules.length < requirement.min_rules) {
        return fail(
          `Variable '${requirement.name}' declares ${rules.length} validation block${rules.length === 1 ? '' : 's'}, and this lab asks for at least ${requirement.min_rules}`,
        );
      }
      if (requirement.condition_mentions !== undefined) {
        const conditions = rules.map((rule) => argumentValue(rule, 'condition') ?? '').join(' ');
        const missing = requirement.condition_mentions.filter(
          (wanted) => !mentions(conditions, wanted),
        );
        if (missing.length > 0) {
          return fail(
            `The validation rules on '${requirement.name}' do not use ${missing.join(', ')}`,
          );
        }
      }
      return pass();
    });
  },
};

// ================================================================= locals

export const terraformLocalsDeclared: SandboxVerifierHandler<'terraform_locals_declared'> = {
  type: 'terraform_locals_declared',
  label: (r) => `Local values ${r.names.join(', ')} are defined`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, async (config) => {
      const defined = new Set<string>();
      for (const block of blocksOfType(config, 'locals')) {
        for (const argument of block.arguments) defined.add(argument.name);
      }
      const missing = requirement.names.filter((name) => !defined.has(name));
      if (missing.length === 0) return pass();
      return fail(
        defined.size > 0
          ? `The locals block does not define ${missing.join(', ')} (it defines: ${[...defined].slice(0, 8).join(', ')})`
          : `The configuration defines no local values (${await scanned(reader, requirement.dir)})`,
      );
    });
  },
};

// ========================================================== data sources

export const terraformDataSourceDeclared: SandboxVerifierHandler<'terraform_data_source_declared'> =
  {
    type: 'terraform_data_source_declared',
    label: (r) => `A data source ${r.data_type}.${r.name} is declared`,
    async run(requirement, reader) {
      return withConfig(reader, requirement.dir, async (config) => {
        if (findBlock(config, 'data', requirement.data_type, requirement.name)) return pass();
        const declared = blocksOfType(config, 'data')
          .map((candidate) => candidate.labels.join('.'))
          .filter(Boolean);
        return fail(
          declared.length > 0
            ? `No 'data "${requirement.data_type}" "${requirement.name}"' block — the configuration declares: ${declared.slice(0, 6).join(', ')}`
            : `The configuration declares no data sources (${await scanned(reader, requirement.dir)})`,
        );
      });
    },
  };

// ========================================================== dependencies

export const terraformResourceDependsOn: SandboxVerifierHandler<'terraform_resource_depends_on'> = {
  type: 'terraform_resource_depends_on',
  label: (r) => `${r.resource_type}.${r.name} declares depends_on`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, (config) => {
      const block = resourceBlock(config, requirement.resource_type, requirement.name, 'managed');
      if (!block) {
        return fail(`No resource '${requirement.resource_type}.${requirement.name}' is declared`);
      }
      const expression = argumentValue(block, 'depends_on');
      if (expression === null) {
        return fail(
          `'${requirement.resource_type}.${requirement.name}' declares no depends_on. Use it only where a real ordering requirement exists that no reference expresses.`,
        );
      }
      const missing = requirement.references.filter(
        (target) => !referencesTarget(expression, target),
      );
      if (missing.length > 0) {
        return fail(
          `The depends_on list on ${requirement.resource_type}.${requirement.name} does not name ${missing.join(', ')}`,
        );
      }
      return pass();
    });
  },
};

// ====================================================== custom conditions

export const terraformResourceCondition: SandboxVerifierHandler<'terraform_resource_condition'> = {
  type: 'terraform_resource_condition',
  label: (r) => `${r.resource_type}.${r.name} declares a ${r.condition}`,
  async run(requirement, reader) {
    return withConfig(reader, requirement.dir, (config) => {
      const block = resourceBlock(
        config,
        requirement.resource_type,
        requirement.name,
        requirement.mode,
      );
      if (!block) {
        const noun = requirement.mode === 'data' ? 'data source' : 'resource';
        return fail(`No ${noun} '${requirement.resource_type}.${requirement.name}' is declared`);
      }
      const lifecycle = findNestedBlock(block, 'lifecycle');
      const conditions = (lifecycle ? lifecycle.blocks : []).filter(
        (nested) => nested.type === requirement.condition,
      );
      if (conditions.length === 0) {
        return fail(
          `'${requirement.resource_type}.${requirement.name}' declares no ${requirement.condition} — custom conditions live inside a lifecycle block`,
        );
      }
      if (requirement.condition_mentions !== undefined) {
        const text = conditions.map((c) => argumentValue(c, 'condition') ?? '').join(' ');
        const missing = requirement.condition_mentions.filter((wanted) => !mentions(text, wanted));
        if (missing.length > 0) {
          return fail(`The ${requirement.condition} does not use ${missing.join(', ')}`);
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
            ? `No 'check "${requirement.name}"' block — the configuration declares: ${declared.slice(0, 6).join(', ')}`
            : `The configuration declares no check blocks (${await scanned(reader, requirement.dir)})`,
        );
      }
      const assertions = block.blocks.filter((nested) => nested.type === 'assert');
      if (assertions.length < requirement.min_assertions) {
        return fail(
          `check '${requirement.name}' declares ${assertions.length} assert block${assertions.length === 1 ? '' : 's'}, and this lab asks for at least ${requirement.min_assertions}`,
        );
      }
      return pass();
    });
  },
};


/**
 * Local values, by name, gathered from every `locals` block.
 *
 * Terraform allows more than one, and a configuration split across files
 * usually has them in different places.
 */
function localDefinitions(config: HclDocument): Map<string, string> {
  const locals = new Map<string, string>();
  for (const block of blocksOfType(config, 'locals')) {
    for (const argument of block.arguments) locals.set(argument.name, argument.value);
  }
  return locals;
}

/** How far a chain of locals is followed before giving up. */
const MAX_LOCAL_DEPTH = 8;

/**
 * Every reference an expression reaches, following local values.
 *
 * A local is a named expression, so
 *
 * ```hcl
 *   locals  { digest = local_file.config.content_sha256 }
 *   resource "local_file" "record" { content = local.digest }
 * ```
 *
 * makes `record` depend on `config` exactly as a direct reference would —
 * Terraform draws the same edge. Refusing to follow the indirection would fail
 * a student for factoring their configuration, which is the opposite of what a
 * dependency lab should reward.
 *
 * Bounded and cycle-guarded: a configuration where two locals refer to each
 * other is invalid Terraform, but it must not hang the verifier.
 */
function reachableReferences(config: HclDocument, expression: string): TerraformReference[] {
  const locals = localDefinitions(config);
  const seen = new Set<string>();
  const collected: TerraformReference[] = [];
  const walk = (text: string, depth: number): void => {
    if (depth > MAX_LOCAL_DEPTH) return;
    for (const reference of extractReferences(text)) {
      if (seen.has(reference.address)) continue;
      seen.add(reference.address);
      collected.push(reference);
      if (reference.kind === 'local') {
        const name = reference.target.slice('local.'.length);
        const definition = locals.get(name);
        if (definition !== undefined) walk(definition, depth + 1);
      }
    }
  };
  walk(expression, 0);
  return collected;
}

function referencesTargetThroughLocals(
  config: HclDocument,
  expression: string,
  target: string,
): boolean {
  return reachableReferences(config, expression).some((r) => r.target === target);
}

/** Direct first — the common case — then through locals. */
function referencesTargetTransitively(
  config: HclDocument,
  expression: string,
  target: string,
): boolean {
  return (
    referencesTarget(expression, target) ||
    referencesTargetThroughLocals(config, expression, target)
  );
}

/**
 * Does an expression use this identifier or function?
 *
 * Word-boundaried and built from an escaped literal, so a lab's identifier can
 * never behave as a pattern, and `len` does not match `length`.
 */
function mentions(expression: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(expression);
}

export type { HclBlock };
