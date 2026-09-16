/**
 * Whole-catalog validation — every structural rule, in one pass, with one report.
 *
 * The rules a single `lab.yaml` must follow already live in `lab-definition.ts`,
 * the rules between labs (duplicate ids and slugs, unknown prerequisites,
 * cycles) in `lab-registry.ts`, and the rules of a learning path in
 * `learning-paths.ts`. Each of those *refuses* what it cannot load, and records
 * why — which is right for a running API, but means a broken lab surfaces as a
 * missing catalog entry and a line on `/health`, not as a failed build.
 *
 * This module collects those refusals and adds the checks nothing else makes,
 * because they are about the repository rather than about one parsed document:
 *
 *   - **layout**: `labs/<track>/<slug>/lab.yaml`, the directory named after the
 *     slug, the slug after the id, one id prefix per track — and no directory
 *     that looks like a lab but has no `lab.yaml`, which the registry would skip
 *     without a word;
 *   - **setup assets**: every manifest, seed script, starter file and workspace
 *     directory a lab declares is read through the *same loaders the providers
 *     use at Start Lab*. Without this a missing file is discovered by the first
 *     student to launch the lab;
 *   - **seeding collisions**: a `workspace_dir` file and a `setup.files` entry
 *     landing on the same destination, where one silently overwrites the other;
 *   - **content hygiene**: symlinks inside a lab directory (the loaders'
 *     resolved-path re-check does not see through them), executable bits on
 *     anything that is not a seed script, files no lab references, and seeded
 *     files whose names say they are a solution;
 *   - **metadata**: a lab with no story, no objectives or no hints, which the
 *     schema allows but every shipped lab has;
 *   - **learning paths**: every path error, the flagship path placing every lab,
 *     and skills defined in `skills.yaml` that no stage declares.
 *
 * Findings are **errors** (the catalog is structurally wrong and CI must fail)
 * or **warnings** (worth a look, never a build failure). Nothing here repairs
 * anything, and nothing here needs Docker, Kubernetes or a database: it reads
 * files, so it is fast enough to run on every push.
 *
 * Output is deterministic — sorted, and with the machine-specific labs
 * directory replaced by `labs` — so two runs on two machines print the same
 * report.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedLabDefinition } from './lab-definition.js';
import type { LabRegistry } from './lab-registry.js';
import {
  LEARNING_PATHS_DIRNAME,
  LearningPathCatalog,
  labSourceFromRegistry,
  learningPathsDirectory,
} from './learning-paths.js';
import { loadSetupManifests } from './session/manifests.js';
import { loadSeedScripts } from './session/seed-scripts.js';
import { loadSetupFiles } from './session/setup-files.js';

/** The path every lab must be placed in. Mirrors `FLAGSHIP_PATH_ID` in apps/web. */
export const FLAGSHIP_LEARNING_PATH_ID = 'devops-engineer';

export type CatalogFindingSeverity = 'error' | 'warning';

export const CATALOG_FINDING_CODES = [
  /** The registry refused a lab: schema, provider contract, duplicate, prerequisite graph. */
  'LAB_LOAD',
  /** `labs/<track>/<slug>/lab.yaml` does not hold. */
  'LAB_LAYOUT',
  /** A track mixes lab id prefixes. */
  'LAB_ID_PREFIX',
  /** A directory under a track has no `lab.yaml`, so no lab is registered from it. */
  'LAB_DIRECTORY_WITHOUT_DEFINITION',
  /** A declared setup asset cannot be loaded the way a provider would load it. */
  'SETUP_ASSET',
  /** Two seeded files land on one destination. */
  'SETUP_DESTINATION_COLLISION',
  /** A symlink inside a lab directory. */
  'LAB_SYMLINK',
  /** A file other than a seed script carries an execute bit. */
  'LAB_EXECUTABLE_FILE',
  /** A file in a lab directory that the lab never references. */
  'LAB_UNREFERENCED_FILE',
  /** A seeded file whose name says it is a solution or answer key. */
  'SETUP_SOLUTION_NAME',
  /** A lab has no story, objectives or hints — optional in the schema, expected of every lab. */
  'LAB_METADATA_INCOMPLETE',
  /** A learning path, or the skill catalog, was refused. */
  'LEARNING_PATH',
  /** The flagship path is missing, or does not place a registered lab. */
  'LEARNING_PATH_COVERAGE',
  /** A skill in `skills.yaml` that no stage of any loaded path declares. */
  'SKILL_UNDECLARED',
] as const;

export type CatalogFindingCode = (typeof CATALOG_FINDING_CODES)[number];

export interface CatalogFinding {
  severity: CatalogFindingSeverity;
  code: CatalogFindingCode;
  /** A lab id, a learning path id, or a `labs/`-relative path. */
  subject: string;
  message: string;
}

