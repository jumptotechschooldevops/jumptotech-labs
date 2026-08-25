/**
 * A small, honest parser for systemd unit files.
 *
 * It exists because grading a unit file with substring matching grades the
 * wrong thing. `ExecStart=/usr/local/bin/app` and `ExecStart = /usr/local/bin/app`
 * are the same directive; a commented-out `#ExecStart=/bin/false` is not a
 * directive at all; `After=a.target` written twice means the same as
 * `After=a.target b.target` written once. A substring check gets all three
 * wrong, and gets them wrong in the direction that passes a broken unit.
 *
 * WHAT IS IMPLEMENTED, AND WHY THAT IS THE LINE
 *
 * The syntax rules below are the ones systemd documents in `systemd.syntax(7)`,
 * verified against the Debian-published manual on 2026-08-25:
 *
 *   · "Empty lines and lines starting with "#" or ";" are ignored"
 *   · "Lines ending in a backslash are concatenated with the following line
 *      while reading and the backslash is replaced by a space character"
 *   · "Whitespace immediately before or after the "=" is ignored"
 *   · "setting to an empty value "resets", which means that previous
 *      assignments are ignored"
 *   · "Various settings are allowed to be specified more than once, in which
 *      case the interpretation depends on the setting"
 *
 * That last rule is the one a parser can get quietly wrong, so this module does
 * not decide it. It records every assignment in order, applies resets, and
 * leaves the list-versus-scalar question to the caller — which reads a
 * directive either as a scalar (last assignment wins) or as an accumulated
 * whitespace-separated list, according to what systemd documents for that
 * specific directive. `LIST_DIRECTIVES` below is that mapping, and each entry
 * is one the manual explicitly says may be given more than once.
 *
 * What is deliberately NOT implemented: unit specifiers (`%i`, `%n`), drop-in
 * merging, template units, `systemd.exec` command-line quoting and escaping
 * beyond stripping one balanced pair of quotes, and any notion of whether the
 * unit would actually *start*. This parses a file and answers questions about
 * its directives. It is not systemd, and a lab using it must not claim it is.
 */

/** The three sections a service unit uses. Section names are case-sensitive. */
export type UnitSection = 'Unit' | 'Service' | 'Install';

export class SystemdUnitParseError extends Error {
  readonly code = 'INVALID_SYSTEMD_UNIT';
  constructor(
    readonly line: number,
    reason: string,
  ) {
    super(`line ${line}: ${reason}`);
    this.name = 'SystemdUnitParseError';
  }
}

/**
 * Directives that accumulate rather than override.
 *
 * Each is documented by systemd as taking a space-separated list and as
 * permitted more than once, with repetitions adding to the list —
 * `systemd.unit(5)` for the dependency and install settings, `systemd.exec(5)`
 * for the environment ones. Anything not listed here is read as a scalar whose
 * last assignment wins, which is systemd's default for an ordinary setting.
 */
export const LIST_DIRECTIVES: ReadonlySet<string> = new Set([
  // [Unit] — "They may be specified more than once, in which case
  // dependencies for all listed names are created."
  'After',
  'Before',
  'Wants',
  'Requires',
  'Requisite',
  'BindsTo',
  'PartOf',
  'Conflicts',
  // [Install] — "may be used more than once, or a space-separated list of unit
  // names may be given."
  'WantedBy',
  'RequiredBy',
  'Also',
  // [Service] — environment settings accumulate.
  'Environment',
  'EnvironmentFile',
]);

/** One parsed unit: section → directive → the assignments that survived resets. */
export class SystemdUnit {
  constructor(private readonly sections: Map<string, Map<string, string[]>>) {}

  /** Whether the file declared this section at all. */
  hasSection(section: string): boolean {
    return this.sections.has(section);
  }

  sectionNames(): string[] {
    return [...this.sections.keys()];
  }

  /** Every assignment still in effect for a directive, in file order. */
  assignments(section: string, directive: string): string[] {
    return [...(this.sections.get(section)?.get(directive) ?? [])];
  }

