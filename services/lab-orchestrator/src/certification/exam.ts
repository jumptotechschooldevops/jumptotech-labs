/**
 * Practice assessments.
 *
 * A blueprint says how many questions to draw from each official domain; an
 * attempt is one sampling of the bank against that blueprint; a result is that
 * attempt graded, with a per-domain breakdown so a student is told *what* to go
 * back to rather than only that they scored 71%.
 *
 * ## Attempts are derived, not stored
 *
 * An attempt id *is* its seed. Building an attempt is a pure function of
 * (blueprint, pool, seed), so grading re-derives exactly the same paper from the
 * id the student was given rather than looking it up. Three consequences, all of
 * them the reason it is written this way:
 *
 *   - there is no attempt store to expire, leak, or grow without bound;
 *   - a client cannot smuggle extra questions into grading, because the paper is
 *     rebuilt from the seed and the submission is matched against it;
 *   - the same id always reproduces the same paper, which is what lets a test
 *     assert on one and a student reload the page without losing their paper.
 *
 * The answer key never travels with the attempt. `ExamAttempt` carries prompts
 * only; `correctKeys` and `explanation` appear for the first time in the graded
 * result, once the student has committed to an answer.
 *
 * ## What the score is not
 *
 * `target_score_percent` is JumpToTech's study threshold. HashiCorp does not
 * publish a cut score, so the platform does not imply one, and nothing here
 * claims that passing a practice assessment predicts passing the real exam.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { OBJECTIVE_ID_PATTERN, type CertificationCatalog } from './catalog.js';
import {
  gradeAnswer,
  toPrompt,
  type CertificationQuestion,
  type GradedAnswer,
  type QuestionPrompt,
  type SubmittedAnswer,
} from './questions.js';

/** `TF-EXAM-004`. */
export const EXAM_ID_PATTERN = /^[A-Z][A-Z0-9]{1,7}-EXAM-[A-Z0-9]{1,8}$/;

const blueprintEntrySchema = z
  .object({
    domain: z.string().regex(OBJECTIVE_ID_PATTERN, 'domain must be a domain id such as 4'),
    questions: z.number().int().min(1).max(60),
  })
  .strict();

const examSchema = z
  .object({
    id: z.string().regex(EXAM_ID_PATTERN, 'exam id must look like TF-EXAM-004'),
    certification: z.string().min(1).max(32),
    track: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'track must be kebab-case'),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
    duration_minutes: z.number().int().positive().max(360),
    /** How many questions one attempt draws. Must equal the blueprint's sum. */
    questions_per_attempt: z.number().int().min(5).max(200),
    /**
     * JumpToTech's own study threshold, in percent.
     *
     * Explicitly ours: the vendor does not publish a cut score, and inventing
     * one would be the single most misleading number this platform could show.
     */
    target_score_percent: z.number().int().min(1).max(100),
    /** How many questions to draw from each official domain. */
    blueprint: z.array(blueprintEntrySchema).min(1).max(20),
  })
  .strict();

export type ExamBlueprintEntry = z.infer<typeof blueprintEntrySchema>;
export type ExamData = z.infer<typeof examSchema>;

export interface ExamDefinition extends ExamData {
  readonly sourcePath: string;
}

export class ExamDefinitionError extends Error {
  readonly code = 'EXAM_DEFINITION_INVALID';
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ExamDefinitionError';
  }

  format(): string {
    const body = this.issues.length > 0 ? this.issues.join('\n') : this.message;
    return `${this.code}\n\n${this.path}:\n${body}`;
  }
}

export function parseExamDefinition(yamlText: string, sourcePath = '<inline>'): ExamDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new ExamDefinitionError(
      `Invalid YAML in exam definition: ${(cause as Error).message}`,
      sourcePath,
    );
  }

  const result = examSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const location = issue.path
        .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
        .join('')
        .replace(/^\./, '');
      return `${location || '<root>'}: ${issue.message}`;
    });
    throw new ExamDefinitionError(
      `Exam definition failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }

  const issues: string[] = [];
  const seen = new Set<string>();
  for (const entry of result.data.blueprint) {
    if (seen.has(entry.domain)) issues.push(`blueprint names domain '${entry.domain}' twice`);
    seen.add(entry.domain);
  }

  const planned = result.data.blueprint.reduce((sum, entry) => sum + entry.questions, 0);
  if (planned !== result.data.questions_per_attempt) {
    issues.push(
      `blueprint draws ${planned} questions but questions_per_attempt is ${result.data.questions_per_attempt}`,
    );
  }

  if (issues.length > 0) {
    throw new ExamDefinitionError(
      `Exam definition failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }

  return { ...result.data, sourcePath };
}

