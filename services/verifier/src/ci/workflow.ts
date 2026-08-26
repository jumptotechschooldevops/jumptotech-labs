/**
 * A structural reader for GitHub Actions workflow files.
 *
 * Shaped from the official workflow-syntax reference: a workflow is a YAML
 * mapping with `on` and `jobs`; each job has `runs-on` and either `steps` or a
 * reusable-workflow `uses`; each step has `uses` or `run`.
 *
 * What this is: a normaliser. It turns a parsed YAML document into a small,
 * total model that handler code can ask plain questions of — "is there a job
 * called build?", "does it check the code out?" — without every handler
 * re-deriving that `on:` may be a string, a sequence, or a mapping.
 *
 * What this is *not*: a GitHub Actions runner, and it does not claim to be. It
 * proves a workflow is well-formed and says what it declares. It cannot prove
 * GitHub would schedule it, because that depends on a repository, a ref, and a
 * runner pool the platform does not have. Labs that need behaviour verified run
 * the underlying build locally instead — see `handlers/build.ts`.
 */
import { parseDocument, type Document } from 'yaml';

export interface WorkflowStep {
  /** Position within the job's `steps` list, 1-based, for messages. */
  index: number;
  name?: string;
  /** `uses:` verbatim, e.g. `actions/checkout@v4`. */
  uses?: string;
  /** `run:` verbatim, including newlines for a block scalar. */
  run?: string;
  /** Keys of the step's `with:` mapping. */
  withKeys: string[];
  /** `env:` entries declared on the step. */
  env: WorkflowAssignment[];
}

export interface WorkflowJob {
  /** The job's key under `jobs:`. */
  id: string;
  name?: string;
  /** `runs-on`, normalised to a list (a single label becomes a one-item list). */
  runsOn: string[];
  needs: string[];
  steps: WorkflowStep[];
  /** A reusable-workflow call has `uses:` at job level and no steps. */
  uses?: string;
  env: WorkflowAssignment[];
}

/** One `KEY: value` pair, wherever it was declared. */
export interface WorkflowAssignment {
  key: string;
  /** The scalar as written. Non-scalar values are reported as `null`. */
  value: string | null;
  /** Human-readable origin, e.g. `jobs.build.env`. */
  location: string;
}

export interface WorkflowTrigger {
  event: string;
  /** `branches:` filter, when the event declares one. */
  branches: string[];
  /** True when the event was given a filter mapping rather than a bare name. */
  filtered: boolean;
}

export interface WorkflowModel {
  name?: string;
  triggers: WorkflowTrigger[];
  jobs: WorkflowJob[];
  /** Workflow-level `env:`. */
  env: WorkflowAssignment[];
  /** Every `KEY: value` the workflow declares, at any level. */
  assignments: WorkflowAssignment[];
}

export type WorkflowParseResult =
  | { ok: true; workflow: WorkflowModel }
  | { ok: false; error: string };

/**
 * Parse workflow YAML into the model.
 *
 * YAML errors are returned, never thrown: a student mid-edit having invalid
 * YAML is an ordinary state of the world and the check that reports it must
 * quote the parser's own message, which is far more useful than "invalid".
 */
export function parseWorkflow(text: string): WorkflowParseResult {
  let document: Document.Parsed;
  try {
    document = parseDocument(text);
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  }
  if (document.errors.length > 0) {
    const first = document.errors[0];
    const line = first?.linePos?.[0]?.line;
    return {
      ok: false,
      error: `${first?.message ?? 'could not be parsed'}${line ? ` (line ${line})` : ''}`,
    };
  }

  const root = document.toJS() as unknown;
  if (root === null || root === undefined) return { ok: false, error: 'the file is empty' };
  if (typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, error: 'the top level of a workflow must be a mapping of keys' };
  }

  const map = root as Record<string, unknown>;
  const assignments: WorkflowAssignment[] = [];

  const env = readAssignments(map.env, 'env', assignments);
  const triggers = readTriggers(map);
  const jobs = readJobs(map.jobs, assignments);

  return {
    ok: true,
    workflow: {
      ...(typeof map.name === 'string' ? { name: map.name } : {}),
      triggers,
      jobs,
      env,
      assignments,
    },
  };
}

/**
 * Read the `on:` key.
 *
 * The `yaml` package parses with the YAML 1.2 core schema, where `on` is a
 * plain string key — the notorious YAML 1.1 "Norway problem" does not apply.
 * The `true` fallback is kept anyway so a workflow written for a 1.1 parser is
 * still understood rather than reported as having no triggers.
 */
