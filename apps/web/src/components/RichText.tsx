/**
 * Lab prose, rendered safely.
 *
 * Lab YAML is written in a small, plain Markdown: backticks for commands and
 * paths, `**bold**` and `*emphasis*`, `-` and `1.` lists, fenced and indented
 * code blocks, and `|` tables. Rendering only the backticks — as this once did
 * — showed students literal asterisks, ran lists and tables into one sentence,
 * and put a three-line answer format (`KEY=value` on each line, read line by
 * line by the verifier) onto a single line that a student then copied.
 *
 * This renders exactly those constructs and nothing else, as React elements.
 * There is no HTML parsing, no link syntax and no `dangerouslySetInnerHTML`, so
 * lab content can never inject markup.
 *
 * ## Line breaks
 *
 * Most descriptions are YAML *folded* scalars (`description: >`). Folding turns
 * each blank line of the source into a single `\n` and joins wrapped lines
 * with spaces, so in that text a single newline is a paragraph break. Literal
 * scalars (`|`) use blank lines. Outside lists, each line is therefore its own
 * paragraph; inside a list item, continuation lines are joined, because that
 * is where authors wrap (the catalog test in rich-text.test.tsx holds this).
 */
import { Fragment, type ReactNode } from 'react';

export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: Block[][] }
  | { kind: 'table'; header: string[]; rows: string[][] };

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

/** Remove the indentation every non-blank line shares. */
function dedent(lines: string[]): string {
  const indents = lines.filter((line) => !isBlank(line)).map(indentOf);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(common)).join('\n');
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Split lab prose into blocks.
 *
 * `joinLines` is for the inside of a list item, where consecutive lines are one
 * wrapped paragraph; elsewhere each line is a paragraph of its own (folded YAML).
 */
