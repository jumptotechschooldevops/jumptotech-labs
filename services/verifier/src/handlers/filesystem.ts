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
 * Reports how many fragments are missing (or present when they must not be),
 * never which: in a findings lab the required text is the answer.
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

    // Counts, never the fragments: in a findings lab (LINUX-007) the text a
    // file must contain is the answer, and a decoy it must not contain is a
    // hint. The label says what the check is about.
    const content = read.content;
    const missing = requirement.contains.filter((fragment) => !content.includes(fragment));
    if (missing.length > 0) {
      return fail(
        `'${requirement.path}' is missing ${missing.length} of the ${requirement.contains.length} things this check looks for`,
      );
    }
    const present = requirement.absent.filter((fragment) => content.includes(fragment));
    if (present.length > 0) {
      return fail(
        `'${requirement.path}' still contains ${present.length === 1 ? 'something' : `${present.length} things`} this check says must not be there`,
      );
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

/**
 * One `KEY = value` answer, given once, with exactly the expected value.
 *
 * See `file_key_value` in requirements.ts for the grading rules. Linear in the
 * file's size: one split, and a scan of each line for its first separator.
 */
export const fileKeyValue: SandboxVerifierHandler<'file_key_value'> = {
  type: 'file_key_value',
  label: (r) => `${r.path} answers ${r.key}`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file', requirement.path);
    if (read.type !== 'file') {
      return fail(`'${requirement.path}' is ${describeType(read)}, not a regular file`);
    }
    if (read.content === undefined) return fail(`'${requirement.path}' could not be read`);
    // A truncated read cannot prove the key is answered only once.
    if (read.truncated) return fail(`'${requirement.path}' is larger than this check can read`);

    const answers = keyValues(read.content, requirement.key, requirement.separator);
    if (answers.length === 0) {
      return fail(`'${requirement.path}' has no answer for ${requirement.key}`);
    }
    if (answers.length > 1) {
      return fail(
        `'${requirement.path}' answers ${requirement.key} ${answers.length} times — give one answer`,
      );
    }
    const fold = (text: string) => (requirement.ignore_case ? text.toLowerCase() : text);
    return fold(answers[0]!) === fold(requirement.equals.trim())
      ? pass()
      : fail(`'${requirement.path}' has the wrong value for ${requirement.key}`);
  },
};

/**
 * Every non-empty value given to `key` in a `KEY<sep>value` text.
 *
 * Comment lines (`#`) are skipped, a leading `export ` on the key is dropped
 * (an env file may use it), and a value wrapped in one pair of matching quotes
 * is unwrapped. An empty value is a placeholder, not an answer.
 */
export function keyValues(text: string, key: string, separator: '=' | ':'): string[] {
  const values: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().replace(/^export\s+/, '');
    if (name !== key) continue;
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
      value = value.slice(1, -1).trim();
    }
    if (value !== '') values.push(value);
  }
  return values;
}

export const fileMode: SandboxVerifierHandler<'file_mode'> = {
  type: 'file_mode',
  label: (r) => `${r.path} has permissions ${normalizeMode(r.mode)}`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file or directory', requirement.path);

    const expected = normalizeMode(requirement.mode);
    const actual = normalizeMode(read.mode);
    if (actual !== expected) {
      // The observed mode, never the required one: working out the octal
      // value is often the lesson itself (LINUX-011's setgid 2770, sticky
      // 1777, a umask that yields 0640), and one Check would hand it over.
      return fail(`'${requirement.path}' has permissions ${actual}, which is not what this lab requires`);
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
