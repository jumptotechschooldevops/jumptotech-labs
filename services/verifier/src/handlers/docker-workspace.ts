/**
 * Workspace checks — the two requirements that read a file the student wrote.
 *
 * Both are reads and only reads. Nothing here executes, sources, evaluates, or
 * builds the file; `dockerfile_valid` parses instruction keywords and stops.
 * The student's own `docker build` is what proves a Dockerfile works, and the
 * image checks are what grade the result.
 */
import { keyValues } from './filesystem.js';
import type { DockerVerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';
import { looksLikeDockerfile, parseDockerfile } from '../dockerfile.js';
import { imageMatches } from '../image.js';

/**
 * A file the student wrote holds what the lab asked for.
 *
 * **Non-disclosure.** A worksheet check's `contains` is frequently the answer
 * itself — the port a service turned out to be on, the resolver a container
 * turned out to use — and a detail that listed the missing values would hand
 * those over to anyone who pressed Check Solution once with a blank worksheet.
 * So the detail says *how many* of the required values are absent and never
 * which, the same rule `docker_container_file_content` holds and for the same
 * reason.
 *
 * That is deliberately less helpful than naming them, and it is the right
 * trade: a student who cannot tell which field they have not answered still has
 * the worksheet in front of them, with its own questions on it.
 */
export const workspaceFileExists: DockerVerifierHandler<'workspace_file_exists'> = {
  type: 'workspace_file_exists',
  label: (r) => `File ${r.path} exists`,
  async run(r, reader) {
    if (!reader.hasWorkspace) return workspaceUnavailable(r.path);

    const content = await reader.file(r.path);
    if (content === null) return fail(`No file named '${r.path}' in your lab workspace`);

    for (const [key, wanted] of Object.entries(r.key_values ?? {})) {
      const answers = keyValues(content, key, r.separator ?? '=');
      if (answers.length === 0) return fail(`'${r.path}' has no answer for ${key}`);
      if (answers.length > 1) return fail(`'${r.path}' answers ${key} ${answers.length} times — give one answer`);
      if (answers[0] !== wanted.trim()) return fail(`'${r.path}' has the wrong value for ${key}`);
    }

    const required = r.contains ?? [];
    const missing = required.filter((needle) => !content.includes(needle));
    if (missing.length === 0) return pass(`${content.length} bytes`);
    return fail(
      missing.length === required.length
        ? `'${r.path}' is missing everything the lab requires (read ${content.length} bytes)`
        : `'${r.path}' is missing ${missing.length} of the ${required.length} values the lab requires`,
    );
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
