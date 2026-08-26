/**
 * A block-structure scanner for HCL2.
 *
 * Most Terraform verification reads *state*, which is JSON and unambiguous.
 * A few things a Terraform course has to teach are not visible in state,
 * though: whether the student wrote a `variable` block or hardcoded the value,
 * whether they extracted a module or copy-pasted a resource, whether a
 * `lifecycle` rule is declared. Those questions are about the configuration.
 *
 * ### What this is, and what it is not
 *
 * This is a **structure scanner**, not an HCL evaluator. It answers "which
 * blocks exist, with which labels, containing which argument names, and what is
 * the raw text of an argument's value". It never evaluates an expression,
 * resolves a variable, or interprets a function call — and it does not need to,
 * because every value question is answered from state instead.
 *
 * It is written as a real lexer rather than a set of regular expressions
 * because HCL has three constructs that make line-based matching wrong:
 * comments (`#`, `//`, block), quoted strings containing braces, and heredocs.
 * All three are handled here, so a brace inside a string or a `#` inside a
 * heredoc cannot desynchronise the block structure.
 *
 * Documented limits: expression *contents* are opaque text, and a block label
 * written as anything other than a quoted string or a bare identifier is not
 * recognised. Neither appears in the material these labs teach.
 */

export interface HclArgument {
  name: string;
  /** Raw source of the right-hand side, trimmed. Never evaluated. */
  value: string;
  line: number;
}

export interface HclBlock {
  /** `resource`, `variable`, `module`, `output`, `locals`, `data`, `lifecycle`… */
  type: string;
  /** Quoted or bare labels, in order: `resource "local_file" "greeting"`. */
  labels: string[];
  /** Blocks nested directly inside this one. */
  blocks: HclBlock[];
  arguments: HclArgument[];
  line: number;
  /** The file this block came from, when the scan was given one. */
  file?: string;
}

export interface HclDocument {
  blocks: HclBlock[];
  arguments: HclArgument[];
}

// ------------------------------------------------------------------- lexing

type TokenKind = 'ident' | 'string' | 'number' | 'lbrace' | 'rbrace' | 'symbol' | 'newline';

interface Token {
  kind: TokenKind;
  /** For `string`, the decoded-enough literal contents without the quotes. */
  value: string;
  line: number;
  /** Offsets into the original source, so an expression can be sliced exactly. */
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

/** Guardrail against a pathological input consuming the event loop. */
const MAX_INPUT_BYTES = 512 * 1024;

export class HclScanError extends Error {
  readonly code = 'HCL_SCAN_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'HclScanError';
  }
}

function tokenize(text: string): Token[] {
  if (text.length > MAX_INPUT_BYTES) {
    throw new HclScanError(`configuration file is larger than ${MAX_INPUT_BYTES} bytes`);
  }

  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;

  const push = (kind: TokenKind, value: string, start: number, end: number): void => {
    tokens.push({ kind, value, line, start, end });
  };

  while (i < n) {
    const ch = text[i]!;

    if (ch === '\n') {
      push('newline', '\n', i, i + 1);
      line += 1;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }

    // --- comments ---------------------------------------------------------
    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }

    // --- heredoc ----------------------------------------------------------
    if (ch === '<' && text[i + 1] === '<') {
      const consumed = readHeredoc(text, i, line);
      if (consumed) {
        push('string', consumed.value, i, consumed.next);
        i = consumed.next;
        line = consumed.line;
        continue;
      }
    }

    // --- quoted string ----------------------------------------------------
    if (ch === '"') {
      const startLine = line;
      const start = i;
      const read = readQuotedString(text, i);
      i = read.next;
      line += read.newlines;
      tokens.push({ kind: 'string', value: read.value, line: startLine, start, end: i });
      continue;
    }

    // --- identifiers ------------------------------------------------------
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < n && IDENT_PART.test(text[i]!)) i += 1;
      push('ident', text.slice(start, i), start, i);
      continue;
    }

    // --- numbers ----------------------------------------------------------
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < n && /[0-9.eE+-]/.test(text[i]!)) i += 1;
      push('number', text.slice(start, i), start, i);
      continue;
    }

    if (ch === '{') {
      push('lbrace', '{', i, i + 1);
      i += 1;
      continue;
    }
    if (ch === '}') {
      push('rbrace', '}', i, i + 1);
      i += 1;
      continue;
    }

    push('symbol', ch, i, i + 1);
    i += 1;
  }

  return tokens;
}

/**
 * Read a `"…"` literal.
 *
 * Interpolation sequences are consumed as opaque text with their own brace
 * depth, so `"${merge({a = 1})}"` does not terminate the string early and its
 * braces never reach the block scanner.
 */
function readQuotedString(text: string, start: number): { value: string; next: number; newlines: number } {
  let i = start + 1;
  let value = '';
  let newlines = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;
    if (ch === '\\') {
      value += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === '{') {
      let depth = 1;
      const from = i;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        else if (text[i] === '\n') newlines += 1;
        i += 1;
      }
      value += text.slice(from, i);
      continue;
    }
    if (ch === '"') {
      i += 1;
      break;
    }
    if (ch === '\n') newlines += 1;
    value += ch;
    i += 1;
  }

  return { value, next: i, newlines };
}

