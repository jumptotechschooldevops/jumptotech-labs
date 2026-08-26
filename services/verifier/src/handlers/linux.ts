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
import {
  LIST_DIRECTIVES,
  parseSystemdUnit,
  SystemdUnitParseError,
  type SystemdUnit,
} from '../systemd-unit.js';

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

/**
 * The environment a running process actually has.
 *
 * The rule this handler exists to enforce, and the reason it is careful about
 * what it says: **it reports a verdict, never a value.** A student sees which
 * variable is wrong and in what way — missing, present when it should not be,
 * or set to the wrong thing — and never what it is set to, nor what it should
 * have been. `AWS_SECRET_ACCESS_KEY expected X but found Y` is precisely the
 * failure message this must not be able to produce, so no branch below
 * interpolates a value from either the process or the lab definition.
 *
 * `sensitive: true` on a variable withholds even its name.
 *
 * Every matching process must satisfy every assertion. That is stricter than
 * "one of them does", and deliberately: a student who starts a second process
 * with the right environment must not be able to mask a misconfigured one.
 */
export const processEnviron: SandboxVerifierHandler<'process_environ'> = {
  type: 'process_environ',
  label: (r) => `The process matching '${r.pattern}' has the required environment`,
  async run(requirement, reader) {
    const matches = await matchingProcesses(reader, requirement.pattern);
    if (matches.length < requirement.min_count) {
      return fail(
        requirement.min_count === 1
          ? `No running process has '${requirement.pattern}' in its command line`
          : `Found ${matches.length} process(es) matching '${requirement.pattern}'; ${requirement.min_count} are required`,
      );
    }

    const names = requirement.variables.map((v) => v.name);

    for (const match of matches) {
      const environ = await reader.environForPid(match.pid, names);
      if (!environ) {
        // Unreadable is not a pass. The process may have exited between the
        // table read and this one, or the sandbox may not expose /proc.
        return fail(
          `Could not read the environment of the process matching '${requirement.pattern}'`,
        );
      }

      for (const variable of requirement.variables) {
        const actual = environ.get(variable.name);
        const shown = variable.sensitive ? 'A required environment variable' : `'${variable.name}'`;

        if (variable.absent === true) {
          if (actual !== undefined) {
            return fail(`${shown} is set on the process, and must not be`);
          }
          continue;
        }
        if (actual === undefined) {
          return fail(`${shown} is not set on the process`);
        }
        if (variable.present === true) continue;
        if (variable.equals !== undefined && actual !== variable.equals) {
          // Neither value appears. The student is told which variable to look
          // at and that it is wrong, which is what a real runbook would say.
          return fail(`${shown} is set to the wrong value`);
        }
        if (variable.not_equals !== undefined && actual === variable.not_equals) {
          return fail(`${shown} is set to a value this lab forbids`);
        }
      }
    }

    return pass();
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

// --- systemd unit files -----------------------------------------------------

/**
 * Read a unit file and answer one question about one section or directive.
 *
 * Server-side and read-only. The expected value never leaves this process: it
 * comes from the lab definition on the server, the unit file is read out of the
 * sandbox, and the comparison happens here. Nothing is written into the
 * sandbox, no checker script is generated, and the failure details below name
 * what was *observed* rather than what was wanted — so a student who reads
 * every check result still has to work out the answer.
 */
export const systemdUnitSection: SandboxVerifierHandler<'systemd_unit_section'> = {
  type: 'systemd_unit_section',
  label: (r) => `${r.path} declares a [${r.section}] section`,
  async run(requirement, reader) {
    const unit = await readUnit(reader, requirement.path);
    if ('failure' in unit) return unit.failure;
    return unit.value.hasSection(requirement.section)
      ? pass()
      : fail(`'${requirement.path}' has no [${requirement.section}] section`);
  },
};

export const systemdUnitDirective: SandboxVerifierHandler<'systemd_unit_directive'> = {
  type: 'systemd_unit_directive',
  label: (r) => `${r.path} sets ${r.section}/${r.directive} as described`,
  async run(requirement, reader) {
    const unit = await readUnit(reader, requirement.path);
    if ('failure' in unit) return unit.failure;
    const { section, directive } = requirement;
    const where = `[${section}] ${directive}`;

    if (requirement.absent === true) {
      return unit.value.isSet(section, directive)
        ? fail(`'${requirement.path}' still sets ${where}`)
        : pass();
    }

    if (!unit.value.hasSection(section)) {
      return fail(`'${requirement.path}' has no [${section}] section`);
    }
    if (!unit.value.isSet(section, directive)) {
      return fail(`'${requirement.path}' does not set ${where}`);
    }

    /*
     * Which reader applies is decided by systemd's documented behaviour for
     * this directive, not by which assertion the lab happened to write. A
     * dependency setting accumulates across repetitions and is matched by
     * membership; an ordinary setting is a scalar whose last assignment wins.
     */
    if (requirement.contains !== undefined) {
      const members = LIST_DIRECTIVES.has(directive)
        ? unit.value.tokens(section, directive)
        : // A scalar directive has one effective value; membership over its
          // whitespace-split form is still the honest reading of "contains".
          unit.value.tokens(section, directive);
      return members.includes(requirement.contains)
        ? pass()
        : fail(`${where} is set, but not to what this check expects`);
    }

    if (LIST_DIRECTIVES.has(directive)) {
      // `equals` on a list directive compares the whole accumulated list, so a
      // lab cannot accidentally assert "exactly one dependency" by writing the
      // check it would have written for a scalar.
      const joined = unit.value.tokens(section, directive).join(' ');
      return joined === requirement.equals
        ? pass()
        : fail(`${where} is set, but not to what this check expects`);
    }

    const actual = unit.value.scalar(section, directive);
    return collapseWhitespace(actual) === collapseWhitespace(requirement.equals)
      ? pass()
      : fail(`${where} is set, but not to what this check expects`);
  },
};

/**
 * Compare scalar values on their content, not on their spacing.
 *
 * systemd replaces a line-ending backslash with a space and concatenates, so a
 * student who writes a long `ExecStart=` across three indented lines — which is
 * the documented way to write one — ends up with runs of spaces the file does
 * not visibly contain. Failing that answer over invisible whitespace would be
 * grading formatting rather than configuration, and systemd itself splits a
 * command line on whitespace regardless of how much of it there is.
 *
 * This collapses runs; it does not trim meaning. `ExecStart=/bin/a --x` and
 * `ExecStart=/bin/b --x` still differ, and so do `on-failure` and `always`.
 */
function collapseWhitespace(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : value.replace(/\s+/g, ' ').trim();
}

/** Read and parse a unit, turning every failure mode into a check outcome. */
async function readUnit(
  reader: SandboxReader,
  path: string,
): Promise<{ value: SystemdUnit } | { failure: HandlerOutcome }> {
  const read = await reader.path(path);
  if (!read) return { failure: missingPath('unit file', path) };
  if (read.type !== 'file' || read.content === undefined) {
    return { failure: fail(`'${path}' is not a readable regular file`) };
  }
  if (read.truncated) {
    return {
      failure: fail(`'${path}' is too large to read as a unit file`),
    };
  }
  try {
    return { value: parseSystemdUnit(read.content) };
  } catch (error) {
    // The parse error names the line and the shape of the problem, never the
    // directive the lab was looking for.
    const detail = error instanceof SystemdUnitParseError ? error.message : 'could not be parsed';
    return { failure: fail(`'${path}' is not a valid unit file — ${detail}`) };
  }
}
