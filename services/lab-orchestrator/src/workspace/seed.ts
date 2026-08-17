/**
 * Workspace seeding — the file-backed equivalent of `session/manifests.ts`.
 *
 * A Kubernetes lab declares its starting condition as manifests:
 *
 *     setup:
 *       manifests:
 *         - initial/deployment.yaml
 *
 * A file-backed lab declares it as a directory of project files:
 *
 *     setup:
 *       workspace: workspace
 *
 * Everything under that directory is copied into the session's private
 * workspace at Start Lab, and copied again on Reset. It is ordinary project
 * content — a small application, a broken pipeline, a README — and it is data,
 * never executed by the loader.
 *
 * The same containment rules as manifests apply, plus two file-specific caps:
 * a seed may not exceed a bounded number of files or total bytes, so a lab
 * cannot fill the host by shipping a large tree.
 */
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { LabDefinitionError, type LoadedLabDefinition } from '../lab-definition.js';
import { assertSafeRelativePath } from './paths.js';

/** Most files one lab may seed. */
export const MAX_SEED_FILES = 200;

/** Largest single seed file. */
export const MAX_SEED_FILE_BYTES = 256 * 1024;

/** Largest total seed, across all files. */
export const MAX_SEED_TOTAL_BYTES = 2 * 1024 * 1024;

/** One file to write into a fresh workspace. */
export interface SeedFile {
  /** Workspace-relative destination, canonicalised. */
  path: string;
  contents: Buffer;
  /**
   * Whether the file should be executable.
   *
   * Carried explicitly rather than copied from the source mode: lab content
   * lives in a git checkout whose modes vary by platform, and an accidental
   * `0777` on disk must not become an executable bit inside a sandbox.
   */
  executable: boolean;
}

/** Files a seed directory may never contain, whatever a lab declares. */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  // Would be picked up by the lab registry's recursive scan.
  'lab.yaml',
  // Nothing in a seed should look like a credential.
  '.npmrc',
  '.netrc',
  'id_rsa',
  '.env',
]);

/**
 * Read every file under a lab's seed directory.
 *
 * Returns them in a stable (sorted) order so a workspace is byte-identical on
 * every create and every reset — that is what makes "Reset restores the
 * original project files" a testable claim rather than an aspiration.
 */
export async function loadWorkspaceSeed(lab: LoadedLabDefinition): Promise<SeedFile[]> {
  const relative = lab.setup.workspace;
  if (!relative) return [];

  const fail = (reason: string): never => {
    throw new LabDefinitionError(`workspace seed '${relative}': ${reason}`, lab.sourcePath, [], lab.id);
  };

  const rootRelative = assertSafeRelativePath(relative);
  const root = path.resolve(lab.directory, rootRelative);
  const labRoot = path.resolve(lab.directory) + path.sep;
  if (!root.startsWith(labRoot)) {
    return fail('resolves outside the lab directory');
  }

  const info = await lstat(root).catch(() => null);
  if (!info) return fail('directory does not exist');
  if (!info.isDirectory()) return fail('is not a directory');

  const files: SeedFile[] = [];
  let totalBytes = 0;

  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Rejected rather than skipped: a lab author who ships a symlink or a
      // socket has made a mistake, and silently dropping it would produce a
      // workspace that does not match the lab they wrote.
      if (entry.isSymbolicLink()) {
        return fail(`'${childRelative}' is a symbolic link; seed files must be regular files`);
      }
      if (FORBIDDEN_NAMES.has(entry.name)) {
        return fail(`'${childRelative}' is not allowed in a workspace seed`);
      }

      // Validates every segment: no traversal, no odd characters.
      const canonical = assertSafeRelativePath(childRelative);

      if (entry.isDirectory()) {
        await walk(path.join(absolute, entry.name), canonical);
        continue;
      }
      if (!entry.isFile()) {
        return fail(`'${childRelative}' is not a regular file`);
      }

      const contents = await readFile(path.join(absolute, entry.name));
      if (contents.byteLength > MAX_SEED_FILE_BYTES) {
        return fail(`'${childRelative}' is larger than ${MAX_SEED_FILE_BYTES} bytes`);
      }
      totalBytes += contents.byteLength;
      if (totalBytes > MAX_SEED_TOTAL_BYTES) {
        return fail(`total seed size exceeds ${MAX_SEED_TOTAL_BYTES} bytes`);
      }
      if (files.length >= MAX_SEED_FILES) {
        return fail(`seeds more than ${MAX_SEED_FILES} files`);
      }

      files.push({
        path: canonical,
        contents,
        // Shell scripts a lab ships as helpers stay runnable; nothing else does.
        executable: /\.(sh|bash)$/i.test(entry.name),
      });
    }
  };

  await walk(root, '');

  if (files.length === 0) {
    return fail('contains no files');
  }
  return files;
}
