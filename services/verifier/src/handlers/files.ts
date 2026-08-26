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
import { fail, pass, type HandlerOutcome, type CicdVerifierHandler } from '../contract.js';
import type { CicdVerifyReader } from '../cicd-reader.js';

/** Shared wording for a path that is not there. */
function absent(path: string): HandlerOutcome {
  return fail(`No '${path}' found in your workspace`);
}

/*
 * `file_exists`, `file_contains` and `yaml_valid` are deliberately NOT here.
 *
 * All three are generic questions about a file in a sandbox, and all three now
 * live in the `filesystem` family where every provider can answer them — see
 * handlers/filesystem.ts. Keeping CI/CD copies would have meant two
 * definitions of "exists" and two of "contains", differing in whichever
 * details each track happened to need.
 *
 * `artifact_exists` stays, because it is not a path read: it is a claim about
 * what the *build* produced, and it is only meaningful after the build has
 * run.
 */

export const artifactExists: CicdVerifierHandler<'artifact_exists'> = {
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
