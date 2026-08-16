/**
 * Lab registry — discovery, validation, and the catalog projection.
 *
 * Startup contract:
 *   1. discover every `lab.yaml` under the labs directory
 *   2. validate each against the schema in `lab-definition.ts`
 *   3. reject invalid definitions, recording *why*
 *   4. reject duplicate ids and duplicate slugs
 *   5. register what survived
 *
 * Nothing here is lab-specific. Dropping in a new directory containing a valid
 * `lab.yaml` is the entire process for adding a lab: the catalog, the lab page,
 * the verifier, and the setup/reset machinery all read from this registry.
 *
 * Cost note: the registry is pure in-memory data. Browsing the catalog reads
 * from these maps and never touches Kubernetes.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  LabDefinitionError,
  loadLabDefinition,
  type LoadedLabDefinition,
} from './lab-definition.js';
import { assertValidLabId } from './validation.js';

/** Catalog card data. Everything the list view needs, nothing it does not. */
export interface LabSummary {
  id: string;
  slug: string;
  title: string;
  track: string;
  topic: string;
  topicTitle: string;
  difficulty: string;
  level: string;
  durationMinutes: number;
  order: number;
  summary: string;
  skills: string[];
  /** True when the lab pre-creates resources the student starts from. */
  hasSetup: boolean;
  certifications: string[];
}

export interface TopicSummary {
  topic: string;
  title: string;
  labCount: number;
}

export interface TrackSummary {
  track: string;
  title: string;
  labCount: number;
  topics: TopicSummary[];
  difficulties: string[];
}

export interface LabFilter {
  track?: string | undefined;
  topic?: string | undefined;
  difficulty?: string | undefined;
  level?: string | undefined;
  /** Free-text match over id, title, and summary. */
  q?: string | undefined;
}

export class LabNotFoundError extends Error {
  readonly code = 'LAB_NOT_FOUND';
  constructor(labId: string) {
    super(`Lab ${labId} not found`);
    this.name = 'LabNotFoundError';
  }
}

/** `deployments` → `Deployments`, `rolling-update` → `Rolling Update`. */
export function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Track display names. Falls back to title-casing an unknown track slug. */
const TRACK_TITLES: Record<string, string> = {
  kubernetes: 'Kubernetes',
};

export function trackTitle(track: string): string {
  return TRACK_TITLES[track] ?? titleCase(track);
}

export class LabRegistry {
  #labs = new Map<string, LoadedLabDefinition>();
  #slugs = new Map<string, string>();
  #loaded = false;
  #loadErrors: string[] = [];

  constructor(private readonly labsDir: string) {}

  get loadErrors(): readonly string[] {
    return this.#loadErrors;
  }

  get size(): number {
    return this.#labs.size;
  }

  /** Scan the labs directory. Safe to call repeatedly; `force` re-reads disk. */
  async load(force = false): Promise<void> {
    if (this.#loaded && !force) return;

    this.#labs.clear();
    this.#slugs.clear();
    this.#loadErrors = [];

    const files = (await this.#findLabFiles(this.labsDir)).sort();
    for (const file of files) {
      let def: LoadedLabDefinition;
      try {
        def = await loadLabDefinition(file);
      } catch (cause) {
        this.#loadErrors.push(describeLoadFailure(file, cause));
        continue;
      }

      // Rejected, not merged: two labs claiming one id would make `/api/labs/:id`
      // ambiguous, and two claiming one slug would break stable catalog links.
      const existing = this.#labs.get(def.id);
      if (existing) {
        this.#loadErrors.push(
          `LAB_DEFINITION_INVALID\n\n${def.id}:\nduplicate lab id — already defined by ${existing.sourcePath} (${file})`,
        );
        continue;
      }
      const slugOwner = this.#slugs.get(def.slug);
      if (slugOwner) {
        this.#loadErrors.push(
          `LAB_DEFINITION_INVALID\n\n${def.id}:\nduplicate slug '${def.slug}' — already used by ${slugOwner} (${file})`,
        );
        continue;
      }

      this.#labs.set(def.id, def);
      this.#slugs.set(def.slug, def.id);
    }

    this.#loaded = true;
  }

