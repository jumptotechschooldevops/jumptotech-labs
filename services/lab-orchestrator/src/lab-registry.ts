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
  labHasSetup,
  loadLabDefinition,
  type LoadedLabDefinition,
} from './lab-definition.js';
import { assertValidLabId } from './validation.js';
import {
  TrackDefinitionError,
  loadTrackDefinition,
  type TrackDefinition,
} from './track-definition.js';

/**
 * A prerequisite, resolved against the registry so the UI can render a title
 * rather than a bare id.
 */
export interface PrerequisiteSummary {
  id: string;
  title: string;
  /** False when the prerequisite id does not resolve to a registered lab. */
  available: boolean;
}

/** Catalog card data. Everything the list view needs, nothing it does not. */
export interface LabSummary {
  id: string;
  slug: string;
  title: string;
  track: string;
  /** Which sandbox backend this lab needs. Lab metadata, never a UI decision. */
  provider: string;
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
  prerequisites: PrerequisiteSummary[];
  /** How many progressive hints exist. The text itself is not in the catalog. */
  hintCount: number;
}

export interface TopicSummary {
  topic: string;
  title: string;
  labCount: number;
}

export interface TrackSummary {
  track: string;
  title: string;
  /** One-line description from `labs/<track>/track.yaml`, when present. */
  tagline?: string;
  labCount: number;
  topics: TopicSummary[];
  difficulties: string[];
  /** The providers this track's labs declare, in first-appearance order. */
  providers: string[];
  /** Catalog sort position. Tracks without one sort last, alphabetically. */
  order?: number;
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

/**
 * Known track display names, for slugs whose title-cased form is wrong.
 *
 * Consulted only when a track declares no title of its own: a track's preferred
 * title comes from its `track.yaml`, and title-casing covers everything else.
 * That is why adding `labs/<anything>/` with a valid lab produces a correctly
 * labelled catalog section with no code change — this table exists for `aws`,
 * which title-cases to the wrong thing.
 */
const TRACK_TITLES: Record<string, string> = {
  kubernetes: 'Kubernetes',
  linux: 'Linux',
  terraform: 'Terraform',
  docker: 'Docker',
  aws: 'AWS',
};

/**
 * One line describing what a track is for, shown on the catalog's track cards.
 *
 * Data, not logic: a new track adds an entry rather than a branch in React.
 * An unknown track simply has no tagline, and the UI renders without one.
 */
const TRACK_TAGLINES: Record<string, string> = {
  kubernetes: 'CKA-oriented Kubernetes practice on a live cluster',
  linux: 'Linux for DevOps engineers, on a real shell',
  terraform: 'Infrastructure as code, applied in a private sandbox',
  docker: 'Containers from the command line up',
  aws: 'Cloud fundamentals, on scoped throwaway credentials',
};

export function trackTitle(track: string): string {
  return TRACK_TITLES[track] ?? titleCase(track);
}

export function trackTagline(track: string): string | undefined {
  return TRACK_TAGLINES[track];
}

export class LabRegistry {
  #labs = new Map<string, LoadedLabDefinition>();
  #slugs = new Map<string, string>();
  #tracks = new Map<string, TrackDefinition>();
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
    this.#tracks.clear();
    this.#loadErrors = [];

    await this.#loadTrackMetadata();

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

    // Prerequisites can only be checked once every lab is known, so this is a
    // second pass rather than part of per-file validation.
    this.#validatePrerequisites();

    this.#loaded = true;
  }

  /**
   * Reject prerequisite graphs that cannot be satisfied.
   *
   * Two failure modes, both authoring bugs that would otherwise surface as a
   * confusing catalog: a prerequisite naming a lab that does not exist, and a
   * cycle, which would describe a lab that can never be reached.
   *
   * The offending lab is *unregistered*, matching how an invalid definition is
   * treated — a lab whose stated path into it is broken should not be offered.
   */
  #validatePrerequisites(): void {
    /*
     * Iterate to a fixed point.
     *
     * Unregistering one lab can invalidate another: removing a cycle
     * participant leaves the labs that depended on it with a prerequisite that
     * no longer resolves. A single pass would leave those behind pointing at a
     * lab the catalog does not contain, so the checks re-run until a pass
     * removes nothing.
     */
    for (;;) {
      let removedAny = false;

      for (const def of [...this.#labs.values()]) {
        const missing = def.prerequisites.filter((id) => !this.#labs.has(id));
        if (missing.length === 0) continue;
        this.#loadErrors.push(
          `LAB_DEFINITION_INVALID\n\n${def.id}:\nprerequisites reference unknown lab(s): ${missing.join(', ')}\n(${def.sourcePath})`,
        );
        this.#unregister(def);
        removedAny = true;
      }

      for (const def of [...this.#labs.values()]) {
        const cycle = this.#findPrerequisiteCycle(def.id);
        if (!cycle) continue;
        this.#loadErrors.push(
          `LAB_DEFINITION_INVALID\n\n${def.id}:\nprerequisites form a cycle: ${cycle.join(' → ')}\n(${def.sourcePath})`,
        );
        this.#unregister(def);
        removedAny = true;
      }

      if (!removedAny) return;
    }
  }