export interface CatalogValidationReport {
  /** Labs the registry accepted. */
  labCount: number;
  /** `lab.yaml` files on disk, accepted or not. */
  definitionFiles: number;
  learningPaths: string[];
  findings: CatalogFinding[];
  errors: number;
  warnings: number;
}

export interface CatalogValidationOptions {
  /** The labs directory the registry was loaded from. */
  labsDir: string;
  /** An already-loaded registry over `labsDir`. */
  registry: LabRegistry;
  flagshipPathId?: string;
}

/**
 * Seeded file names that read as a solution rather than a starting point.
 *
 * Deliberately narrow: `answers.txt` is a blank worksheet in several labs and
 * `expected` is ordinary English, so neither is here. A hit is a warning for a
 * person to look at, not an error.
 */
const SOLUTION_NAME = /(^|[-_.])(solutions?|answer[-_]?keys?|teacher|instructor|walkthrough)([-_.]|$)/i;

const SEVERITY_RANK: Record<CatalogFindingSeverity, number> = { error: 0, warning: 1 };

export async function validateCatalog(options: CatalogValidationOptions): Promise<CatalogValidationReport> {
  const labsDir = path.resolve(options.labsDir);
  const { registry } = options;
  const flagshipPathId = options.flagshipPathId ?? FLAGSHIP_LEARNING_PATH_ID;
  const findings: CatalogFinding[] = [];
  const add = (severity: CatalogFindingSeverity, code: CatalogFindingCode, subject: string, message: string) =>
    findings.push({ severity, code, subject, message: relativise(message, labsDir) });

  for (const error of registry.loadErrors) {
    add('error', 'LAB_LOAD', loadErrorSubject(error, labsDir), error.replace(/^[A-Z_]+\n\n/, ''));
  }

  const tree = await scanLabsTree(labsDir);
  const labs = registry.all();

  checkLayout(labs, labsDir, tree, add);
  for (const lab of labs) {
    await checkSetupAssets(lab, add);
    checkLabFiles(lab, labsDir, tree, add);
    checkMetadata(lab, add);
  }

  const learningPaths = await checkLearningPaths(labsDir, registry, flagshipPathId, add);

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      compare(a.code, b.code) ||
      compare(a.subject, b.subject) ||
      compare(a.message, b.message),
  );
  const errors = findings.filter((f) => f.severity === 'error').length;
  return {
    labCount: labs.length,
    definitionFiles: tree.files.filter((f) => path.basename(f.relative) === 'lab.yaml').length,
    learningPaths,
    findings,
    errors,
    warnings: findings.length - errors,
  };
}

/** One line per finding, errors first. */
export function formatCatalogReport(report: CatalogValidationReport): string {
  const lines = report.findings.map(
    (f) => `${f.severity.toUpperCase()} ${f.code} ${f.subject}: ${f.message.replace(/\n+/g, ' ')}`,
  );
  lines.push(
    `${report.labCount} labs registered from ${report.definitionFiles} lab.yaml files; ` +
      `learning paths: ${report.learningPaths.join(', ') || 'none'}; ` +
      `${report.errors} error${report.errors === 1 ? '' : 's'}, ${report.warnings} warning${report.warnings === 1 ? '' : 's'}`,
  );
  return lines.join('\n');
}

// --- the tree on disk ---------------------------------------------------------

interface TreeEntry {
  /** Relative to the labs directory, forward slashes. */
  relative: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  mode: number;
}

interface LabsTree {
  files: TreeEntry[];
  directories: TreeEntry[];
  symlinks: TreeEntry[];
}

async function scanLabsTree(labsDir: string): Promise<LabsTree> {
  const tree: LabsTree = { files: [], directories: [], symlinks: [] };
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(labsDir, relative), { withFileTypes: true });
    } catch {
      return; // the registry has already reported an unreadable labs directory
    }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const stats = await lstat(path.join(labsDir, child));
      if (stats.isSymbolicLink()) {
        tree.symlinks.push({ relative: child, kind: 'symlink', mode: stats.mode });
      } else if (stats.isDirectory()) {
        tree.directories.push({ relative: child, kind: 'directory', mode: stats.mode });
        await walk(child);
      } else if (stats.isFile()) {
        tree.files.push({ relative: child, kind: 'file', mode: stats.mode });
      }
    }
  };
  await walk('');
  return tree;
}

type Add = (severity: CatalogFindingSeverity, code: CatalogFindingCode, subject: string, message: string) => void;

// --- layout -------------------------------------------------------------------

