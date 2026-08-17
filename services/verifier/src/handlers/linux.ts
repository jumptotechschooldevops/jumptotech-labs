/**
 * Linux system requirement handlers.
 *
 * The `filesystem` handlers next door answer "what is at this path". These
 * answer the questions a system-administration lab is actually about, and that
 * a path read cannot reach: is this process running, is anything listening on
 * that port, does this account exist and is it in that group, does the script
 * the student wrote actually work.
 *
 * Three properties hold across every handler here:
 *
 * **Nothing inspects what the student typed.** A process is running or it is
 * not; a group exists or it does not. How the student got there — a command, a
 * script, an editor — is never observed and never graded. That is what lets two
 * correct solutions both pass.
 *
 * **Matching happens here, over data the verifier read itself.** A lab's
 * process pattern is compared against a process table this module parsed; it is
 * never handed to `pgrep`, a shell, or a regular-expression engine. So a lab
 * pattern can neither inject nor backtrack.
 *
 * **The sandbox is fixed before a handler sees it.** Handlers receive a
 * `SandboxReader` already bound to one session's container. There is no
 * parameter anywhere below for naming a different one.
 */
import type { RequirementOf } from '@jumptotech/lab-orchestrator';
import { fail, missingPath, pass, type HandlerOutcome, type SandboxVerifierHandler } from '../contract.js';
import type { SandboxReader } from '../sandbox-reader.js';
import { normalizeMode } from './filesystem.js';

// --- filesystem, the parts the base family does not cover -------------------

export const pathAbsent: SandboxVerifierHandler<'path_absent'> = {
  type: 'path_absent',
  label: (r) => `Nothing remains at ${r.path}`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return pass();
    return fail(`'${requirement.path}' is still present`);
  },
};

export const fileContentAbsent: SandboxVerifierHandler<'file_content_absent'> = {
  type: 'file_content_absent',
  label: (r) => `File ${r.path} no longer contains that text`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file', requirement.path);
    if (read.type !== 'file' || read.content === undefined) {
      return fail(`'${requirement.path}' is not a readable regular file`);
    }
    // A truncated read cannot prove *absence* — the text could be past the cut.
    if (read.truncated) {
      return fail(
        `'${requirement.path}' is too large to check exhaustively; the platform only read the first part of it`,
      );
    }
    return contains(read.content, requirement.contains, requirement.ignore_case)
      ? fail(`'${requirement.path}' still contains that text`)
      : pass();
  },
};

/**
 * A regular file that its owner may execute.
 *
 * The owner bit specifically, not "any execute bit": a script a student wrote
 * is one they own, and `chmod o+x` on a file the owner cannot run is a mistake
 * a scripting lab should catch rather than accept.
 */
export const scriptExecutable: SandboxVerifierHandler<'script_executable'> = {
  type: 'script_executable',
  label: (r) => `${r.path} is executable`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('file', requirement.path);
    if (read.type !== 'file') return fail(`'${requirement.path}' is not a regular file`);

    const bits = Number.parseInt(normalizeMode(read.mode), 8);
    // 0o100 is the owner's execute bit.
    if ((bits & 0o100) === 0) {
      return fail(`'${requirement.path}' has mode ${normalizeMode(read.mode)} — its owner cannot execute it`);
    }
    return pass();
  },
};

// --- processes and ports ----------------------------------------------------

export const processRunning: SandboxVerifierHandler<'process_running'> = {
  type: 'process_running',
  label: (r) => `A process matching '${r.pattern}' is running`,
  async run(requirement, reader) {
    const matches = await matchingProcesses(reader, requirement.pattern);
    if (matches.length >= requirement.min_count) return pass();
    return fail(
      requirement.min_count === 1
        ? `No running process has '${requirement.pattern}' in its command line`
        : `Found ${matches.length} process(es) matching '${requirement.pattern}'; ${requirement.min_count} are required`,
    );
  },
};

