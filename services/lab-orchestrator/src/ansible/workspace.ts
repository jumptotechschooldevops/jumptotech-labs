/**
 * Lab workspace loading.
 *
 * An Ansible lab starts the student from a project on disk rather than from an
 * empty directory:
 *
 * ```yaml
 * setup:
 *   workspace_dir: workspace
 * ```
 *
 * Everything under that directory — `ansible.cfg`, an inventory, a half-written
 * playbook, a deliberately broken role — is copied into `/home/student/lab` on
 * the control node before the terminal opens, and copied again from the same
 * source on every reset. That is what makes reset meaningful: the baseline is a
 * file tree in the repository, not a state the platform tried to remember.
 *
 * The loader is deliberately strict:
 *
 *   - it never leaves the lab's own directory (symlinks included — the resolved
 *     real path is re-checked, not the spelling);
 *   - it accepts UTF-8 text only, so a lab cannot ship a binary payload;
 *   - it caps per-file and total size, and the number of files.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { LabDefinitionError, type LoadedLabDefinition } from '../lab-definition.js';

/** One seeded project file, ready to be written into the control node. */
export interface WorkspaceFile {
  /** Path relative to the workspace root, e.g. `roles/web/tasks/main.yml`. */
  relativePath: string;
  content: string;
  /** Octal mode string. Only `0644` and `0755` are produced. */
  mode: '0644' | '0755';
}

export const MAX_WORKSPACE_FILES = 60;
export const MAX_WORKSPACE_FILE_BYTES = 64 * 1024;
export const MAX_WORKSPACE_TOTAL_BYTES = 512 * 1024;

/** Names a workspace entry may use. Same conservative class as lab paths. */
const SAFE_ENTRY = /^[A-Za-z0-9._-]+$/;

/** Files whose content is executable and should be seeded 0755. */
const EXECUTABLE_SUFFIXES = ['.sh'];

/**
 * Read a lab's workspace tree.
 *
 * Returns files in a stable, depth-first, alphabetical order so the provider
 * writes parents before children and two runs produce an identical sequence.
 */
export async function loadLabWorkspace(lab: LoadedLabDefinition): Promise<WorkspaceFile[]> {
  const relativeRoot = lab.setup.workspace_dir;
  if (!relativeRoot) return [];

  const fail = (reason: string): never => {
    throw new LabDefinitionError(
      `setup.workspace_dir '${relativeRoot}': ${reason}`,
      lab.sourcePath,
      [],
      lab.id,
    );
  };

  const labRoot = await realpath(lab.directory).catch(() => lab.directory);
  const root = path.resolve(labRoot, relativeRoot);
  if (!root.startsWith(`${labRoot}${path.sep}`)) {
    return fail('resolves outside the lab directory');
  }

  const rootStat = await stat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    return fail('is not a directory');
  }

  const files: WorkspaceFile[] = [];
  let totalBytes = 0;

  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const entries = (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const entry of entries) {
      if (!SAFE_ENTRY.test(entry.name)) {
        fail(`entry '${prefix}${entry.name}' uses characters that are not allowed in a lab workspace`);
      }

      const child = path.join(absolute, entry.name);
      const relative = `${prefix}${entry.name}`;

      // Resolve before deciding what it is: a symlink pointing out of the lab
      // directory must be rejected on its target, not on its own name.
      const real = await realpath(child).catch(() => null);
      if (real === null || !real.startsWith(`${labRoot}${path.sep}`)) {
        fail(`entry '${relative}' points outside the lab directory`);
      }

      const info = await stat(child);
      if (info.isDirectory()) {
        await walk(child, `${relative}/`);
        continue;
      }
      if (!info.isFile()) {
        fail(`entry '${relative}' is neither a regular file nor a directory`);
      }

      if (files.length >= MAX_WORKSPACE_FILES) {
        fail(`contains more than ${MAX_WORKSPACE_FILES} files`);
      }
      if (info.size > MAX_WORKSPACE_FILE_BYTES) {
        fail(`file '${relative}' is larger than ${MAX_WORKSPACE_FILE_BYTES} bytes`);
      }
      totalBytes += info.size;
      if (totalBytes > MAX_WORKSPACE_TOTAL_BYTES) {
        fail(`is larger than ${MAX_WORKSPACE_TOTAL_BYTES} bytes in total`);
      }

      const content = await readFile(child, 'utf8');
      if (content.includes('\0')) {
        fail(`file '${relative}' is not UTF-8 text`);
      }

      files.push({
        relativePath: relative,
        content,
        mode: EXECUTABLE_SUFFIXES.some((suffix) => relative.endsWith(suffix)) ? '0755' : '0644',
      });
    }
  };

  await walk(root, '');
  return files;
}

/** Directories that must exist before the files are written, parents first. */
export function workspaceDirectories(files: readonly WorkspaceFile[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.relativePath.split('/').slice(0, -1);
    for (let i = 1; i <= segments.length; i += 1) {
      directories.add(segments.slice(0, i).join('/'));
    }
  }
  return [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}