function checkLayout(labs: readonly LoadedLabDefinition[], labsDir: string, tree: LabsTree, add: Add): void {
  const prefixes = new Map<string, Map<string, string[]>>();

  for (const lab of labs) {
    const relative = toPosix(path.relative(labsDir, lab.directory));
    const segments = relative.split('/');
    if (segments.length !== 2) {
      add(
        'error',
        'LAB_LAYOUT',
        lab.id,
        `lab.yaml is at labs/${relative}/lab.yaml; labs live at labs/<track>/<slug>/lab.yaml`,
      );
    } else {
      const [trackDir, labDir] = segments as [string, string];
      if (trackDir !== lab.track) {
        add('error', 'LAB_LAYOUT', lab.id, `declares track '${lab.track}' but lives under labs/${trackDir}/`);
      }
      if (labDir !== lab.slug) {
        add('error', 'LAB_LAYOUT', lab.id, `directory '${labDir}' does not match its slug '${lab.slug}'`);
      }
    }
    if (!lab.slug.startsWith(`${lab.id.toLowerCase()}-`)) {
      add('error', 'LAB_LAYOUT', lab.id, `slug '${lab.slug}' does not begin with its id ('${lab.id.toLowerCase()}-')`);
    }

    const prefix = lab.id.slice(0, lab.id.lastIndexOf('-'));
    const byPrefix = prefixes.get(lab.track) ?? new Map<string, string[]>();
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), lab.id]);
    prefixes.set(lab.track, byPrefix);
  }

  for (const [track, byPrefix] of prefixes) {
    if (byPrefix.size < 2) continue;
    const described = [...byPrefix.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([prefix, ids]) => `${prefix} (${ids.sort(compare).join(', ')})`)
      .join('; ');
    add('error', 'LAB_ID_PREFIX', track, `track '${track}' mixes lab id prefixes: ${described}`);
  }

  // A lab directory whose definition is misnamed (`lab.yml`, `Lab.yaml`) is
  // skipped by discovery without any error at all.
  const withDefinition = new Set(
    tree.files.filter((f) => path.posix.basename(f.relative) === 'lab.yaml').map((f) => path.posix.dirname(f.relative)),
  );
  for (const directory of tree.directories) {
    const segments = directory.relative.split('/');
    if (segments.length !== 2 || segments[0] === LEARNING_PATHS_DIRNAME) continue;
    if (withDefinition.has(directory.relative)) continue;
    add(
      'error',
      'LAB_DIRECTORY_WITHOUT_DEFINITION',
      `labs/${directory.relative}`,
      'this directory has no lab.yaml, so no lab is registered from it',
    );
  }
  for (const file of tree.files) {
    if (/^lab\.ya?ml$/i.test(path.posix.basename(file.relative)) && path.posix.basename(file.relative) !== 'lab.yaml') {
      add('error', 'LAB_LAYOUT', `labs/${file.relative}`, 'a lab definition must be named exactly lab.yaml');
    }
  }
}

// --- setup assets -------------------------------------------------------------

async function checkSetupAssets(lab: LoadedLabDefinition, add: Add): Promise<void> {
  const attempt = async (what: string, load: () => Promise<unknown>) => {
    try {
      await load();
    } catch (cause) {
      add('error', 'SETUP_ASSET', lab.id, `${what}: ${(cause as Error).message}`);
    }
  };

  if (lab.setup.manifests.length > 0) await attempt('setup.manifests', () => loadSetupManifests(lab));
  if (lab.setup.seed_scripts.length > 0) await attempt('setup.seed_scripts', () => loadSeedScripts(lab));
  if (lab.setup.files.length > 0 || lab.setup.workspace_dir !== undefined) {
    await attempt('setup.files', async () => {
      const loaded = await loadSetupFiles(lab);
      const owners = new Map<string, string[]>();
      for (const file of loaded) owners.set(file.path, [...(owners.get(file.path) ?? []), file.source]);
      for (const [destination, sources] of [...owners.entries()].sort(([a], [b]) => compare(a, b))) {
        if (sources.length < 2) continue;
        add(
          'error',
          'SETUP_DESTINATION_COLLISION',
          lab.id,
          `'${destination}' is seeded by ${sources.join(' and ')}; only one of them would reach the student`,
        );
      }
    });
  }
}

// --- files inside a lab directory ---------------------------------------------

