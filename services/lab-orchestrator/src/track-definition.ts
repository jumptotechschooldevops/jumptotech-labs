/**
 * Optional per-track metadata.
 *
 * Tracks are discovered from the labs on disk — a track exists because labs
 * declare it, not because anything enumerates a list. That already made the
 * catalog data-driven, but it left presentation guessing: a track's display
 * name was title-cased from its slug, and its order in the catalog was
 * alphabetical.
 *
 * `labs/<track>/track.yaml` lets a track say those things about itself:
 *
 * ```yaml
 * title: Docker
 * tagline: Containers, images, and the daemon underneath them.
 * order: 20
 * ```
 *
 * The file is entirely optional. A track with no `track.yaml` still appears,
 * still lists its labs, and still gets a sensible title — so adding a lab
 * remains the only required step for adding a track.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

const trackDefinitionSchema = z
  .object({
    /** Display name. Defaults to the title-cased slug. */
    title: z.string().min(1).max(64).optional(),
    /** One line describing the track, shown under its heading. */
    tagline: z.string().min(1).max(240).optional(),
    /**
     * Sort position in the catalog. Lower comes first.
     *
     * Tracks without an explicit order sort after those with one, alphabetically,
     * so a partially-annotated labs directory still produces a stable listing.
     */
    order: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

export type TrackDefinition = z.infer<typeof trackDefinitionSchema>;

export class TrackDefinitionError extends Error {
  readonly code = 'TRACK_DEFINITION_INVALID';
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'TrackDefinitionError';
  }

  format(): string {
    const body = this.issues.length > 0 ? this.issues.join('\n') : this.message;
    return `${this.code}\n\n${this.path}:\n${body}`;
  }
}

export function parseTrackDefinition(yamlText: string, sourcePath = '<inline>'): TrackDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new TrackDefinitionError(
      `Invalid YAML in track definition: ${(cause as Error).message}`,
      sourcePath,
    );
  }

  // An empty file is a valid "I have nothing to add" rather than an error.
  if (raw === null || raw === undefined) return {};

  const result = trackDefinitionSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
    throw new TrackDefinitionError(
      `Track definition failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      sourcePath,
      issues,
    );
  }
  return result.data;
}

/** Read a `track.yaml`. Returns `null` when the file does not exist. */
export async function loadTrackDefinition(filePath: string): Promise<TrackDefinition | null> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new TrackDefinitionError(
      `Cannot read track definition: ${(cause as Error).message}`,
      filePath,
    );
  }
  return parseTrackDefinition(text, filePath);
}