export async function loadExamDefinition(filePath: string): Promise<ExamDefinition> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new ExamDefinitionError(`Cannot read exam definition: ${(cause as Error).message}`, filePath);
  }
  return parseExamDefinition(text, filePath);
}

// -------------------------------------------------------------- attempt ids

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Deliberately not `Math.random()`: an attempt has to be reproducible from its
 * id, and it must never depend on process state. Deliberately not a crypto RNG
 * either — this shuffles a question paper, it does not protect anything.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the attempt id, so the same id always seeds the same paper. */
function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const ATTEMPT_ID_PATTERN = /^[a-z0-9]{8,32}$/;

/** A fresh attempt id. Random here because a *new* paper should differ. */
export function newAttemptId(random: () => number = Math.random): string {
  let id = '';
  while (id.length < 16) {
    id += Math.floor(random() * 0xffffffff)
      .toString(36)
      .padStart(6, '0');
  }
  return id.slice(0, 16);
}

/** Fisher–Yates, driven by the supplied PRNG so it stays reproducible. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ----------------------------------------------------------------- attempts

export interface ExamAttempt {
  attemptId: string;
  examId: string;
  certification: string;
  title: string;
  durationMinutes: number;
  targetScorePercent: number;
  /** Question prompts only — never the answer key. */
  questions: QuestionPrompt[];
  /** Blueprint coverage actually achieved, so a short pool is visible, not hidden. */
  domains: Array<{ id: string; title: string; planned: number; drawn: number }>;
}

export interface ExamPool {
  /** Every question available for this exam, already filtered to its certification. */
  questions: readonly CertificationQuestion[];
  catalog: CertificationCatalog;
}

/**
 * Build one attempt.
 *
 * Sampling is per domain rather than over the whole bank, because a random draw
 * across a bank whose domains have different sizes would systematically
 * over-represent the biggest ones — and a practice assessment that under-tests a
 * domain is exactly the kind of quiet inaccuracy this platform must not ship.
 *
 * A domain whose pool is smaller than its blueprint quota contributes every
 * question it has and reports the shortfall in `domains[].drawn`. It is never
 * silently topped up from elsewhere.
 */
export function buildExamAttempt(
  exam: ExamDefinition,
  pool: ExamPool,
  attemptId: string,
): ExamAttempt {
  const random = mulberry32(seedFrom(attemptId));

  const byDomain = new Map<string, CertificationQuestion[]>();
  for (const question of pool.questions) {
    const domain = pool.catalog.domainOf(question.objective);
    if (!domain) continue;
    const bucket = byDomain.get(domain.id);
    if (bucket) bucket.push(question);
    else byDomain.set(domain.id, [question]);
  }

  const drawn: CertificationQuestion[] = [];
  const domains: ExamAttempt['domains'] = [];

  for (const entry of exam.blueprint) {
    const available = byDomain.get(entry.domain) ?? [];
    // Sort before shuffling so the draw depends on the seed alone and not on
    // the order files happened to be read from disk.
    const ordered = [...available].sort((a, b) => a.id.localeCompare(b.id));
    const picked = shuffle(ordered, random).slice(0, entry.questions);
    drawn.push(...picked);
    domains.push({
      id: entry.domain,
      title: pool.catalog.domain(entry.domain)?.title ?? entry.domain,
      planned: entry.questions,
      drawn: picked.length,
    });
  }

  const paper = shuffle(drawn, random);

  return {
    attemptId,
    examId: exam.id,
    certification: exam.certification,
    title: exam.title,
    durationMinutes: exam.duration_minutes,
    targetScorePercent: exam.target_score_percent,
    questions: paper.map((question) => ({
      ...toPrompt(question),
      choices: shuffle(question.choices, random).map((choice) => ({ ...choice })),
    })),
    domains,
  };
}