function checkLabFiles(lab: LoadedLabDefinition, labsDir: string, tree: LabsTree, add: Add): void {
  const root = toPosix(path.relative(labsDir, lab.directory));
  const inLab = (entry: TreeEntry) => entry.relative.startsWith(`${root}/`);
  const local = (entry: TreeEntry) => entry.relative.slice(root.length + 1);

  const seedScripts = new Set(lab.setup.seed_scripts);
  const workspace = lab.setup.workspace_dir;
  const referenced = new Set<string>(['lab.yaml', ...lab.setup.manifests, ...seedScripts, ...lab.setup.files.map((f) => f.source)]);
  const seeded = new Set(lab.setup.files.map((f) => f.source));

  for (const link of tree.symlinks.filter(inLab)) {
    add(
      'error',
      'LAB_SYMLINK',
      lab.id,
      `${local(link)} is a symlink; lab content must be regular files, because a symlink can point outside the lab directory`,
    );
  }

  for (const file of tree.files.filter(inLab)) {
    const name = local(file);
    // Nested lab directories are reported against their own lab, not this one.
    if (name.includes('/') && name.endsWith('/lab.yaml')) continue;
    const inWorkspace = workspace !== undefined && name.startsWith(`${workspace}/`);

    if ((file.mode & 0o111) !== 0 && !seedScripts.has(name)) {
      add(
        'warning',
        'LAB_EXECUTABLE_FILE',
        lab.id,
        `${name} is executable, but only seed scripts are run; starter files are written without execute bits`,
      );
    }
    if (!referenced.has(name) && !inWorkspace) {
      add('warning', 'LAB_UNREFERENCED_FILE', lab.id, `${name} is not referenced by lab.yaml and never reaches a sandbox`);
    }
    if ((seeded.has(name) || inWorkspace) && SOLUTION_NAME.test(path.posix.basename(name))) {
      add(
        'warning',
        'SETUP_SOLUTION_NAME',
        lab.id,
        `${name} is seeded into the student's sandbox and its name suggests a solution; confirm it is starter content`,
      );
    }
  }
}

// --- metadata -----------------------------------------------------------------

function checkMetadata(lab: LoadedLabDefinition, add: Add): void {
  const missing = [
    ...(lab.story?.trim() ? [] : ['story']),
    ...(lab.objectives.length > 0 ? [] : ['objectives']),
    ...(lab.hints.length > 0 ? [] : ['hints']),
  ];
  if (missing.length === 0) return;
  add('warning', 'LAB_METADATA_INCOMPLETE', lab.id, `has no ${missing.join(', ')}; every shipped lab gives the student these`);
}

// --- learning paths -----------------------------------------------------------

async function checkLearningPaths(labsDir: string, registry: LabRegistry, flagshipPathId: string, add: Add): Promise<string[]> {
  const catalog = await LearningPathCatalog.load(learningPathsDirectory(labsDir), labSourceFromRegistry(registry));

  for (const error of catalog.loadErrors) {
    add('error', 'LEARNING_PATH', learningPathSubject(error, labsDir), error.replace(/^[A-Z_]+\n\n/, ''));
  }

  const flagship = catalog.get(flagshipPathId);
  if (!flagship) {
    // A refused flagship has already been reported with its reasons above.
    if (!catalog.isRefused(flagshipPathId)) {
      add('error', 'LEARNING_PATH_COVERAGE', flagshipPathId, `the flagship learning path '${flagshipPathId}' is not defined`);
    }
  } else {
    for (const lab of registry.all()) {
      if (flagship.labs.has(lab.id)) continue;
      add(
        'error',
        'LEARNING_PATH_COVERAGE',
        flagshipPathId,
        `lab ${lab.id} is not placed in the flagship learning path '${flagshipPathId}'; every catalog lab must appear in it exactly once`,
      );
    }
  }

  const loaded = catalog.list();
  if (loaded.length > 0) {
    const declared = new Set(loaded.flatMap((p) => p.stages.flatMap((stage) => stage.skills)));
    for (const skill of [...catalog.skills.keys()].sort(compare)) {
      if (declared.has(skill)) continue;
      add('warning', 'SKILL_UNDECLARED', skill, `skill '${skill}' is defined in skills.yaml but no stage of any learning path declares it`);
    }
  }

  return loaded.map((p) => p.id).sort(compare);
}

// --- helpers ------------------------------------------------------------------

/** Code-point order, so a report never depends on the machine's locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function relativise(message: string, labsDir: string): string {
  return message.split(labsDir).join('labs');
}

/** `LAB_DEFINITION_INVALID\n\nK8S-004:\n…` → `K8S-004`; otherwise the first line. */
function loadErrorSubject(error: string, labsDir: string): string {
  const heading = /^[A-Z_]+\n\n([^\n]+):\n/.exec(error)?.[1];
  if (heading) return relativise(heading, labsDir);
  return relativise(error.split('\n')[0] ?? error, labsDir);
}

function learningPathSubject(error: string, labsDir: string): string {
  const heading = /^[A-Z_]+\n\n([^\n]+):\n/.exec(error)?.[1];
  return relativise(heading ?? error.split(':')[0] ?? error, labsDir);
}
