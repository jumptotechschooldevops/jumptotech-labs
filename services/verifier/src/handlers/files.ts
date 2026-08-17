/**
 * Handlers that read the session workspace as files.
 *
 * These are the file-backed counterparts of `handlers/pods.ts`: given a
 * requirement and a reader, look at what is actually there and report. As
 * everywhere else in the verifier, a failure detail describes the *observed
 * state* — "exists but is empty", "parses as YAML but the top level is a list"
 * — and never the solution.
 */
import type { RequirementOf } from '@jumptotech/lab-orchestrator';
import { parseDocument } from 'yaml';
import { fail, pass, type HandlerOutcome, type VerifierHandler } from '../contract.js';
import type { VerifyReader } from '../reader.js';

/** Shared wording for a path that is not there. */
function absent(path: string): HandlerOutcome {
  return fail(`No '${path}' found in your workspace`);
}

export const fileExists: VerifierHandler<'file_exists'> = {
  type: 'file_exists',
  label: (r) => `${r.path} exists`,
  async run(requirement, reader) {
    const stat = await reader.fileStat(requirement.path);
    if (!stat) return absent(requirement.path);

    if (stat.kind !== requirement.kind) {
      return fail(`'${requirement.path}' is a ${stat.kind}, but this lab expects a ${requirement.kind}`);
    }
    const minimum = requirement.min_bytes;
    if (minimum !== undefined && stat.size < minimum) {
      // The commonest false pass in a file lab: `touch` created the path and
      // nothing wrote to it.
      return fail(
        stat.size === 0
          ? `'${requirement.path}' exists but is empty`
          : `'${requirement.path}' is ${stat.size} bytes; this lab expects at least ${minimum}`,
      );
    }
    return pass(stat.kind === 'directory' ? `${stat.entries ?? 0} entries` : `${stat.size} bytes`);
  },
};

/** Collapse whitespace and case so formatting differences do not decide a grade. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase();
}

export const fileContains: VerifierHandler<'file_contains'> = {
  type: 'file_contains',
  label: (r) =>
    r.contains.length > 0
      ? `${r.path} includes ${r.contains.map((c) => `'${c}'`).join(', ')}`
      : `${r.path} no longer includes ${r.absent.map((c) => `'${c}'`).join(', ')}`,
  async run(requirement, reader) {
    const text = await reader.fileText(requirement.path);
    if (text === null) return absent(requirement.path);
    if (text.trim().length === 0) return fail(`'${requirement.path}' exists but is empty`);

    const haystack = normalise(text);

    const missing = requirement.contains.filter((f) => !haystack.includes(normalise(f)));
    if (missing.length > 0) {
      return fail(
        `'${requirement.path}' does not include ${missing.map((m) => `'${m}'`).join(' or ')}`,
      );
    }

    const lingering = requirement.absent.filter((f) => haystack.includes(normalise(f)));
    if (lingering.length > 0) {
      return fail(
        `'${requirement.path}' still includes ${lingering.map((m) => `'${m}'`).join(' and ')}`,
      );
    }

    return pass(`${requirement.contains.length + requirement.absent.length} checks matched`);
  },
};

export const yamlValid: VerifierHandler<'yaml_valid'> = {
  type: 'yaml_valid',
  label: (r) => `${r.path} is valid YAML`,
  async run(requirement, reader) {
    const text = await reader.fileText(requirement.path);
    if (text === null) return absent(requirement.path);
    if (text.trim().length === 0) return fail(`'${requirement.path}' is empty`);

    let document;
    try {
      document = parseDocument(text);
    } catch (cause) {
      return fail(`'${requirement.path}' is not valid YAML: ${(cause as Error).message}`);
    }
    if (document.errors.length > 0) {
      const first = document.errors[0];
      const line = first?.linePos?.[0]?.line;
      // Quoting the parser's own message and line is what makes an indentation
      // fault findable — CICD-010 relies on this being specific.
      return fail(
        `'${requirement.path}' is not valid YAML: ${first?.message ?? 'parse error'}${line ? ` (line ${line})` : ''}`,
      );
    }

    const value = document.toJS() as unknown;
    if (value === null || value === undefined) {
      return fail(`'${requirement.path}' parses as YAML but contains no content`);
    }
    return pass('parses cleanly');
  },
};

export const artifactExists: VerifierHandler<'artifact_exists'> = {
  type: 'artifact_exists',
  label: (r) => `Build artifact ${r.path} was produced`,
  async run(requirement, reader) {
    const stat = await reader.fileStat(requirement.path);
    if (!stat) {
      return fail(
        `No artifact at '${requirement.path}'. Nothing in the workspace has produced it yet.`,
      );
    }
    if (stat.kind !== requirement.kind) {
      return fail(
        `'${requirement.path}' is a ${stat.kind}, but the artifact for this lab is a ${requirement.kind}`,
      );
    }
    if (stat.size < requirement.min_bytes) {
      return fail(
        stat.size === 0
          ? `'${requirement.path}' exists but is empty — the build produced no content`
          : `'${requirement.path}' holds ${stat.size} bytes; this lab expects at least ${requirement.min_bytes}`,
      );
    }
    return pass(`${stat.size} bytes`);
  },
};