  #unregister(def: LoadedLabDefinition): void {
    this.#labs.delete(def.id);
    this.#slugs.delete(def.slug);
  }

  /** Depth-first walk from one lab, returning the cycle path if it loops back. */
  #findPrerequisiteCycle(start: string): string[] | null {
    const path: string[] = [];
    const onPath = new Set<string>();

    const walk = (id: string): string[] | null => {
      if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
      const def = this.#labs.get(id);
      if (!def) return null;

      path.push(id);
      onPath.add(id);
      for (const prerequisite of def.prerequisites) {
        const found = walk(prerequisite);
        if (found) return found;
      }
      path.pop();
      onPath.delete(id);
      return null;
    };

    return walk(start);
  }

  /**
   * Read the optional `track.yaml` beside each track's labs.
   *
   * A malformed one is recorded as a load error but never prevents the track's
   * labs from loading: presentation metadata going wrong should not take a
   * working track out of the catalog.
   */
  async #loadTrackMetadata(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.labsDir, { withFileTypes: true });
    } catch {
      // The missing-directory case is already reported by `#findLabFiles`.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.labsDir, entry.name, 'track.yaml');
      try {
        const definition = await loadTrackDefinition(file);
        if (definition) this.#tracks.set(entry.name, definition);
      } catch (cause) {
        this.#loadErrors.push(
          cause instanceof TrackDefinitionError
            ? `${cause.format()}\n(${file})`
            : `${file}: ${(cause as Error).message}`,
        );
      }
    }
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
      .map((def) => this.summarise(def));
  }

  /** Every lab in one track, in catalog order. */
  labsForTrack(track: string): LabSummary[] {
    return this.list({ track });
  }

  /** Catalog projection for one definition, with prerequisites resolved. */
  summarise(def: LoadedLabDefinition): LabSummary {
    return { ...toSummary(def), prerequisites: this.prerequisitesOf(def) };
  }

  /**
   * Resolve a lab's prerequisite ids to titles.
   *
   * `available: false` cannot occur for a registered lab — `#validatePrerequisites`
   * unregisters labs with dangling prerequisites — but the field is carried so
   * callers holding an unregistered definition still render something honest.
   */
  prerequisitesOf(def: LoadedLabDefinition): PrerequisiteSummary[] {
    return def.prerequisites.map((id) => {
      const found = this.#labs.get(id);
      return found
        ? { id, title: found.title, available: true }
        : { id, title: id, available: false };
    });
  }

  /**
   * Tracks present in the catalog, derived from the labs themselves.
   *
   * A track exists because labs declare it. `track.yaml` may then refine how it
   * is presented — title, tagline, order — but nothing here enumerates a list
   * of known tracks, so a new one appears purely by adding lab definitions.
   */
  tracks(): TrackSummary[] {
    const byTrack = new Map<string, LoadedLabDefinition[]>();
    for (const def of this.all()) {
      const bucket = byTrack.get(def.track);
      if (bucket) bucket.push(def);
      else byTrack.set(def.track, [def]);
    }

    return [...byTrack.entries()]
      .map(([track, labs]) => {
        const meta = this.#tracks.get(track);
        return {
          track,
          title: meta?.title ?? trackTitle(track),
          labCount: labs.length,
          topics: topicsOf(labs),
          difficulties: [...new Set(labs.map((l) => l.difficulty))].sort(byDifficulty),
          providers: [...new Set(labs.map((l) => l.environment.provider))],
          ...(meta?.tagline ? { tagline: meta.tagline } : {}),
          ...(meta?.order !== undefined ? { order: meta.order } : {}),
        };
      })
      .sort(byTrackOrder);
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

/**
 * Catalog order for tracks.
 *
 * A track with a declared `order` comes first, lowest first. Undeclared tracks
 * follow, alphabetically — so a labs directory where only some tracks carry a
 * `track.yaml` still produces a stable, sensible listing.
 */
function byTrackOrder(a: TrackSummary, b: TrackSummary): number {
  const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.track.localeCompare(b.track);
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

/**
 * Catalog-safe projection.
 *
 * Deliberately excludes `requirements`, `setup`, and `reset`: the catalog is a
 * public listing, and the expected end state of a lab — especially a
 * troubleshooting lab's injected fault — is not something a student should be
 * able to read before starting.
 */
function toSummary(def: LoadedLabDefinition): LabSummary {
  return {
    id: def.id,
    slug: def.slug,
    title: def.title,
    track: def.track,
    provider: def.environment.provider,
    topic: def.topic,
    topicTitle: titleCase(def.topic),
    difficulty: def.difficulty,
    level: def.level,
    durationMinutes: def.duration_minutes,
    order: def.order,
    summary: def.task.summary,
    skills: def.skills,
    hasSetup: labHasSetup(def),
    certifications: def.certification.filter((c) => c.relevant).map((c) => c.certification),
    prerequisites: def.prerequisites.map((id) => ({ id, title: id, available: false })),
    hintCount: def.hints.length,
  };
}

function describeLoadFailure(file: string, cause: unknown): string {
  if (cause instanceof LabDefinitionError) {
    return `${cause.format()}\n(${file})`;
  }
  return `${file}: ${(cause as Error).message}`;
}