/** Read `<<TAG` / `<<-TAG` … `TAG`. Returns null when it is not a heredoc. */
function readHeredoc(
  text: string,
  start: number,
  line: number,
): { value: string; next: number; line: number } | null {
  let i = start + 2;
  if (text[i] === '-') i += 1;
  const tagStart = i;
  while (i < text.length && IDENT_PART.test(text[i] ?? '')) i += 1;
  const tag = text.slice(tagStart, i);
  if (tag.length === 0) return null;

  // Skip to the end of the opening line.
  while (i < text.length && text[i] !== '\n') i += 1;
  if (i < text.length) i += 1;

  let currentLine = line + 1;
  const bodyStart = i;
  while (i < text.length) {
    const lineEnd = text.indexOf('\n', i);
    const end = lineEnd === -1 ? text.length : lineEnd;
    if (text.slice(i, end).trim() === tag) {
      /*
       * Stop *at* the terminator's newline, not past it.
       *
       * The newline is HCL's statement separator. Swallowing it here would
       * leave no token between the heredoc and the next argument, and the
       * expression reader would then consume that argument as part of the
       * heredoc's value.
       */
      return { value: text.slice(bodyStart, i), next: end, line: currentLine };
    }
    currentLine += 1;
    if (lineEnd === -1) break;
    i = lineEnd + 1;
  }

  // Unterminated heredoc: treat the rest of the file as its body rather than
  // letting the scanner mis-read the remaining braces.
  return { value: text.slice(bodyStart), next: text.length, line: currentLine };
}

// ------------------------------------------------------------------ parsing

/**
 * Scan one configuration file into blocks and top-level arguments.
 *
 * A malformed file does not throw: a student mid-edit (and TF-010's seeded
 * fault) must still produce whatever structure *is* readable, so that a check
 * can report "no `variable` block named X" instead of "the platform crashed".
 */
export function scanHcl(text: string, file?: string): HclDocument {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return { blocks: [], arguments: [] };
  }
  const parser = new Parser(tokens, text, file);
  return parser.parseBody(true);
}

/** Scan several files and merge their top-level blocks, in the given order. */
export function scanHclFiles(files: ReadonlyArray<{ path: string; text: string }>): HclDocument {
  const blocks: HclBlock[] = [];
  const args: HclArgument[] = [];
  for (const file of files) {
    const doc = scanHcl(file.text, file.path);
    blocks.push(...doc.blocks);
    args.push(...doc.arguments);
  }
  return { blocks, arguments: args };
}

class Parser {
  #index = 0;

  constructor(
    private readonly tokens: Token[],
    /** The original source, so an expression can be returned verbatim. */
    private readonly source: string,
    private readonly file: string | undefined,
  ) {}

  #peek(offset = 0): Token | undefined {
    return this.tokens[this.#index + offset];
  }

  /** Next token, skipping newlines, together with how far ahead it sits. */
  #peekSignificant(from: number): { token: Token; offset: number } | null {
    let offset = from;
    for (;;) {
      const token = this.tokens[this.#index + offset];
      if (!token) return null;
      if (token.kind !== 'newline') return { token, offset };
      offset += 1;
    }
  }

