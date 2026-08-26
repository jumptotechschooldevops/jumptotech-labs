/**
 * Terraform reference extraction.
 *
 * `hcl.ts` answers *what blocks and arguments exist*. This module answers the
 * question a dependency lab actually asks: **is this argument a literal, or
 * does it refer to something else in the configuration?**
 *
 * ```hcl
 *   subnet_id = "subnet-123"        → a literal. No dependency.
 *   subnet_id = aws_subnet.app.id   → a reference. Terraform draws an edge.
 * ```
 *
 * Those two are indistinguishable to a substring search, and the second is the
 * whole point of an implicit-dependency lab. Telling them apart is why this
 * file exists.
 *
 * ### Why not a regular expression
 *
 * Because `"aws_subnet.app.id"` — the quoted string — must *not* count, while
 * `"prefix-${aws_subnet.app.id}"` must. A pattern that finds dotted identifiers
 * finds both, and a lab built on it would pass a student who pasted an address
 * into a string. So this walks the expression with a small mode stack: text
 * inside quotes and heredoc bodies is inert, and only what appears inside
 * `${…}` interpolation — or outside strings altogether — is a reference.
 *
 * ### What this is not
 *
 * Not an evaluator. Nothing here resolves a value, calls a function, follows a
 * module, or contacts anything. It reads source text and reports the shape of
 * the references it finds. Terraform's own semantics decide what those
 * references *mean*; this only reports that they are there.
 */

/** What a reference points at. */
export type ReferenceKind =
  | 'resource'
  | 'data'
  | 'variable'
  | 'local'
  | 'module'
  | 'builtin'
  | 'unknown';

export interface TerraformReference {
  kind: ReferenceKind;
  /**
   * The object referred to, without the attribute:
   * `local_file.config`, `var.channel`, `data.local_file.seed`, `module.app`.
   */
  target: string;
  /** The attribute path after the target, if any: `content_sha256`, `id`. */
  attribute?: string;
  /** Everything, as written after index brackets were dropped. */
  address: string;
}

/**
 * Prefixes Terraform reserves. `var.x` is not a resource of type `var`, and
 * `count.index` is not a resource of type `count`.
 */
const RESERVED = new Set([
  'var',
  'local',
  'data',
  'module',
  'each',
  'count',
  'path',
  'terraform',
  'self',
]);

const BUILTIN = new Set(['each', 'count', 'path', 'terraform', 'self']);

/** A Terraform identifier: a name a resource type or label may take. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** A provider resource type, which is always lower-case and underscored. */
const RESOURCE_TYPE = /^[a-z][a-z0-9_]*$/;

/**
 * Every reference in one expression's raw source.
 *
 * Duplicates are collapsed by address, because "does this depend on X" is not
 * a counting question.
 */
export function extractReferences(expression: string): TerraformReference[] {
  const found = new Map<string, TerraformReference>();
  for (const chain of dottedChains(expression)) {
    const reference = classify(chain);
    if (reference) found.set(reference.address, reference);
  }
  return [...found.values()];
}

/** Does this expression refer to `target` — `local_file.a`, `var.channel`, …? */
export function referencesTarget(expression: string, target: string): boolean {
  const wanted = target.trim();
  return extractReferences(expression).some((reference) => reference.target === wanted);
}

/**
 * Is this expression nothing but a literal — a quoted string, number or bool?
 *
 * The inverse of "contains a reference" is not this: `"${a.b}"` contains a
 * reference *and* is a quoted string. A literal is one with no interpolation.
 */
export function isLiteralExpression(expression: string): boolean {
  const text = expression.trim();
  if (text === 'true' || text === 'false' || text === 'null') return true;
  if (/^-?\d+(\.\d+)?$/.test(text)) return true;
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return false;
  return extractReferences(text).length === 0;
}

/**
 * Walk the expression and yield every dotted identifier chain that is *live* —
 * that is, not sealed inside string or heredoc text.
 *
 * The mode stack is what makes this correct rather than approximate. Quoted
 * text and heredoc bodies are inert until `${` opens an interpolation, and an
 * interpolation is live until its braces balance — so a string inside an
 * interpolation inside a string behaves properly, which is exactly the shape
 * `"${join(",", [a.b])}"` takes.
 */
