/**
 * The documentation points at things that exist.
 *
 * Found by the developer-experience audit (docs/releases/overnight-devex-documentation-audit.md):
 * README anchors to a heading that had been renamed, a test file that had been
 * deleted, a "this is the whole process" lab recipe that `validate:labs` rejects,
 * and runbook pages no index listed. None of it failed anything, because nothing
 * read the Markdown. This does, for the contracts that matter and no more:
 *
 *   · every relative Markdown link resolves, and every `#anchor` into a
 *     Markdown file names a heading that exists (GitHub's slug rules);
 *   · docs/README.md, the documentation map, links every file under docs/
 *     exactly once, so a new document is classified rather than orphaned;
 *   · in the authorities — everything the map does not list as a record or a
 *     design specification — every `npm run` script, `make` target and
 *     `test/… --root <workspace>` file named in code exists.
 *
 * It does not parse shell. It reads fenced code and inline `code`, and checks
 * names. Hermetic: it reads the repository and runs nothing.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

/** Directories that hold no maintained documentation, or none of ours. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'labs', // lab content: student-facing text, validated by `npm run validate:labs`
  'dist',
  'playwright-report',
  'test-results',
  '.stack',
  'backups',
  'generated',
]);

function markdownFiles(dir = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir))) {
    if (SKIP_DIRS.has(entry)) continue;
    const relative = dir ? `${dir}/${entry}` : entry;
    const stat = statSync(path.join(REPO_ROOT, relative));
    if (stat.isDirectory()) found.push(...markdownFiles(relative));
    else if (entry.endsWith('.md')) found.push(relative);
  }
  return found.sort();
}

/** Lines outside fenced code, with their numbers. */
function proseLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ line: index + 1, text: line });
  });
  return out;
}

const anchorCache = new Map<string, Set<string>>();

