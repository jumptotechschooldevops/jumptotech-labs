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
import {
  AWS_RESERVED_ADDRESSES_PER_SUBNET,
  cidrContains,
  firstOverlappingPair,
  freeAddresses,
  isRfc1918,
  parseIpv4Cidr,
  usableAddresses,
  type Ipv4Cidr,
} from '../cidr.js';
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

// ---------------------------------------------------------------- CIDR ----
//
// Network design checks. The rule from the top of this file applies with more
// force here: these grade *addressing*, so any plan that satisfies the stated
// constraints passes. Failure detail reports the arithmetic that failed — the
// range that escaped the VPC, the pair that overlapped, the capacity that fell
// short — and never a range the student was supposed to choose.

/**
 * Read one resource's property and parse it as an IPv4 CIDR.
 *
 * Every distinguishable way this can go wrong gets its own message, because
 * "not a valid CIDR" is the one failure a student cannot act on.
 */
function readCidr(
  template: CfnTemplate,
  logicalId: string,
  property: string,
  path: string,
): { cidr: Ipv4Cidr } | { outcome: HandlerOutcome } {
  const resource = template.resources[logicalId];
  if (!resource) {
    return { outcome: fail(`no resource named '${logicalId}' in '${path}'; ${declared(template)}`) };
  }
  const raw = readPath(resource.properties, property);
  if (raw === undefined) {
    return { outcome: fail(`'${logicalId}' does not set ${property}`) };
  }
  if (typeof raw !== 'string') {
    // A `!Ref` or `!Sub` here is a real answer, but not one that can be graded
    // as addressing: the value is only known at deploy time.
    return {
      outcome: fail(
        `'${logicalId}' sets ${property} to an intrinsic function rather than a literal CIDR block`,
      ),
    };
  }
  const cidr = parseIpv4Cidr(raw);
  if (!cidr) return { outcome: fail(`'${logicalId}' sets ${property} to '${raw}', which is not a valid IPv4 CIDR block`) };
  return { cidr };
}

/** Read a whole set of resources' CIDRs, failing on the first unreadable one. */
function readCidrSet(
  template: CfnTemplate,
  logicalIds: readonly string[],
  property: string,
  path: string,
): { entries: Array<{ logicalId: string; cidr: Ipv4Cidr }> } | { outcome: HandlerOutcome } {
  const entries: Array<{ logicalId: string; cidr: Ipv4Cidr }> = [];
  for (const logicalId of logicalIds) {
    const read = readCidr(template, logicalId, property, path);
    if ('outcome' in read) return { outcome: read.outcome };
    entries.push({ logicalId, cidr: read.cidr });
  }
  return { entries };
}

export const cfnCidrValid: SandboxVerifierHandler<'cfn_cidr_valid'> = {
  type: 'cfn_cidr_valid',
  label: (r) => `${r.logical_id} sets ${r.property} to a usable CIDR block`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const read = readCidr(result.template, requirement.logical_id, requirement.property, requirement.path);
    if ('outcome' in read) return read.outcome;
    const { cidr } = read;

    if (requirement.prefix_min !== undefined && cidr.prefixLength < requirement.prefix_min) {
      return fail(
        `'${requirement.logical_id}' is a /${cidr.prefixLength}, which is wider than the /${requirement.prefix_min} allowed here`,
      );
    }
    if (requirement.prefix_max !== undefined && cidr.prefixLength > requirement.prefix_max) {
      return fail(
        `'${requirement.logical_id}' is a /${cidr.prefixLength}, which is narrower than the /${requirement.prefix_max} allowed here`,
      );
    }
    if (requirement.min_addresses !== undefined && cidr.addressCount < requirement.min_addresses) {
      return fail(
        `'${requirement.logical_id}' holds ${cidr.addressCount} addresses, short of the ${requirement.min_addresses} required`,
      );
    }
    if (requirement.min_usable !== undefined) {
      const usable = usableAddresses(cidr);
      if (usable < requirement.min_usable) {
        return fail(
          `'${requirement.logical_id}' offers ${usable} assignable addresses (${cidr.addressCount} less the ${AWS_RESERVED_ADDRESSES_PER_SUBNET} AWS reserves), short of the ${requirement.min_usable} required`,
        );
      }
    }
    if (requirement.rfc1918 === true && !isRfc1918(cidr)) {
      return fail(`'${requirement.logical_id}' is not inside any RFC 1918 private range`);
    }
    return pass();
  },
};

