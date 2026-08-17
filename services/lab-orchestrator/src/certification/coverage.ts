/**
 * Curriculum coverage against a published objective list.
 *
 * This is the module the coverage gate is built on, and its job is to be
 * *pessimistic*. Coverage is only claimed where something concrete backs it:
 *
 *   - hands-on coverage means a lab exists whose `certification` block names the
 *     objective and whose `requirements` verify a real result;
 *   - conceptual coverage means a study unit teaches it;
 *   - assessment coverage means at least one question is mapped to it.
 *
 * An objective is FULL only when it is assessed *and* delivered the way the
 * catalog says it should be. An objective the catalog marks `hands-on` is not
 * FULL because three multiple-choice questions exist about it — that would be
 * the platform grading its own homework, and it is precisely the failure mode a
 * certification-alignment claim invites.
 *
 * The percentages produced here describe *our curriculum's mapping onto the
 * published objectives*. They are not, and must never be presented as, a
 * likelihood of passing anything.
 */
import type { LabDefinition } from '../lab-definition.js';
import type { CertificationCatalog, PracticeMode } from './catalog.js';
import type { CertificationQuestion } from './questions.js';
import type { StudyUnit } from './study.js';

export type CoverageStatus = 'FULL' | 'PARTIAL' | 'MISSING';

export interface ObjectiveCoverage {
  objective: string;
  title: string;
  domain: string;
  domainTitle: string;
  practice: PracticeMode;
  /** Hands-on labs claiming this objective, in catalog order. */
  labs: string[];
  /** Conceptual study units teaching it. */
  studyUnits: string[];
  /** Questions assessing it. */
  questions: string[];
  status: CoverageStatus;
  /** What is missing, in plain words. Empty when FULL. */
  gaps: string[];
}

export interface DomainCoverage {
  domain: string;
  title: string;
  objectives: ObjectiveCoverage[];
  total: number;
  full: number;
  partial: number;
  missing: number;
  /** Percent of this domain's objectives that are FULL. */
  percent: number;
}

export interface CoverageReport {
  certification: string;
  name: string;
  examVersion: string;
  productVersion: string;
  reviewedOn: string;
  domains: DomainCoverage[];
  total: number;
  full: number;
  partial: number;
  missing: number;
  /** Percent of published objectives that are FULL. */
  percent: number;
  /** Objectives claimed by content but absent from the published list. */
  unknownObjectives: UnknownObjectiveReference[];
  /** True when every objective is FULL and nothing references an unknown id. */
  complete: boolean;
}

export interface UnknownObjectiveReference {
  /** `lab`, `study`, or `question`. */
  kind: 'lab' | 'study' | 'question';
  /** The referring lab / unit / question id. */
  id: string;
  objective: string;
}

export interface CoverageInput {
  catalog: CertificationCatalog;
  /** Every lab in the catalog's track. Labs from other tracks are ignored. */
  labs: readonly LabDefinition[];
  studyUnits: readonly StudyUnit[];
  questions: readonly CertificationQuestion[];
}

/** Objective ids a lab claims for one certification. */
export function labObjectives(lab: LabDefinition, certificationId: string): string[] {
  return lab.certification
    .filter((entry) => entry.relevant && entry.certification === certificationId)
    .flatMap((entry) => entry.objectives);
}

