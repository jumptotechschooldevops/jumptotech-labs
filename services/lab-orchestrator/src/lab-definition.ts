/**
 * Lab definition schema + loader.
 *
 * A lab is a declarative YAML document under `labs/<track>/<dir>/lab.yaml`.
 * Nothing in the frontend, the API routes, the orchestrator, or the verifier
 * hardcodes lab content: adding `labs/kubernetes/k8s-011-example/lab.yaml` is
 * sufficient to make a new lab appear in the catalog and become verifiable.
 *
 * The schema is strict on purpose:
 *   - Every object is `.strict()`, so an unknown key is an error rather than
 *     silently ignored data.
 *   - `requirements[]` is drawn from the closed vocabulary in
 *     `requirements.ts`. There is no requirement type that executes anything,
 *     and no field anywhere in this schema carries a command, script, or
 *     shell fragment.
 *   - Setup manifest paths are confined to the lab's own directory.
 *   - At least one reference must point at official upstream documentation.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { LAB_ID_PATTERN } from './validation.js';
import { isSupportedRequirementType, REQUIREMENT_TYPES, requirementSchema } from './requirements.js';

/**
 * Official documentation hosts, per track.
 *
 * The platform's content rule is that Kubernetes teaching material is written
 * from upstream documentation. This is data, not logic — a new track adds an
 * entry here rather than a branch anywhere else.
 */
export const OFFICIAL_DOC_HOSTS: Record<string, readonly string[]> = {
  kubernetes: ['kubernetes.io', 'www.kubernetes.io', 'github.com/kubernetes'],
};

/**
 * Hosts that must never appear in a lab definition.
 *
 * Lab wording, scenarios, hints, and verification are original JumpToTech
 * content. Referencing a commercial training platform would both breach that
 * rule and mislead students about the source of truth.
 */
export const DISALLOWED_DOC_HOSTS: readonly string[] = [
  'kodekloud.com',
  'udemy.com',
  'acloudguru.com',
  'pluralsight.com',
  'linuxacademy.com',
  'whizlabs.com',
  'examtopics.com',
];

const referenceSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z
      .string()
      .url()
      .refine((u) => /^https:\/\//i.test(u), { message: 'reference url must be https' }),
  })
  .strict();

const hintSchema = z
  .object({
    /** 1 = nudge, 2 = where to look, 3 = concrete guidance. Never a full solution. */
    level: z.number().int().min(1).max(5),
    text: z.string().min(1).max(2000),
  })
  .strict();

const certificationSchema = z
  .object({
    certification: z.string().min(1).max(32),
    relevant: z.boolean(),
    /**
     * Exam domain slugs. Deliberately free-form strings: official objectives
     * and their weights change, and nothing in application logic may depend on
     * a fixed set. Percentages are intentionally absent.
     */
    domains: z.array(z.string().min(1).max(64)).default([]),
  })
  .strict();

/**
 * A path to a manifest inside the lab directory.
 *
 * Rejects absolute paths, parent traversal, and backslashes before the loader
 * ever touches the filesystem.
 */
const manifestPath = z
  .string()
  .min(1)
  .max(255)
  .refine((p) => !path.isAbsolute(p), { message: 'manifest path must be relative to the lab directory' })
  .refine((p) => !p.includes('\\'), { message: 'manifest path must use forward slashes' })
  .refine((p) => !p.split('/').includes('..'), { message: 'manifest path must not traverse upwards' })
  .refine((p) => /\.ya?ml$/i.test(p), { message: 'manifest path must be a .yaml file' });

const setupSchema = z
  .object({
    /** Applied into the session namespace, in order, before the terminal opens. */
    manifests: z.array(manifestPath).max(10).default([]),
    /**
     * Checks that must pass before the lab is handed to the student. Reuses the
     * requirement vocabulary, so setup verification and solution verification
     * run through exactly the same registry.
     */
    verify: z.array(requirementSchema).max(20).default([]),
    /** How long to poll `verify` before declaring the setup broken. */
    verify_timeout_seconds: z.number().int().min(1).max(600).default(180),
  })
  .strict();

