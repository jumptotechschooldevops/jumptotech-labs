/**
 * IAM policy requirement handlers.
 *
 * The rule these exist to enforce: **an IAM policy is graded on what it means,
 * not on how it is written.** Every handler below parses the document and asks
 * the model a question. None of them looks for a substring, so a student who
 * writes `"Action": ["s3:GetObject"]` and one who writes
 * `"Action":"s3:GetObject"` are graded identically — and a student who pastes
 * the right words in a policy that does not actually grant anything is not
 * given a pass for it.
 *
 * The document is read, never executed, and never sent anywhere.
 */
import { fail, missingPath, pass, type HandlerOutcome, type SandboxVerifierHandler } from '../contract.js';
import type { SandboxReader } from '../sandbox-reader.js';
import {
  IamPolicyParseError,
  evaluateIamPolicy,
  findStatements,
  parseIamPolicy,
  wildcardStatements,
  type IamPolicy,
} from '../iam-policy.js';

/**
 * Read and parse the policy at `path`, or explain why it could not be.
 *
 * Returns either the parsed policy or the outcome to report. A document that
 * does not parse is a failure of the check that asked for it, described in the
 * terms the student can act on ("the document is not valid JSON…").
 */
async function readPolicy(
  reader: SandboxReader,
  path: string,
): Promise<{ policy: IamPolicy } | { outcome: HandlerOutcome }> {
  const read = await reader.path(path);
  if (!read) return { outcome: missingPath('policy document', path) };
  if (read.type !== 'file') {
    return { outcome: fail(`'${path}' is not a regular file`) };
  }
  if (read.content === undefined) {
    return { outcome: fail(`'${path}' could not be read`) };
  }
  if (read.truncated) {
    return { outcome: fail(`'${path}' is too large to parse as a policy document`) };
  }

  try {
    return { policy: parseIamPolicy(read.content) };
  } catch (error) {
    if (error instanceof IamPolicyParseError) {
      return { outcome: fail(`'${path}' is not a valid IAM policy: ${error.message}`) };
    }
    throw error;
  }
}

/** How many statements a document has, for failure detail. */
function summarise(policy: IamPolicy): string {
  const count = policy.statements.length;
  return `the document has ${count} statement${count === 1 ? '' : 's'}`;
}

export const iamPolicyDocument: SandboxVerifierHandler<'iam_policy_document'> = {
  type: 'iam_policy_document',
  label: (r) => `${r.path} is a valid IAM policy document`,
  async run(requirement, reader) {
    const result = await readPolicy(reader, requirement.path);
    if ('outcome' in result) return result.outcome;
    const { policy } = result;

    if (requirement.version !== undefined && policy.version !== requirement.version) {
      return fail(
        policy.version === undefined
          ? `'${requirement.path}' declares no Version`
          : `'${requirement.path}' declares Version '${policy.version}'`,
      );
    }
    if (
      requirement.statement_count !== undefined &&
      policy.statements.length !== requirement.statement_count
    ) {
      return fail(`'${requirement.path}': ${summarise(policy)}`);
    }
    return pass();
  },
};

export const iamPolicyStatement: SandboxVerifierHandler<'iam_policy_statement'> = {
  type: 'iam_policy_statement',
  label: (r) => {
    const parts: string[] = [];
    if (r.effect) parts.push(`${r.effect}s`);
    if (r.actions) parts.push(r.actions.join(', '));
    if (r.resources) parts.push(`on ${r.resources.join(', ')}`);
    return `${r.path} has a statement that ${parts.join(' ') || 'matches'}`;
  },
  async run(requirement, reader) {
    const result = await readPolicy(reader, requirement.path);
    if ('outcome' in result) return result.outcome;
    const { policy } = result;

    const selector = {
      ...(requirement.effect !== undefined ? { effect: requirement.effect } : {}),
      ...(requirement.sid !== undefined ? { sid: requirement.sid } : {}),
      ...(requirement.actions !== undefined ? { actions: requirement.actions } : {}),
      ...(requirement.resources !== undefined ? { resources: requirement.resources } : {}),
      ...(requirement.condition !== undefined ? { condition: requirement.condition } : {}),
    };

    if (findStatements(policy, selector).length > 0) return pass();

    // Say which part of the selector nothing satisfied, so the student learns
    // where to look without being handed the statement to write.
    const effectOnly = requirement.effect
      ? findStatements(policy, { effect: requirement.effect })
      : policy.statements;
    if (effectOnly.length === 0) {
      return fail(
        `no statement in '${requirement.path}' has Effect ${requirement.effect}; ${summarise(policy)}`,
      );
    }
    if (requirement.condition !== undefined) {
      const withoutCondition = findStatements(policy, { ...selector, condition: undefined });
      if (withoutCondition.length > 0) {
        return fail(
          `a matching statement exists in '${requirement.path}', but none carries a ${requirement.condition.operator} condition on ${requirement.condition.key}`,
        );
      }
    }
    return fail(
      `no single statement in '${requirement.path}' covers all of that; ${summarise(policy)}`,
    );
  },
};

export const iamPolicyAllows: SandboxVerifierHandler<'iam_policy_allows'> = {
  type: 'iam_policy_allows',
  label: (r) => `${r.path} permits ${r.action} on ${r.resource}`,
  async run(requirement, reader) {
    const result = await readPolicy(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const decision = evaluateIamPolicy(result.policy, {
      action: requirement.action,
      resource: requirement.resource,
    });
    if (decision === 'allow') return pass();
    return fail(
      decision === 'explicitDeny'
        ? `'${requirement.path}' explicitly denies ${requirement.action} on that resource`
        : `'${requirement.path}' does not permit ${requirement.action} on that resource; ${summarise(result.policy)}`,
    );
  },
};

export const iamPolicyNotAllows: SandboxVerifierHandler<'iam_policy_not_allows'> = {
  type: 'iam_policy_not_allows',
  label: (r) => `${r.path} does not permit ${r.action} on ${r.resource}`,
  async run(requirement, reader) {
    const result = await readPolicy(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const decision = evaluateIamPolicy(result.policy, {
      action: requirement.action,
      resource: requirement.resource,
    });
    if (decision !== 'allow') return pass();
    return fail(`'${requirement.path}' permits ${requirement.action} on that resource`);
  },
};

export const iamPolicyNoWildcard: SandboxVerifierHandler<'iam_policy_no_wildcard'> = {
  type: 'iam_policy_no_wildcard',
  label: (r) =>
    `${r.path} uses no "*" wildcard in ${r.field}${r.effect ? ` of any ${r.effect} statement` : ''}`,
  async run(requirement, reader) {
    const result = await readPolicy(reader, requirement.path);
    if ('outcome' in result) return result.outcome;

    const offending = wildcardStatements(result.policy, requirement.field, requirement.effect);
    if (offending.length === 0) return pass();

    const where = offending
      .map((statement) => statement.sid ?? `statement ${statement.index + 1}`)
      .join(', ');
    return fail(`${where} in '${requirement.path}' uses "*" as its ${requirement.field}`);
  },
};
