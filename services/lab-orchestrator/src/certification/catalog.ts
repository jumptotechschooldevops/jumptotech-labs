/**
 * Certification objective catalogs.
 *
 * A catalog is the machine-readable copy of a vendor's *published* exam content
 * list: `labs/<track>/certification-<version>.yaml`. It is deliberately the only
 * place an objective id is defined. Labs, study units, questions and exams all
 * *reference* objective ids; none of them may invent one.
 *
 * That asymmetry is the whole point. A lab that claims `9z` fails to load
 * rather than quietly inflating our coverage figures, and an objective the
 * vendor publishes but nothing in the curriculum touches shows up as a gap
 * instead of being invisible.
 *
 * Nothing here is Terraform-specific. A CKA or LFCS catalog is another file in
 * another track directory; the schema, the loader and the coverage gate do not
 * change.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

/** `TERRAFORM-ASSOCIATE-004` — matches the lab schema's `certification` field. */
export const CERTIFICATION_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,31}$/;

/**
 * `1a`, `4h`, `12`, `services-and-networking`.
 *
 * Deliberately permissive: vendors number objectives however they like, and the
 * catalog is the authority on which ids exist. What this pattern buys is that an
 * id is a short opaque token — never a path, a URL, or anything that could be
 * mistaken for one.
 */
export const OBJECTIVE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,31}$/i;

/**
 * How JumpToTech intends to teach an objective.
 *
 * `hands-on` — it can be practised for real in an offline sandbox, so the
 *   curriculum owes it a lab whose verification reads a real result.
 * `conceptual` — it cannot be (a remote service, a paid platform, or knowledge
 *   with no artefact to inspect), so the curriculum owes it a study unit and
 *   assessment questions instead.
 *
 * This is our decision, not the vendor's. It is recorded in the catalog so the
 * coverage gate can hold us to it rather than accepting a multiple-choice
 * question in place of practice that was actually possible.
 */
export const PRACTICE_MODES = ['hands-on', 'conceptual'] as const;
export type PracticeMode = (typeof PRACTICE_MODES)[number];

const referenceSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z
      .string()
      .url()
      .refine((u) => /^https:\/\//i.test(u), { message: 'reference url must be https' }),
  })
  .strict();

const objectiveSchema = z
  .object({
    id: z.string().regex(OBJECTIVE_ID_PATTERN, 'objective id must be a short token such as 4h'),
    /** The vendor's own wording. Not paraphrased — this is what we are mapping to. */
    title: z.string().min(1).max(240),
    practice: z.enum(PRACTICE_MODES),
    /** Official documentation for this objective. At least one is required. */
    references: z.array(referenceSchema).min(1).max(8),
  })
  .strict();

const domainSchema = z
  .object({
    id: z.string().regex(OBJECTIVE_ID_PATTERN, 'domain id must be a short token such as 4'),
    title: z.string().min(1).max(160),
    objectives: z.array(objectiveSchema).min(1).max(40),
  })
  .strict();

const catalogSchema = z
  .object({
    id: z.string().regex(CERTIFICATION_ID_PATTERN, 'certification id must look like TERRAFORM-ASSOCIATE-004'),
    name: z.string().min(1).max(160),
    short_name: z.string().min(1).max(80),
    vendor: z.string().min(1).max(80),
    /** The learning track whose labs may claim this certification. */
    track: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'track must be kebab-case'),
    exam_version: z.string().min(1).max(16),
    product: z.string().min(1).max(64),
    /**
     * The product version the exam states it tests.
     *
     * Held as data so the platform can compare it with what the sandbox image
     * actually ships and report the difference, rather than letting a version
     * drift sit undocumented between a lab and the exam it claims to prepare
     * for.
     */
    product_version: z.string().min(1).max(32),
    /** When a human last checked this file against the published objectives. */
    reviewed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'reviewed_on must be an ISO date'),
    notes: z.string().max(2000).optional(),
    sources: z.array(referenceSchema).min(1).max(12),
    domains: z.array(domainSchema).min(1).max(20),
  })
  .strict();

