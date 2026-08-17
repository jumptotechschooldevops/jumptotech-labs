/**
 * Handlers for GitHub Actions workflow structure.
 *
 * Each one reads the workflow file, normalises it through `ci/workflow.ts`, and
 * asks one question. The failure text names what was found — which jobs exist,
 * which triggers are declared — so a student can see the gap without being
 * handed the answer.
 */
import { fail, pass, type HandlerOutcome, type VerifierHandler } from '../contract.js';
import type { VerifyReader } from '../reader.js';
import {
  findJob,
  findTrigger,
  parseWorkflow,
  runContains,
  usesAction,
  type WorkflowModel,
} from '../ci/workflow.js';

/**
 * Read and parse a workflow, or produce the outcome that explains why not.
 *
 * Every handler here starts the same way, and each of the three failure modes —
 * absent, empty, unparseable — deserves its own message rather than a shared
 * "invalid workflow".
 */
async function loadWorkflow(
  reader: VerifyReader,
  path: string,
): Promise<{ workflow: WorkflowModel } | { outcome: HandlerOutcome }> {
  const text = await reader.fileText(path);
  if (text === null) {
    return {
      outcome: fail(
        `No workflow file at '${path}'. GitHub Actions reads workflows from .github/workflows in the repository root.`,
      ),
    };
  }
  if (text.trim().length === 0) {
    return { outcome: fail(`'${path}' exists but is empty`) };
  }

  const parsed = parseWorkflow(text);
  if (!parsed.ok) {
    return { outcome: fail(`'${path}' is not a valid workflow: ${parsed.error}`) };
  }
  return { workflow: parsed.workflow };
}

export const githubWorkflowExists: VerifierHandler<'github_workflow_exists'> = {
  type: 'github_workflow_exists',
  label: (r) => `Workflow ${r.path} is a valid GitHub Actions workflow`,
  async run(requirement, reader) {
    const loaded = await loadWorkflow(reader, requirement.path);
    if ('outcome' in loaded) return loaded.outcome;
    const { workflow } = loaded;

    // `on` and `jobs` are the two keys the workflow syntax requires; a file
    // missing either is YAML but not a workflow.
    if (workflow.triggers.length === 0) {
      return fail(`'${requirement.path}' declares no 'on:' trigger, so nothing would ever start it`);
    }
    if (workflow.jobs.length === 0) {
      return fail(`'${requirement.path}' declares no jobs under 'jobs:'`);
    }
    if (requirement.require_name && !workflow.name) {
      return fail(`'${requirement.path}' has no 'name:' — this lab asks for the workflow to be named`);
    }

    return pass(
      `${workflow.jobs.length} job${workflow.jobs.length === 1 ? '' : 's'}, triggered on ${workflow.triggers
        .map((t) => t.event)
        .join(', ')}`,
    );
  },
};

export const githubWorkflowTrigger: VerifierHandler<'github_workflow_trigger'> = {
  type: 'github_workflow_trigger',
  label: (r) => `Workflow runs on ${r.trigger}`,
  async run(requirement, reader) {
    const loaded = await loadWorkflow(reader, requirement.path);
    if ('outcome' in loaded) return loaded.outcome;
    const { workflow } = loaded;

    const trigger = findTrigger(workflow, requirement.trigger);
    if (!trigger) {
      const declared = workflow.triggers.map((t) => t.event);
      return fail(
        declared.length > 0
          ? `'${requirement.path}' is triggered on ${declared.join(', ')} — not on ${requirement.trigger}`
          : `'${requirement.path}' declares no triggers at all`,
      );
    }

    if (requirement.branches) {
      const missing = requirement.branches.filter((branch) => !trigger.branches.includes(branch));
      if (missing.length > 0) {
        return fail(
          trigger.branches.length > 0
            ? `the ${requirement.trigger} trigger filters on ${trigger.branches.join(', ')}; ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not included`
            : `the ${requirement.trigger} trigger has no branches filter, so it runs on every branch`,
        );
      }
    }

    return pass(
      trigger.branches.length > 0 ? `on ${trigger.event} (${trigger.branches.join(', ')})` : `on ${trigger.event}`,
    );
  },
};

