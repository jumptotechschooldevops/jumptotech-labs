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
  /** Keys of the step's `with:` mapping that carry a value (not null or ''). */
  withKeys: string[];
  /**
   * The step's `with:` values that are scalars, as their YAML text. A mapping
   * or list value is absent here rather than stringified.
   */
  withValues: Record<string, string>;
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
      return { index, withKeys: [], withValues: {}, env: [] };
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
      // An input with no value is not set: the action sees nothing.
      withKeys: Object.entries(withMap)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key]) => key),
      withValues: scalarValues(withMap),
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

function scalarValues(map: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
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

/** Shell comments removed: `#` at the start of a line or after whitespace. */
export function withoutShellComments(text: string): string {
  return text.split('\n').map(withoutShellComment).join('\n');
}

/**
 * One line with its shell comment cut: everything from the first `#` that
 * starts the line or follows whitespace, to the end of the line.
 *
 * A scan, not `/(^|\s)#.*$/`. The regex's `.` stops at `\r`, U+2028 and
 * U+2029, which the shell does not treat as line ends — so
 * `# node build.mjs\rtrue` stayed "code" and passed a check for a build step
 * that never runs. And it is quadratic on a line of ` #` repeated: 40 KB held
 * the api for seconds.
 */
export function withoutShellComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

/**
 * Does code expand this variable, rather than merely spell its name?
 *
 * `$NAME`, `${NAME}` (and `${NAME:-default}`, `${NAME%…}`), and
 * `env.NAME` — which covers `${{ env.NAME }}` in a workflow and `env.NAME` /
 * `${env.NAME}` in a Jenkinsfile. The caller removes comments first. The
 * name is a validated identifier, so it is safe inside the pattern.
 */
export function expandsVariable(code: string, name: string): boolean {
  return new RegExp(`\\$(\\{\\s*)?${name}(?![A-Za-z0-9_])|(^|[^A-Za-z0-9_.])env\\.${name}(?![A-Za-z0-9_])`).test(code);
}

/**
 * `expandsVariable` for a shell script, as the shell reads it.
 *
 * `$NAME` inside single quotes, or written `\$NAME`, is the literal text
 * `$NAME`: `docker build -t 'image:$IMAGE_TAG' .` tags the image
 * `image:$IMAGE_TAG`, and used to pass "the image tag comes from IMAGE_TAG".
 * `${{ env.NAME }}` is substituted by the runner before the shell sees the
 * script, so quotes do not matter to it and it is read from the whole text.
 * Not for a Jenkinsfile: there `sh '… $NAME'` is the Groovy string that hands
 * `$NAME` to the shell to expand.
 */
export function shellExpandsVariable(script: string, name: string): boolean {
  if (new RegExp(`(^|[^A-Za-z0-9_.])env\\.${name}(?![A-Za-z0-9_])`).test(script)) return true;
  return expandsVariable(withoutShellLiterals(script), name);
}

/**
 * The script with every single-quoted span and every backslash-escaped
 * character blanked, offsets kept. One pass; double quotes still expand.
 */
function withoutShellLiterals(script: string): string {
  const out = script.split('');
  let quote: '' | "'" | '"' = '';
  for (let i = 0; i < out.length; i += 1) {
    const ch = script[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
      else if (ch !== '\n') out[i] = ' ';
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < out.length && script[i + 1] !== '\n') out[i + 1] = ' ';
      i += 1;
      continue;
    }
    if (ch === '"') quote = quote === '"' ? '' : '"';
    else if (ch === "'" && quote === '') quote = "'";
  }
  return out.join('');
}

/**
 * Does a `run:` block contain every fragment, ignoring case and whitespace
 * runs? Returns the fragments it lacks.
 *
 * Shell comments are not commands. YAML strips ` # …` from a plain scalar, but
 * in a `run: |` block the comment is part of the string, so `# node build.mjs`
 * would otherwise count as running the build. The rule is the one the pipeline
 * reference checks use: `#` at the start of a line or after whitespace.
 */
export function runContains(
  run: string | undefined,
  fragments: readonly string[],
  asCommand = false,
): string[] {
  if (!run) return [...fragments];
  const code = withoutShellComments(run);
  if (asCommand) return commandsMissing(code, fragments);
  const haystack = code.replace(/\s+/g, ' ').toLowerCase();
  return fragments.filter((fragment) => !haystack.includes(fragment.replace(/\s+/g, ' ').toLowerCase()));
}

/** Words that run the command after them rather than being the command. */
const COMMAND_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|exec|time|env|then|do|else|!)\s+/;

/**
 * Which fragments do not *start* a command in this (comment-free) code?
 *
 * A substring test passed `echo node build.mjs` and `sh 'echo TODO node
 * --test'` as running the build and the tests. Here the code is cut at the
 * places a new command can begin — newlines, `;`, `&&`, `||`, `|`, `(`, `)`,
 * `$(`, a backquote, and a quote, which is where a Jenkins `sh '…'` script
 * starts — and a fragment counts only at the start of a piece, after any
 * `VAR=value` assignments and `sudo`/`exec`/`time`/`env`. So
 * `npm ci && node build.mjs`, `NODE_ENV=test node --test` and
 * `sh "node --test"` run the command; `echo node --test` does not.
 *
 * Linear: one split and one prefix strip per piece, over at most the capped
 * file the reader returns.
 */
export function commandsMissing(code: string, fragments: readonly string[]): string[] {
  const pieces = code
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n|;|&&|\|\||\||\$\(|[()`'"]/)
    .map((piece) => {
      let text = piece.trim();
      for (let i = 0; i < 8; i += 1) {
        const stripped = text.replace(COMMAND_PREFIX, '');
        if (stripped === text) break;
        text = stripped;
      }
      return text.replace(/\s+/g, ' ').toLowerCase();
    });
  return fragments.filter((fragment) => {
    const wanted = fragment.replace(/\s+/g, ' ').trim().toLowerCase();
    return !pieces.some((piece) => piece === wanted || piece.startsWith(`${wanted} `));
  });
}