export const processNotRunning: SandboxVerifierHandler<'process_not_running'> = {
  type: 'process_not_running',
  label: (r) => `No process matching '${r.pattern}' is running`,
  async run(requirement, reader) {
    const matches = await matchingProcesses(reader, requirement.pattern);
    if (matches.length === 0) return pass();
    // Report the count, never the pids: a troubleshooting lab must not hand
    // back the identifier that makes the fix a copy-paste.
    return fail(
      `${matches.length} process(es) matching '${requirement.pattern}' are still running`,
    );
  },
};

export const portListening: SandboxVerifierHandler<'port_listening'> = {
  type: 'port_listening',
  label: (r) => `Something is listening on ${r.protocol}/${r.port}`,
  async run(requirement, reader) {
    const sockets = await reader.sockets();
    const found = sockets.some(
      (s) => s.port === requirement.port && s.protocol === requirement.protocol,
    );
    return found
      ? pass()
      : fail(`Nothing is listening on ${requirement.protocol} port ${requirement.port}`);
  },
};

export const portNotListening: SandboxVerifierHandler<'port_not_listening'> = {
  type: 'port_not_listening',
  label: (r) => `Nothing is listening on ${r.protocol}/${r.port}`,
  async run(requirement, reader) {
    const sockets = await reader.sockets();
    const found = sockets.some(
      (s) => s.port === requirement.port && s.protocol === requirement.protocol,
    );
    return found
      ? fail(`Something is still listening on ${requirement.protocol} port ${requirement.port}`)
      : pass();
  },
};

// --- accounts ---------------------------------------------------------------

/**
 * Account checks read `getent`, not `/etc/passwd`.
 *
 * `getent` is the documented interface to the account databases, and it gives
 * the same answer whether an account is local or comes from somewhere else —
 * which is the behaviour the lab is teaching, and which parsing `/etc/passwd`
 * by hand would quietly get wrong.
 */
export const userExists: SandboxVerifierHandler<'user_exists'> = {
  type: 'user_exists',
  label: (r) => `The ${r.name} account exists`,
  async run(requirement, reader) {
    const entry = await getent(reader, 'passwd', requirement.name);
    return entry ? pass() : fail(`There is no account named '${requirement.name}'`);
  },
};

export const groupExists: SandboxVerifierHandler<'group_exists'> = {
  type: 'group_exists',
  label: (r) => `The ${r.name} group exists`,
  async run(requirement, reader) {
    const entry = await getent(reader, 'group', requirement.name);
    return entry ? pass() : fail(`There is no group named '${requirement.name}'`);
  },
};

/**
 * Membership, counting both kinds.
 *
 * A user belongs to a group either because the group lists them as a secondary
 * member, or because it is their *primary* group and they are not listed at
 * all. Checking only the group line would fail a perfectly correct
 * `useradd -g deployers`, so both are checked.
 */
export const userInGroup: SandboxVerifierHandler<'user_in_group'> = {
  type: 'user_in_group',
  label: (r) => `${r.user} is a member of ${r.group}`,
  async run(requirement, reader) {
    const group = await getent(reader, 'group', requirement.group);
    if (!group) return fail(`There is no group named '${requirement.group}'`);

    const user = await getent(reader, 'passwd', requirement.user);
    if (!user) return fail(`There is no account named '${requirement.user}'`);

    // group: name:passwd:gid:member,member
    const groupFields = group.split(':');
    const gid = groupFields[2] ?? '';
    const members = (groupFields[3] ?? '').split(',').filter(Boolean);
    if (members.includes(requirement.user)) return pass();

    // passwd: name:passwd:uid:gid:...
    if ((user.split(':')[3] ?? '') === gid && gid !== '') return pass();

    return fail(`'${requirement.user}' is not a member of '${requirement.group}'`);
  },
};

// --- scripts and allow-listed inspection commands ---------------------------

/**
 * Run the student's own script and grade its behaviour, not its source.
 *
 * This is what lets a scripting lab accept every correct solution: two students
 * who solve the task with completely different code both pass, because what is
 * compared is the exit status and the output. Reading the source and matching
 * on it would grade style, and would fail a correct answer written differently
 * from the one the author had in mind.
 *
 * It runs as the unprivileged student, inside that student's own throwaway
 * container — the one place where their script can already run, because they
 * have a shell in it.
 */
