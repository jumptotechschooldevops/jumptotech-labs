/**
 * Study units — the conceptual half of a certification track.
 *
 * Some published objectives cannot honestly be practised in an offline sandbox.
 * "Describe HCP Terraform collaboration and governance features" needs an
 * account on a hosted platform; "Describe state locking" needs a backend that
 * implements locking. The platform's answer is *not* to fake a backend, print
 * invented CLI output, or tell a student they are connected to something they
 * are not. It is to teach those objectives as reading plus assessment, and to
 * label them as such everywhere they appear.
 *
 * A study unit is therefore a deliberately small thing: prose, optional text
 * diagrams, official references, an explicit statement of what it *cannot*
 * demonstrate, and the questions that assess it. It has no sandbox, no
 * requirements, and no Check Solution — and because it is not a lab, it cannot
 * accidentally acquire one. `mode: conceptual` is stated in the file rather than
 * inferred, so nothing downstream has to guess.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { OBJECTIVE_ID_PATTERN } from './catalog.js';
import { QUESTION_ID_PATTERN } from './questions.js';

/** `TF-C03`. Distinct from a lab id so the two can never be confused. */
export const STUDY_UNIT_ID_PATTERN = /^[A-Z][A-Z0-9]{1,7}-C\d{2,3}$/;

const referenceSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z
      .string()
      .url()
      .refine((u) => /^https:\/\//i.test(u), { message: 'reference url must be https' }),
  })
  .strict();

const sectionSchema = z
  .object({
    heading: z.string().min(1).max(160),
    body: z.string().min(1).max(6000),
    /**
     * A monospace text diagram.
     *
     * Rendered verbatim in a `<pre>`. Text rather than an image because it
     * survives a diff, a terminal, and a screen reader's linearisation, and
     * because an architecture that needs a rendering pipeline to be understood
     * is usually one that needs better prose.
     */
    diagram: z.string().max(4000).optional(),
  })
  .strict();

const studyUnitSchema = z
  .object({
    id: z.string().regex(STUDY_UNIT_ID_PATTERN, 'study unit id must look like TF-C01'),
    certification: z.string().min(1).max(32),
    track: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'track must be kebab-case'),
    title: z.string().min(1).max(120),
    /** Sort position within the track's conceptual sequence. */
    order: z.number().int().min(0).max(9999).default(0),
    duration_minutes: z.number().int().positive().max(180),
    summary: z.string().min(1).max(400),
    /** Official objective ids this unit teaches. Validated against the catalog. */
    objectives: z
      .array(z.string().regex(OBJECTIVE_ID_PATTERN, 'must be an objective id such as 8c'))
      .min(1)
      .max(12),
    sections: z.array(sectionSchema).min(1).max(12),
    /**
     * What this unit cannot show you, and why.
     *
     * Required, not optional. A conceptual unit exists precisely because
     * something is out of reach, and saying so plainly is the difference
     * between honest teaching material and a simulation that implies the
     * student has done something they have not.
     */
    limitations: z.string().min(20).max(2000),
    references: z.array(referenceSchema).min(1).max(12),
    review_questions: z
      .array(z.string().regex(QUESTION_ID_PATTERN, 'must be a question id such as TFQ-001'))
      .min(1)
      .max(12),
  })
  .strict();

export type StudySection = z.infer<typeof sectionSchema>;
export type StudyUnitData = z.infer<typeof studyUnitSchema>;

/** A validated study unit, with where it came from. */
export interface StudyUnit extends StudyUnitData {
  /** Always `conceptual`. Present so consumers never infer it from the absence of something. */
  readonly mode: 'conceptual';
  readonly sourcePath: string;
}

export class StudyUnitError extends Error {
  readonly code = 'STUDY_UNIT_INVALID';
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'StudyUnitError';
  }

  format(): string {
    const body = this.issues.length > 0 ? this.issues.join('\n') : this.message;
    return `${this.code}\n\n${this.path}:\n${body}`;
  }
}

export function parseStudyUnit(yamlText: string, sourcePath = '<inline>'): StudyUnit {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new StudyUnitError(`Invalid YAML in study unit: ${(cause as Error).message}`, sourcePath);
  }

  const result = studyUnitSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const location = issue.path
        .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
        .join('')
        .replace(/^\./, '');
      return `${location || '<root>'}: ${issue.message}`;
    });
    throw new StudyUnitError(
      `Study unit failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }

  const duplicateObjectives = result.data.objectives.filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicateObjectives.length > 0) {
    throw new StudyUnitError(
      'Study unit failed validation (1 issue)',
      sourcePath,
      [`objectives contains duplicates: ${[...new Set(duplicateObjectives)].join(', ')}`],
    );
  }

  return { ...result.data, mode: 'conceptual', sourcePath };
}

export async function loadStudyUnit(filePath: string): Promise<StudyUnit> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new StudyUnitError(`Cannot read study unit: ${(cause as Error).message}`, filePath);
  }
  return parseStudyUnit(text, filePath);
}
