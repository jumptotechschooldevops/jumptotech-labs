/**
 * "The rest of the line, without trailing whitespace" — in linear time.
 *
 * Four parsers used to end their line pattern with `(.+?)\s*$`. That tail is
 * quadratic: the lazy group grows one character at a time, and at every step
 * `\s*$` rescans the whole run of whitespace ahead of it before failing. A
 * line holding a long run of spaces with anything after it — which a student
 * controls completely, in their own process arguments or their own pipeline
 * file — therefore costs seconds of CPU per line. Measured before this change:
 * one 60 KiB line in a CI file took ~5 s, and one 100 KiB `ps` line ~15 s. The
 * verifier runs on the API's event loop, so that is every student's API
 * stalled, once per Check.
 *
 * These helpers compute the same capture without backtracking. The prefix is
 * still a regular expression, but one that ends in greedy whitespace and so
 * never has to give anything back to the value.
 *
 * One deliberate difference from the old tail: a value made only of whitespace
 * is no value. `(.+?)` would borrow a single whitespace character from the
 * prefix to capture `" "`, which no caller could use.
 */

/** Characters `.` does not match, so a value may not contain them. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Match `prefix` at the start of `line` and return its groups plus the value
 * that follows it, trailing whitespace removed.
 *
 * `prefix` must be anchored with `^` and should end in `\s*` or `\s+`, so the
 * value starts at the first non-whitespace character after it. Returns `null`
 * when the prefix does not match, the value is empty, or the value spans a
 * line terminator.
 */
export function matchLineValue(
  line: string,
  prefix: RegExp,
): { groups: RegExpExecArray; value: string } | null {
  const groups = prefix.exec(line);
  if (!groups || groups.index !== 0) return null;
  const value = line.slice(groups[0].length).trimEnd();
  if (value.length === 0 || LINE_TERMINATOR.test(value)) return null;
  return { groups, value };
}

/**
 * The value after the first `:` or `=` on a line that is followed by one.
 *
 * The linear equivalent of `/[:=]\s*(.+?)\s*$/.exec(line)?.[1]`.
 *
 * Without a line terminator in the line, the first separator decides: if it
 * has nothing after it, no later one can. With one, a separator's value is
 * usable only if no terminator lies inside it, which leaves two candidates:
 * a separator followed by nothing but whitespace up to the last terminator
 * (the whitespace, terminator included, is skipped), or failing that the
 * first separator after the last terminator.
 */
export function valueAfterSeparator(line: string): string | undefined {
  const trimmed = line.trimEnd();
  const valueFrom = (separator: number): string | undefined => {
    const value = trimmed.slice(separator + 1).trimStart();
    return value.length > 0 && !LINE_TERMINATOR.test(value) ? value : undefined;
  };
  const isSeparator = (char: string | undefined) => char === ':' || char === '=';

  const lastTerminator = Math.max(
    trimmed.lastIndexOf('\n'),
    trimmed.lastIndexOf('\r'),
    trimmed.lastIndexOf('\u2028'),
    trimmed.lastIndexOf('\u2029'),
  );
  if (lastTerminator < 0) {
    const separator = trimmed.search(/[:=]/);
    return separator < 0 ? undefined : valueFrom(separator);
  }

  let before = lastTerminator;
  while (before >= 0 && trimmed[before]!.trim() === '') before -= 1;
  if (before >= 0 && isSeparator(trimmed[before])) return valueFrom(before);

  const after = trimmed.slice(lastTerminator + 1).search(/[:=]/);
  return after < 0 ? undefined : valueFrom(lastTerminator + 1 + after);
}
