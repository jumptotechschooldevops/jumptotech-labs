/**
 * A structural reader for declarative Jenkins pipelines.
 *
 * ### What this does, precisely
 *
 * A `Jenkinsfile` is Groovy, and the platform does not embed a Groovy engine —
 * doing so would mean evaluating a student's code inside the API process, which
 * is exactly what this codebase refuses to do anywhere else. Instead this
 * module reads the file the way the declarative *syntax* is defined in the
 * Jenkins pipeline documentation: a `pipeline` block containing directives, a
 * `stages` block containing `stage('Name')` blocks, each containing `steps`.
 *
 * It is a brace-matching scanner that is aware of comments and string literals,
 * so a `{` inside `sh 'echo {'` does not open a block and a `}` inside a
 * comment does not close one. From that it produces a block tree and reads the
 * declarative directives out of it.
 *
 * ### What it proves, and what it does not
 *
 * Proves: the file is structurally well-formed (balanced, `pipeline` present,
 * an `agent`, a `stages` block); which stages exist and in what order; what
 * each stage's `steps` block contains as text; what `environment` declares.
 * That is enough to grade "write a multi-stage declarative pipeline correctly",
 * which is what CICD-006 to CICD-008 teach — and enough to catch a missing
 * brace or a `stage` written outside `stages`, which is what CICD-010 injects.
 *
 * Does NOT prove: that Jenkins would run it, that a step would succeed, or that
 * a Groovy expression evaluates. Labs never claim otherwise; the README lists
 * each Jenkins exercise as syntax-verified, locally-executed, or future work.
 */

export interface JenkinsStep {
  /** The step's text, one entry per non-empty line inside `steps { }`. */
  text: string;
}

export interface JenkinsStage {
  name: string;
  /** Position among sibling stages, 1-based. */
  order: number;
  /** Raw body of the stage's `steps { }` block, or null when there is none. */
  stepsBody: string | null;
  /** `environment { }` entries declared on the stage. */
  environment: JenkinsAssignment[];
  hasWhen: boolean;
  hasAgent: boolean;
}

/** One `KEY = expression` pair from an `environment { }` block. */
export interface JenkinsAssignment {
  key: string;
  /** The right-hand side as written, trimmed. */
  value: string;
  /** `pipeline.environment` or `stage('Build').environment`. */
  location: string;
}

export interface JenkinsPipeline {
  /** Text of the `agent` directive, e.g. `any` or `{ label 'linux' }`. */
  agent: string | null;
  stages: JenkinsStage[];
  environment: JenkinsAssignment[];
  /** Top-level directive names found inside `pipeline { }`. */
  directives: string[];
  hasPost: boolean;
}

export type JenkinsParseResult =
  | { ok: true; pipeline: JenkinsPipeline }
  | { ok: false; error: string };

/**
 * Read a Jenkinsfile.
 *
 * Returns a structured failure rather than throwing, for the same reason the
 * workflow parser does: a half-written pipeline is a normal thing for the
 * check to encounter and report.
 */
