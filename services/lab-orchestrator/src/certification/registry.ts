/**
 * Certification registry — discovery, cross-validation, and the read model.
 *
 * Mirrors `LabRegistry`: scan a directory, validate what is found, reject what
 * is broken while recording *why*, and expose the survivors as pure in-memory
 * data. Nothing here reaches a cluster, a container, or a network.
 *
 * ```text
 *   labs/<track>/certification-*.yaml   → objective catalogs
 *   labs/<track>/questions/*.yaml       → question banks
 *   labs/<track>/study/*.yaml           → conceptual study units
 *   labs/<track>/exams/*.yaml           → practice assessments
 * ```
 *
 * The cross-checks are the part that earns its keep. Each file validates
 * standalone, but the errors that actually bite a curriculum are *between*
 * files: a lab claiming an objective the vendor does not publish, a study unit
 * pointing at a question id nobody wrote, an exam blueprint asking for twelve
 * questions from a domain that only has five. Those are caught here, at load,
 * and reported as load errors rather than surfacing later as a quietly
 * short-changed practice paper.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { LabDefinition } from '../lab-definition.js';
import {
  CertificationCatalogError,
  loadCertificationCatalog,
  type CertificationCatalog,
} from './catalog.js';
import {
  QuestionBankError,
  loadQuestionBank,
  type CertificationQuestion,
} from './questions.js';
import { StudyUnitError, loadStudyUnit, type StudyUnit } from './study.js';
import { ExamDefinitionError, loadExamDefinition, type ExamDefinition } from './exam.js';
import {
  computeCoverage,
  coverageViolations,
  labObjectives,
  type CoverageReport,
} from './coverage.js';

const CATALOG_FILE = /^certification-[a-z0-9-]+\.ya?ml$/i;
const CONTENT_DIRECTORIES = new Set(['questions', 'study', 'exams']);

/** Everything registered for one certification. */
export interface CertificationBundle {
  catalog: CertificationCatalog;
  questions: CertificationQuestion[];
  studyUnits: StudyUnit[];
  exams: ExamDefinition[];
}

export class CertificationRegistry {
  #catalogs = new Map<string, CertificationCatalog>();
  #questions = new Map<string, CertificationQuestion[]>();
  #study = new Map<string, StudyUnit[]>();
  #exams = new Map<string, ExamDefinition[]>();
  #questionById = new Map<string, CertificationQuestion>();
  #loadErrors: string[] = [];
  #loaded = false;

  constructor(private readonly contentDir: string) {}

  get loadErrors(): readonly string[] {
    return this.#loadErrors;
  }

  get size(): number {
    return this.#catalogs.size;
  }

  /**
   * Scan the content directory.
   *
   * `labs` is supplied so the registry can cross-check objective claims at load
   * time. It is read, never retained: coverage is recomputed from a fresh lab
   * list on every call to `coverage()`, so a lab reload cannot leave a stale
   * matrix behind.
   */
  async load(labs: readonly LabDefinition[] = [], force = false): Promise<void> {
    if (this.#loaded && !force) return;

    this.#catalogs.clear();
    this.#questions.clear();
    this.#study.clear();
    this.#exams.clear();
    this.#questionById.clear();
    this.#loadErrors = [];

    const found = await this.#discover(this.contentDir);

    for (const file of found.catalogs.sort()) {
      try {
        const catalog = await loadCertificationCatalog(file);
        if (this.#catalogs.has(catalog.id)) {
          this.#loadErrors.push(
            `CERTIFICATION_CATALOG_INVALID\n\n${file}:\nduplicate certification id '${catalog.id}'`,
          );
          continue;
        }
        this.#catalogs.set(catalog.id, catalog);
      } catch (cause) {
        this.#loadErrors.push(describe(file, cause));
      }
    }

    for (const file of found.questions.sort()) {
      try {
        for (const question of await loadQuestionBank(file)) {
          if (this.#questionById.has(question.id)) {
            const owner = this.#questionById.get(question.id)!.sourcePath;
            this.#loadErrors.push(
              `QUESTION_BANK_INVALID\n\n${file}:\nduplicate question id '${question.id}' — already defined by ${owner}`,
            );
            continue;
          }
          this.#questionById.set(question.id, question);
          push(this.#questions, question.certification, question);
        }
      } catch (cause) {
        this.#loadErrors.push(describe(file, cause));
      }
    }

    for (const file of found.study.sort()) {
      try {
        const unit = await loadStudyUnit(file);
        push(this.#study, unit.certification, unit);
      } catch (cause) {
        this.#loadErrors.push(describe(file, cause));
      }
    }

    for (const file of found.exams.sort()) {
      try {
        const exam = await loadExamDefinition(file);
        push(this.#exams, exam.certification, exam);
      } catch (cause) {
        this.#loadErrors.push(describe(file, cause));
      }
    }

    this.#crossValidate(labs);
    this.#loaded = true;
  }

  async #discover(dir: string): Promise<{
    catalogs: string[];
    questions: string[];
    study: string[];
    exams: string[];
  }> {
    const out = { catalogs: [] as string[], questions: [] as string[], study: [] as string[], exams: [] as string[] };

    const walk = async (current: string, kind: string | null): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (cause) {
        this.#loadErrors.push(`cannot read certification directory ${current}: ${(cause as Error).message}`);
        return;
      }

      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full, CONTENT_DIRECTORIES.has(entry.name) ? entry.name : kind);
          continue;
        }
        if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;