  async #findLabFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      this.#loadErrors.push(`cannot read labs directory ${dir}: ${(cause as Error).message}`);
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.#findLabFiles(full)));
      } else if (entry.isFile() && entry.name === 'lab.yaml') {
        files.push(full);
      }
    }
    return files;
  }

  /** Every registered definition, in catalog order. */
  all(): LoadedLabDefinition[] {
    return [...this.#labs.values()].sort(byCatalogOrder);
  }

  list(filter: LabFilter = {}): LabSummary[] {
    const q = filter.q?.trim().toLowerCase();
    return this.all()
      .filter((def) => {
        if (filter.track && def.track !== filter.track) return false;
        if (filter.topic && def.topic !== filter.topic) return false;
        if (filter.difficulty && def.difficulty !== filter.difficulty) return false;
        if (filter.level && def.level !== filter.level) return false;
        if (q) {
          const haystack = `${def.id} ${def.title} ${def.task.summary} ${def.topic}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .map(toSummary);
  }

  tracks(): TrackSummary[] {
    const byTrack = new Map<string, LoadedLabDefinition[]>();
    for (const def of this.all()) {
      const bucket = byTrack.get(def.track);
      if (bucket) bucket.push(def);
      else byTrack.set(def.track, [def]);
    }

    return [...byTrack.entries()]
      .map(([track, labs]) => ({
        track,
        title: trackTitle(track),
        labCount: labs.length,
        topics: topicsOf(labs),
        difficulties: [...new Set(labs.map((l) => l.difficulty))].sort(byDifficulty),
      }))
      .sort((a, b) => a.track.localeCompare(b.track));
  }

  track(name: string): TrackSummary | null {
    return this.tracks().find((t) => t.track === name) ?? null;
  }

  /** Topics present in a track, in first-appearance (catalog) order. */
  topics(track?: string): TopicSummary[] {
    return topicsOf(this.all().filter((def) => !track || def.track === track));
  }

  /** Look up a lab by (already validated or raw) id. Throws on bad id or miss. */
  get(labId: string): LoadedLabDefinition {
    const canonical = assertValidLabId(labId);
    const def = this.#labs.get(canonical);
    if (!def) throw new LabNotFoundError(canonical);
    return def;
  }

  getBySlug(slug: string): LoadedLabDefinition | null {
    const id = this.#slugs.get(slug);
    return id ? (this.#labs.get(id) ?? null) : null;
  }

  has(labId: string): boolean {
    try {
      this.get(labId);
      return true;
    } catch {
      return false;
    }
  }
}

const DIFFICULTY_RANK: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };

function byDifficulty(a: string, b: string): number {
  return (DIFFICULTY_RANK[a] ?? 99) - (DIFFICULTY_RANK[b] ?? 99);
}

function byCatalogOrder(a: LoadedLabDefinition, b: LoadedLabDefinition): number {
  if (a.track !== b.track) return a.track.localeCompare(b.track);
  if (a.order !== b.order) return a.order - b.order;
  return a.id.localeCompare(b.id);
}

function topicsOf(labs: LoadedLabDefinition[]): TopicSummary[] {
  const counts = new Map<string, number>();
  for (const def of [...labs].sort(byCatalogOrder)) {
    counts.set(def.topic, (counts.get(def.topic) ?? 0) + 1);
  }
  return [...counts.entries()].map(([topic, labCount]) => ({
    topic,
    title: titleCase(topic),
    labCount,
  }));
}

function toSummary(def: LoadedLabDefinition): LabSummary {
  return {
    id: def.id,
    slug: def.slug,
    title: def.title,
    track: def.track,
    topic: def.topic,
    topicTitle: titleCase(def.topic),
    difficulty: def.difficulty,
    level: def.level,
    durationMinutes: def.duration_minutes,
    order: def.order,
    summary: def.task.summary,
    skills: def.skills,
    hasSetup: def.setup.manifests.length > 0,
    certifications: def.certification.filter((c) => c.relevant).map((c) => c.certification),
  };
}

function describeLoadFailure(file: string, cause: unknown): string {
  if (cause instanceof LabDefinitionError) {
    return `${cause.format()}\n(${file})`;
  }
  return `${file}: ${(cause as Error).message}`;
}