export const githubWorkflowJobExists: VerifierHandler<'github_workflow_job_exists'> = {
  type: 'github_workflow_job_exists',
  label: (r) => `Workflow defines a '${r.job}' job`,
  async run(requirement, reader) {
    const loaded = await loadWorkflow(reader, requirement.path);
    if ('outcome' in loaded) return loaded.outcome;
    const { workflow } = loaded;

    const job = findJob(workflow, requirement.job);
    if (!job) {
      const ids = workflow.jobs.map((j) => j.id);
      return fail(
        ids.length > 0
          ? `'${requirement.path}' defines ${ids.map((id) => `'${id}'`).join(', ')} but no job called '${requirement.job}'`
          : `'${requirement.path}' defines no jobs`,
      );
    }

    if (requirement.runs_on !== undefined) {
      if (job.runsOn.length === 0) {
        return fail(`job '${job.id}' has no 'runs-on', so GitHub would not know where to run it`);
      }
      if (!job.runsOn.includes(requirement.runs_on)) {
        return fail(`job '${job.id}' runs on ${job.runsOn.join(', ')}, not ${requirement.runs_on}`);
      }
    }

    if (requirement.min_steps !== undefined && job.steps.length < requirement.min_steps) {
      return fail(
        `job '${job.id}' has ${job.steps.length} step${job.steps.length === 1 ? '' : 's'}; this lab expects at least ${requirement.min_steps}`,
      );
    }

    if (requirement.needs) {
      const missing = requirement.needs.filter((id) => !job.needs.includes(id));
      if (missing.length > 0) {
        return fail(
          job.needs.length > 0
            ? `job '${job.id}' needs ${job.needs.join(', ')} — it does not wait for ${missing.join(', ')}`
            : `job '${job.id}' declares no 'needs:', so it does not wait for ${missing.join(', ')}`,
        );
      }
    }

    return pass(
      `${job.steps.length} step${job.steps.length === 1 ? '' : 's'}${job.runsOn.length > 0 ? ` on ${job.runsOn.join(', ')}` : ''}`,
    );
  },
};

export const githubWorkflowStepExists: VerifierHandler<'github_workflow_step_exists'> = {
  type: 'github_workflow_step_exists',
  label: (r) =>
    r.uses
      ? `Job '${r.job}' has a step using ${r.uses}`
      : `Job '${r.job}' has a step running ${r.run_contains?.join(' ') ?? 'the required command'}`,
  async run(requirement, reader) {
    const loaded = await loadWorkflow(reader, requirement.path);
    if ('outcome' in loaded) return loaded.outcome;
    const { workflow } = loaded;

    const job = findJob(workflow, requirement.job);
    if (!job) {
      return fail(`'${requirement.path}' defines no job called '${requirement.job}'`);
    }
    if (job.steps.length === 0) {
      return fail(`job '${requirement.job}' has no steps`);
    }

    /*
     * A step satisfies the requirement when it satisfies every clause the lab
     * wrote — `uses` and `run_contains` are ANDed, not ORed, so a lab that asks
     * for "a step that runs the build AND passes --production" is not satisfied
     * by two separate steps each doing half.
     */
    const matches = job.steps.filter((step) => {
      if (requirement.uses !== undefined && !usesAction(step.uses, requirement.uses)) return false;
      if (requirement.run_contains !== undefined) {
        if (runContains(step.run, requirement.run_contains).length > 0) return false;
      }
      if (requirement.with_keys !== undefined) {
        if (!requirement.with_keys.every((key) => step.withKeys.includes(key))) return false;
      }
      return true;
    });

    if (matches.length > 0) {
      const step = matches[0];
      return pass(`step ${step?.index}${step?.name ? ` — ${step.name}` : ''}`);
    }

    // Explain against what the job *does* contain, so the student can compare.
    if (requirement.uses !== undefined) {
      const used = job.steps.map((s) => s.uses).filter((u): u is string => Boolean(u));
      return fail(
        used.length > 0
          ? `job '${requirement.job}' uses ${used.join(', ')} — none of them is ${requirement.uses}`
          : `no step in job '${requirement.job}' uses an action; this lab expects ${requirement.uses}`,
      );
    }

    const fragments = requirement.run_contains ?? [];
    const runningSteps = job.steps.filter((s) => s.run !== undefined);
    return fail(
      runningSteps.length > 0
        ? `no 'run:' step in job '${requirement.job}' includes ${fragments.map((f) => `'${f}'`).join(' and ')}`
        : `job '${requirement.job}' has no 'run:' step at all`,
    );
  },
};