        if (kind === 'questions') out.questions.push(full);
        else if (kind === 'study') out.study.push(full);
        else if (kind === 'exams') out.exams.push(full);
        else if (CATALOG_FILE.test(entry.name)) out.catalogs.push(full);
      }
    };

    await walk(dir, null);
    return out;
  }

  /**
   * The checks that only make sense once everything is loaded.
   *
   * Deliberately recorded as load errors rather than thrown: one broken exam
   * blueprint should not take the whole catalog offline, and an operator needs
   * the full list of what is wrong, not the first thing that failed.
   */
  #crossValidate(labs: readonly LabDefinition[]): void {
    const knownQuestion = (id: string): boolean => this.#questionById.has(id);

    // Content pointing at a certification nobody defined.
    for (const [certification, questions] of this.#questions) {
      if (this.#catalogs.has(certification)) continue;
      this.#loadErrors.push(
        `QUESTION_BANK_INVALID\n\n${questions[0]?.sourcePath ?? '<unknown>'}:\nno certification catalog defines '${certification}'`,
      );
    }
    for (const [certification, units] of this.#study) {
      if (this.#catalogs.has(certification)) continue;
      this.#loadErrors.push(
        `STUDY_UNIT_INVALID\n\n${units[0]?.sourcePath ?? '<unknown>'}:\nno certification catalog defines '${certification}'`,
      );
    }
    for (const [certification, exams] of this.#exams) {
      if (this.#catalogs.has(certification)) continue;
      this.#loadErrors.push(
        `EXAM_DEFINITION_INVALID\n\n${exams[0]?.sourcePath ?? '<unknown>'}:\nno certification catalog defines '${certification}'`,
      );
    }

    for (const catalog of this.#catalogs.values()) {
      const questions = this.#questions.get(catalog.id) ?? [];

      for (const question of questions) {
        if (catalog.hasObjective(question.objective)) continue;
        this.#loadErrors.push(
          `QUESTION_BANK_INVALID\n\n${question.sourcePath}:\n${question.id} names objective '${question.objective}', which ${catalog.id} does not publish`,
        );
      }

      for (const unit of this.#study.get(catalog.id) ?? []) {
        for (const objective of unit.objectives) {
          if (catalog.hasObjective(objective)) continue;
          this.#loadErrors.push(
            `STUDY_UNIT_INVALID\n\n${unit.sourcePath}:\n${unit.id} names objective '${objective}', which ${catalog.id} does not publish`,
          );
        }
        for (const questionId of unit.review_questions) {
          if (knownQuestion(questionId)) continue;
          this.#loadErrors.push(
            `STUDY_UNIT_INVALID\n\n${unit.sourcePath}:\n${unit.id} references question '${questionId}', which no question bank defines`,
          );
        }
      }

      // Exam blueprints: every published domain represented, and a pool deep
      // enough to fill the quota. A blueprint that quietly draws four questions
      // where it asked for twelve would under-report a whole domain.
      const poolByDomain = new Map<string, number>();
      for (const question of questions) {
        const domain = catalog.domainOf(question.objective);
        if (!domain) continue;
        poolByDomain.set(domain.id, (poolByDomain.get(domain.id) ?? 0) + 1);
      }

      for (const exam of this.#exams.get(catalog.id) ?? []) {
        const planned = new Set(exam.blueprint.map((entry) => entry.domain));
        for (const domain of catalog.domains) {
          if (planned.has(domain.id)) continue;
          this.#loadErrors.push(
            `EXAM_DEFINITION_INVALID\n\n${exam.sourcePath}:\n${exam.id} does not draw any questions from domain ${domain.id} (${domain.title})`,
          );
        }
        for (const entry of exam.blueprint) {
          if (!catalog.domain(entry.domain)) {
            this.#loadErrors.push(
              `EXAM_DEFINITION_INVALID\n\n${exam.sourcePath}:\n${exam.id} draws from domain '${entry.domain}', which ${catalog.id} does not publish`,
            );
            continue;
          }
          const available = poolByDomain.get(entry.domain) ?? 0;
          if (available < entry.questions) {
            this.#loadErrors.push(
              `EXAM_DEFINITION_INVALID\n\n${exam.sourcePath}:\n${exam.id} draws ${entry.questions} questions from domain ${entry.domain} but the bank holds only ${available}`,
            );
          }
        }
      }

      // Labs: objective claims must be published, and review questions must exist.
      for (const lab of labs) {
        if (lab.track !== catalog.track) continue;
        for (const objective of labObjectives(lab, catalog.id)) {
          if (catalog.hasObjective(objective)) continue;
          this.#loadErrors.push(
            `LAB_DEFINITION_INVALID\n\n${lab.id}:\ncertification claims objective '${objective}', which ${catalog.id} does not publish`,
          );
        }
      }
    }

    for (const lab of labs) {
      for (const questionId of lab.review_questions) {
        if (knownQuestion(questionId)) continue;
        this.#loadErrors.push(
          `LAB_DEFINITION_INVALID\n\n${lab.id}:\nreview_questions references '${questionId}', which no question bank defines`,
        );
      }
    }
  }

  // ------------------------------------------------------------------ reads

  certifications(): CertificationCatalog[] {
    return [...this.#catalogs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  catalog(certificationId: string): CertificationCatalog | null {
    return this.#catalogs.get(certificationId) ?? null;
  }

  /** Catalogs whose track matches, for the track-level UI. */
  catalogsForTrack(track: string): CertificationCatalog[] {
    return this.certifications().filter((catalog) => catalog.track === track);
  }

  questionsFor(certificationId: string): CertificationQuestion[] {
    return [...(this.#questions.get(certificationId) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  }

  question(questionId: string): CertificationQuestion | null {
    return this.#questionById.get(questionId) ?? null;
  }

  /** Resolve a list of question ids, dropping any that do not exist. */
  resolveQuestions(ids: readonly string[]): CertificationQuestion[] {
    return ids
      .map((id) => this.#questionById.get(id))
      .filter((question): question is CertificationQuestion => question !== undefined);
  }

  studyUnitsFor(certificationId: string): StudyUnit[] {
    return [...(this.#study.get(certificationId) ?? [])].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    );
  }

  studyUnit(unitId: string): StudyUnit | null {
    for (const units of this.#study.values()) {
      const found = units.find((unit) => unit.id === unitId);
      if (found) return found;
    }
    return null;
  }

  examsFor(certificationId: string): ExamDefinition[] {
    return [...(this.#exams.get(certificationId) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  }

  exam(examId: string): ExamDefinition | null {
    for (const exams of this.#exams.values()) {
      const found = exams.find((entry) => entry.id === examId);
      if (found) return found;
    }
    return null;
  }

  bundle(certificationId: string): CertificationBundle | null {
    const catalog = this.catalog(certificationId);
    if (!catalog) return null;
    return {
      catalog,
      questions: this.questionsFor(certificationId),
      studyUnits: this.studyUnitsFor(certificationId),
      exams: this.examsFor(certificationId),
    };
  }

  /** The coverage matrix for one certification, computed against `labs`. */
  coverage(certificationId: string, labs: readonly LabDefinition[]): CoverageReport | null {
    const catalog = this.catalog(certificationId);
    if (!catalog) return null;
    return computeCoverage({
      catalog,
      labs,
      studyUnits: this.studyUnitsFor(certificationId),
      questions: this.questionsFor(certificationId),
    });
  }

  /** Gate verdict for one certification: empty means fully mapped. */
  violations(certificationId: string, labs: readonly LabDefinition[]): string[] {
    const report = this.coverage(certificationId, labs);
    return report ? coverageViolations(report) : [`no catalog defines '${certificationId}'`];
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function describe(file: string, cause: unknown): string {
  if (
    cause instanceof CertificationCatalogError ||
    cause instanceof QuestionBankError ||
    cause instanceof StudyUnitError ||
    cause instanceof ExamDefinitionError
  ) {
    return cause.format();
  }
  return `${file}: ${(cause as Error).message}`;
}
