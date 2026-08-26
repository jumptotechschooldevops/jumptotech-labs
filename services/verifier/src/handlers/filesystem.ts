/**
 * Filesystem requirement handlers.
 *
 * These read the *real* filesystem inside the student's sandbox. Nothing here
 * inspects what the student typed: creating a directory with `mkdir -p`, with
 * `install -d`, from a script, or by extracting an archive all pass identically,
 * because all of them produce the same state.
 *
 * Two deliberate strictnesses, both about honesty rather than pedantry:
 *
 * **A symlink is not a file.** `stat` runs without `-L`, so a link reports as a
 * link. A permissions lab that accepted `ln -s /etc/hostname release.txt` as
 * "the file exists with the right contents" would be teaching the wrong thing,
 * and would let a student point a content check at something they never wrote.
 *
 * **Mode is compared as permission bits, not as a string.** `750`, `0750` and
 * `00750` are the same permission and all pass; `755` does not.
 */
import { parse as parseYaml } from 'yaml';
import type { RequirementOf, SandboxPathRead } from '@jumptotech/lab-orchestrator';
import {
  fail,
  missingPath,
  pass,
  type HandlerOutcome,
  type SandboxVerifierHandler,
} from '../contract.js';
import type { SandboxReader } from '../sandbox-reader.js';

/** Normalise `0750` / `750` / `00750` to the three-digit permission bits. */
export function normalizeMode(mode: string): string {
  const parsed = Number.parseInt(mode, 8);
  if (!Number.isFinite(parsed)) return mode;
  return (parsed & 0o7777).toString(8).padStart(3, '0');
}

/** How a path that is present but of the wrong type should be described. */
function describeType(read: SandboxPathRead): string {
  switch (read.type) {
    case 'file':
      return 'a regular file';
    case 'directory':
      return 'a directory';
    case 'symlink':
      return 'a symbolic link';
    default:
      return 'neither a regular file nor a directory';
  }
}

export const fileExists: SandboxVerifierHandler<'file_exists'> = {
  type: 'file_exists',
  label: (r) => `File ${r.path} exists`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file', requirement.path);
    if (read.type !== 'file') {
      return fail(`'${requirement.path}' is ${describeType(read)}, not a regular file`);
    }
    if (requirement.min_bytes !== undefined) {
      // `touch ci.yml` satisfies "exists" and teaches nothing. A lab that asked
      // the student to *write* a file says how much writing counts.
      const size = read.sizeBytes ?? Buffer.byteLength(read.content ?? '', 'utf8');
      if (size < requirement.min_bytes) {
        return fail(
          `'${requirement.path}' exists but holds ${size} bytes; this lab expects at least ${requirement.min_bytes}`,
        );
      }
    }
    return pass();
  },
};

/**
 * Several fragments must appear in one file, and/or several must not.
 *
 * Reports the *first* missing fragment rather than all of them: a student
 * fixing a pipeline script wants the next thing to do, and a list of four
 * absences for one forgotten line reads as four problems.
 */
export const fileContains: SandboxVerifierHandler<'file_contains'> = {
  type: 'file_contains',
  label: (r) => `File ${r.path} has the expected contents`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file', requirement.path);
    if (read.type !== 'file') {
      return fail(`'${requirement.path}' is ${describeType(read)}, not a regular file`);
    }
    if (read.content === undefined) return fail(`'${requirement.path}' could not be read`);
    if (read.truncated) {
      return fail(`'${requirement.path}' is larger than this check can read`);
    }

    const content = read.content;
    const missing = requirement.contains.find((fragment) => !content.includes(fragment));
    if (missing !== undefined) {
      return fail(`'${requirement.path}' does not mention '${missing}'`);
    }
    const present = requirement.absent.find((fragment) => content.includes(fragment));
    if (present !== undefined) {
      return fail(`'${requirement.path}' still mentions '${present}'`);
    }
    return pass();
  },
};

/**
 * The file parses as YAML.
 *
 * The first check a lab that asks for a YAML document should run: every later
 * question about its structure is meaningless if the parser rejected it, and
 * "not valid YAML: bad indentation at line 7" is the actionable answer.
 */