  /**
   * Parse tokens until the matching `}` (or end of input at the top level).
   *
   * Recognises exactly two statement shapes and skips anything else, which is
   * what keeps an unparseable expression from derailing the surrounding blocks:
   *
   *   `ident label* {`   → a block
   *   `ident =`          → an argument
   */
  parseBody(topLevel: boolean): HclDocument {
    const blocks: HclBlock[] = [];
    const args: HclArgument[] = [];

    for (;;) {
      const token = this.#peek();
      if (!token) break;

      if (token.kind === 'newline' || (token.kind === 'symbol' && token.value === ',')) {
        this.#index += 1;
        continue;
      }

      if (token.kind === 'rbrace') {
        if (topLevel) {
          // A stray closer in a malformed file; drop it and keep going.
          this.#index += 1;
          continue;
        }
        this.#index += 1;
        break;
      }

      if (token.kind === 'ident') {
        const statement = this.#tryStatement(token);
        if (statement === 'block') {
          blocks.push(this.#lastBlock!);
          continue;
        }
        if (statement === 'argument') {
          args.push(this.#lastArgument!);
          continue;
        }
      }

      // Not a shape we model — skip the rest of this line, staying balanced.
      this.#skipStatement();
    }

    return { blocks, arguments: args };
  }

  #lastBlock: HclBlock | undefined;
  #lastArgument: HclArgument | undefined;

  #tryStatement(head: Token): 'block' | 'argument' | null {
    // `ident =` — an argument.
    const after = this.#peekSignificant(1);
    if (after && after.token.kind === 'symbol' && after.token.value === '=') {
      const next = this.tokens[this.#index + after.offset + 1];
      // `==` is a comparison inside an expression, not an assignment.
      if (!(next && next.kind === 'symbol' && next.value === '=')) {
        this.#index += after.offset + 1;
        const value = this.#readExpression();
        this.#lastArgument = { name: head.value, value, line: head.line };
        return 'argument';
      }
    }

    // `ident label* {` — a block.
    const labels: string[] = [];
    let offset = 1;
    for (;;) {
      const upcoming = this.#peekSignificant(offset);
      if (!upcoming) return null;
      if (upcoming.token.kind === 'lbrace') {
        this.#index += upcoming.offset + 1;
        const body = this.parseBody(false);
        this.#lastBlock = {
          type: head.value,
          labels,
          blocks: body.blocks,
          arguments: body.arguments,
          line: head.line,
          ...(this.file ? { file: this.file } : {}),
        };
        return 'block';
      }
      if (upcoming.token.kind === 'string' || upcoming.token.kind === 'ident') {
        labels.push(upcoming.token.value);
        offset = upcoming.offset + 1;
        continue;
      }
      return null;
    }
  }

  /**
   * Consume one expression, returning its source text verbatim.
   *
   * Sliced from the original document rather than rebuilt from tokens: joining
   * tokens with spaces would turn `var.environment` into `var . environment`
   * and `==` into `= =`, which would then break anything that reads the
   * expression back — `referencedNames` most obviously.
   *
   * Bracket, paren, and brace depth are tracked so an object or list literal
   * spanning several lines is read whole. The scan stops at the first newline
   * at depth zero — HCL's own statement terminator.
   */
  #readExpression(): string {
    const first = this.#peek();
    if (!first) return '';

    let start = -1;
    let end = -1;
    let depth = 0;

    for (;;) {
      const token = this.#peek();
      if (!token) break;

      if (token.kind === 'newline') {
        if (depth === 0) break;
        this.#index += 1;
        end = token.end;
        continue;
      }
      if (token.kind === 'rbrace') {
        if (depth === 0) break;
        depth -= 1;
        this.#index += 1;
        end = token.end;
        continue;
      }
      if (token.kind === 'lbrace') depth += 1;
      if (token.kind === 'symbol' && (token.value === '[' || token.value === '(')) depth += 1;
      if (token.kind === 'symbol' && (token.value === ']' || token.value === ')')) {
        depth = Math.max(0, depth - 1);
      }
      if (token.kind === 'symbol' && token.value === ',' && depth === 0) break;

      if (start === -1) start = token.start;
      end = token.end;
      this.#index += 1;
    }

    if (start === -1) return '';
    // Collapse runs of whitespace so a multi-line literal is one comparable
    // string, but keep every other character exactly as written.
    return this.source.slice(start, end).replace(/\s+/g, ' ').trim();
  }

  /** Skip an unrecognised statement without losing brace balance. */
  #skipStatement(): void {
    let depth = 0;
    for (;;) {
      const token = this.#peek();
      if (!token) return;
      if (token.kind === 'newline' && depth === 0) {
        this.#index += 1;
        return;
      }
      if (token.kind === 'lbrace') depth += 1;
      if (token.kind === 'rbrace') {
        if (depth === 0) return;
        depth -= 1;
      }
      this.#index += 1;
    }
  }
}

// ------------------------------------------------------------------ queries

/** Every block of a type, e.g. all `variable` blocks. */
export function blocksOfType(doc: HclDocument, type: string): HclBlock[] {
  return doc.blocks.filter((block) => block.type === type);
}

/** One block by type and labels, e.g. `resource` + `['local_file','greeting']`. */
export function findBlock(
  doc: HclDocument,
  type: string,
  ...labels: string[]
): HclBlock | null {
  return (
    doc.blocks.find(
      (block) =>
        block.type === type &&
        block.labels.length >= labels.length &&
        labels.every((label, index) => block.labels[index] === label),
    ) ?? null
  );
}

/** A nested block inside another, e.g. `lifecycle` inside a `resource`. */
export function findNestedBlock(block: HclBlock, type: string): HclBlock | null {
  return block.blocks.find((nested) => nested.type === type) ?? null;
}

export function argumentValue(block: HclBlock, name: string): string | null {
  return block.arguments.find((arg) => arg.name === name)?.value ?? null;
}

export function hasArgument(block: HclBlock, name: string): boolean {
  return block.arguments.some((arg) => arg.name === name);
}

/** Argument names declared directly in a block, in source order. */
export function argumentNames(block: HclBlock): string[] {
  return block.arguments.map((arg) => arg.name);
}

/**
 * Identifiers mentioned in an expression's raw text.
 *
 * Used to answer "does `ignore_changes` list `content`" without evaluating the
 * list. Quoted string contents are included, since `ignore_changes` accepts
 * both bare references and, in older styles, quoted names.
 */
export function referencedNames(expression: string): string[] {
  return [...expression.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*/g)].map((match) => match[0]);
}

/** Strip surrounding quotes from a raw expression, when it is a plain literal. */
export function literalString(expression: string | null): string | null {
  if (expression === null) return null;
  const trimmed = expression.trim();
  const match = /^"(.*)"$/s.exec(trimmed);
  return match ? (match[1] ?? '') : null;
}
