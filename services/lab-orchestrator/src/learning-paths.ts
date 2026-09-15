/**
 * Learning paths — the curriculum structure above the lab catalog.
 *
 * The catalog answers "what labs exist". A learning path answers the question a
 * beginner actually has: "in what order should I learn this, and why?" It is
 * data, in the same spirit as `lab.yaml`, and lives beside the labs it arranges:
 *
 * ```text
 *   labs/learning-paths/skills.yaml            every skill a path may name
 *   labs/learning-paths/devops-engineer.yaml   one path: stages → skills → labs
 * ```
 *
 * ```text
 *   LearningPath ─┬─ outcomes, audience
 *                 └─ Stage[] (ordered) ─┬─ objectives, why it matters
 *                                       ├─ prerequisites → earlier stages (required | recommended)
 *                                       ├─ skills        → skills.yaml
 *                                       └─ labs[]        → lab ids, in recommended order
 *                                                           (skills, why, core or optional)
 * ```
 *
 * Three rules the model is built around:
 *
 *   - **Nothing here is progress.** A path references labs by id and never
 *     records who did what. Completion is derived elsewhere (`learning-progress.ts`)
 *     from verified progress only.
 *   - **A curriculum gap is data, not a flag.** A skill no lab in the path
 *     covers *is* a gap; a stage with no labs *is* coming soon. Adding and
 *     mapping a lab closes the gap with no other edit, and no field exists that
 *     could claim coverage without a lab behind it.
 *   - **Invalid structure is refused, not repaired.** A path naming a lab that
 *     does not exist, placing a lab twice, or ordering prerequisites backwards
 *     is rejected with every reason listed, the way an invalid `lab.yaml` is.
 *
 * Lab ids, lab URLs and lab runtime behaviour are untouched: a path only
 * *points at* labs.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { LabRegistry } from './lab-registry.js';
import { LAB_ID_PATTERN } from './validation.js';

/** `devops-engineer`, `kubernetes`. Also used for stage ids. */
export const LEARNING_PATH_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

/** Dotted lowercase, the same shape a lab's own `skills` use: `linux.permissions`. */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** Directory under `LABS_DIR` that holds the path definitions. */
export const LEARNING_PATHS_DIRNAME = 'learning-paths';

/** The skill catalog, inside that directory. Every other `.yaml` there is one path. */
export const SKILLS_FILENAME = 'skills.yaml';

export function learningPathsDirectory(labsDir: string): string {
  return path.join(labsDir, LEARNING_PATHS_DIRNAME);
}

const pathId = z.string().regex(LEARNING_PATH_ID_PATTERN, 'id must be kebab-case, e.g. devops-engineer');
const skillId = z.string().max(64).regex(SKILL_ID_PATTERN, 'skill must be dotted lowercase, e.g. linux.permissions');

const skillSchema = z
  .object({
    id: skillId,
    /** What a student reads. Plain words, not an identifier. */
    title: z.string().min(1).max(80),
    /** One or two sentences a beginner can follow. */
    description: z.string().min(1).max(300),
  })
  .strict();

const skillCatalogSchema = z.object({ skills: z.array(skillSchema).min(1).max(500) }).strict();

const prerequisiteSchema = z
  .object({
    stage: pathId,
    /**
     * `required`: the stage shows as waiting on this one, and the next-lab rule
     * will not start it until the earlier stage's core labs are verified.
     * `recommended`: shown as advice only.
     *
     * Neither blocks launching a lab. Lab start is not gated anywhere, so an
     * instructor can always send a student straight to a later lab.
     */
    kind: z.enum(['required', 'recommended']),
  })
  .strict();

const labAssignmentSchema = z
  .object({
    lab: z.string().regex(LAB_ID_PATTERN, 'lab must be a lab id like K8S-001'),
    /** Path skills this lab gives practice in. Must be skills of this path. */
    skills: z.array(skillId).min(1).max(6),
    /** Why this lab belongs at this point of the path, in one sentence. */
    why: z.string().min(1).max(300),
    /**
     * Extra practice rather than a core lab. A stage is complete when its core
     * labs are verified; optional labs deepen it without holding a student back.
     */
    optional: z.boolean().default(false),
  })
  .strict();