export const yamlValid: SandboxVerifierHandler<'yaml_valid'> = {
  type: 'yaml_valid',
  label: (r) => `${r.path} is valid YAML`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file', requirement.path);
    if (read.type !== 'file') {
      return fail(`'${requirement.path}' is ${describeType(read)}, not a regular file`);
    }
    if (read.content === undefined) return fail(`'${requirement.path}' could not be read`);
    if (read.truncated) return fail(`'${requirement.path}' is too large to parse as YAML`);

    let parsed: unknown;
    try {
      parsed = parseYaml(read.content);
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      return fail(`'${requirement.path}' is not valid YAML: ${message}`);
    }
    if (parsed === null || parsed === undefined) return fail(`'${requirement.path}' is empty`);
    return pass();
  },
};

export const directoryExists: SandboxVerifierHandler<'directory_exists'> = {
  type: 'directory_exists',
  label: (r) => `Directory ${r.path} exists`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('directory', requirement.path);
    if (read.type !== 'directory') {
      return fail(`'${requirement.path}' is ${describeType(read)}, not a directory`);
    }
    return pass();
  },
};

export const fileContent: SandboxVerifierHandler<'file_content'> = {
  type: 'file_content',
  label: (r) => `File ${r.path} has the expected contents`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file', requirement.path);
    if (read.type !== 'file') {
      return fail(`'${requirement.path}' is ${describeType(read)}, not a regular file`);
    }
    if (read.content === undefined) {
      return fail(`'${requirement.path}' could not be read`);
    }
    if (read.truncated) {
      return fail(
        `'${requirement.path}' is larger than this check can read; a lab file should be small`,
      );
    }

    const actual = read.content;
    if (requirement.equals !== undefined) {
      // Trailing whitespace is an editor artefact, not a mistake worth failing.
      if (actual.replace(/\s+$/, '') !== requirement.equals.replace(/\s+$/, '')) {
        return fail(
          `'${requirement.path}' does not contain the expected text — found ${summarise(actual)}`,
        );
      }
    }
    if (requirement.contains !== undefined && !actual.includes(requirement.contains)) {
      return fail(
        `'${requirement.path}' does not contain the expected text — found ${summarise(actual)}`,
      );
    }
    return pass();
  },
};

export const fileMode: SandboxVerifierHandler<'file_mode'> = {
  type: 'file_mode',
  label: (r) => `${r.path} has permissions ${normalizeMode(r.mode)}`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file or directory', requirement.path);

    const expected = normalizeMode(requirement.mode);
    const actual = normalizeMode(read.mode);
    if (actual !== expected) {
      return fail(
        `'${requirement.path}' has permissions ${actual}, expected ${expected}`,
      );
    }
    return pass();
  },
};

export const fileOwner: SandboxVerifierHandler<'file_owner'> = {
  type: 'file_owner',
  label: (r) => `${r.path} is owned by ${r.owner}`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file or directory', requirement.path);
    if (read.owner !== requirement.owner) {
      return fail(
        `'${requirement.path}' is owned by '${read.owner || 'unknown'}', expected '${requirement.owner}'`,
      );
    }
    return pass();
  },
};

export const fileGroup: SandboxVerifierHandler<'file_group'> = {
  type: 'file_group',
  label: (r) => `${r.path} belongs to group ${r.group}`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file or directory', requirement.path);
    if (read.group !== requirement.group) {
      return fail(
        `'${requirement.path}' belongs to group '${read.group || 'unknown'}', expected '${requirement.group}'`,
      );
    }
    return pass();
  },
};

/**
 * A short, safe rendering of what was actually found.
 *
 * Enough for a student to see *that* the contents differ without the failure
 * detail becoming a dump of the file — and it never states what the file should
 * have contained, which would be the answer.
 */
function summarise(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 'an empty file';
  const firstLine = trimmed.split('\n')[0] ?? '';
  const shown = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  const lines = trimmed.split('\n').length;
  return lines > 1 ? `'${shown}' (${lines} lines)` : `'${shown}'`;
}

/** Reused by the Terraform handlers, which also reason about path types. */
export function typeOf(read: SandboxPathRead | null): string {
  return read ? describeType(read) : 'nothing';
}

export type { HandlerOutcome, RequirementOf, SandboxReader };
