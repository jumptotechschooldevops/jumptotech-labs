/**
 * Lab prose as a student reads it.
 *
 * Lab YAML is written in plain Markdown, and the page used to render only its
 * backticks: lists ran into one sentence, tables into a row of pipes, bold
 * showed its asterisks, and a fenced answer format — three `KEY=value` lines
 * the verifier reads line by line — appeared on one line. Folded YAML also
 * turned every paragraph of 71 descriptions into one wall of text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import yaml from 'js-yaml';
import { HintPanel } from '../src/components/HintPanel';
import { RichText, parseBlocks, type Block } from '../src/components/RichText';

describe('lab prose', () => {
  it('reads each line of folded YAML as its own paragraph', () => {
    // `description: >` turns the blank line between paragraphs into one newline.
    const { container } = render(<RichText text={'First paragraph.\nSecond paragraph.\n'} className="brief__body" />);

    const paragraphs = container.querySelectorAll('p.brief__body');
    expect([...paragraphs].map((p) => p.textContent)).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('keeps a fenced answer format line for line, as the verifier reads it', () => {
    const text = 'Record in `syscalls.txt`:\n\n```\nBLOCKED_SYSCALL=<name>\nPRINTER_IS=<buffered>\n```\n\nThen run it.';
    const { container } = render(<RichText text={text} />);

    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe('BLOCKED_SYSCALL=<name>\nPRINTER_IS=<buffered>');
    expect(container.textContent).not.toContain('```');
    expect(screen.getByText('Then run it.')).toBeTruthy();
  });

  it('renders an indented block — a Jenkinsfile skeleton — as code', () => {
    const text = 'So the shape is:\n\n    pipeline {\n        agent any\n    }\n\nThat is the skeleton.';
    const { container } = render(<RichText text={text} />);

    expect(container.querySelector('pre code')?.textContent).toBe('pipeline {\n    agent any\n}');
  });

  it('renders lists, joining the lines an item was wrapped over', () => {
    const text =
      'The required final state:\n\n  - `ledger-api` must run the image, with its container\n    port `80` published.\n  - `ledger-web` runs too.\n\nKeep the names.';
    const { container } = render(<RichText text={text} />);

    const items = [...container.querySelectorAll('ul > li')].map((li) => li.textContent);
    expect(items).toEqual(['ledger-api must run the image, with its container port 80 published.', 'ledger-web runs too.']);
    expect(screen.getByText('Keep the names.')).toBeTruthy();
  });

  it('renders numbered lists as ordered lists', () => {
    const { container } = render(<RichText text={'1. Build it.\n2. Test it.\n3. Ship it.'} />);

    expect(container.querySelectorAll('ol > li')).toHaveLength(3);
  });

  it('keeps a code block that belongs to a list item inside it', () => {
    const text = '  - `local_file.report`, whose content is one line —\n\n        deployment: <id>\n\n    — taken from the resource.';
    const blocks = parseBlocks(text);

    expect(blocks).toHaveLength(1);
    const [list] = blocks as [Extract<Block, { kind: 'list' }>];
    expect(list.items[0]!.map((block) => block.kind)).toEqual(['paragraph', 'code', 'paragraph']);
  });

  it('renders a pipe table as a table', () => {
    const text = '| situation | exit status |\n| --- | --- |\n| within the limit | `0` |\n| over the limit | `3` |';
    render(<RichText text={text} />);

    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['situation', 'exit status']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('3', { selector: 'code' })).toBeTruthy();
  });

  it('renders bold and emphasis, and leaves arithmetic and globs alone', () => {
    const { container } = render(
      <RichText text={'**First, change where state lives.** The config asks for *a* pet name; `rm *.log` and 2 * 3 stay as written.'} />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('First, change where state lives.');
    expect(container.querySelector('em')?.textContent).toBe('a');
    expect(container.textContent).toContain('rm *.log');
    expect(container.textContent).toContain('2 * 3');
    expect(container.textContent).not.toContain('**');
  });

  it('keeps code inside bold, and an unbalanced backtick as itself', () => {
    const { container } = render(<RichText text={'**Edit `versions.tf` first.** A stray ` tick.'} />);

    expect(container.querySelector('strong code')?.textContent).toBe('versions.tf');
    expect(container.textContent).toContain('A stray ` tick.');
  });

  it('never turns lab text into markup', () => {
    const { container } = render(<RichText text={'<img src=x onerror="alert(1)"> **<b>bold</b>**'} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('renders a revealed hint with its commands as code', () => {
    render(<HintPanel hints={[{ level: 1, text: 'Run `ls -la ~/project` and read the owner column.' }]} alreadyRevealed={1} />);

    expect(screen.getByText('ls -la ~/project', { selector: 'code' })).toBeTruthy();
    expect(screen.queryByText(/`/)).toBeNull();
  });
});

// ------------------------------------------------------------ the real catalog

const labsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../labs');

function labFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return labFiles(full);
    return name === 'lab.yaml' ? [full] : [];
  });
}

interface LabYaml {
  id: string;
  story?: string;
  task: { description: string };
  hints?: { text: string }[];
}

function paragraphsOf(blocks: Block[]): string[] {
  return blocks.flatMap((block) => {
    if (block.kind === 'paragraph') return [block.text];
    if (block.kind === 'list') return block.items.flatMap((item) => paragraphsOf(item));
    return [];
  });
}

describe('every lab in the catalog', () => {
  const labs = labFiles(labsRoot).map((file) => yaml.load(readFileSync(file, 'utf8')) as LabYaml);
  const prose = labs.flatMap((lab) => [
    { lab: lab.id, field: 'description', text: lab.task.description },
    ...(lab.story ? [{ lab: lab.id, field: 'story', text: lab.story }] : []),
    ...(lab.hints ?? []).map((hint, index) => ({ lab: lab.id, field: `hint ${index + 1}`, text: hint.text })),
  ]);

  it('is read from disk', () => {
    expect(labs.length).toBeGreaterThan(100);
  });

  it('never splits a sentence into two paragraphs', () => {
    // A lower-case paragraph after an unfinished one is the second half of a
    // wrapped line. (A paragraph may still start in lower case — `kubectl can…`,
    // or the rest of a sentence after a displayed code block.)
    const split = prose.flatMap(({ lab, field, text }) => {
      const blocks = parseBlocks(text);
      return blocks.flatMap((block, index) => {
        const previous = blocks[index - 1];
        return block.kind === 'paragraph' &&
          /^[a-z]/.test(block.text) &&
          previous?.kind === 'paragraph' &&
          !/[.:;!?)"'`*—]$/.test(previous.text)
          ? [`${lab} ${field}: ${previous.text.slice(-40)} / ${block.text.slice(0, 40)}`]
          : [];
      });
    });
    expect(split).toEqual([]);
  });

  it('leaves no Markdown syntax showing in its paragraphs', () => {
    const raw = prose.flatMap(({ lab, field, text }) =>
      paragraphsOf(parseBlocks(text))
        .filter((paragraph) => paragraph.includes('```') || /^\|.*\|$/.test(paragraph))
        .map((paragraph) => `${lab} ${field}: ${paragraph.slice(0, 60)}`),
    );
    expect(raw).toEqual([]);
  });
});
