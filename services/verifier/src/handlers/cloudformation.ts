/**
 * CloudFormation requirement handlers.
 *
 * The rule these exist to enforce: **a template is graded on what it declares,
 * not on how it is typed.** Every handler parses the document and asks the
 * model a question, so `!Ref Bucket` and `{"Ref":"Bucket"}` are the same
 * answer, and resource order, property order and indentation are not answers
 * at all.
 *
 * The template is read, never rendered, never deployed, and never sent
 * anywhere. Nothing here needs an AWS account.
 *
 * Failure detail names the property that failed and, where it helps, what was
 * found in its place — never the whole template, and never the value the lab
 * is asking the student to supply.
 */
import { fail, missingPath, pass, type HandlerOutcome, type SandboxVerifierHandler } from '../contract.js';
import type { SandboxReader } from '../sandbox-reader.js';
import {
  CloudFormationParseError,
  outputReference,
  parseCloudFormationTemplate,
  readPath,
  referenceAt,
  unresolvedReferences,
  valueEquals,
  type CfnTemplate,
} from '../cloudformation.js';

async function readTemplate(
  reader: SandboxReader,
  path: string,
): Promise<{ template: CfnTemplate } | { outcome: HandlerOutcome }> {
  const read = await reader.path(path);
  if (!read) return { outcome: missingPath('template', path) };
  if (read.type !== 'file') return { outcome: fail(`'${path}' is not a regular file`) };
  if (read.content === undefined) return { outcome: fail(`'${path}' could not be read`) };
  if (read.truncated) return { outcome: fail(`'${path}' is too large to parse as a template`) };

  try {
    return { template: parseCloudFormationTemplate(read.content) };
  } catch (error) {
    if (error instanceof CloudFormationParseError) {
      return { outcome: fail(`'${path}' is not a valid CloudFormation template: ${error.message}`) };
    }
    throw error;
  }
}

/** Names the resources a template declares, for orientation without dumping it. */
function declared(template: CfnTemplate): string {
  const ids = Object.keys(template.resources);
  return `the template declares ${ids.length} resource${ids.length === 1 ? '' : 's'}`;
}

export const cfnTemplateValid: SandboxVerifierHandler<'cfn_template_valid'> = {
  type: 'cfn_template_valid',
  label: (r) => `${r.path} is a valid CloudFormation template`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;
    const { template } = result;

    if (requirement.format_version !== undefined && template.formatVersion !== requirement.format_version) {
      return fail(
        template.formatVersion === undefined
          ? `'${requirement.path}' declares no AWSTemplateFormatVersion`
          : `'${requirement.path}' declares AWSTemplateFormatVersion '${template.formatVersion}'`,
      );
    }
    if (
      requirement.min_resources !== undefined &&
      Object.keys(template.resources).length < requirement.min_resources
    ) {
      return fail(`'${requirement.path}': ${declared(template)}`);
    }
    return pass();
  },
};

export const cfnResourceExists: SandboxVerifierHandler<'cfn_resource_exists'> = {
  type: 'cfn_resource_exists',
  label: (r) => `${r.logical_id} is declared as ${r.resource_type}`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const resource = result.template.resources[requirement.logical_id];
    if (!resource) {
      return fail(
        `no resource named '${requirement.logical_id}' in '${requirement.path}'; ${declared(result.template)}`,
      );
    }
    if (resource.type !== requirement.resource_type) {
      return fail(`'${requirement.logical_id}' is declared as ${resource.type}`);
    }
    return pass();
  },
};

export const cfnResourceProperty: SandboxVerifierHandler<'cfn_resource_property'> = {
  type: 'cfn_resource_property',
  label: (r) =>
    r.equals === undefined
      ? `${r.logical_id} sets ${r.property}`
      : `${r.logical_id} sets ${r.property} correctly`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const resource = result.template.resources[requirement.logical_id];
    if (!resource) return fail(`no resource named '${requirement.logical_id}' in '${requirement.path}'`);

    const value = readPath(resource.properties, requirement.property);
    if (value === undefined || value === null) {
      return fail(`'${requirement.logical_id}' has no ${requirement.property}`);
    }
    if (requirement.equals !== undefined && !valueEquals(value, requirement.equals)) {
      // Report the shape found, not the value expected.
      const shape = Array.isArray(value) ? `a list of ${value.length}` : typeof value;
      return fail(`'${requirement.logical_id}' has ${requirement.property}, but not that value (found ${shape})`);
    }
    return pass();
  },
};

export const cfnResourceReference: SandboxVerifierHandler<'cfn_resource_reference'> = {
  type: 'cfn_resource_reference',
  label: (r) => `${r.logical_id}.${r.property} refers to ${r.references} with ${r.via}`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const resource = result.template.resources[requirement.logical_id];
    if (!resource) return fail(`no resource named '${requirement.logical_id}' in '${requirement.path}'`);

    const reference = referenceAt(result.template, requirement.logical_id, requirement.property);
    if (!reference) {
      return fail(`'${requirement.logical_id}'.${requirement.property} is not a reference to anything`);
    }
    if (reference.kind !== requirement.via) {
      return fail(
        `'${requirement.logical_id}'.${requirement.property} uses ${reference.kind} rather than ${requirement.via}`,
      );
    }
    if (reference.target !== requirement.references) {
      return fail(
        `'${requirement.logical_id}'.${requirement.property} refers to '${reference.target}'`,
      );
    }
    if (requirement.attribute !== undefined && reference.attribute !== requirement.attribute) {
      return fail(
        reference.attribute === undefined
          ? `'${requirement.logical_id}'.${requirement.property} names no attribute`
          : `'${requirement.logical_id}'.${requirement.property} names the attribute '${reference.attribute}'`,
      );
    }
    return pass();
  },
};

export const cfnReferencesResolve: SandboxVerifierHandler<'cfn_references_resolve'> = {
  type: 'cfn_references_resolve',
  label: (r) => `Every reference in ${r.path} resolves`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const dangling = unresolvedReferences(result.template);
    if (dangling.length === 0) return pass();

    // Name where the dangling references are and what they point at — that is
    // the observation. It does not say what they should have pointed at.
    const shown = dangling
      .slice(0, 3)
      .map((r) => `${r.where} refers to '${r.target}'`)
      .join('; ');
    const more = dangling.length > 3 ? ` (and ${dangling.length - 3} more)` : '';
    return fail(`${dangling.length} reference(s) resolve to nothing: ${shown}${more}`);
  },
};

export const cfnOutputExists: SandboxVerifierHandler<'cfn_output_exists'> = {
  type: 'cfn_output_exists',
  label: (r) =>
    r.references === undefined
      ? `The template exports ${r.name}`
      : `The template exports ${r.name}, taken from ${r.references}`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const names = Object.keys(result.template.outputs);
    if (!names.includes(requirement.name)) {
      return fail(
        names.length === 0
          ? `'${requirement.path}' declares no Outputs`
          : `'${requirement.path}' declares no output named '${requirement.name}'`,
      );
    }
    if (requirement.references !== undefined) {
      const reference = outputReference(result.template, requirement.name);
      if (!reference) return fail(`output '${requirement.name}' does not reference a resource`);
      if (reference.target !== requirement.references) {
        return fail(`output '${requirement.name}' references '${reference.target}'`);
      }
    }
    return pass();
  },
};