const resetSchema = z
  .object({
    /** Namespaced kinds a reset is allowed to purge before re-applying setup. */
    purge_namespaced_resources: z
      .array(z.string().min(1).max(63))
      .default([
        'pods',
        'deployments',
        'replicasets',
        'statefulsets',
        'daemonsets',
        'jobs',
        'cronjobs',
        'services',
        'configmaps',
        'secrets',
        'ingresses',
      ]),
    /** Objects the cluster or the platform owns, which must survive a reset. */
    protected_resources: z.array(z.string().min(1).max(253)).default([]),
  })
  .strict();

const labDefinitionSchema = z
  .object({
    id: z.string().regex(LAB_ID_PATTERN, 'lab id must look like K8S-001'),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug must be kebab-case'),
    title: z.string().min(1).max(120),
    track: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'track must be kebab-case'),
    topic: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'topic must be kebab-case'),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
    level: z.enum(['practice', 'challenge', 'assessment']).default('practice'),
    duration_minutes: z.number().int().positive().max(600),
    /** Sort position within the track. Ties fall back to lab id. */
    order: z.number().int().min(0).max(9999).default(0),

    environment: z
      .object({
        provider: z.enum(['kubernetes']),
        /** Only namespace isolation exists today; the field keeps the seam visible. */
        isolation: z.enum(['namespace']).default('namespace'),
      })
      .strict(),

    task: z
      .object({
        summary: z.string().min(1).max(400),
        description: z.string().min(1).max(4000),
      })
      .strict(),

    requirements: z.array(requirementSchema).min(1).max(20),

    setup: setupSchema.default({ manifests: [], verify: [], verify_timeout_seconds: 180 }),
    reset: resetSchema.default({}),

    hints: z.array(hintSchema).max(5).default([]),
    references: z.array(referenceSchema).min(1).max(10),
    skills: z
      .array(
        z
          .string()
          .min(3)
          .max(64)
          .regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, 'skill must be dotted lowercase, e.g. kubernetes.pods.create'),
      )
      .min(1)
      .max(12),
    certification: z.array(certificationSchema).max(6).default([]),
  })
  .strict();

export type LabDefinition = z.infer<typeof labDefinitionSchema>;
export type LabReference = z.infer<typeof referenceSchema>;
export type LabHint = z.infer<typeof hintSchema>;
export type LabCertification = z.infer<typeof certificationSchema>;
export type LabSetup = z.infer<typeof setupSchema>;

/** A lab definition that also knows where it came from. */
export interface LoadedLabDefinition extends LabDefinition {
  /** Absolute path of the directory containing lab.yaml. Setup manifests resolve against it. */
  readonly directory: string;
  readonly sourcePath: string;
}