export function parseJenkinsfile(text: string): JenkinsParseResult {
  const stripped = stripCommentsAndStrings(text);
  if (!stripped.ok) return { ok: false, error: stripped.error };

  const balance = checkBraces(stripped.masked);
  if (!balance.ok) return { ok: false, error: balance.error };

  const pipelineBlock = findBlock(stripped.masked, text, /(^|[^\w.])pipeline\s*\{/);
  if (!pipelineBlock) {
    return {
      ok: false,
      error: "no `pipeline { … }` block was found — a declarative pipeline starts with `pipeline {`",
    };
  }

  const body = pipelineBlock.body;
  const maskedBody = stripped.masked.slice(pipelineBlock.bodyStart, pipelineBlock.bodyEnd);

  const agent = readDirectiveValue(maskedBody, body, 'agent');
  const environment = readEnvironmentBlock(maskedBody, body, 'pipeline.environment');
  const stagesBlock = findBlock(maskedBody, body, /(^|[^\w.])stages\s*\{/);

  if (!stagesBlock) {
    return {
      ok: false,
      error: "no `stages { … }` block was found inside `pipeline { … }`",
    };
  }

  const stages = readStages(
    maskedBody.slice(stagesBlock.bodyStart, stagesBlock.bodyEnd),
    stagesBlock.body,
  );

  return {
    ok: true,
    pipeline: {
      agent,
      stages,
      environment,
      directives: readDirectiveNames(maskedBody),
      hasPost: findBlock(maskedBody, body, /(^|[^\w.])post\s*\{/) !== null,
    },
  };
}

// --- lexing -----------------------------------------------------------------

/**
 * Blank out comments and string bodies, preserving offsets.
 *
 * Every character of a comment or a string literal is replaced with a space, so
 * the masked text is the same length as the original and any offset found in it
 * indexes the original correctly. Brace matching then runs on the mask, where a
 * brace can only be real syntax.
 */
function stripCommentsAndStrings(
  text: string,
): { ok: true; masked: string } | { ok: false; error: string } {
  const out = text.split('');
  let i = 0;
  const n = text.length;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < n) {
    const two = text.slice(i, i + 2);

    if (two === '//') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return { ok: false, error: 'an unterminated /* … */ comment' };
      blank(i, end + 2);
      i = end + 2;
      continue;
    }

    const three = text.slice(i, i + 3);
    if (three === "'''" || three === '"""') {
      const end = text.indexOf(three, i + 3);
      if (end === -1) return { ok: false, error: `an unterminated ${three} string literal` };
      blank(i, end + 3);
      i = end + 3;
      continue;
    }

    const ch = text[i];
    if (ch === "'" || ch === '"') {
      let k = i + 1;
      while (k < n) {
        if (text[k] === '\\') {
          k += 2;
          continue;
        }
        if (text[k] === ch) break;
        // A single-quoted Groovy string does not span lines; treating a newline
        // as the end keeps one stray quote from swallowing the whole file.
        if (text[k] === '\n') break;
        k += 1;
      }
      blank(i, Math.min(k + 1, n));
      i = Math.min(k + 1, n);
      continue;
    }

    i += 1;
  }

  return { ok: true, masked: out.join('') };
}

function checkBraces(masked: string): { ok: true } | { ok: false; error: string } {
  let depth = 0;
  let line = 1;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '\n') line += 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return { ok: false, error: `an unexpected closing brace on line ${line}` };
    }
  }
  if (depth > 0) {
    return {
      ok: false,
      error: `${depth} unclosed block${depth === 1 ? '' : 's'} — a '{' is never closed`,
    };
  }
  return { ok: true };
}

interface Block {
  /** Offsets into the *masked* text, which share indices with the original. */
  bodyStart: number;
  bodyEnd: number;
  /** Body text taken from the original (comments and strings intact). */
  body: string;
}

/**
 * Find the first block whose header matches, and return its body.
 *
 * `masked` drives the search and the brace walk; `original` supplies the text
 * that is handed back, so callers read real content rather than the mask.
 */
function findBlock(masked: string, original: string, header: RegExp): Block | null {
  const match = header.exec(masked);
  if (!match) return null;

  const open = masked.indexOf('{', match.index);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { bodyStart: open + 1, bodyEnd: i, body: original.slice(open + 1, i) };
      }
    }
  }
  return null;
}