function* dottedChains(expression: string): Generator<string> {
  type Mode = 'code' | 'string' | 'heredoc';
  const stack: Mode[] = ['code'];
  /** Brace depth of each open interpolation, so `${}` nesting closes correctly. */
  const interpolations: number[] = [];
  let braceDepth = 0;
  let heredocTag: string | null = null;
  let index = 0;
  let buffer = '';

  const flush = function* (): Generator<string> {
    if (buffer.includes('.')) yield buffer;
    buffer = '';
  };

  while (index < expression.length) {
    const mode = stack[stack.length - 1]!;
    const char = expression[index]!;
    const next = expression[index + 1];

    if (mode === 'code') {
      // Comments are text, never references.
      if (char === '#' || (char === '/' && next === '/')) {
        yield* flush();
        while (index < expression.length && expression[index] !== '\n') index += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        yield* flush();
        index += 2;
        while (index < expression.length && !(expression[index] === '*' && expression[index + 1] === '/')) {
          index += 1;
        }
        index += 2;
        continue;
      }
      if (char === '"') {
        yield* flush();
        stack.push('string');
        index += 1;
        continue;
      }
      if (char === '<' && next === '<') {
        yield* flush();
        const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(expression.slice(index));
        if (heredoc) {
          heredocTag = heredoc[1]!;
          stack.push('heredoc');
          index += heredoc[0].length;
          continue;
        }
      }
      if (char === '{') braceDepth += 1;
      if (char === '}') {
        // Closing an interpolation returns to the text that opened it.
        if (interpolations.length > 0 && braceDepth === interpolations[interpolations.length - 1]) {
          interpolations.pop();
          yield* flush();
          stack.pop();
          index += 1;
          continue;
        }
        braceDepth -= 1;
      }
      if (/[A-Za-z0-9_.\-]/.test(char)) {
        // A chain may not begin mid-number: `1.2` is not a traversal.
        if (buffer === '' && !/[A-Za-z_]/.test(char)) {
          index += 1;
          continue;
        }
        buffer += char;
        index += 1;
        continue;
      }
      if (char === '[') {
        /*
         * A bracket means two different things, and conflating them loses
         * references either way.
         *
         *   · after a traversal — `aws_subnet.app[0].id` — it is an index. The
         *     index is dropped and the buffer is *kept*, so the `.id` that
         *     follows continues the same chain rather than starting a dead one.
         *   · otherwise — `[a.b, c.d]` — it is a list literal, whose elements
         *     are ordinary expressions and must keep being scanned.
         */
        if (buffer === '') {
          index += 1;
          continue;
        }
        let depth = 1;
        const start = index + 1;
        index += 1;
        while (index < expression.length && depth > 0) {
          if (expression[index] === '[') depth += 1;
          if (expression[index] === ']') depth -= 1;
          index += 1;
        }
        // The index expression can hold references of its own — `count.index`,
        // `each.key`, even another resource attribute.
        yield* dottedChains(expression.slice(start, Math.max(start, index - 1)));
        continue;
      }
      yield* flush();
      index += 1;
      continue;
    }

    // --- inert text: only `${` wakes it up -------------------------------
    if (char === '$' && next === '{') {
      stack.push('code');
      braceDepth += 1;
      interpolations.push(braceDepth);
      index += 2;
      continue;
    }
    if (mode === 'string') {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '"') {
        stack.pop();
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    // heredoc: ends at a line whose only content is the tag
    if (char === '\n' || index === 0) {
      const rest = expression.slice(char === '\n' ? index + 1 : index);
      const line = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      if (line && line[1] === heredocTag) {
        stack.pop();
        heredocTag = null;
        index += (char === '\n' ? 1 : 0) + line[0].length;
        continue;
      }
    }
    index += 1;
  }
  yield* flush();
}

/** Turn a dotted chain into a structured reference, or discard it. */
function classify(chain: string): TerraformReference | null {
  const parts = chain.split('.').filter((part) => part !== '');
  if (parts.length < 2) return null;
  const [head, second, ...rest] = parts as [string, string, ...string[]];
  if (!IDENTIFIER.test(head)) return null;

  if (BUILTIN.has(head)) {
    return { kind: 'builtin', target: head, address: chain };
  }
  if (head === 'var' || head === 'local') {
    if (!IDENTIFIER.test(second)) return null;
    return {
      kind: head === 'var' ? 'variable' : 'local',
      target: `${head}.${second}`,
      address: chain,
      ...(rest.length > 0 ? { attribute: rest.join('.') } : {}),
    };
  }
  if (head === 'module') {
    if (!IDENTIFIER.test(second)) return null;
    return {
      kind: 'module',
      target: `module.${second}`,
      address: chain,
      ...(rest.length > 0 ? { attribute: rest.join('.') } : {}),
    };
  }
  if (head === 'data') {
    const [name, ...attribute] = rest;
    if (!RESOURCE_TYPE.test(second) || name === undefined || !IDENTIFIER.test(name)) return null;
    return {
      kind: 'data',
      target: `data.${second}.${name}`,
      address: chain,
      ...(attribute.length > 0 ? { attribute: attribute.join('.') } : {}),
    };
  }
  if (RESERVED.has(head)) return { kind: 'unknown', target: head, address: chain };
  if (!RESOURCE_TYPE.test(head) || !IDENTIFIER.test(second)) return null;
  return {
    kind: 'resource',
    target: `${head}.${second}`,
    address: chain,
    ...(rest.length > 0 ? { attribute: rest.join('.') } : {}),
  };
}