export class LabDefinitionError extends Error {
  readonly code = 'LAB_DEFINITION_INVALID';
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
    readonly labId?: string,
  ) {
    super(message);
    this.name = 'LabDefinitionError';
  }

  /**
   * The operator-facing form required by the story:
   *
   *   LAB_DEFINITION_INVALID
   *
   *   K8S-004:
   *   requirements[1].type is not supported
   */
  format(): string {
    const heading = this.labId ? `${this.labId}:` : `${this.path}:`;
    const body = this.issues.length > 0 ? this.issues.join('\n') : this.message;
    return `${this.code}\n\n${heading}\n${body}`;
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
 * Report unsupported requirement types before schema parsing.
 *
 * A union failure would otherwise produce a wall of per-variant errors; this
 * yields the single precise line the story asks for.
 */
function checkRequirementTypes(raw: unknown, field: string, issues: string[]): void {
  const list = (raw as { [k: string]: unknown })?.[field];
  if (!Array.isArray(list)) return;
  list.forEach((entry, index) => {
    const type = (entry as { type?: unknown } | null)?.type;
    if (type === undefined) {
      issues.push(`${field}[${index}].type is missing`);
      return;
    }
    if (!isSupportedRequirementType(type)) {
      issues.push(
        `${field}[${index}].type is not supported ('${String(type)}'; supported types: ${REQUIREMENT_TYPES.join(', ')})`,
      );
    }
  });
}

function checkReferences(def: LabDefinition, issues: string[]): void {
  const hosts = def.references.map((ref) => {
    try {
      return new URL(ref.url).hostname.toLowerCase();
    } catch {
      return '';
    }
  });

  for (const [index, host] of hosts.entries()) {
    const banned = DISALLOWED_DOC_HOSTS.find((bad) => host === bad || host.endsWith(`.${bad}`));
    if (banned) {
      issues.push(
        `references[${index}].url points at '${banned}'. Lab content must be written from official documentation only.`,
      );
    }
  }

  const official = OFFICIAL_DOC_HOSTS[def.track];
  if (official && !hosts.some((host) => official.some((allowed) => host === allowed || allowed.startsWith(`${host}/`)))) {
    issues.push(
      `references must include at least one official ${def.track} documentation link (${official.join(', ')})`,
    );
  }
}

/** Parse and validate a lab definition from raw YAML text. */
export function parseLabDefinition(yamlText: string, sourcePath = '<inline>'): LabDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new LabDefinitionError(
      `Invalid YAML in lab definition: ${(cause as Error).message}`,
      sourcePath,
    );
  }

  const declaredId = typeof (raw as { id?: unknown })?.id === 'string' ? String((raw as { id: string }).id) : undefined;

  // Precise messages for the most common authoring mistake, before the union.
  const preIssues: string[] = [];
  checkRequirementTypes(raw, 'requirements', preIssues);
  checkRequirementTypes((raw as { setup?: unknown })?.setup, 'verify', preIssues);
  if (preIssues.length > 0) {
    throw new LabDefinitionError(
      `Lab definition failed validation (${preIssues.length} issue${preIssues.length === 1 ? '' : 's'})`,
      sourcePath,
      preIssues,
      declaredId,
    );
  }

  const result = labDefinitionSchema.safeParse(raw);
  if (!result.success) {
    const issues = issueLines(result.error);
    throw new LabDefinitionError(
      `Lab definition failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
      declaredId,
    );
  }

  const def = result.data;
  const issues: string[] = [];

  checkReferences(def, issues);

  const duplicateSkills = def.skills.filter((skill, i, all) => all.indexOf(skill) !== i);
  if (duplicateSkills.length > 0) {
    issues.push(`skills contains duplicates: ${[...new Set(duplicateSkills)].join(', ')}`);
  }

  const hintLevels = def.hints.map((h) => h.level);
  if (hintLevels.some((level, i) => hintLevels.indexOf(level) !== i)) {
    issues.push('hints must have distinct levels');
  }
  if (hintLevels.some((level, i) => i > 0 && level <= (hintLevels[i - 1] ?? 0))) {
    issues.push('hints must be ordered by ascending level');
  }

  // A lab whose setup declares manifests but no verification would hand the
  // student an environment nobody checked.
  if (def.setup.manifests.length > 0 && def.setup.verify.length === 0) {
    issues.push('setup.verify must describe at least one check when setup.manifests is non-empty');
  }

  if (issues.length > 0) {
    throw new LabDefinitionError(
      `Lab definition failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
      def.id,
    );
  }

  return def;
}

/** Read and validate a lab definition from disk. */
export async function loadLabDefinition(filePath: string): Promise<LoadedLabDefinition> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new LabDefinitionError(
      `Cannot read lab definition: ${(cause as Error).message}`,
      filePath,
    );
  }
  const def = parseLabDefinition(text, filePath);
  return { ...def, directory: path.dirname(filePath), sourcePath: filePath };
}

/**
 * Resolve a declared manifest path to an absolute path inside the lab directory.
 *
 * The schema already rejects `..` and absolute paths; this re-checks the
 * resolved result so a symlinked or unusual path cannot escape either.
 */
export function resolveManifestPath(lab: LoadedLabDefinition, relative: string): string {
  const resolved = path.resolve(lab.directory, relative);
  const root = path.resolve(lab.directory) + path.sep;
  if (!resolved.startsWith(root)) {
    throw new LabDefinitionError(
      `Setup manifest '${relative}' resolves outside the lab directory`,
      lab.sourcePath,
      [],
      lab.id,
    );
  }
  return resolved;
}