export interface DomainScore {
  id: string;
  title: string;
  total: number;
  correct: number;
  /** Rounded to a whole percent. 0 when the domain drew no questions. */
  percent: number;
}

export interface ExamResult {
  attemptId: string;
  examId: string;
  certification: string;
  total: number;
  correct: number;
  incorrect: number;
  /** Questions on the paper the student left blank. Counted as incorrect. */
  unanswered: number;
  scorePercent: number;
  targetScorePercent: number;
  /** Whether the *practice* target was met. Never a claim about the real exam. */
  metTarget: boolean;
  domains: DomainScore[];
  /** Domains below the target, worst first. What to study next. */
  recommendedReview: string[];
  answers: GradedAnswer[];
  /** Stated on every result so the number is never read as a prediction. */
  disclaimer: string;
}

export const PRACTICE_DISCLAIMER =
  'This is JumpToTech practice material. A score here does not predict or guarantee the result of the official HashiCorp exam.';

/**
 * Grade an attempt.
 *
 * The paper is rebuilt from `attemptId`, so the questions graded are the ones
 * the student was actually given. Answers naming a question that is not on the
 * paper are ignored rather than rejected: a stale tab must not be able to make
 * grading fail, and an ignored answer can only ever lower a score.
 */
export function gradeExamAttempt(
  exam: ExamDefinition,
  pool: ExamPool,
  attemptId: string,
  submitted: readonly SubmittedAnswer[],
): ExamResult {
  const attempt = buildExamAttempt(exam, pool, attemptId);
  const byId = new Map(pool.questions.map((question) => [question.id, question]));
  const answers = new Map(submitted.map((answer) => [answer.questionId, answer.selected]));

  const graded: GradedAnswer[] = [];
  const perDomain = new Map<string, { total: number; correct: number }>();
  let correctCount = 0;
  let unanswered = 0;

  for (const prompt of attempt.questions) {
    const question = byId.get(prompt.id);
    if (!question) continue;
    const selected = answers.get(prompt.id) ?? [];
    if (selected.length === 0) unanswered += 1;

    const outcome = gradeAnswer(question, selected);
    if (outcome.correct) correctCount += 1;

    const domain = pool.catalog.domainOf(question.objective);
    const bucket = perDomain.get(domain?.id ?? '') ?? { total: 0, correct: 0 };
    bucket.total += 1;
    if (outcome.correct) bucket.correct += 1;
    perDomain.set(domain?.id ?? '', bucket);

    graded.push({
      questionId: question.id,
      objective: question.objective,
      ...(domain ? { domain: domain.id } : {}),
      correct: outcome.correct,
      selected: outcome.selected,
      correctKeys: [...question.correctKeys],
      explanation: question.explanation,
      officialReference: question.officialReference,
    });
  }

  const total = graded.length;
  const scorePercent = total === 0 ? 0 : Math.round((correctCount / total) * 100);

  const domains: DomainScore[] = exam.blueprint.map((entry) => {
    const bucket = perDomain.get(entry.domain) ?? { total: 0, correct: 0 };
    return {
      id: entry.domain,
      title: pool.catalog.domain(entry.domain)?.title ?? entry.domain,
      total: bucket.total,
      correct: bucket.correct,
      percent: bucket.total === 0 ? 0 : Math.round((bucket.correct / bucket.total) * 100),
    };
  });

  const recommendedReview = domains
    .filter((domain) => domain.total > 0 && domain.percent < exam.target_score_percent)
    .sort((a, b) => a.percent - b.percent)
    .map((domain) => domain.title);

  return {
    attemptId,
    examId: exam.id,
    certification: exam.certification,
    total,
    correct: correctCount,
    incorrect: total - correctCount,
    unanswered,
    scorePercent,
    targetScorePercent: exam.target_score_percent,
    metTarget: scorePercent >= exam.target_score_percent,
    domains,
    recommendedReview,
    answers: graded,
    disclaimer: PRACTICE_DISCLAIMER,
  };
}
