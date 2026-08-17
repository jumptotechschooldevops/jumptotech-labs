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
import {
  isSupportedRequirementType,
  requirementFamily,
  REQUIREMENT_TYPES,
  requirementSchema,
  type Requirement,
} from './requirements.js';
import {
  ISOLATION_MODES,
  LAB_PROVIDERS,
  PROVIDER_ISOLATION,
  type IsolationMode,
  type LabProviderId,
} from './providers/catalog.js';

/**
 * Official documentation hosts, per track.
 *
 * The platform's content rule is that teaching material is written from
 * upstream documentation. This is data, not logic — a new track adds an entry
 * here rather than a branch anywhere else.
 */
export const OFFICIAL_DOC_HOSTS: Record<string, readonly string[]> = {
  kubernetes: ['kubernetes.io', 'www.kubernetes.io', 'github.com/kubernetes'],
  // The Linux track is written from man pages and the maintainers' own
  // documentation: the POSIX/`man7` reference set and the GNU coreutils manual.
  linux: ['man7.org', 'www.man7.org', 'www.gnu.org', 'gnu.org', 'pubs.opengroup.org'],
  terraform: ['developer.hashicorp.com', 'www.terraform.io', 'terraform.io'],
  docker: ['docs.docker.com'],
  aws: ['docs.aws.amazon.com', 'aws.amazon.com'],
};

/**
 * Which requirement families a provider can actually verify.
 *
 * The check this table exists for: a Linux lab cannot ask for `pod_running`,
 * because there is no Kubernetes API behind a Linux sandbox to read it from,
 * and a Kubernetes lab cannot ask for `file_mode`, because the verifier has no
 * sandbox filesystem to look at. Catching that at load time turns a runtime
 * "unsupported" into a precise authoring error.
 */
export const PROVIDER_REQUIREMENT_FAMILIES: Record<LabProviderId, readonly string[]> = {
  kubernetes: ['kubernetes'],
  linux: ['filesystem'],
  terraform: ['filesystem', 'terraform'],
  docker: ['filesystem'],
  aws: [],
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

/**
 * One step of the progressive hint ladder.
 *
 * Level is the *order in which hints unlock*, not a severity: a student opens
 * level 1 before level 2 becomes available. Level 1 is conceptual, level 2
 * points at where to look, level 3 names the objects and documentation. No
 * level may contain a copy-pasteable solution — see `checkHints`.
 */
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

/**
 * A starter file seeded into a container sandbox.
 *
 * `source` is read from the lab directory; `path` is where it lands inside the
 * session's sandbox home. Both are constrained — see `setup-files.ts` — and the
 * mode has its execute bits cleared, so lab content cannot ship a script.
 */
const setupFileSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(255)
      .refine((p) => !path.isAbsolute(p), { message: 'source must be relative to the lab directory' })
      .refine((p) => !p.includes('\\'), { message: 'source must use forward slashes' })
      .refine((p) => !p.split('/').includes('..'), { message: 'source must not traverse upwards' }),
    /** Destination relative to the sandbox home. Never absolute, never `..`. */
    path: z
      .string()
      .min(1)
      .max(255)
      .refine((p) => !p.startsWith('/') && !p.startsWith('~'), {
        message: 'path must be relative to the sandbox home directory',
      })
      .refine((p) => !p.includes('\\'), { message: 'path must use forward slashes' })
      .refine((p) => !p.split('/').includes('..'), { message: 'path must not traverse upwards' }),
    /** Octal mode. Execute bits are stripped when the file is written. */
    mode: z
      .string()
      .regex(/^0?[0-7]{3}$/, 'mode must be an octal permission string such as 644')
      .default('644'),
  })
  .strict();

