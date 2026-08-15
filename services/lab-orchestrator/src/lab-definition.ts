/**
 * Lab definition schema + loader.
 *
 * Labs are declarative YAML files under `labs/<track>/<slug>/lab.yaml`.
 * Nothing in the frontend or the verifier hardcodes lab content — both are
 * driven entirely by what is parsed here.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { LAB_ID_PATTERN } from './validation.js';

const documentationLinkSchema = z.object({
  title: z.string().min(1),
  // Only http(s) links may be rendered in the UI.
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), {
    message: 'documentation url must be http(s)',
  }),
});

export const CHECK_TYPES = [
  'pod_exists',
  'pod_namespace',
  'container_image',
  'pod_phase',
  'container_ready',
] as const;

const checkSchema = z.object({
  id: z.string().min(1),
  type: z.enum(CHECK_TYPES),
  label: z.string().min(1),
});

const labDefinitionSchema = z.object({
  id: z.string().regex(LAB_ID_PATTERN, 'lab id must look like K8S-001'),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug must be kebab-case'),
  title: z.string().min(1),
  track: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  duration_minutes: z.number().int().positive().max(600),

  environment: z.object({
    provider: z.string().min(1),
    namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/),
  }),

  task: z.object({
    summary: z.string().min(1),
    description: z.string().min(1),
  }),

  requirements: z.object({
    pod_name: z.string().min(1),
    namespace: z.string().min(1),
    image: z.string().min(1),
    status: z.string().min(1),
  }),

  requirement_labels: z.array(z.string().min(1)).min(1),
  hint: z.string().min(1),
  documentation: z.array(documentationLinkSchema).min(1),

  verification: z.object({
    checks: z.array(checkSchema).min(1),
  }),

  reset: z.object({
    purge_namespaced_resources: z.array(z.string().min(1)),
    protected_resources: z.array(z.string().min(1)).default([]),
    apply_manifests: z.array(z.string().min(1)).default([]),
  }),
});

export type LabDefinition = z.infer<typeof labDefinitionSchema>;
export type LabCheckDefinition = z.infer<typeof checkSchema>;
export type DocumentationLink = z.infer<typeof documentationLinkSchema>;

export class LabDefinitionError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'LabDefinitionError';
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

  const result = labDefinitionSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new LabDefinitionError(
      `Lab definition failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }

  const def = result.data;

  // Cross-field invariants the schema alone cannot express.
  if (def.requirements.namespace !== def.environment.namespace) {
    throw new LabDefinitionError(
      `requirements.namespace (${def.requirements.namespace}) must match environment.namespace (${def.environment.namespace})`,
      sourcePath,
    );
  }

  const duplicateCheckIds = def.verification.checks
    .map((c) => c.id)
    .filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicateCheckIds.length > 0) {
    throw new LabDefinitionError(
      `duplicate verification check ids: ${[...new Set(duplicateCheckIds)].join(', ')}`,
      sourcePath,
    );
  }

  return def;
}

/** Read and validate a lab definition from disk. */
export async function loadLabDefinition(filePath: string): Promise<LabDefinition> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new LabDefinitionError(
      `Cannot read lab definition: ${(cause as Error).message}`,
      filePath,
    );
  }
  return parseLabDefinition(text, filePath);
}
