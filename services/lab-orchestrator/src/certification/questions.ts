/**
 * Certification questions — schema, bank, and grading.
 *
 * ## What a question is for
 *
 * Knowledge that has no artefact to inspect. "Which command writes the
 * dependency lock file" is a lab; "why does a team put state in a remote
 * backend" is a question. The platform keeps the two apart deliberately: a
 * question can never mark a hands-on requirement satisfied, and a passing lab
 * never answers a question. `coverage.ts` reports them as separate columns for
 * exactly that reason.
 *
 * ## Originality
 *
 * Every question in the bank is original JumpToTech material written from the
 * vendor's own documentation, and each carries the documentation link that
 * supports it. The schema requires `official_reference` and rejects the
 * commercial training hosts listed in `lab-definition.ts` — a question sourced
 * from an exam dump could not carry a first-party citation, so requiring one is
 * a structural check rather than a promise.
 *
 * ## Why choices become keys
 *
 * The YAML lists choices as plain text, which is what makes a bank readable and
 * reviewable. At load time each choice gains a stable key (`a`, `b`, `c`, …)
 * derived from its position, and `correct_answer` is resolved from text to
 * keys. Everything downstream — the API payload, the student's submission, the
 * grader — speaks keys. Three things fall out of that:
 *
 *   1. the answer key never has to travel to a browser to be compared;
 *   2. a student's submission is a handful of one-character tokens rather than
 *      free text, so grading has no whitespace or unicode edge cases;
 *   3. a question's choices can be presented in a shuffled order without the
 *      grader caring, because a key identifies the choice, not its position.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { DISALLOWED_DOC_HOSTS } from '../lab-definition.js';
import { OBJECTIVE_ID_PATTERN } from './catalog.js';

/** `TFQ-001`. The prefix is the bank's, the number is unique within it. */
export const QUESTION_ID_PATTERN = /^[A-Z][A-Z0-9]{1,11}-\d{3,4}$/;

export const QUESTION_TYPES = ['single', 'multiple', 'true_false'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Choice keys, by position. Capped at the schema's own choice limit. */
const CHOICE_KEYS = 'abcdefgh'.split('');

const MAX_CHOICES = CHOICE_KEYS.length;

const questionSchema = z
  .object({
    id: z.string().regex(QUESTION_ID_PATTERN, 'question id must look like TFQ-001'),
    /** Exactly one official objective. Domain scoring depends on it being one. */
    objective: z.string().regex(OBJECTIVE_ID_PATTERN, 'objective must be an objective id such as 4h'),
    type: z.enum(QUESTION_TYPES),
    question: z.string().min(10).max(1200),
    /**
     * Answer options as written.
     *
     * Optional only for `true_false`, which fills in True/False — spelling them
     * out in every true/false entry would be noise, and letting an author
     * respell them would let two questions disagree about the wording of the
     * same two choices.
     */
    choices: z.array(z.string().min(1).max(400)).min(2).max(MAX_CHOICES).optional(),
    /** The correct option(s), matching `choices` text exactly. */
    correct_answer: z.array(z.string().min(1).max(400)).min(1).max(MAX_CHOICES),
    /** Why the answer is right. The point of the question, not an afterthought. */
    explanation: z.string().min(20).max(2000),
    official_reference: z
      .string()
      .url()
      .refine((u) => /^https:\/\//i.test(u), { message: 'official_reference must be https' }),
  })
  .strict();

const bankSchema = z
  .object({
    certification: z.string().min(1).max(32),
    /** Free-text note about what this file covers. Not used for anything. */
    description: z.string().max(400).optional(),
    questions: z.array(questionSchema).min(1).max(200),
  })
  .strict();

const TRUE_FALSE_CHOICES = ['True', 'False'];

/** One choice as everything downstream sees it. */
export interface QuestionChoice {
  key: string;
  text: string;
}

/** A loaded, resolved question. `correctKeys` never leaves the server unbidden. */
export interface CertificationQuestion {
  readonly id: string;
  readonly certification: string;
  readonly objective: string;
  readonly type: QuestionType;
  readonly question: string;
  readonly choices: readonly QuestionChoice[];
  readonly correctKeys: readonly string[];
  readonly explanation: string;
  readonly officialReference: string;
  readonly sourcePath: string;
}

export class QuestionBankError extends Error {
  readonly code = 'QUESTION_BANK_INVALID';
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'QuestionBankError';
  }

  format(): string {
    const body = this.issues.length > 0 ? this.issues.join('\n') : this.message;
    return `${this.code}\n\n${this.path}:\n${body}`;
  }
}

function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path
      .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
      .join('')
      .replace(/^\./, '');
    return `${location || '<root>'}: ${issue.message}`;
  });
}

/**
 * Parse a question file into resolved questions.
 *
 * Validation beyond the schema, all of it about grading being well-defined:
 *
 *   - a `single` or `true_false` question has exactly one correct answer, and a
 *     `multiple` has at least two but not all of them (a question whose every
 *     option is correct tests nothing);
 *   - every `correct_answer` names a choice that exists, so a typo in the key
 *     is an authoring error rather than a question nobody can ever get right;
 *   - no two choices repeat, which would make a key ambiguous to a reader.
 */
