/**
 * The catalog, described from the labs directory rather than pinned in a test.
 *
 * Why this module exists
 * ----------------------
 * The catalog is data-driven: a track exists because labs declare it, and a lab
 * exists because a `lab.yaml` is on disk. The *tests*, however, used to restate
 * today's curriculum as literals — `size` is 33, there are four tracks, the
 * Kubernetes one has twelve labs. Every one of those literals is a snapshot of
 * the curriculum, not a property of the platform, so adding a legitimate track
 * or lab in one worktree broke shared tests owned by nobody.
 *
 * The fix is not to delete those assertions but to *derive* them. This module
 * walks the labs directory with a plain YAML parse — deliberately not through
 * `LabRegistry` — and reports what the catalog should contain. A test then
 * asserts the registry (and the API on top of it) agrees with the disk.
 *
 * That is strictly stronger than the literals it replaces:
 *
 *   · a lab that silently fails to load still fails the test, because the file
 *     is on disk and its id is missing from the registry;
 *   · a duplicate id, a dangling prerequisite, or a cycle still fails, for the
 *     same reason;
 *   · the ordering contract is re-derived here independently, so a change to
 *     the registry's sort is caught rather than absorbed;
 *   · and adding a valid track or lab requires no test edit at all.
 *
 * The independence matters. Nothing below imports the registry, so "the
 * registry matches the catalog" is a comparison of two implementations rather
 * than a tautology.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { LABS_DIR } from './helpers.js';

export { LABS_DIR };

/** One `lab.yaml` on disk, read for the few fields the catalog shape needs. */
export interface DiscoveredLab {
  id: string;
  slug: string;
  track: string;
  order: number;
  provider: string;
  /** Absolute path to the `lab.yaml`. */
  file: string;
}

/** One track directory that contains at least one lab. */
export interface DiscoveredTrack {
  track: string;
  labs: DiscoveredLab[];
  labCount: number;
  /** `title` from `labs/<track>/track.yaml`, when the track declares one. */
  declaredTitle?: string;
  /** `order` from `labs/<track>/track.yaml`, when the track declares one. */
  declaredOrder?: number;
  declaredTagline?: string;
}

export interface DiscoveredCatalog {
  /** Every lab on disk, in the order `LabRegistry.all()` promises. */
  labs: DiscoveredLab[];
  /** Every track with labs, in the order `LabRegistry.tracks()` promises. */
  tracks: DiscoveredTrack[];
  labCount: number;
  trackCount: number;
  /** Lab ids, in catalog order. */
  ids: string[];
  /** Track slugs, in catalog order. */
  trackIds: string[];
  /** Lab ids in one track, in catalog order. Empty for an unknown track. */
  idsForTrack(track: string): string[];
  /** Lab count for one track. Zero for an unknown track. */
  labCountForTrack(track: string): number;
}

/**
 * Catalog order for labs: track slug, then declared order, then id.
 *
 * Restated here rather than imported so the registry's sort is checked against
 * an independent statement of the contract.
 */
function byCatalogOrder(a: DiscoveredLab, b: DiscoveredLab): number {
  if (a.track !== b.track) return a.track.localeCompare(b.track);
  if (a.order !== b.order) return a.order - b.order;
  return a.id.localeCompare(b.id);
}

/** Catalog order for tracks: declared `order` first, then the rest by slug. */
function byTrackOrder(a: DiscoveredTrack, b: DiscoveredTrack): number {
  const aOrder = a.declaredOrder ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.declaredOrder ?? Number.MAX_SAFE_INTEGER;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.track.localeCompare(b.track);
}

async function findLabFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await findLabFiles(full)));
    else if (entry.isFile() && entry.name === 'lab.yaml') files.push(full);
  }
  return files.sort();
}

/**
 * Walk a labs directory and report the catalog it should produce.
 *
 * Reads each `lab.yaml` with a plain YAML parse: no schema validation, no
 * registry, no dedup. What comes back is "what is on disk", which is the thing
 * the registry's output has to be checked against.
 */
/**
 * Cached scan of the *shipped* labs directory.
 *
 * The real catalog does not change during a test run, and the scan walks and
 * YAML-parses every `lab.yaml` on disk. Dozens of call sites re-running that
 * was pure repeated work. Temporary directories are never cached — each one is
 * built for a single test and must be read as it actually is.
 */
let cachedRealScan: Promise<DiscoveredCatalog> | undefined;

export function scanLabsDirectory(labsDir: string = LABS_DIR): Promise<DiscoveredCatalog> {
  if (labsDir !== LABS_DIR) return scanLabsDirectoryUncached(labsDir);
  cachedRealScan ??= scanLabsDirectoryUncached(labsDir);
  return cachedRealScan;
}

