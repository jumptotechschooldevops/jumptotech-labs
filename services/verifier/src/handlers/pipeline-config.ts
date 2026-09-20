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
import { fail, pass, type HandlerOutcome, type CicdVerifierHandler } from '../contract.js';
import type { CicdVerifyReader } from '../cicd-reader.js';
import { parseWorkflow } from '../ci/workflow.js';
import { allAssignments, parseJenkinsfile, stripComments } from '../ci/jenkinsfile.js';
import {
  findHardcodedSecrets,
  isSecretReference,
  scanTextForAssignments,
  type CandidateAssignment,
} from '../ci/secrets.js';
import { valueAfterSeparator } from '../line-value.js';

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
  reader: CicdVerifyReader,
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

export const environmentReferenceExists: CicdVerifierHandler<'environment_reference_exists'> = {
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
      // model, so a text fallback keeps a correct answer from failing. The
      // fallback holds the same line the structured path does: a comment is
      // not configuration, and when the lab pins a mechanism, only a line that
      // *uses that mechanism* counts — `$REGISTRY_PASSWORD` in a shell step is
      // a use of the name, not a binding of it.
      if (referencedInCode(text, requirement.path, requirement.name, requirement.via)) {
        if (requirement.value_contains !== undefined) {
          return fail(`${requirement.name} is referenced, but no declaration of its value was found`);
        }
        return pass('referenced in the pipeline');
      }
      const declared = [...new Set(assignments.map((a) => a.key))];
      if (requirement.via && mentionsName(codeLines(text, requirement.path), requirement.name)) {
        return fail(`${requirement.name} is used, but never ${viaDescription(requirement.via)}`);
      }
      return fail(
        declared.length > 0
          ? `'${requirement.path}' declares ${declared.slice(0, 8).join(', ')} but not ${requirement.name}`
          : `'${requirement.path}' declares no environment values`,
      );
    }

    const declared = requirement.via ? matching.filter((a) => matchesVia(requirement.via!, a)) : matching;
    if (requirement.via && declared.length === 0) {
      return fail(`${requirement.name} is set, but not ${viaDescription(requirement.via)}`);
    }

    if (requirement.value_contains !== undefined) {
      // Never name the text: it is what the student had to decide.
      const wanted = requirement.value_contains.replace(/\s+/g, '').toLowerCase();
      const holds = declared.some(
        (a) => a.value !== null && a.value.replace(/\s+/g, '').toLowerCase().includes(wanted),
      );
      if (!holds) {
        return fail(`${requirement.name} is declared, but its value is not derived the way this lab asks`);
      }
    }

    return pass(requirement.via ? viaDescription(requirement.via) : `declared in ${matching[0]?.location ?? requirement.path}`);
  },
};

export const secretNotHardcoded: CicdVerifierHandler<'secret_not_hardcoded'> = {
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
function matchesVia(via: string, assignment: CandidateAssignment): boolean {
  const { value } = assignment;
  switch (via) {
    case 'workflow_secret':
      return value !== null && /\$\{\{\s*secrets\./i.test(value);
    case 'jenkins_credentials':
      return value !== null && /\bcredentials\s*\(/i.test(value);
    case 'workflow_env':
      // `with:` inputs are recorded as assignments too — so that a token
      // passed to an action inline is still caught as hardcoded — but an
      // action input is not an environment variable. Only an `env:` mapping,
      // at workflow, job or step level, declares one.
      return isWorkflowEnvLocation(assignment.location);
    case 'jenkins_environment':
      // "Declared in the pipeline's environment block": a stage-level
      // `environment` is invisible to every other stage.
      return assignment.location === 'pipeline.environment';
    default:
      return true;
  }
}

/** `env`, `jobs.<id>.env` or `jobs.<id>.steps[n].env` — never `….with`. */
function isWorkflowEnvLocation(location: string | undefined): boolean {
  return location === undefined || location === 'env' || location.endsWith('.env');
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
 * The fallback: does code in the file (not a comment) reference the name the
 * way the lab asks for?
 *
 *   no `via`              any mention in code
 *   `jenkins_credentials` a `withCredentials` binding that names it as its
 *                         variable (`passwordVariable: 'NAME'` and friends)
 *   `workflow_secret`     `${{ secrets.NAME }}`
 *   `workflow_env`, `jenkins_environment`
 *                         never — both are declarations the parsers model, so
 *                         reaching the fallback means there is none
 */
function referencedInCode(text: string, path: string, name: string, via: string | undefined): boolean {
  const lines = codeLines(text, path);
  const escaped = escapeRegExp(name);
  switch (via) {
    case undefined:
      return mentionsName(lines, name);
    case 'jenkins_credentials': {
      const binding = new RegExp(`\\b[A-Za-z]*[Vv]ariable\\s*:\\s*['"]${escaped}['"]`);
      return lines.some((line) => binding.test(line));
    }
    case 'workflow_secret': {
      const secret = new RegExp(`\\$\\{\\{[^}]*\\bsecrets\\.${escaped}\\b`);
      return lines.some((line) => secret.test(line));
    }
    default:
      return false;
  }
}

/**
 * Is the name referenced anywhere in these lines, as a whole word?
 *
 * Paired with `isSecretReference` so a bare mention inside a hardcoded value
 * does not count.
 */
function mentionsName(lines: readonly string[], name: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    // Linear: the pipeline file is the student's, and `(.+?)\s*$` was not.
    const assignment = valueAfterSeparator(line);
    // A line that assigns a plain literal to *this name* is a hardcoded value,
    // not a reference; `secret_not_hardcoded` is the check that reports it.
    // `run: echo "$NAME"` assigns to `run`, and is a use of the name.
    if (assignment && assignedKey(line) === name && !isSecretReference(assignment)) continue;
    return true;
  }
  return false;
}

/**
 * The file's lines with comments removed.
 *
 * A Jenkinsfile goes through the Jenkins lexer, which knows `//`, `/* … *\/`
 * and where strings are. Anything else here (a workflow, a shell script) uses
 * `#`, which counts only at the start of a line or after whitespace, so
 * `${{ … }}` and URLs survive. It can keep a comment it should have dropped
 * inside an unusual string, but it never invents code.
 */
function codeLines(text: string, path: string): string[] {
  if (isJenkinsPath(path)) return stripComments(text).split('\n');
  return text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '$1'));
}

/** The key a `KEY = value` / `KEY: value` line assigns to, list dash and quotes removed. */
function assignedKey(line: string): string {
  const separator = line.search(/[:=]/);
  if (separator < 0) return '';
  return line
    .slice(0, separator)
    .replace(/^[\s-]*/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