const stageSchema = z
  .object({
    id: pathId,
    title: z.string().min(1).max(64),
    /** What the student will learn, in plain words. */
    summary: z.string().min(1).max(400),
    /** Why this matters in real DevOps work. */
    why: z.string().min(1).max(600),
    objectives: z.array(z.string().min(1).max(200)).min(1).max(10),
    prerequisites: z.array(prerequisiteSchema).max(6).default([]),
    skills: z.array(skillId).min(1).max(20),
    /** In recommended order. Empty for a stage the curriculum does not cover yet. */
    labs: z.array(labAssignmentSchema).max(40).default([]),
    /** An honest note about what is missing, shown where the gap is. */
    coming_soon: z.string().min(1).max(400).optional(),
  })
  .strict();

const learningPathSchema = z
  .object({
    id: pathId,
    title: z.string().min(1).max(64),
    summary: z.string().min(1).max(400),
    audience: z.string().min(1).max(400),
    outcomes: z.array(z.string().min(1).max(200)).min(1).max(10),
    stages: z.array(stageSchema).min(1).max(30),
  })
  .strict();

export type SkillDefinition = z.infer<typeof skillSchema>;
export type LearningPathDefinition = z.infer<typeof learningPathSchema>;
export type LearningStageDefinition = z.infer<typeof stageSchema>;
export type PrerequisiteKind = z.infer<typeof prerequisiteSchema>['kind'];

export class LearningPathDefinitionError extends Error {
  readonly code = 'LEARNING_PATH_INVALID';
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'LearningPathDefinitionError';
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

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, text: string, source: string, what: string): T {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (cause) {
    throw new LearningPathDefinitionError(`Invalid YAML in ${what}: ${(cause as Error).message}`, source);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = issueLines(result.error);
    throw new LearningPathDefinitionError(`${what} failed validation`, source, issues);
  }
  return result.data;
}

/** Parse `skills.yaml`. Duplicate ids are an error. */
export function parseSkillCatalog(text: string, source = '<inline>'): Map<string, SkillDefinition> {
  const catalog = parseWith(skillCatalogSchema, text, source, 'skill catalog');
  const skills = new Map<string, SkillDefinition>();
  const duplicates: string[] = [];
  for (const skill of catalog.skills) {
    if (skills.has(skill.id)) duplicates.push(skill.id);
    else skills.set(skill.id, skill);
  }
  if (duplicates.length > 0) {
    throw new LearningPathDefinitionError('skill catalog failed validation', source, [
      `skills are defined more than once: ${[...new Set(duplicates)].join(', ')}`,
    ]);
  }
  return skills;
}

/** Parse one path file. Schema only — see `validateLearningPath` for structure. */
export function parseLearningPath(text: string, source = '<inline>'): LearningPathDefinition {
  return parseWith(learningPathSchema, text, source, 'learning path');
}

/** The catalog facts a path needs about one lab. */
export interface PathLabInfo {
  id: string;
  title: string;
  summary: string;
  track: string;
  provider: string;
  difficulty: string;
  durationMinutes: number;
  /** The lab's own `prerequisites`, from `lab.yaml`. */
  prerequisites: readonly string[];
}

/** Where a path looks labs up. The registry in production; a fake in tests. */
export interface PathLabSource {
  lab(labId: string): PathLabInfo | undefined;
}

export function labSourceFromRegistry(registry: LabRegistry): PathLabSource {
  return {
    lab(labId) {
      if (!registry.has(labId)) return undefined;
      const def = registry.get(labId);
      return {
        id: def.id,
        title: def.title,
        summary: def.task.summary,
        track: def.track,
        provider: def.environment.provider,
        difficulty: def.difficulty,
        durationMinutes: def.duration_minutes,
        prerequisites: def.prerequisites,
      };
    },
  };
}