export function parseQuestionBank(
  yamlText: string,
  sourcePath = '<inline>',
): CertificationQuestion[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new QuestionBankError(`Invalid YAML in question bank: ${(cause as Error).message}`, sourcePath);
  }

  const result = bankSchema.safeParse(raw);
  if (!result.success) {
    const issues = issueLines(result.error);
    throw new QuestionBankError(
      `Question bank failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }

  const issues: string[] = [];
  const questions: CertificationQuestion[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of result.data.questions.entries()) {
    const where = `questions[${index}] (${entry.id})`;

    if (seen.has(entry.id)) issues.push(`${where}: duplicate question id`);
    seen.add(entry.id);

    const choiceTexts = entry.type === 'true_false' ? (entry.choices ?? TRUE_FALSE_CHOICES) : entry.choices;
    if (!choiceTexts) {
      issues.push(`${where}: choices is required for a ${entry.type} question`);
      continue;
    }
    if (new Set(choiceTexts).size !== choiceTexts.length) {
      issues.push(`${where}: choices must be distinct`);
    }

    const choices: QuestionChoice[] = choiceTexts.map((text, position) => ({
      key: CHOICE_KEYS[position]!,
      text,
    }));

    const correctKeys: string[] = [];
    for (const answer of entry.correct_answer) {
      const match = choices.find((choice) => choice.text === answer);
      if (!match) {
        issues.push(`${where}: correct_answer '${answer}' is not one of the choices`);
        continue;
      }
      if (correctKeys.includes(match.key)) {
        issues.push(`${where}: correct_answer lists '${answer}' twice`);
        continue;
      }
      correctKeys.push(match.key);
    }

    if (entry.type === 'single' || entry.type === 'true_false') {
      if (entry.correct_answer.length !== 1) {
        issues.push(`${where}: a ${entry.type} question must have exactly one correct answer`);
      }
    } else if (correctKeys.length < 2) {
      issues.push(`${where}: a multiple-answer question must have at least two correct answers`);
    } else if (correctKeys.length === choices.length) {
      issues.push(`${where}: every choice is marked correct, so the question tests nothing`);
    }

    if (entry.type === 'true_false' && choices.length !== 2) {
      issues.push(`${where}: a true_false question must have exactly two choices`);
    }

    let host = '';
    try {
      host = new URL(entry.official_reference).hostname.toLowerCase();
    } catch {
      /* the schema already rejected a malformed URL */
    }
    const banned = DISALLOWED_DOC_HOSTS.find((bad) => host === bad || host.endsWith(`.${bad}`));
    if (banned) {
      issues.push(
        `${where}: official_reference points at '${banned}'. Questions are written from official documentation only.`,
      );
    }

    questions.push({
      id: entry.id,
      certification: result.data.certification,
      objective: entry.objective,
      type: entry.type,
      question: entry.question,
      choices,
      correctKeys,
      explanation: entry.explanation,
      officialReference: entry.official_reference,
      sourcePath,
    });
  }

  if (issues.length > 0) {
    throw new QuestionBankError(
      `Question bank failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }

  return questions;
}

export async function loadQuestionBank(filePath: string): Promise<CertificationQuestion[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new QuestionBankError(`Cannot read question bank: ${(cause as Error).message}`, filePath);
  }
  return parseQuestionBank(text, filePath);
}

// ------------------------------------------------------------------ grading

/** A question as a student sees it: no answer key, no explanation. */
export interface QuestionPrompt {
  id: string;
  objective: string;
  type: QuestionType;
  question: string;
  choices: QuestionChoice[];
  /** How many options to pick, for a multiple-answer question. */
  selectCount?: number;
}

export function toPrompt(question: CertificationQuestion): QuestionPrompt {
  return {
    id: question.id,
    objective: question.objective,
    type: question.type,
    question: question.question,
    choices: question.choices.map((choice) => ({ ...choice })),
    // Stated for multiple-answer questions the way the official sample
    // questions state it ("pick the 2 correct responses"). Withholding it would
    // turn a knowledge question into a guessing game about how many to tick.
    ...(question.type === 'multiple' ? { selectCount: question.correctKeys.length } : {}),
  };
}

export interface SubmittedAnswer {
  questionId: string;
  /** Choice keys the student selected. Order is irrelevant. */
  selected: string[];
}

export interface GradedAnswer {
  questionId: string;
  objective: string;
  domain?: string;
  correct: boolean;
  /** What the student picked, normalised. */
  selected: string[];
  correctKeys: string[];
  explanation: string;
  officialReference: string;
}

/**
 * Grade one question.
 *
 * All-or-nothing, including for multiple-answer questions: partial credit for
 * "two of the three right answers plus a wrong one" would tell a student they
 * are 66% correct about something they have actually misunderstood.
 */
export function gradeAnswer(
  question: CertificationQuestion,
  selected: readonly string[],
): { correct: boolean; selected: string[] } {
  const valid = new Set(question.choices.map((choice) => choice.key));
  // Unknown keys are dropped rather than rejected: a stale client cannot make
  // grading throw, and dropping one can only ever make an answer wrong.
  const normalised = [...new Set(selected.filter((key) => valid.has(key)))].sort();
  const expected = [...question.correctKeys].sort();
  const correct =
    normalised.length === expected.length &&
    normalised.every((key, index) => key === expected[index]);
  return { correct, selected: normalised };
}