/** Every `name {` or `name value` directive at the top level of a block. */
function readDirectiveNames(maskedBody: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  let lineStart = 0;

  for (let i = 0; i <= maskedBody.length; i += 1) {
    const ch = maskedBody[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;

    if (ch === '\n' || i === maskedBody.length) {
      if (depth <= 1) {
        const line = maskedBody.slice(lineStart, i).trim();
        const word = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
        if (word?.[1]) names.add(word[1]);
      }
      lineStart = i + 1;
    }
  }
  return [...names];
}

/**
 * Read a directive that takes a value rather than a block, such as `agent any`.
 *
 * Returns the text after the directive name up to the end of the line, or the
 * whole block when the directive is written as `agent { … }`.
 */
function readDirectiveValue(maskedBody: string, body: string, name: string): string | null {
  const pattern = new RegExp(`(^|[^\\w.])${name}\\b`, 'm');
  const match = pattern.exec(maskedBody);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = maskedBody.slice(start);
  const braceAt = rest.search(/\S/);
  if (braceAt !== -1 && rest[braceAt] === '{') {
    const block = findBlock(rest, body.slice(start), /\{/);
    return block ? `{${block.body.trim()}}` : null;
  }

  const newline = rest.indexOf('\n');
  const value = body.slice(start, newline === -1 ? undefined : start + newline).trim();
  return value.length > 0 ? value : null;
}

/** Read `environment { KEY = value }` into assignments. */
function readEnvironmentBlock(
  maskedBody: string,
  body: string,
  location: string,
): JenkinsAssignment[] {
  const block = findBlock(maskedBody, body, /(^|[^\w.])environment\s*\{/);
  if (!block) return [];

  const assignments: JenkinsAssignment[] = [];
  for (const line of block.body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;
    assignments.push({ key: match[1], value: match[2], location });
  }
  return assignments;
}

/** Read the `stage('Name') { … }` blocks inside a `stages { }` body, in order. */
function readStages(maskedStages: string, stagesBody: string): JenkinsStage[] {
  const stages: JenkinsStage[] = [];
  const header = /(^|[^\w.])stage\s*\(\s*(['"])(.*?)\2\s*\)\s*\{/g;

  // The stage *name* lives inside a string literal, which the mask blanked out,
  // so headers are located in the original text and only the brace walk that
  // follows uses the mask.
  let match: RegExpExecArray | null;
  while ((match = header.exec(stagesBody)) !== null) {
    const name = match[3] ?? '';
    const open = stagesBody.indexOf('{', match.index + match[0].length - 1);
    if (open === -1) continue;

    let depth = 0;
    let close = -1;
    for (let i = open; i < maskedStages.length; i += 1) {
      if (maskedStages[i] === '{') depth += 1;
      else if (maskedStages[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;

    const stageBody = stagesBody.slice(open + 1, close);
    const maskedStageBody = maskedStages.slice(open + 1, close);
    const stepsBlock = findBlock(maskedStageBody, stageBody, /(^|[^\w.])steps\s*\{/);

    stages.push({
      name,
      order: stages.length + 1,
      stepsBody: stepsBlock ? stepsBlock.body : null,
      environment: readEnvironmentBlock(
        maskedStageBody,
        stageBody,
        `stage('${name}').environment`,
      ),
      hasWhen: findBlock(maskedStageBody, stageBody, /(^|[^\w.])when\s*\{/) !== null,
      hasAgent: /(^|[^\w.])agent\b/.test(maskedStageBody),
    });

    // Continue scanning after this stage's closing brace so a nested
    // `stage(…)` inside a parallel block is not counted as a sibling.
    header.lastIndex = close;
  }

  return stages;
}

// --- queries handlers use ---------------------------------------------------

export function findStage(pipeline: JenkinsPipeline, name: string): JenkinsStage | null {
  return pipeline.stages.find((stage) => stage.name === name) ?? null;
}

/** Fragments not found in a stage's steps block. Whitespace- and case-insensitive. */
export function stepsMissing(stage: JenkinsStage, fragments: readonly string[]): string[] {
  const haystack = (stage.stepsBody ?? '').replace(/\s+/g, ' ').toLowerCase();
  return fragments.filter((f) => !haystack.includes(f.replace(/\s+/g, ' ').toLowerCase()));
}

/** Every `environment` assignment in the pipeline, at any level. */
export function allAssignments(pipeline: JenkinsPipeline): JenkinsAssignment[] {
  return [...pipeline.environment, ...pipeline.stages.flatMap((stage) => stage.environment)];
}