function readTriggers(map: Record<string, unknown>): WorkflowTrigger[] {
  const raw = map.on ?? map.true;
  if (raw === undefined || raw === null) return [];

  if (typeof raw === 'string') {
    return [{ event: raw, branches: [], filtered: false }];
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is string => typeof entry === 'string')
      .map((event) => ({ event, branches: [], filtered: false }));
  }
  if (typeof raw !== 'object') return [];

  return Object.entries(raw as Record<string, unknown>).map(([event, config]) => {
    if (config === null || config === undefined) {
      return { event, branches: [], filtered: false };
    }
    if (typeof config !== 'object' || Array.isArray(config)) {
      return { event, branches: [], filtered: true };
    }
    const branches = toStringList((config as Record<string, unknown>).branches);
    return { event, branches, filtered: true };
  });
}

function readJobs(raw: unknown, assignments: WorkflowAssignment[]): WorkflowJob[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];

  return Object.entries(raw as Record<string, unknown>).map(([id, value]) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { id, runsOn: [], needs: [], steps: [], env: [] };
    }
    const job = value as Record<string, unknown>;
    const env = readAssignments(job.env, `jobs.${id}.env`, assignments);

    return {
      id,
      ...(typeof job.name === 'string' ? { name: job.name } : {}),
      runsOn: toStringList(job['runs-on']),
      needs: toStringList(job.needs),
      steps: readSteps(job.steps, id, assignments),
      ...(typeof job.uses === 'string' ? { uses: job.uses } : {}),
      env,
    };
  });
}

function readSteps(raw: unknown, jobId: string, assignments: WorkflowAssignment[]): WorkflowStep[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((entry, i): WorkflowStep => {
    const index = i + 1;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { index, withKeys: [], env: [] };
    }
    const step = entry as Record<string, unknown>;
    const withMap =
      step.with !== null && typeof step.with === 'object' && !Array.isArray(step.with)
        ? (step.with as Record<string, unknown>)
        : {};

    // `with:` inputs are recorded as assignments too: a token passed to an
    // action inline is exactly as hardcoded as one written into `env:`.
    for (const [key, value] of Object.entries(withMap)) {
      assignments.push({
        key,
        value: typeof value === 'string' ? value : null,
        location: `jobs.${jobId}.steps[${index}].with`,
      });
    }

    return {
      index,
      ...(typeof step.name === 'string' ? { name: step.name } : {}),
      ...(typeof step.uses === 'string' ? { uses: step.uses } : {}),
      ...(typeof step.run === 'string' ? { run: step.run } : {}),
      withKeys: Object.keys(withMap),
      env: readAssignments(step.env, `jobs.${jobId}.steps[${index}].env`, assignments),
    };
  });
}

function readAssignments(
  raw: unknown,
  location: string,
  sink: WorkflowAssignment[],
): WorkflowAssignment[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const entries = Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null,
    location,
  }));
  sink.push(...entries);
  return entries;
}

function toStringList(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  return [];
}

// --- queries handlers use ---------------------------------------------------

export function findJob(workflow: WorkflowModel, id: string): WorkflowJob | null {
  return workflow.jobs.find((job) => job.id === id) ?? null;
}

export function findTrigger(workflow: WorkflowModel, event: string): WorkflowTrigger | null {
  return workflow.triggers.find((trigger) => trigger.event === event) ?? null;
}

/**
 * Does a `uses:` reference name this action?
 *
 * The version is compared only when the lab asks for one. A lab that says
 * `actions/checkout` accepts `@v4`, `@v5`, or a commit SHA — pinning a major
 * version is a real practice, and a lab about checking code out should not
 * fail a student for using a newer one. A lab that writes `actions/cache@v4`
 * does require that exact ref.
 */
export function usesAction(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const wanted = expected.trim();
  const found = actual.trim();
  if (wanted.includes('@')) return found === wanted;
  const withoutVersion = found.split('@')[0] ?? found;
  return withoutVersion === wanted;
}

/** Does a `run:` block contain every fragment, ignoring case and whitespace runs? */
export function runContains(run: string | undefined, fragments: readonly string[]): string[] {
  if (!run) return [...fragments];
  const haystack = run.replace(/\s+/g, ' ').toLowerCase();
  return fragments.filter((fragment) => !haystack.includes(fragment.replace(/\s+/g, ' ').toLowerCase()));
}
