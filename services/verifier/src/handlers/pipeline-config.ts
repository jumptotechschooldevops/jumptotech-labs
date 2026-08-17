/**
 * Handlers for environment variables and credential handling in pipeline files.
 *
 * Two checks, and the pairing is the lesson: one asks that a value is supplied
 * *by reference*, the other asks that no value is supplied *by literal*. A lab
 * that used only the first would pass a student who wrote the token inline
 * under the right name.
 *
 * Neither check ever echoes a value it read. A verification detail is shown in
 * a browser and pasted into support threads; a check that quoted the secret it
 * objected to would be worse than no check.
 */
import { fail, pass, type HandlerOutcome, type VerifierHandler } from '../contract.js';
import type { VerifyReader } from '../reader.js';
import { parseWorkflow } from '../ci/workflow.js';
import { allAssignments, parseJenkinsfile } from '../ci/jenkinsfile.js';
import {
  findHardcodedSecrets,
  isSecretReference,
  scanTextForAssignments,
  type CandidateAssignment,
} from '../ci/secrets.js';

/** Does this path look like a GitHub Actions workflow? */
function isWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/.+\.(ya?ml)$/i.test(path);
}

/** Does this path look like a Jenkinsfile? */
function isJenkinsPath(path: string): boolean {
  return /(^|\/)Jenkinsfile(\.[A-Za-z0-9_-]+)?$/.test(path);
}

/**
 * Collect every `KEY = value` a file declares, using the best reader for it.
 *
 * Falls back to a line scan for files with no dedicated parser, so a student
 * who put a token in a shell script is still caught.
 */
async function collectAssignments(
  reader: VerifyReader,
  path: string,
): Promise<{ assignments: CandidateAssignment[]; text: string } | { outcome: HandlerOutcome }> {
  const text = await reader.fileText(path);
  if (text === null) return { outcome: fail(`No '${path}' found in your workspace`) };
  if (text.trim().length === 0) return { outcome: fail(`'${path}' exists but is empty`) };

  if (isWorkflowPath(path)) {
    const parsed = parseWorkflow(text);
    if (!parsed.ok) return { outcome: fail(`'${path}' is not a valid workflow: ${parsed.error}`) };
    return { assignments: parsed.workflow.assignments, text };
  }

  if (isJenkinsPath(path)) {
    const parsed = parseJenkinsfile(text);
    if (!parsed.ok) {
      return { outcome: fail(`'${path}' is not a well-formed declarative pipeline: ${parsed.error}`) };
    }
    return { assignments: allAssignments(parsed.pipeline), text };
  }

  return { assignments: scanTextForAssignments(text, path), text };
}

export const environmentReferenceExists: VerifierHandler<'environment_reference_exists'> = {
  type: 'environment_reference_exists',
  label: (r) => `${r.name} is supplied by the pipeline`,
  async run(requirement, reader) {
    const collected = await collectAssignments(reader, requirement.path);
    if ('outcome' in collected) return collected.outcome;
    const { assignments, text } = collected;

    const matching = assignments.filter((a) => a.key === requirement.name);
    if (matching.length === 0) {
      // A step-level `env:` in a workflow and a `withCredentials` binding in a
      // Jenkinsfile both introduce a name without an assignment the parsers
      // model, so a text fallback keeps a correct answer from failing.
      if (mentionsName(text, requirement.name)) {
        return pass('referenced in the pipeline');
      }
      const declared = [...new Set(assignments.map((a) => a.key))];
      return fail(
        declared.length > 0
          ? `'${requirement.path}' declares ${declared.slice(0, 8).join(', ')} but not ${requirement.name}`
          : `'${requirement.path}' declares no environment values`,
      );
    }

    if (requirement.via) {
      const wanted = viaDescription(requirement.via);
      const satisfied = matching.some((a) => matchesVia(requirement.via!, a.value));
      if (!satisfied) {
        return fail(`${requirement.name} is set, but not ${wanted}`);
      }
      return pass(wanted);
    }

    return pass(`declared in ${matching[0]?.location ?? requirement.path}`);
  },
};

export const secretNotHardcoded: VerifierHandler<'secret_not_hardcoded'> = {
  type: 'secret_not_hardcoded',
  label: (r) => `${r.path} contains no hardcoded credentials`,
  async run(requirement, reader) {
    const collected = await collectAssignments(reader, requirement.path);
    if ('outcome' in collected) return collected.outcome;

    const findings = findHardcodedSecrets(collected.assignments);
    if (findings.length > 0) {
      const first = findings[0];
      return fail(
        findings.length === 1
          ? `${first?.reason}. Reference a secret instead of writing the value in the file.`
          : `${findings.length} values are written in plain text (${findings.map((f) => f.key).join(', ')}). Reference secrets instead.`,
      );
    }

    return pass('no credential-shaped literals');
  },
};

/**
 * Does a value use the mechanism the lab pinned?
 *
 * Each arm is the documented spelling of that mechanism: GitHub's `secrets`
 * context, GitHub's `env` mapping, Jenkins' `credentials()` helper, and a
 * Jenkins `environment` entry (which is satisfied by the assignment existing
 * at all — the caller has already found it in that block).
 */
function matchesVia(via: string, value: string | null): boolean {
  switch (via) {
    case 'workflow_secret':
      return value !== null && /\$\{\{\s*secrets\./i.test(value);
    case 'jenkins_credentials':
      return value !== null && /\bcredentials\s*\(/i.test(value);
    case 'workflow_env':
    case 'jenkins_environment':
      return true;
    default:
      return true;
  }
}

function viaDescription(via: string): string {
  switch (via) {
    case 'workflow_secret':
      return 'read from the secrets context';
    case 'jenkins_credentials':
      return "bound with credentials('…')";
    case 'workflow_env':
      return "declared in the workflow's env";
    case 'jenkins_environment':
      return "declared in the pipeline's environment block";
    default:
      return 'supplied by reference';
  }
}

/**
 * Is the name referenced anywhere in the file, as a whole word?
 *
 * Used only as a fallback when no structured assignment carries it — and it is
 * paired with `isSecretReference` so a bare mention inside a hardcoded value
 * does not count.
 */
function mentionsName(text: string, name: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue;
    const assignment = /[:=]\s*(.+?)\s*$/.exec(line);
    // A line that assigns a plain literal to this name is a hardcoded value,
    // not a reference; `secret_not_hardcoded` is the check that reports it.
    if (assignment?.[1] && !isSecretReference(assignment[1])) continue;
    return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