export type CertificationReference = z.infer<typeof referenceSchema>;
export type CertificationObjective = z.infer<typeof objectiveSchema>;
export type CertificationDomain = z.infer<typeof domainSchema>;
export type CertificationCatalogData = z.infer<typeof catalogSchema>;

export class CertificationCatalogError extends Error {
  readonly code = 'CERTIFICATION_CATALOG_INVALID';
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'CertificationCatalogError';
  }

  format(): string {
    const body = this.issues.length > 0 ? this.issues.join('\n') : this.message;
    return `${this.code}\n\n${this.path}:\n${body}`;
  }
}

/** An objective together with the domain it belongs to. */
export interface ObjectiveEntry {
  readonly domain: CertificationDomain;
  readonly objective: CertificationObjective;
}

/**
 * A validated catalog with lookups.
 *
 * Constructed once at startup and then read-only; every consumer (labs,
 * questions, exams, the coverage gate, the API) shares one instance.
 */
export class CertificationCatalog {
  readonly #byObjective = new Map<string, ObjectiveEntry>();
  readonly #byDomain = new Map<string, CertificationDomain>();

  constructor(
    readonly data: CertificationCatalogData,
    readonly sourcePath: string,
  ) {
    for (const domain of data.domains) {
      this.#byDomain.set(domain.id, domain);
      for (const objective of domain.objectives) {
        this.#byObjective.set(objective.id, { domain, objective });
      }
    }
  }

  get id(): string {
    return this.data.id;
  }

  get track(): string {
    return this.data.track;
  }

  get domains(): readonly CertificationDomain[] {
    return this.data.domains;
  }

  /** Every objective id, in published order. */
  objectiveIds(): string[] {
    return this.data.domains.flatMap((domain) => domain.objectives.map((o) => o.id));
  }

  objectives(): ObjectiveEntry[] {
    return this.data.domains.flatMap((domain) =>
      domain.objectives.map((objective) => ({ domain, objective })),
    );
  }

  objective(id: string): ObjectiveEntry | null {
    return this.#byObjective.get(id) ?? null;
  }

  hasObjective(id: string): boolean {
    return this.#byObjective.has(id);
  }

  domain(id: string): CertificationDomain | null {
    return this.#byDomain.get(id) ?? null;
  }

  /** The domain an objective belongs to, e.g. `4h` → domain `4`. */
  domainOf(objectiveId: string): CertificationDomain | null {
    return this.#byObjective.get(objectiveId)?.domain ?? null;
  }
}

export function parseCertificationCatalog(
  yamlText: string,
  sourcePath = '<inline>',
): CertificationCatalog {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new CertificationCatalogError(
      `Invalid YAML in certification catalog: ${(cause as Error).message}`,
      sourcePath,
    );
  }

  const result = catalogSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const location = issue.path
        .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
        .join('')
        .replace(/^\./, '');
      return `${location || '<root>'}: ${issue.message}`;
    });
    throw new CertificationCatalogError(
      `Certification catalog failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }

  const issues: string[] = [];
  const seenDomains = new Set<string>();
  const seenObjectives = new Set<string>();
  for (const domain of result.data.domains) {
    if (seenDomains.has(domain.id)) issues.push(`duplicate domain id '${domain.id}'`);
    seenDomains.add(domain.id);
    for (const objective of domain.objectives) {
      if (seenObjectives.has(objective.id)) {
        issues.push(`duplicate objective id '${objective.id}'`);
      }
      seenObjectives.add(objective.id);
    }
  }

  if (issues.length > 0) {
    throw new CertificationCatalogError(
      `Certification catalog failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }

  return new CertificationCatalog(result.data, sourcePath);
}

export async function loadCertificationCatalog(filePath: string): Promise<CertificationCatalog> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new CertificationCatalogError(
      `Cannot read certification catalog: ${(cause as Error).message}`,
      filePath,
    );
  }
  return parseCertificationCatalog(text, filePath);
}