export function computeCoverage(input: CoverageInput): CoverageReport {
  const { catalog, labs, studyUnits, questions } = input;
  const certificationId = catalog.id;

  const labsByObjective = new Map<string, string[]>();
  const studyByObjective = new Map<string, string[]>();
  const questionsByObjective = new Map<string, string[]>();
  const unknownObjectives: UnknownObjectiveReference[] = [];

  const record = (
    map: Map<string, string[]>,
    objective: string,
    id: string,
    kind: UnknownObjectiveReference['kind'],
  ): void => {
    if (!catalog.hasObjective(objective)) {
      unknownObjectives.push({ kind, id, objective });
      return;
    }
    const bucket = map.get(objective);
    if (bucket) {
      if (!bucket.includes(id)) bucket.push(id);
    } else {
      map.set(objective, [id]);
    }
  };

  for (const lab of labs) {
    if (lab.track !== catalog.track) continue;
    for (const objective of labObjectives(lab, certificationId)) {
      record(labsByObjective, objective, lab.id, 'lab');
    }
  }

  for (const unit of studyUnits) {
    if (unit.certification !== certificationId) continue;
    for (const objective of unit.objectives) {
      record(studyByObjective, objective, unit.id, 'study');
    }
  }

  for (const question of questions) {
    if (question.certification !== certificationId) continue;
    record(questionsByObjective, question.objective, question.id, 'question');
  }

  const domains: DomainCoverage[] = catalog.domains.map((domain) => {
    const objectives: ObjectiveCoverage[] = domain.objectives.map((objective) => {
      const labIds = labsByObjective.get(objective.id) ?? [];
      const studyIds = studyByObjective.get(objective.id) ?? [];
      const questionIds = questionsByObjective.get(objective.id) ?? [];

      const gaps: string[] = [];
      if (objective.practice === 'hands-on' && labIds.length === 0) {
        gaps.push('no hands-on lab verifies this objective');
      }
      if (objective.practice === 'conceptual' && studyIds.length === 0) {
        gaps.push('no study unit teaches this objective');
      }
      if (questionIds.length === 0) {
        gaps.push('no assessment question covers this objective');
      }

      const hasAnything = labIds.length + studyIds.length + questionIds.length > 0;
      const status: CoverageStatus =
        gaps.length === 0 ? 'FULL' : hasAnything ? 'PARTIAL' : 'MISSING';

      return {
        objective: objective.id,
        title: objective.title,
        domain: domain.id,
        domainTitle: domain.title,
        practice: objective.practice,
        labs: labIds,
        studyUnits: studyIds,
        questions: questionIds,
        status,
        gaps,
      };
    });

    const full = objectives.filter((o) => o.status === 'FULL').length;
    const partial = objectives.filter((o) => o.status === 'PARTIAL').length;
    const missing = objectives.filter((o) => o.status === 'MISSING').length;

    return {
      domain: domain.id,
      title: domain.title,
      objectives,
      total: objectives.length,
      full,
      partial,
      missing,
      percent: objectives.length === 0 ? 0 : Math.round((full / objectives.length) * 100),
    };
  });

  const all = domains.flatMap((domain) => domain.objectives);
  const full = all.filter((o) => o.status === 'FULL').length;
  const partial = all.filter((o) => o.status === 'PARTIAL').length;
  const missing = all.filter((o) => o.status === 'MISSING').length;

  return {
    certification: certificationId,
    name: catalog.data.name,
    examVersion: catalog.data.exam_version,
    productVersion: catalog.data.product_version,
    reviewedOn: catalog.data.reviewed_on,
    domains,
    total: all.length,
    full,
    partial,
    missing,
    percent: all.length === 0 ? 0 : Math.round((full / all.length) * 100),
    unknownObjectives,
    complete: full === all.length && unknownObjectives.length === 0,
  };
}

/**
 * The gate's verdict, as lines an operator can act on.
 *
 * Returns an empty array when the curriculum maps onto every published
 * objective. Anything else is a list of concrete, quotable gaps — never a bare
 * "coverage failed", because the whole value of the gate is naming the
 * objective that is missing.
 */
export function coverageViolations(report: CoverageReport): string[] {
  const violations: string[] = [];

  for (const reference of report.unknownObjectives) {
    violations.push(
      `${reference.kind} ${reference.id} references objective '${reference.objective}', which is not published for ${report.certification}`,
    );
  }

  for (const domain of report.domains) {
    for (const objective of domain.objectives) {
      if (objective.status === 'FULL') continue;
      violations.push(
        `${objective.objective} (${objective.title}) — ${objective.status}: ${objective.gaps.join('; ')}`,
      );
    }
  }

  return violations;
}