export function parseBlocks(text: string, joinLines = false): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const codeIndent = joinLines ? 4 : 2;
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    if (joinLines) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    else for (const line of paragraph) blocks.push({ kind: 'paragraph', text: line });
    paragraph = [];
  };
  /** The index of the first non-blank line at or after `from`. */
  const nextContent = (from: number): number => {
    let at = from;
    while (at < lines.length && isBlank(lines[at])) at += 1;
    return at;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (isBlank(line)) {
      flush();
      i += 1;
      continue;
    }

    // ``` fenced code ```: kept exactly, line for line.
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // the closing fence, if there is one
      blocks.push({ kind: 'code', text: dedent(body) });
      continue;
    }

    // | a | b |  followed by  | --- | --- |
    if (line.trim().startsWith('|') && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      flush();
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(tableCells(lines[i]!));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const first = LIST_ITEM.exec(line);
    if (first) {
      flush();
      const markerIndent = first[1]!.length;
      const ordered = /\d/.test(first[2]!);
      const items: Block[][] = [];
      let item: RegExpExecArray | null = first;
      while (item) {
        const contentIndent = markerIndent + item[2]!.length + 1;
        const body = [item[3]!];
        i += 1;
        while (i < lines.length) {
          const next = lines[i]!;
          if (isBlank(next)) {
            // A blank line ends the item unless the item carries on, indented, after it.
            const ahead = nextContent(i);
            if (ahead < lines.length && indentOf(lines[ahead]!) >= contentIndent) {
              body.push('');
              i += 1;
              continue;
            }
            break;
          }
          if (indentOf(next) <= markerIndent) break;
          body.push(next.slice(Math.min(indentOf(next), contentIndent)));
          i += 1;
        }
        items.push(parseBlocks(body.join('\n'), true));

        // The next item of the same list: same indentation, same kind of marker.
        const ahead = nextContent(i);
        const following = ahead < lines.length ? LIST_ITEM.exec(lines[ahead]!) : null;
        if (following && following[1]!.length === markerIndent && /\d/.test(following[2]!) === ordered) {
          i = ahead;
          item = following;
        } else {
          item = null;
        }
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Indented, after a break: a code block (a config file, a Jenkinsfile, a line
    // to copy). Folded YAML keeps "more-indented" lines as they are, so at the top
    // level two spaces are enough; inside a list item, wrapped text is indented
    // too, and only four more spaces mean code.
    if (indentOf(line) >= codeIndent && paragraph.length === 0) {
      const body: string[] = [];
      while (i < lines.length) {
        const next = lines[i]!;
        if (isBlank(next)) {
          const ahead = nextContent(i);
          if (ahead >= lines.length || indentOf(lines[ahead]!) < codeIndent) break;
        } else if (indentOf(next) < codeIndent) {
          break;
        }
        body.push(next);
        i += 1;
      }
      blocks.push({ kind: 'code', text: dedent(body) });
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flush();
  return blocks;
}

/** The closing `marker` for an opening that ended at `from`, skipping code spans; -1 when there is none. */
function findClose(text: string, marker: '**' | '*', from: number): number {
  for (let at = from; at < text.length; at += 1) {
    if (text[at] === '`') {
      const end = text.indexOf('`', at + 1);
      if (end === -1) return -1;
      at = end;
      continue;
    }
    if (!text.startsWith(marker, at)) continue;
    if (marker === '*' && text[at + 1] === '*') {
      at += 1;
      continue;
    }
    // Emphasis closes against a character, never after a space: `a * b` is not emphasis.
    if (at > from && !/\s/.test(text[at - 1]!) && (marker === '**' || !/\w/.test(text[at + 1] ?? ''))) return at;
  }
  return -1;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  let key = 0;
  const pushPlain = () => {
    if (plain) out.push(<Fragment key={key++}>{plain}</Fragment>);
    plain = '';
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at]!;

    if (char === '`') {
      const end = text.indexOf('`', at + 1);
      // An unbalanced backtick is shown as itself rather than swallowing the rest of the sentence.
      if (end === -1) {
        plain += text.slice(at);
        break;
      }
      pushPlain();
      out.push(<code key={key++}>{text.slice(at + 1, end)}</code>);
      at = end + 1;
      continue;
    }

    if (char === '*' && text[at + 1] === '*' && /\S/.test(text[at + 2] ?? ' ')) {
      const end = findClose(text, '**', at + 2);
      if (end !== -1) {
        pushPlain();
        out.push(<strong key={key++}>{inline(text.slice(at + 2, end))}</strong>);
        at = end + 2;
        continue;
      }
    }

    const opensEmphasis =
      char === '*' && text[at + 1] !== '*' && /\S/.test(text[at + 1] ?? ' ') && !/\w/.test(text[at - 1] ?? ' ');
    if (opensEmphasis) {
      const end = findClose(text, '*', at + 1);
      if (end !== -1) {
        pushPlain();
        out.push(<em key={key++}>{inline(text.slice(at + 1, end))}</em>);
        at = end + 1;
        continue;
      }
    }

    plain += char;
    at += 1;
  }
  pushPlain();
  return out;
}

/** One line of lab prose: code spans, bold and emphasis. */
export function InlineText({ text }: { text: string }) {
  return <>{inline(text)}</>;
}

function Blocks({ blocks, className }: { blocks: Block[]; className?: string | undefined }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'paragraph':
            return (
              <p key={index} className={className}>
                <InlineText text={block.text} />
              </p>
            );
          case 'code':
            return (
              <pre key={index} className="rich__code">
                <code>{block.text}</code>
              </pre>
            );
          case 'list': {
            const items = block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <Blocks blocks={item} className="rich__item-text" />
              </li>
            ));
            const listClass = className ? `rich__list ${className}` : 'rich__list';
            return block.ordered ? (
              <ol key={index} className={listClass}>
                {items}
              </ol>
            ) : (
              <ul key={index} className={listClass}>
                {items}
              </ul>
            );
          }
          case 'table':
            return (
              <div key={index} className="rich__table-wrap">
                <table className="rich__table">
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} scope="col">
                          <InlineText text={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex}>
                            <InlineText text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}

/** A block of lab prose — a task description, a story, a hint. */
export function RichText({ text, className }: { text: string; className?: string }) {
  return <Blocks blocks={parseBlocks(text)} className={className} />;
}