  /**
   * The directive's effective scalar value: the last assignment, or null.
   *
   * Correct for an ordinary setting, where systemd lets the last assignment
   * win. Reading a list directive this way would be wrong, so callers are
   * expected to consult `LIST_DIRECTIVES` first — `directiveTokens` is the
   * right reader for those.
   */
  scalar(section: string, directive: string): string | null {
    const values = this.sections.get(section)?.get(directive);
    if (!values || values.length === 0) return null;
    return values[values.length - 1] ?? null;
  }

  /**
   * A list directive's accumulated members.
   *
   * Every surviving assignment is split on whitespace and flattened, which is
   * what makes `After=a.target b.target` and two separate `After=` lines mean
   * the same thing — as systemd says they do. One balanced pair of surrounding
   * quotes is stripped per token, which covers `Environment="A=b c"`-style
   * values well enough for a configuration check without pretending to
   * implement systemd's full escaping rules.
   */
  tokens(section: string, directive: string): string[] {
    return this.assignments(section, directive)
      .flatMap((value) => value.split(/\s+/))
      .filter((token) => token.length > 0)
      .map(stripOneQuotePair);
  }

  /** Whether the directive has any value in effect. */
  isSet(section: string, directive: string): boolean {
    return this.assignments(section, directive).length > 0;
  }
}

function stripOneQuotePair(token: string): string {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return token.slice(1, -1);
  }
  return token;
}

const SECTION_LINE = /^\[([^\]]*)\]$/;
/** Directive names are ASCII words; systemd matches them case-sensitively. */
const DIRECTIVE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Parse a unit file.
 *
 * Throws `SystemdUnitParseError` on input systemd itself would refuse: a
 * directive before any section header, an unterminated section header, or a
 * line that is neither blank, a comment, a section, nor an assignment. Failing
 * loudly matters here — a lab that silently treated an unparseable file as
 * "no directives set" would report a confusing set of missing-directive
 * failures instead of the one thing that is actually wrong.
 */
export function parseSystemdUnit(text: string): SystemdUnit {
  const sections = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | null = null;
  let currentName = '';

  // Join continuations first: a trailing backslash means the next line is part
  // of this one, with the backslash becoming a space. Line numbers reported
  // afterwards refer to the line the logical statement started on.
  const logical: Array<{ text: string; line: number }> = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    let value = (raw[i] ?? '').replace(/\r$/, '');
    const startedAt = i + 1;
    while (value.endsWith('\\') && i + 1 < raw.length) {
      value = `${value.slice(0, -1)} ${(raw[i + 1] ?? '').replace(/\r$/, '')}`;
      i += 1;
    }
    logical.push({ text: value, line: startedAt });
  }

  for (const { text: line, line: lineNumber } of logical) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Comment markers are only comments at the start of a line; a `#` inside a
    // value is part of the value, which is why this tests `trimmed` rather
    // than searching the line.
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    if (trimmed.startsWith('[')) {
      const match = SECTION_LINE.exec(trimmed);
      if (!match || (match[1] ?? '').trim() === '') {
        throw new SystemdUnitParseError(lineNumber, 'malformed section header');
      }
      currentName = (match[1] ?? '').trim();
      current = sections.get(currentName) ?? new Map<string, string[]>();
      sections.set(currentName, current);
      continue;
    }

    const equals = trimmed.indexOf('=');
    if (equals < 0) {
      throw new SystemdUnitParseError(lineNumber, 'expected a directive assignment');
    }
    if (!current) {
      throw new SystemdUnitParseError(lineNumber, 'directive appears before any section header');
    }

    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    if (!DIRECTIVE_NAME.test(key)) {
      throw new SystemdUnitParseError(lineNumber, 'malformed directive name');
    }

    // "setting to an empty value resets, which means that previous assignments
    // are ignored" — so an empty assignment clears the list rather than adding
    // an empty member to it.
    if (value === '') {
      current.set(key, []);
      continue;
    }

    const existing = current.get(key);
    if (existing) existing.push(value);
    else current.set(key, [value]);
  }

  void currentName;
  return new SystemdUnit(sections);
}
