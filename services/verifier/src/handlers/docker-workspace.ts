/**
 * Workspace checks — the two requirements that read a file the student wrote.
 *
 * Both are reads and only reads. Nothing here executes, sources, evaluates, or
 * builds the file; `dockerfile_valid` parses instruction keywords and stops.
 * The student's own `docker build` is what proves a Dockerfile works, and the
 * image checks are what grade the result.
 */
import type { DockerVerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';
import { looksLikeDockerfile, parseDockerfile } from '../dockerfile.js';
import { imageMatches } from '../image.js';

export const workspaceFileExists: DockerVerifierHandler<'workspace_file_exists'> = {
  type: 'workspace_file_exists',
  label: (r) => `File ${r.path} exists`,
  async run(r, reader) {
    if (!reader.hasWorkspace) return workspaceUnavailable(r.path);

    const content = await reader.file(r.path);
    if (content === null) return fail(`No file named '${r.path}' in your lab workspace`);

    const missing = (r.contains ?? []).filter((needle) => !content.includes(needle));
    return missing.length === 0
      ? pass(`${content.length} bytes`)
      : fail(`'${r.path}' does not mention ${missing.map((m) => `'${m}'`).join(', ')}`);
  },
};

export const dockerfileValid: DockerVerifierHandler<'dockerfile_valid'> = {
  type: 'dockerfile_valid',
  label: (r) =>
    r.requires.length === 0
      ? `${r.path} is a valid Dockerfile`
      : `${r.path} uses ${r.requires.join(', ')}`,
  async run(r, reader) {
    if (!reader.hasWorkspace) return workspaceUnavailable(r.path);

    const content = await reader.file(r.path);
    if (content === null) return fail(`No file named '${r.path}' in your lab workspace`);

    const parsed = parseDockerfile(content);
    if (!looksLikeDockerfile(parsed)) {
      return fail(
        parsed.lines.length === 0
          ? `'${r.path}' contains no Dockerfile instructions`
          : `'${r.path}' has no FROM instruction, so it cannot be built`,
      );
    }

    const problems: string[] = [];

    const missing = r.requires.filter((instruction) => !parsed.instructions.includes(instruction));
    if (missing.length > 0) problems.push(`missing ${missing.join(', ')}`);

    if (r.base_image !== undefined) {
      const matched = parsed.baseImages.some((base) => imageMatches(base, r.base_image!));
      if (!matched) {
        problems.push(
          `FROM names ${parsed.baseImages.map((b) => `'${b}'`).join(', ') || 'nothing'}, expected '${r.base_image}'`,
        );
      }
    }

    return problems.length === 0
      ? pass(`instructions: ${parsed.instructions.join(', ')}`)
      : fail(`'${r.path}': ${problems.join('; ')}`);
  },
};

/**
 * The workspace could not be reached.
 *
 * Reported as a failure with an operator-facing reason rather than as a wrong
 * answer: a student whose terminal never opened has not made a mistake, and the
 * message must not imply they did.
 */
function workspaceUnavailable(path: string) {
  return fail(
    `Cannot read '${path}' — the lab workspace is not available. Open the terminal to create it.`,
  );
}