async function scanLabsDirectoryUncached(labsDir: string): Promise<DiscoveredCatalog> {
  const files = await findLabFiles(labsDir);

  const labs: DiscoveredLab[] = [];
  for (const file of files) {
    const raw = parseYaml(await readFile(file, 'utf8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') continue;
    labs.push({
      id: String(raw.id),
      slug: String(raw.slug),
      track: String(raw.track),
      order: typeof raw.order === 'number' ? raw.order : 0,
      provider: String((raw.environment as { provider?: unknown } | undefined)?.provider ?? ''),
      file,
    });
  }
  labs.sort(byCatalogOrder);

  const byTrack = new Map<string, DiscoveredLab[]>();
  for (const lab of labs) {
    const bucket = byTrack.get(lab.track);
    if (bucket) bucket.push(lab);
    else byTrack.set(lab.track, [lab]);
  }

  const tracks: DiscoveredTrack[] = [];
  for (const [track, trackLabs] of byTrack) {
    const meta = await readTrackYaml(path.join(labsDir, track, 'track.yaml'));
    tracks.push({
      track,
      labs: trackLabs,
      labCount: trackLabs.length,
      ...(meta?.title !== undefined ? { declaredTitle: meta.title } : {}),
      ...(meta?.order !== undefined ? { declaredOrder: meta.order } : {}),
      ...(meta?.tagline !== undefined ? { declaredTagline: meta.tagline } : {}),
    });
  }
  tracks.sort(byTrackOrder);

  return {
    labs,
    tracks,
    labCount: labs.length,
    trackCount: tracks.length,
    ids: labs.map((l) => l.id),
    trackIds: tracks.map((t) => t.track),
    idsForTrack: (track) => labs.filter((l) => l.track === track).map((l) => l.id),
    labCountForTrack: (track) => labs.filter((l) => l.track === track).length,
  };
}

interface TrackYaml {
  title?: string;
  tagline?: string;
  order?: number;
}

async function readTrackYaml(file: string): Promise<TrackYaml | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const raw = parseYaml(text) as TrackYaml | null;
  return raw && typeof raw === 'object' ? raw : null;
}

// ------------------------------------------------------- temporary catalogs

/**
 * A valid lab definition for a track that ships no labs.
 *
 * Used to prove the platform discovers a new track without a code or test
 * change. It is deliberately a *complete* definition — the point is that a
 * legitimate track is picked up, not that validation was relaxed for it.
 *
 * `references` cites man7.org because the fixture runs on the `linux` provider;
 * `OFFICIAL_DOC_HOSTS` has no entry for a track slug it has never seen, so this
 * also documents that a brand-new track is not yet covered by the per-track
 * documentation allowlist (see `docHostPolicy` in the catalog tests).
 */
export function fixtureLabYaml(
  overrides: {
    id?: string;
    slug?: string;
    track?: string;
    title?: string;
    order?: number;
    extra?: string;
  } = {},
): string {
  const id = overrides.id ?? 'FIXTURE-901';
  const slug = overrides.slug ?? 'fixture-901-demo';
  const track = overrides.track ?? 'fixture-track';
  return `id: ${id}
slug: ${slug}
title: ${overrides.title ?? 'Fixture Lab'}
track: ${track}
topic: fixtures
difficulty: beginner
duration_minutes: 15
order: ${overrides.order ?? 1}
environment:
  provider: linux
  isolation: container
story: A fixture lab that exists only inside a temporary labs directory.
objectives:
  - Prove a new track is discovered from its labs alone
task:
  summary: Do the thing.
  description: A longer description of the thing.
requirements:
  - type: file_exists
    path: /home/student/project
    label: The project directory exists
references:
  - title: man7 pages
    url: https://man7.org/linux/man-pages/man1/ls.1.html
skills:
  - linux.files.list
hints:
  - level: 1
    text: Look at what the task asks for.
  - level: 2
    text: Consult the manual page.
${overrides.extra ?? ''}`;
}

/**
 * Copy the parts of a labs directory that the *registry* actually reads.
 *
 * `LabRegistry.load()` looks for exactly two filenames: `lab.yaml`, found by
 * walking the tree, and `track.yaml`, read beside each track's labs. Setup
 * manifests and seed scripts are opened later by the setup engine, from the
 * real labs directory, and never by discovery.
 *
 * So a discovery fixture needs those two files and nothing else. Deep-copying
 * the whole tree instead — which is what this used to do — moved every setup
 * manifest and seed script four times per run for no benefit, and made these
 * the slowest tests in the suite by a wide margin: they were the only ones
 * still timing out on a loaded machine. Copying the skeleton is the same test
 * against the same loader, without the dead I/O.
 */
async function copyCatalogSkeleton(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyCatalogSkeleton(source, target);
    } else if (entry.name === 'lab.yaml' || entry.name === 'track.yaml') {
      await cp(source, target);
    }
  }
}

const tempRoots: string[] = [];

/** Temporary directories created by this module, for a test's cleanup hook. */
export function temporaryLabsDirs(): string[] {
  return tempRoots.splice(0);
}

/**
 * Copy the real labs directory to a temporary one, then add files to it.
 *
 * `files` maps a path relative to the labs root to its contents, so a caller
 * writes `{ 'fixture-track/fixture-901-demo/lab.yaml': fixtureLabYaml() }`.
 *
 * Working from a copy of the *real* catalog is what makes the resulting
 * assertions meaningful: the extra track has to coexist with everything already
 * shipped, rather than being discovered in an otherwise empty directory.
 */
export async function labsDirPlus(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'jtt-catalog-'));
  tempRoots.push(root);
  const labsRoot = path.join(root, 'labs');
  await copyCatalogSkeleton(LABS_DIR, labsRoot);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(labsRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return labsRoot;
}