function duplicatesOf(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/** Depth-first search over stage prerequisites. Returns the cycle, if any. */
function findStageCycle(def: LearningPathDefinition): string[] | null {
  const edges = new Map(def.stages.map((stage) => [stage.id, stage.prerequisites.map((p) => p.stage)]));
  const done = new Set<string>();
  const onPath: string[] = [];

  const walk = (id: string): string[] | null => {
    const loop = onPath.indexOf(id);
    if (loop !== -1) return [...onPath.slice(loop), id];
    if (done.has(id) || !edges.has(id)) return null;
    onPath.push(id);
    for (const next of edges.get(id) ?? []) {
      if (next === id) continue; // reported separately as a self-reference
      const found = walk(next);
      if (found) return found;
    }
    onPath.pop();
    done.add(id);
    return null;
  };

  for (const stage of def.stages) {
    const found = walk(stage.id);
    if (found) return found;
  }
  return null;
}

/**
 * Structural validation of a parsed path against the skill catalog and the
 * lab catalog. Returns every problem found; an empty list means valid.
 *
 * What it refuses, and why each would mislead a student:
 *
 *   - a lab id the catalog does not have — a stage would count a lab nobody can open;
 *   - a lab placed twice — its completion would be counted twice;
 *   - an unknown skill, or a skill claimed by two stages — skill progress would
 *     have no single home;
 *   - a stage prerequisite that is unknown, itself, later in the path, or
 *     circular — "do this first" would point forwards or nowhere;
 *   - a lab placed before one of its own `lab.yaml` prerequisites, or a lab
 *     whose prerequisite is not in the path at all — the recommended order
 *     would contradict the lab;
 *   - a core lab that depends on an optional one — "optional" would be false;
 *   - a stage with labs but no core lab — it could never be anything but complete.
 */
export function validateLearningPath(
  def: LearningPathDefinition,
  skills: ReadonlyMap<string, SkillDefinition>,
  labs: PathLabSource,
): string[] {
  const issues: string[] = [];

  const stageIndex = new Map<string, number>();
  def.stages.forEach((stage, index) => {
    if (stageIndex.has(stage.id)) issues.push(`stage '${stage.id}' is declared more than once`);
    else stageIndex.set(stage.id, index);
  });

  // Skills: known, and owned by exactly one stage.
  const skillOwner = new Map<string, string>();
  for (const stage of def.stages) {
    for (const duplicate of duplicatesOf(stage.skills)) {
      issues.push(`stage '${stage.id}' lists skill '${duplicate}' more than once`);
    }
    for (const skill of new Set(stage.skills)) {
      if (!skills.has(skill)) {
        issues.push(`stage '${stage.id}': skill '${skill}' is not defined in ${SKILLS_FILENAME}`);
      }
      const owner = skillOwner.get(skill);
      if (owner !== undefined) {
        issues.push(`skill '${skill}' is declared by both stage '${owner}' and stage '${stage.id}'`);
      } else {
        skillOwner.set(skill, stage.id);
      }
    }
  }

  // Labs: exist, placed once, with skills this path declares.
  const placement = new Map<string, { stageId: string; stageIndex: number; sequence: number; optional: boolean }>();
  def.stages.forEach((stage, index) => {
    stage.labs.forEach((assignment, sequence) => {
      const existing = placement.get(assignment.lab);
      if (existing) {
        issues.push(
          `lab ${assignment.lab} is assigned more than once (stage '${existing.stageId}' and stage '${stage.id}')`,
        );
        return;
      }
      placement.set(assignment.lab, {
        stageId: stage.id,
        stageIndex: index,
        sequence,
        optional: assignment.optional,
      });
      if (!labs.lab(assignment.lab)) {
        issues.push(`stage '${stage.id}': lab ${assignment.lab} does not exist in the lab catalog`);
      }
      for (const duplicate of duplicatesOf(assignment.skills)) {
        issues.push(`stage '${stage.id}': lab ${assignment.lab} lists skill '${duplicate}' more than once`);
      }
      for (const skill of new Set(assignment.skills)) {
        if (!skillOwner.has(skill)) {
          issues.push(
            `stage '${stage.id}': lab ${assignment.lab} names skill '${skill}', which no stage of this path declares`,
          );
        }
      }
    });
    if (stage.labs.length > 0 && stage.labs.every((assignment) => assignment.optional)) {
      issues.push(`stage '${stage.id}' has labs but no core lab — at least one lab must not be optional`);
    }
  });

  // Stage prerequisites: known, earlier, acyclic.
  def.stages.forEach((stage, index) => {
    for (const duplicate of duplicatesOf(stage.prerequisites.map((p) => p.stage))) {
      issues.push(`stage '${stage.id}' lists prerequisite stage '${duplicate}' more than once`);
    }
    for (const prerequisite of stage.prerequisites) {
      if (prerequisite.stage === stage.id) {
        issues.push(`stage '${stage.id}' lists itself as a prerequisite`);
        continue;
      }
      const target = stageIndex.get(prerequisite.stage);
      if (target === undefined) {
        issues.push(`stage '${stage.id}': prerequisite stage '${prerequisite.stage}' does not exist in this path`);
      } else if (target > index) {
        issues.push(
          `stage '${stage.id}': prerequisite stage '${prerequisite.stage}' comes later in the path — a prerequisite must come before the stage that needs it`,
        );
      }
    }
  });
  const cycle = findStageCycle(def);
  if (cycle) issues.push(`stage prerequisites form a cycle: ${cycle.join(' → ')}`);

  // Lab prerequisites (from lab.yaml) must agree with the path's order.
  for (const [labId, place] of placement) {
    const info = labs.lab(labId);
    if (!info) continue;
    for (const prerequisite of info.prerequisites) {
      const before = placement.get(prerequisite);
      if (!before) {
        issues.push(
          `lab ${labId} (stage '${place.stageId}') requires ${prerequisite}, which is not placed in this path`,
        );
        continue;
      }
      const later =
        before.stageIndex > place.stageIndex ||
        (before.stageIndex === place.stageIndex && before.sequence > place.sequence);
      if (later) {
        issues.push(
          `lab ${labId} is placed before its prerequisite ${prerequisite} — move it after ${prerequisite} in stage '${place.stageId}' or into a later stage`,
        );
      }
      if (!place.optional && before.optional) {
        issues.push(
          `core lab ${labId} requires ${prerequisite}, which is optional — a core lab cannot depend on extra practice`,
        );
      }
    }
  }

  return issues;
}

/** One lab, placed in a stage. */
export interface ResolvedPathLab {
  labId: string;
  stageId: string;
  /** 0-based position within the stage, in recommended order. */
  sequence: number;
  optional: boolean;
  why: string;
  skills: readonly string[];
  info: PathLabInfo;
}

export interface ResolvedStage {
  id: string;
  /** 1-based position in the path. */
  position: number;
  title: string;
  summary: string;
  why: string;
  objectives: readonly string[];
  comingSoon?: string;
  prerequisites: ReadonlyArray<{ stageId: string; kind: PrerequisiteKind }>;
  skills: readonly string[];
  labs: readonly ResolvedPathLab[];
}

/** A validated path, joined to its skills and labs. Immutable after construction. */
export interface ResolvedLearningPath {
  id: string;
  title: string;
  summary: string;
  audience: string;
  outcomes: readonly string[];
  stages: readonly ResolvedStage[];
  /** This path's skills, in stage order. */
  skills: ReadonlyMap<string, SkillDefinition>;
  /** Every placed lab, in path order. */
  labs: ReadonlyMap<string, ResolvedPathLab>;
  stage(stageId: string): ResolvedStage | undefined;
  /** Labs, anywhere in the path, that give practice in a skill. Empty means a curriculum gap. */
  labsForSkill(skillId: string): readonly ResolvedPathLab[];
}

/** Join a path that has already passed `validateLearningPath`. */
export function resolveLearningPath(
  def: LearningPathDefinition,
  skills: ReadonlyMap<string, SkillDefinition>,
  labs: PathLabSource,
): ResolvedLearningPath {
  const labsById = new Map<string, ResolvedPathLab>();
  const stages: ResolvedStage[] = def.stages.map((stage, index) => {
    const placed = stage.labs.map((assignment, sequence) => {
      const info = labs.lab(assignment.lab);
      if (!info) throw new Error(`lab ${assignment.lab} is not in the catalog; validate the path first`);
      const lab: ResolvedPathLab = {
        labId: assignment.lab,
        stageId: stage.id,
        sequence,
        optional: assignment.optional,
        why: assignment.why.trim(),
        skills: [...assignment.skills],
        info,
      };
      labsById.set(lab.labId, lab);
      return lab;
    });
    return {
      id: stage.id,
      position: index + 1,
      title: stage.title,
      summary: stage.summary.trim(),
      why: stage.why.trim(),
      objectives: [...stage.objectives],
      ...(stage.coming_soon ? { comingSoon: stage.coming_soon.trim() } : {}),
      prerequisites: stage.prerequisites.map((p) => ({ stageId: p.stage, kind: p.kind })),
      skills: [...stage.skills],
      labs: placed,
    };
  });

  const pathSkills = new Map<string, SkillDefinition>();
  for (const stage of stages) {
    for (const id of stage.skills) {
      const skill = skills.get(id);
      if (skill) pathSkills.set(id, skill);
    }
  }

  const bySkill = new Map<string, ResolvedPathLab[]>();
  for (const lab of labsById.values()) {
    for (const skill of lab.skills) {
      const list = bySkill.get(skill);
      if (list) list.push(lab);
      else bySkill.set(skill, [lab]);
    }
  }

  const byStage = new Map(stages.map((stage) => [stage.id, stage]));
  return {
    id: def.id,
    title: def.title,
    summary: def.summary.trim(),
    audience: def.audience.trim(),
    outcomes: [...def.outcomes],
    stages,
    skills: pathSkills,
    labs: labsById,
    stage: (stageId) => byStage.get(stageId),
    labsForSkill: (id) => bySkill.get(id) ?? [],
  };
}

export interface LearningPathSource {
  text: string;
  source: string;
  /** The id the file name promises (`devops-engineer.yaml` → `devops-engineer`). */
  expectedId?: string;
}

/**
 * Every valid learning path, and why any others were refused.
 *
 * Like the lab registry, a refused definition is recorded rather than thrown:
 * `/health` reports it, and the tests assert the shipped paths load with no
 * errors at all.
 */
export class LearningPathCatalog {
  readonly #paths: Map<string, ResolvedLearningPath>;
  readonly #refused: Set<string>;

  constructor(
    paths: readonly ResolvedLearningPath[],
    readonly skills: ReadonlyMap<string, SkillDefinition>,
    readonly loadErrors: readonly string[],
    /** Ids of paths that exist on disk but were refused — unavailable, not unknown. */
    refused: readonly string[] = [],
  ) {
    this.#paths = new Map(paths.map((p) => [p.id, p]));
    this.#refused = new Set(refused.filter((id) => !this.#paths.has(id)));
  }

  /**
   * True for a path that is defined but could not be served — for example
   * because a lab it references failed to load. Callers report it as
   * unavailable, never as "not found", which would blame the student's address.
   */
  isRefused(pathIdValue: string): boolean {
    return this.#refused.has(pathIdValue);
  }

  static empty(): LearningPathCatalog {
    return new LearningPathCatalog([], new Map(), []);
  }

  get size(): number {
    return this.#paths.size;
  }

  list(): ResolvedLearningPath[] {
    return [...this.#paths.values()];
  }

  get(pathIdValue: string): ResolvedLearningPath | undefined {
    return this.#paths.get(pathIdValue);
  }

  /** Build from file contents. Pure, so validation is testable without a disk. */
  static build(
    input: { skills: LearningPathSource; paths: readonly LearningPathSource[] },
    labs: PathLabSource,
  ): LearningPathCatalog {
    const loadErrors: string[] = [];
    let skills: Map<string, SkillDefinition>;
    const refused = input.paths.flatMap((file) => (file.expectedId ? [file.expectedId] : []));
    try {
      skills = parseSkillCatalog(input.skills.text, input.skills.source);
    } catch (cause) {
      loadErrors.push(describe(cause, input.skills.source));
      return new LearningPathCatalog([], new Map(), loadErrors, refused);
    }

    const resolved: ResolvedLearningPath[] = [];
    const seen = new Set<string>();
    for (const file of input.paths) {
      let def: LearningPathDefinition;
      try {
        def = parseLearningPath(file.text, file.source);
      } catch (cause) {
        loadErrors.push(describe(cause, file.source));
        continue;
      }
      refused.push(def.id);
      const issues = validateLearningPath(def, skills, labs);
      if (file.expectedId !== undefined && file.expectedId !== def.id) {
        issues.unshift(`id '${def.id}' does not match the file name (expected '${file.expectedId}')`);
      }
      if (seen.has(def.id)) issues.unshift(`learning path '${def.id}' is defined more than once`);
      if (issues.length > 0) {
        loadErrors.push(new LearningPathDefinitionError('learning path failed validation', file.source, issues).format());
        continue;
      }
      seen.add(def.id);
      resolved.push(resolveLearningPath(def, skills, labs));
    }
    return new LearningPathCatalog(resolved, skills, loadErrors, refused);
  }

  /**
   * Read `<labsDir>/learning-paths`. A missing directory is an empty catalog —
   * a deployment may ship labs without paths — not an error.
   */
  static async load(directory: string, labs: PathLabSource): Promise<LearningPathCatalog> {
    let names: string[];
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return LearningPathCatalog.empty();
      return new LearningPathCatalog([], new Map(), [`cannot read ${directory}: ${(cause as Error).message}`]);
    }

    if (!names.includes(SKILLS_FILENAME)) {
      return new LearningPathCatalog(
        [],
        new Map(),
        [`${path.join(directory, SKILLS_FILENAME)} is missing`],
        names.map((name) => name.replace(/\.ya?ml$/, '')),
      );
    }

    const read = async (name: string): Promise<LearningPathSource> => {
      const source = path.join(directory, name);
      return { text: await readFile(source, 'utf8'), source, expectedId: name.replace(/\.ya?ml$/, '') };
    };
    const skills = await read(SKILLS_FILENAME);
    const paths = await Promise.all(names.filter((name) => name !== SKILLS_FILENAME).map(read));
    return LearningPathCatalog.build({ skills, paths }, labs);
  }
}

function describe(cause: unknown, source: string): string {
  return cause instanceof LearningPathDefinitionError ? cause.format() : `${source}: ${(cause as Error).message}`;
}
