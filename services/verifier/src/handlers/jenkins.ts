/**
 * Handlers for declarative Jenkins pipeline structure.
 *
 * These grade the *shape* of a Jenkinsfile — the thing CICD-006 to CICD-008
 * actually teach — using the structural reader in `ci/jenkinsfile.ts`. They do
 * not run Jenkins, and the failure messages are careful not to imply that they
 * did: a passing check says the pipeline is well-formed and declares what the
 * lab asked for, which is exactly what it verified.
 */
import { fail, pass, type HandlerOutcome, type VerifierHandler } from '../contract.js';
import type { VerifyReader } from '../reader.js';
import {
  findStage,
  parseJenkinsfile,
  stepsMissing,
  type JenkinsPipeline,
} from '../ci/jenkinsfile.js';

async function loadPipeline(
  reader: VerifyReader,
  path: string,
): Promise<{ pipeline: JenkinsPipeline } | { outcome: HandlerOutcome }> {
  const text = await reader.fileText(path);
  if (text === null) {
    return { outcome: fail(`No '${path}' found in your workspace`) };
  }
  if (text.trim().length === 0) {
    return { outcome: fail(`'${path}' exists but is empty`) };
  }

  const parsed = parseJenkinsfile(text);
  if (!parsed.ok) {
    return { outcome: fail(`'${path}' is not a well-formed declarative pipeline: ${parsed.error}`) };
  }
  return { pipeline: parsed.pipeline };
}

export const jenkinsfileExists: VerifierHandler<'jenkinsfile_exists'> = {
  type: 'jenkinsfile_exists',
  label: (r) => `${r.path} declares a valid pipeline`,
  async run(requirement, reader) {
    const loaded = await loadPipeline(reader, requirement.path);
    if ('outcome' in loaded) return loaded.outcome;
    const { pipeline } = loaded;

    if (requirement.require_agent && pipeline.agent === null) {
      return fail(
        "the pipeline has no 'agent' directive — a declarative pipeline must say where it runs",
      );
    }
    if (pipeline.stages.length === 0) {
      return fail("the 'stages' block contains no 'stage' blocks");
    }

    return pass(
      `agent ${pipeline.agent ?? 'unset'} · ${pipeline.stages.length} stage${pipeline.stages.length === 1 ? '' : 's'}`,
    );
  },
};

export const jenkinsStageExists: VerifierHandler<'jenkins_stage_exists'> = {
  type: 'jenkins_stage_exists',
  label: (r) => `Pipeline has a '${r.stage}' stage`,
  async run(requirement, reader) {
    const loaded = await loadPipeline(reader, requirement.path);
    if ('outcome' in loaded) return loaded.outcome;
    const { pipeline } = loaded;

    const stage = findStage(pipeline, requirement.stage);
    if (!stage) {
      const names = pipeline.stages.map((s) => `'${s.name}'`);
      return fail(
        names.length > 0
          ? `the pipeline declares ${names.join(', ')} but no stage called '${requirement.stage}'`
          : "the pipeline declares no stages at all",
      );
    }

    // A stage with no steps is syntactically legal and does nothing, which is
    // a real mistake worth naming rather than passing over.
    if (stage.stepsBody === null) {
      return fail(`stage '${stage.name}' has no 'steps' block, so it would do nothing`);
    }
    if (stage.stepsBody.trim().length === 0) {
      return fail(`stage '${stage.name}' has an empty 'steps' block`);
    }

    if (requirement.steps_contain) {
      const missing = stepsMissing(stage, requirement.steps_contain);
      if (missing.length > 0) {
        return fail(
          `stage '${stage.name}' does not run ${missing.map((m) => `'${m}'`).join(' or ')}`,
        );
      }
    }

    if (requirement.after) {
      /*
       * Stage order is the point of CICD-007: a pipeline that packages before
       * it builds is not a pipeline. Order is compared by position in the
       * `stages` block, which is the order Jenkins runs them in.
       */
      for (const earlier of requirement.after) {
        const before = findStage(pipeline, earlier);
        if (!before) {
          return fail(`stage '${earlier}' is missing, so '${stage.name}' cannot come after it`);
        }
        if (before.order >= stage.order) {
          return fail(
            `stage '${stage.name}' is declared before '${earlier}'; the pipeline runs stages in the order they appear`,
          );
        }
      }
    }

    return pass(`stage ${stage.order} of ${pipeline.stages.length}`);
  },
};