/** GitHub's heading anchors: lower-case, punctuation dropped, spaces to `-`, duplicates suffixed. */
function anchorsOf(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const anchors = new Set<string>();
  anchorCache.set(file, anchors);
  const seen = new Map<string, number>();
  for (const { text } of proseLines(read(file))) {
    for (const match of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(match[1]!);
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
    if (!heading) continue;
    // Tags are stripped until none is left: one pass over `<<b>b>` leaves `<b>`.
    let title = heading[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    for (let previous = ''; previous !== title; ) {
      previous = title;
      title = title.replace(/<[^>]*>/g, '');
    }
    const slug = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(slug);
    anchors.add(count === undefined ? slug : `${slug}-${count}`);
    seen.set(slug, (count ?? -1) + 1);
  }
  return anchors;
}

interface Link {
  file: string;
  line: number;
  target: string;
}

function linksIn(file: string): Link[] {
  const links: Link[] = [];
  for (const { line, text } of proseLines(read(file))) {
    // Inline code is not a link, even when it looks like one.
    const withoutCode = text.replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
      links.push({ file, line, target });
    }
  }
  return links;
}

function resolveLink(link: Link): { file: string; anchor: string | undefined } {
  const [target, anchor] = link.target.split('#') as [string, string | undefined];
  const file = target ? path.posix.normalize(path.posix.join(path.posix.dirname(link.file), decodeURIComponent(target))) : link.file;
  return { file, anchor };
}

/** Everything an operator or developer might paste: fenced code, and inline `code` spans. */
function commandsIn(file: string): Array<{ line: number; text: string }> {
  const commands: Array<{ line: number; text: string }> = [];
  let fenced = false;
  let pending = '';
  let pendingLine = 0;
  read(file)
    .split('\n')
    .forEach((text, index) => {
      if (/^\s*(```|~~~)/.test(text)) {
        fenced = !fenced;
        return;
      }
      if (fenced) {
        // Join `\` continuations so a command and its `--root` are one line.
        if (!pending) pendingLine = index + 1;
        pending += `${text.replace(/\\\s*$/, '')} `;
        if (!/\\\s*$/.test(text)) {
          commands.push({ line: pendingLine, text: pending.replace(/\s+#\s.*$/, '') });
          pending = '';
        }
        return;
      }
      const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      if (spans.length > 0) commands.push({ line: index + 1, text: spans.join(' ; ') });
    });
  return commands;
}

// --- the documentation map ---------------------------------------------------

const MAP = 'docs/README.md';

/** The files the map lists under a `## <heading>` section. */
function mapSection(heading: string): Set<string> {
  const text = read(MAP);
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`${MAP} has no "## ${heading}" section`);
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  const files = new Set<string>();
  for (const link of linksIn(MAP)) {
    if (!section.includes(`](${link.target})`)) continue;
    files.add(resolveLink(link).file);
  }
  return files;
}

const ALL = markdownFiles();
const RECORDS = mapSection('Records');
const SPECIFICATIONS = mapSection('Design and curriculum specifications');
const AUTHORITIES = ALL.filter((file) => !RECORDS.has(file) && !SPECIFICATIONS.has(file));

describe('Markdown links', () => {
  const links = ALL.flatMap(linksIn);

  it('finds the links it polices', () => {
    expect(ALL).toContain('README.md');
    expect(ALL).toContain(MAP);
    expect(links.length).toBeGreaterThan(300);
  });

  it('resolve to files that exist', () => {
    const broken = links.filter((link) => !existsSync(path.join(REPO_ROOT, resolveLink(link).file)));
    expect(broken.map((l) => `${l.file}:${l.line} → ${l.target}`)).toEqual([]);
  });

  it('name headings that exist when they carry an anchor into Markdown', () => {
    const broken = links.filter((link) => {
      const { file, anchor } = resolveLink(link);
      if (!anchor || !file.endsWith('.md') || !existsSync(path.join(REPO_ROOT, file))) return false;
      return !anchorsOf(file).has(decodeURIComponent(anchor).toLowerCase());
    });
    expect(broken.map((l) => `${l.file}:${l.line} → ${l.target}`)).toEqual([]);
  });

  it('computes anchors the way GitHub does', () => {
    // A heading's number, punctuation and code marks are all folded the same way.
    const anchors = anchorsOf('docs/runbooks/private-beta-operations.md');
    expect(anchors).toContain('1-the-production-command');
    expect(anchorsOf('docs/development/production-host-readiness.md')).toContain('181-scrape-token-permissions-fixed-on-this-branch');
  });
});

describe('the documentation map', () => {
  it('links every document under docs/ exactly once', () => {
    const counts = new Map<string, number>();
    for (const link of linksIn(MAP)) {
      const { file } = resolveLink(link);
      if (file.startsWith('docs/')) counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    const docs = ALL.filter((file) => file.startsWith('docs/') && file !== MAP);
    expect(docs.filter((file) => !counts.has(file)), 'not in docs/README.md').toEqual([]);
    expect(
      [...counts].filter(([, n]) => n > 1).map(([file]) => file),
      'listed twice in docs/README.md',
    ).toEqual([]);
  });

  it('is reachable from the root README', () => {
    expect(read('README.md')).toContain('](docs/README.md)');
  });

  it('classifies records and specifications that exist', () => {
    expect(RECORDS.size).toBeGreaterThan(5);
    expect(SPECIFICATIONS.size).toBeGreaterThan(3);
    for (const file of [...RECORDS, ...SPECIFICATIONS]) expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
  });
});

describe('commands named in the authorities', () => {
  interface Manifest {
    name?: string;
    scripts?: Record<string, string>;
  }
  const manifest = (file: string): Manifest => JSON.parse(read(file)) as Manifest;
  const rootScripts = Object.keys(manifest('package.json').scripts ?? {});
  const workspaceScripts = new Map<string, string[]>();
  for (const top of ['apps', 'services']) {
    for (const entry of readdirSync(path.join(REPO_ROOT, top))) {
      const file = `${top}/${entry}/package.json`;
      if (!existsSync(path.join(REPO_ROOT, file))) continue;
      const m = manifest(file);
      workspaceScripts.set(m.name!, Object.keys(m.scripts ?? {}));
      workspaceScripts.set(`${top}/${entry}`, Object.keys(m.scripts ?? {}));
    }
  }
  const targets = new Set([...read('Makefile').matchAll(/^([a-z][a-z0-9-]*):/gm)].map((m) => m[1]!));

  const commands = AUTHORITIES.flatMap((file) => commandsIn(file).map((c) => ({ file, ...c })));
  const where = (c: { file: string; line: number }): string => `${c.file}:${c.line}`;

  it('finds the commands it polices', () => {
    expect(AUTHORITIES).toContain('README.md');
    expect(AUTHORITIES).toContain('docs/development/testing.md');
    expect(AUTHORITIES).not.toContain('docs/development/private-beta-security-audit.md');
    expect(commands.length).toBeGreaterThan(1000);
  });

  it('name npm scripts that exist', () => {
    const missing: string[] = [];
    for (const command of commands) {
      for (const m of command.text.matchAll(/npm run (?:-s |--silent )?([a-z][a-z0-9:*-]*)(?: (?:--workspace[ =]|-w )(\S+))?/g)) {
        const [, script, workspace] = m as unknown as [string, string, string | undefined];
        const available = workspace ? workspaceScripts.get(workspace) : rootScripts;
        const ok = script.endsWith('*')
          ? (available ?? []).some((s) => s.startsWith(script.slice(0, -1)))
          : (available ?? []).includes(script);
        if (!ok) missing.push(`${where(command)} → npm run ${script}${workspace ? ` --workspace ${workspace}` : ''}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('name make targets that exist', () => {
    const missing: string[] = [];
    for (const command of commands) {
      for (const m of command.text.matchAll(/(?:^|[\s;&|(])make ([a-z][a-z0-9-]*)/g)) {
        if (!targets.has(m[1]!)) missing.push(`${where(command)} → make ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('name test files that exist under the workspace given as --root', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const command of commands) {
      const roots = [...command.text.matchAll(/--root[ =]([A-Za-z0-9_./-]+)/g)].map((m) => m[1]!);
      if (roots.length !== 1) continue; // none, or several workspaces in one line: not attributable
      for (const m of command.text.matchAll(/(?:^|[\s"'(])(test\/[A-Za-z0-9_./-]+\.test\.tsx?)/g)) {
        checked++;
        if (!existsSync(path.join(REPO_ROOT, roots[0]!, m[1]!))) missing.push(`${where(command)} → ${roots[0]}/${m[1]}`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});