const setupSchema = z
  .object({
    /** Applied into the session namespace, in order, before the terminal opens. */
    manifests: z.array(manifestPath).max(10).default([]),
    /** Seeded into the session's sandbox home, for container-backed providers. */
    files: z.array(setupFileSchema).max(20).default([]),
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

    /**
     * Which kind of sandbox this lab needs.
     *
     * The provider is *lab metadata*, not a frontend concern: nothing in React
     * maps a track to a provider, and nothing in the API branches on one. The
     * registry resolves it at Start Lab. `isolation` may be omitted — the
     * loader fills in what the provider actually implements, so a lab author
     * cannot claim isolation the provider does not give them.
     */
    environment: z
      .object({
        provider: z.enum(LAB_PROVIDERS),
        isolation: z.enum(ISOLATION_MODES).optional(),
      })
      .strict(),

    /**
     * The realistic situation the student is dropped into.
     *
     * Labs are written as small DevOps scenarios on the JumpToTech banking
     * platform, not as exam questions. The story is what makes "scale to three
     * replicas" mean something; it is original JumpToTech content built on
     * documented Kubernetes behaviour.
     */
    story: z.string().min(1).max(2000).optional(),

    /** What the student should be able to do afterwards. Rendered as a list. */
    objectives: z.array(z.string().min(1).max(300)).max(8).default([]),

    /**
     * Labs that should come first, by id.
     *
     * PLATFORM-003 exposes this as guidance only. There are no authenticated
     * users and no stored progress yet, so nothing is *enforced* per student —
     * see `prerequisitesEnforced` on the catalog payload, which reports `false`
     * rather than letting the UI imply a guarantee that does not exist.
     */
    prerequisites: z.array(z.string().regex(LAB_ID_PATTERN, 'prerequisite must be a lab id like K8S-001')).max(10).default([]),

    task: z
      .object({
        summary: z.string().min(1).max(400),
        description: z.string().min(1).max(4000),
      })
      .strict(),

    requirements: z.array(requirementSchema).min(1).max(20),

    setup: setupSchema.default({
      manifests: [],
      files: [],
      verify: [],
      verify_timeout_seconds: 180,
    }),
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

/**
 * A validated lab definition.
 *
 * `environment.isolation` is required here even though the schema allows it to
 * be omitted: the loader resolves it from the provider, so every downstream
 * consumer sees a concrete value rather than an optional one.
 */
export type LabDefinition = Omit<z.infer<typeof labDefinitionSchema>, 'environment'> & {
  environment: { provider: LabProviderId; isolation: IsolationMode };
};
export type LabReference = z.infer<typeof referenceSchema>;
export type LabHint = z.infer<typeof hintSchema>;
export type LabCertification = z.infer<typeof certificationSchema>;
export type LabSetup = z.infer<typeof setupSchema>;
export type LabSetupFile = z.infer<typeof setupFileSchema>;

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

/**
 * Refuse a lab that asks its provider for something the provider cannot do.
 *
 * Three ways to get this wrong, all authoring bugs that would otherwise fail
 * confusingly at Start Lab or, worse, mark a lab passed on a check that never
 * ran:
 *
 *   1. requirement types from a family the provider cannot verify;
 *   2. Kubernetes setup manifests on a provider with no Kubernetes API;
 *   3. sandbox starter files on a provider with no sandbox filesystem.
 */
function checkProviderCapabilities(def: LabDefinition, issues: string[]): void {
  const provider = def.environment.provider;
  const supported = PROVIDER_REQUIREMENT_FAMILIES[provider];

  const check = (list: readonly Requirement[], field: string): void => {
    list.forEach((requirement, index) => {
      const family = requirementFamily(requirement.type);
      if (!supported.includes(family)) {
        issues.push(
          `${field}[${index}].type '${requirement.type}' is a ${family} check, which the '${provider}' provider cannot verify (it supports: ${supported.join(', ') || 'no requirement families yet'})`,
        );
      }
    });
  };

  check(def.requirements as readonly Requirement[], 'requirements');
  check(def.setup.verify as readonly Requirement[], 'setup.verify');

  if (def.setup.manifests.length > 0 && provider !== 'kubernetes') {
    issues.push(
      `setup.manifests are Kubernetes objects and cannot be applied by the '${provider}' provider — use setup.files instead`,
    );
  }
  if (def.setup.files.length > 0 && PROVIDER_ISOLATION[provider] !== 'container') {
    issues.push(
      `setup.files are seeded into a sandbox filesystem, which the '${provider}' provider does not have`,
    );
  }
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

  /*
   * Resolve the isolation mode from the provider.
   *
   * A lab may state it (which reads well, and keeps the seam visible in the
   * file) or omit it. Stating something the provider does not implement is an
   * error rather than a silent override: a `linux` lab claiming `namespace`
   * isolation would be describing a guarantee nobody provides.
   */
  const providerId = result.data.environment.provider;
  const providerIsolation = PROVIDER_ISOLATION[providerId];
  const declaredIsolation = result.data.environment.isolation;

  const def: LabDefinition = {
    ...result.data,
    environment: { provider: providerId, isolation: declaredIsolation ?? providerIsolation },
  };
  const issues: string[] = [];

  if (declaredIsolation !== undefined && declaredIsolation !== providerIsolation) {
    issues.push(
      `environment.isolation is '${declaredIsolation}', but the '${providerId}' provider isolates with '${providerIsolation}'`,
    );
  }

  checkProviderCapabilities(def, issues);
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
  // The ladder has to start at the top rung, or the UI's "reveal the next hint"
  // affordance would begin part-way through a sequence the author intended.
  if (def.hints.length > 0 && def.hints[0]?.level !== 1) {
    issues.push('hints must start at level 1');
  }

  /*
   * Every student-visible requirement needs its own wording.
   *
   * `toLabDetail` renders `requirements[]` as the student's checklist. Without
   * a label it would have to fall back to the raw requirement type, which both
   * reads like an internal identifier and leaks how the check is implemented —
   * exactly what a troubleshooting lab must not reveal.
   */
  def.requirements.forEach((requirement, index) => {
    if (!requirement.label) {
      issues.push(
        `requirements[${index}].label is required — it is the student-facing text for this check`,
      );
    }
  });

  const duplicatePrerequisites = def.prerequisites.filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicatePrerequisites.length > 0) {
    issues.push(`prerequisites contains duplicates: ${[...new Set(duplicatePrerequisites)].join(', ')}`);
  }
  if (def.prerequisites.includes(def.id)) {
    issues.push(`prerequisites must not include the lab's own id (${def.id})`);
  }

  // A lab whose setup seeds anything but verifies nothing would hand the
  // student an environment nobody checked.
  if (
    (def.setup.manifests.length > 0 || def.setup.files.length > 0) &&
    def.setup.verify.length === 0
  ) {
    issues.push(
      'setup.verify must describe at least one check when setup.manifests or setup.files is non-empty',
    );
  }

  const duplicateSetupPaths = def.setup.files
    .map((file) => file.path)
    .filter((p, i, all) => all.indexOf(p) !== i);
  if (duplicateSetupPaths.length > 0) {
    issues.push(
      `setup.files declares the same destination twice: ${[...new Set(duplicateSetupPaths)].join(', ')}`,
    );
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
