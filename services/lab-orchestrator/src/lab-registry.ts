/**
 * Discovers and caches lab definitions from the labs/ directory tree.
 *
 * Layout: <labsDir>/<track>/<slug>/lab.yaml
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadLabDefinition, LabDefinitionError, type LabDefinition } from './lab-definition.js';
import { assertValidLabId } from './validation.js';
import type { LabContext } from './types.js';

export interface LabSummary {
  id: string;
  slug: string;
  title: string;
  track: string;
  difficulty: string;
  durationMinutes: number;
  summary: string;
}

export class LabNotFoundError extends Error {
  readonly code = 'LAB_NOT_FOUND';
  constructor(labId: string) {
    super(`Lab ${labId} not found`);
    this.name = 'LabNotFoundError';
  }
}

export class LabRegistry {
  #labs = new Map<string, LabDefinition>();
  #loaded = false;
  #loadErrors: string[] = [];

  constructor(private readonly labsDir: string) {}

  get loadErrors(): readonly string[] {
    return this.#loadErrors;
  }

  /** Scan the labs directory. Safe to call repeatedly; `force` re-reads disk. */
  async load(force = false): Promise<void> {
    if (this.#loaded && !force) return;

    this.#labs.clear();
    this.#loadErrors = [];

    const yamlFiles = await this.#findLabFiles(this.labsDir);
    for (const file of yamlFiles) {
      try {
        const def = await loadLabDefinition(file);
        if (this.#labs.has(def.id)) {
          this.#loadErrors.push(`duplicate lab id ${def.id} (${file})`);
          continue;
        }
        // Directory name must match the slug so the tree stays navigable.
        const dirName = path.basename(path.dirname(file));
        if (dirName !== def.slug) {
          this.#loadErrors.push(
            `lab ${def.id}: directory '${dirName}' does not match slug '${def.slug}'`,
          );
          continue;
        }
        this.#labs.set(def.id, def);
      } catch (cause) {
        const detail =
          cause instanceof LabDefinitionError && cause.issues.length > 0
            ? `${cause.message} — ${cause.issues.join('; ')}`
            : (cause as Error).message;
        this.#loadErrors.push(`${file}: ${detail}`);
      }
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

  list(): LabSummary[] {
    return [...this.#labs.values()]
      .map((def) => ({
        id: def.id,
        slug: def.slug,
        title: def.title,
        track: def.track,
        difficulty: def.difficulty,
        durationMinutes: def.duration_minutes,
        summary: def.task.summary,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Look up a lab by (already validated or raw) id. Throws on bad id or miss. */
  get(labId: string): LabDefinition {
    const canonical = assertValidLabId(labId);
    const def = this.#labs.get(canonical);
    if (!def) throw new LabNotFoundError(canonical);
    return def;
  }

  has(labId: string): boolean {
    try {
      this.get(labId);
      return true;
    } catch {
      return false;
    }
  }

  get size(): number {
    return this.#labs.size;
  }
}

/** Build the provider context for a lab from its definition. */
export function labContextFor(def: LabDefinition): LabContext {
  return {
    labId: def.id,
    namespace: def.environment.namespace,
    purgeResources: def.reset.purge_namespaced_resources,
    protectedResources: def.reset.protected_resources,
  };
}