export const cfnCidrWithin: SandboxVerifierHandler<'cfn_cidr_within'> = {
  type: 'cfn_cidr_within',
  label: (r) => `every ${r.property} lies inside ${r.parent}`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const parent = readCidr(result.template, requirement.parent, requirement.parent_property, requirement.path);
    if ('outcome' in parent) return parent.outcome;
    const children = readCidrSet(result.template, requirement.logical_ids, requirement.property, requirement.path);
    if ('outcome' in children) return children.outcome;

    const escaped = children.entries.filter((entry) => !cidrContains(parent.cidr, entry.cidr));
    if (escaped.length > 0) {
      const names = escaped.map((entry) => `'${entry.logicalId}' (${entry.cidr.text})`).join(', ');
      return fail(`${names} ${escaped.length === 1 ? 'is' : 'are'} not inside ${requirement.parent} (${parent.cidr.text})`);
    }
    return pass();
  },
};

export const cfnCidrDisjoint: SandboxVerifierHandler<'cfn_cidr_disjoint'> = {
  type: 'cfn_cidr_disjoint',
  label: (r) => `no two ${r.property} values overlap`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const read = readCidrSet(result.template, requirement.logical_ids, requirement.property, requirement.path);
    if ('outcome' in read) return read.outcome;

    const clash = firstOverlappingPair(read.entries);
    if (clash) {
      const [a, b] = clash;
      return fail(`'${a.logicalId}' (${a.cidr.text}) overlaps '${b.logicalId}' (${b.cidr.text})`);
    }
    return pass();
  },
};

export const cfnCidrFreeSpace: SandboxVerifierHandler<'cfn_cidr_free_space'> = {
  type: 'cfn_cidr_free_space',
  label: (r) => `${r.parent} keeps at least ${r.min_free_percent}% of its range unallocated`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const parent = readCidr(result.template, requirement.parent, requirement.parent_property, requirement.path);
    if ('outcome' in parent) return parent.outcome;
    const children = readCidrSet(result.template, requirement.logical_ids, requirement.property, requirement.path);
    if ('outcome' in children) return children.outcome;

    const free = freeAddresses(parent.cidr, children.entries.map((entry) => entry.cidr));
    const percent = (free / parent.cidr.addressCount) * 100;
    if (percent < requirement.min_free_percent) {
      return fail(
        `the subnets leave ${percent.toFixed(1)}% of ${requirement.parent} (${parent.cidr.text}) unallocated, short of ${requirement.min_free_percent}%`,
      );
    }
    return pass();
  },
};

export const cfnPropertyDistinct: SandboxVerifierHandler<'cfn_property_distinct'> = {
  type: 'cfn_property_distinct',
  label: (r) => `${r.property} takes at least ${r.min_distinct} different values`,
  async run(requirement, reader) {
    const result = await readTemplate(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const values = new Set<string>();
    for (const logicalId of requirement.logical_ids) {
      const resource = result.template.resources[logicalId];
      if (!resource) {
        return fail(`no resource named '${logicalId}' in '${requirement.path}'; ${declared(result.template)}`);
      }
      const raw = readPath(resource.properties, requirement.property);
      if (raw === undefined) return fail(`'${logicalId}' does not set ${requirement.property}`);
      // Intrinsics are compared by their canonical form, so `!Select [0, …]`
      // and the long-form spelling of the same call count as one value.
      values.add(typeof raw === 'string' ? raw : JSON.stringify(raw));
    }

    if (values.size < requirement.min_distinct) {
      return fail(
        `${requirement.property} takes ${values.size} different value${values.size === 1 ? '' : 's'} across those resources, not ${requirement.min_distinct}`,
      );
    }
    return pass();
  },
};
