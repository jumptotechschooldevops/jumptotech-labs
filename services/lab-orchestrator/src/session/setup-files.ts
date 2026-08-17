/**
 * Starter-file loading for container-backed labs.
 *
 * The container equivalent of `manifests.ts`. A Terraform lab that begins from
 * a skeleton configuration declares it declaratively:
 *
 * ```yaml
 * setup:
 *   files:
 *     - source: setup/versions.tf     # inside the lab directory
 *       path: terraform/versions.tf   # inside the session's sandbox home
 *       mode: "0644"
 * ```
 *
 * Both halves are constrained, and for the same reason as the Kubernetes
 * manifest loader: lab content is data, and data does not get to choose where
 * it lands.
 *
 *   · `source` cannot escape the lab directory (schema + resolved re-check);
 *   · `path` cannot escape the sandbox home (`assertSafeSandboxPath`);
 *   · a file is capped in size, so a lab cannot ship a sandbox-filling blob;
 *   · nothing is executable — `mode` is masked to remove the execute bits, so
 *     a starter file can never be a script the platform then runs. Nothing in
 *     the platform runs starter files at all; this is belt and braces.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LabDefinitionError, type LoadedLabDefinition } from '../lab-definition.js';
import { assertSafeSandboxPath } from './sandbox-paths.js';

/** Cap on a single starter file. Lab skeletons are a few hundred bytes. */
export const MAX_SETUP_FILE_BYTES = 64 * 1024;

export interface LoadedSetupFile {
  /** Path relative to the sandbox home. */
  path: string;
  content: string;
  /** Octal mode string, e.g. `644`. Execute bits are always cleared. */
  mode: string;
  /** Where it came from, for error messages and reset reporting. */
  source: string;
}

/** Strip the execute bits from a declared mode. */
export function nonExecutableMode(mode: string): string {
  const parsed = Number.parseInt(mode, 8);
  if (!Number.isFinite(parsed)) return '644';
  // 0o111 is --x--x--x.
  const masked = parsed & ~0o111;
  return (masked & 0o777).toString(8).padStart(3, '0');
}

export async function loadSetupFiles(lab: LoadedLabDefinition): Promise<LoadedSetupFile[]> {
  const files: LoadedSetupFile[] = [];

  for (const declared of lab.setup.files) {
    const absolute = resolveSourcePath(lab, declared.source);

    let content: string;
    try {
      content = await readFile(absolute, 'utf8');
    } catch (cause) {
      throw new LabDefinitionError(
        `Cannot read setup file '${declared.source}': ${(cause as Error).message}`,
        lab.sourcePath,
        [],
        lab.id,
      );
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_SETUP_FILE_BYTES) {
      throw new LabDefinitionError(
        `setup file '${declared.source}' is larger than ${MAX_SETUP_FILE_BYTES} bytes`,
        lab.sourcePath,
        [],
        lab.id,
      );
    }

    try {
      assertSafeSandboxPath(declared.path);
    } catch (cause) {
      throw new LabDefinitionError(
        `setup file destination '${declared.path}': ${(cause as Error).message}`,
        lab.sourcePath,
        [],
        lab.id,
      );
    }

    files.push({
      path: declared.path,
      content,
      mode: nonExecutableMode(declared.mode),
      source: declared.source,
    });
  }

  return files;
}

/**
 * Resolve a declared source path inside the lab directory.
 *
 * Mirrors `resolveManifestPath`: the schema already rejects `..` and absolute
 * paths, and this re-checks the resolved result so a symlinked or unusual path
 * cannot escape either.
 */
function resolveSourcePath(lab: LoadedLabDefinition, relative: string): string {
  const resolved = path.resolve(lab.directory, relative);
  const root = path.resolve(lab.directory) + path.sep;
  if (!resolved.startsWith(root)) {
    throw new LabDefinitionError(
      `Setup file '${relative}' resolves outside the lab directory`,
      lab.sourcePath,
      [],
      lab.id,
    );
  }
  return resolved;
}