export const scriptRuns: SandboxVerifierHandler<'script_runs'> = {
  type: 'script_runs',
  label: (r) => `${r.path} runs and behaves as described`,
  async run(requirement, reader) {
    const read = await reader.path(requirement.path);
    if (!read) return missingPath('script', requirement.path);
    if (read.type !== 'file') return fail(`'${requirement.path}' is not a regular file`);

    const bits = Number.parseInt(normalizeMode(read.mode), 8);
    if ((bits & 0o100) === 0) {
      return fail(`'${requirement.path}' is not executable — its owner cannot run it`);
    }

    const result = await reader.script(requirement.path, requirement.args, {
      timeoutMs: requirement.timeout_seconds * 1000,
    });

    if (result.timedOut) {
      return fail(
        `'${requirement.path}' did not finish within ${requirement.timeout_seconds}s — it may be waiting for input`,
      );
    }
    if (result.exitCode !== requirement.expected_exit_code) {
      return fail(
        `'${requirement.path}' exited with ${result.exitCode}; ${requirement.expected_exit_code} was expected`,
      );
    }

    const output = `${result.stdout}\n${result.stderr}`;
    for (const expected of requirement.output_contains) {
      if (!contains(output, expected, false)) {
        return fail(`The output of '${requirement.path}' does not contain the expected text`);
      }
    }
    return pass();
  },
};

export const commandExitCode: SandboxVerifierHandler<'command_exit_code'> = {
  type: 'command_exit_code',
  label: (r) => `${r.command} reports the expected status`,
  async run(requirement, reader) {
    const result = await runInspection(reader, requirement);
    if (result.timedOut) return fail(`'${requirement.command}' did not finish in time`);
    return result.exitCode === requirement.expected_exit_code
      ? pass()
      : fail(`'${requirement.command}' exited with ${result.exitCode}`);
  },
};

export const commandOutput: SandboxVerifierHandler<'command_output'> = {
  type: 'command_output',
  label: (r) => `${r.command} reports the expected output`,
  async run(requirement, reader) {
    const result = await runInspection(reader, requirement);
    if (result.timedOut) return fail(`'${requirement.command}' did not finish in time`);
    if (result.exitCode !== 0) {
      return fail(`'${requirement.command}' exited with ${result.exitCode}`);
    }
    return contains(result.stdout, requirement.contains, false)
      ? pass()
      : fail(`The output of '${requirement.command}' does not contain the expected text`);
  },
};

// --- helpers ----------------------------------------------------------------

function contains(haystack: string, needle: string, ignoreCase: boolean): boolean {
  return ignoreCase
    ? haystack.toLowerCase().includes(needle.toLowerCase())
    : haystack.includes(needle);
}

/**
 * Processes whose command line contains a lab's fixed pattern.
 *
 * Plain substring matching over a table the verifier parsed. The verifier's own
 * `ps` invocation is excluded so a check can never match itself.
 */
async function matchingProcesses(reader: SandboxReader, pattern: string) {
  const processes = await reader.processes();
  return processes.filter(
    (entry) => entry.command.includes(pattern) && !entry.command.startsWith('ps -eo'),
  );
}

/** One `getent <database> <key>` line, or null when the key is unknown. */
async function getent(
  reader: SandboxReader,
  database: 'passwd' | 'group',
  key: string,
): Promise<string | null> {
  const result = await reader.inspect('getent', [database, key]);
  if (result.exitCode !== 0) return null;
  const line = result.stdout.split('\n')[0]?.trim();
  return line ? line : null;
}

function runInspection(
  reader: SandboxReader,
  requirement: RequirementOf<'command_exit_code'> | RequirementOf<'command_output'>,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return reader.inspect(requirement.command, requirement.args, {
    asRoot: requirement.as_user === 'root',
  });
}

/** Re-exported so the registry can name the whole family in one import. */
export type LinuxHandlerOutcome = HandlerOutcome;
