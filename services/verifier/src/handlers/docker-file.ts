/**
 * The one check that reads inside a container.
 *
 * It reads through the daemon's archive endpoint, so nothing executes in the
 * student's container, a stopped container grades as well as a running one, and
 * an image with no shell is no obstacle.
 *
 * **Non-disclosure is the rule this file exists to hold.** A lab that grades a
 * file is often grading an answer, and a check that failed by saying "expected
 * `production`, found `staging`" would hand the answer to anyone who guessed
 * wrong. So:
 *
 *   - the expected value is never named in a detail;
 *   - the file's content is never quoted back, not even a prefix;
 *   - the only facts a detail may carry are structural — the path, whether
 *     anything was there, how many bytes were read, and whether it was text.
 *
 * That is deliberately less helpful than the other Docker checks, and it is the
 * right trade: every other check grades configuration the student chose, which
 * is theirs to see. This one can be grading something they are supposed to work
 * out.
 */
import { DockerUnreachableError } from '@jumptotech/lab-orchestrator';
import type { DockerVerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';
import { MAX_CONTAINER_FILE_BYTES } from '../docker-reader.js';

/**
 * Is this content text we can compare?
 *
 * A NUL byte means binary, and a lossy UTF-8 decode means the bytes are not the
 * text the lab is comparing against. Either way the honest answer is "this is
 * not a text file", not a comparison against mojibake.
 */
function asText(content: Buffer): string | null {
  if (content.includes(0)) return null;
  const text = content.toString('utf8');
  // The replacement character only appears from a decode failure unless the
  // file genuinely contains one, and a lab never compares against one.
  if (text.includes('�')) return null;
  return text;
}

/** One trailing newline is an editor artefact, not a difference. */
const trimTrailingNewline = (text: string): string => text.replace(/\r?\n$/, '');

export const dockerContainerFileContent: DockerVerifierHandler<'docker_container_file_content'> = {
  type: 'docker_container_file_content',
  label: (r) => {
    if (r.absent) return `Container ${r.container} has no file at ${r.path}`;
    if (r.exists) return `Container ${r.container} has a file at ${r.path}`;
    return `The file ${r.path} in container ${r.container} holds what the lab expects`;
  },
  async run(r, reader) {
    // The container is resolved first, so "there is no such container" is never
    // reported as "the file is wrong".
    const container = await reader.container(r.container);
    if (!container) {
      return fail(`No container named '${r.container}' exists in your Docker environment`);
    }

    let read: Awaited<ReturnType<typeof reader.containerFile>>;
    try {
      read = await reader.containerFile(r.container, r.path);
    } catch (error) {
      // An environment that cannot be read is never a wrong answer. Let it
      // propagate so `verifyLab` reports ENVIRONMENT_UNREACHABLE and the
      // student's checks are skipped rather than failed.
      if (error instanceof DockerUnreachableError) throw error;
      // An unreadable archive — a directory, a link, a malformed stream — is a
      // failed check with a structural reason, never a silent "wrong content".
      const reason = error instanceof Error ? error.message : 'the path could not be read';
      return fail(`Could not read ${r.path} from '${r.container}': ${reason}`);
    }

    if (r.absent) {
      return read === null
        ? pass()
        : fail(`Container '${r.container}' still has a file at ${r.path}`);
    }

    if (read === null) {
      return fail(`Container '${r.container}' has no file at ${r.path}`);
    }

    if (r.exists) return pass(`${read.declaredSize} bytes`);

    if (read.truncated) {
      return fail(
        `File ${r.path} in '${r.container}' is ${read.declaredSize} bytes, larger than the ${MAX_CONTAINER_FILE_BYTES} the verifier reads`,
      );
    }

    const text = asText(read.content);
    if (text === null) {
      return fail(`File ${r.path} in '${r.container}' is not text, so it cannot be compared`);
    }

    if (r.equals !== undefined) {
      return trimTrailingNewline(text) === trimTrailingNewline(r.equals)
        ? pass()
        : fail(
            // Structural facts only. Neither the expectation nor the content.
            `File ${r.path} in '${r.container}' does not match what the lab expects (read ${read.declaredSize} bytes)`,
          );
    }

    const missing = (r.contains ?? []).filter((needle) => !text.includes(needle));
    if (missing.length === 0) return pass();
    return fail(
      missing.length === (r.contains ?? []).length
        ? `File ${r.path} in '${r.container}' is missing everything the lab requires (read ${read.declaredSize} bytes)`
        : `File ${r.path} in '${r.container}' is missing ${missing.length} of the ${(r.contains ?? []).length} values the lab requires`,
    );
  },
};
