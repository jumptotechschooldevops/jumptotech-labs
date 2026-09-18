/**
 * The private-beta operator surface, from the files as shipped.
 *
 * Hermetic: it reads the repository and runs nothing. What it pins:
 *
 *   · the operator socket exists only in the api container, inside its private
 *     /tmp, and is on no network;
 *   · the runbooks' `ops` helper and diagnostics target point at things that
 *     exist;
 *   · the incident runbook covers every incident A–U, each with the parts an
 *     operator relies on;
 *   · no runbook code block — what an operator copies and pastes at 2am —
 *     holds a destructive command, except the few named and bounded ones.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** A top-level compose service's block, comments removed. */
function serviceBlock(file: string, service: string): string {
  const text = code(read(file));
  const match = new RegExp(`^ {2}${service}:\\n((?: {4,}.*\\n|\\s*\\n)*)`, 'm').exec(text);
  return match?.[1] ?? '';
}

const COMPOSE_FILES = readdirSync(REPO_ROOT).filter((f) => /^docker-compose.*\.yml$/.test(f));

describe('the operator socket', () => {
  it('is configured for the api, inside its private tmpfs', () => {
    const api = serviceBlock('docker-compose.yml', 'api');
    const match = /^ {6}OPERATOR_SOCKET_PATH: (\S+)$/m.exec(api);
    expect(match, 'docker-compose.yml sets OPERATOR_SOCKET_PATH for the api').not.toBeNull();
    expect(match![1]).toMatch(/^\/tmp\/[a-z-]+\/[a-z-]+\.sock$/);
    expect(api).toMatch(/^ {6}- \/tmp:/m);
    expect(api).toMatch(/^ {4}read_only: true$/m);
  });

  it('is given to no other service, in any compose file', () => {
    for (const file of COMPOSE_FILES) {
      for (const service of ['web', 'terminal', 'sandboxd', 'postgres', 'prometheus', 'alertmanager', 'grafana']) {
        expect(serviceBlock(file, service), `${service} in ${file}`).not.toMatch(/OPERATOR_SOCKET_PATH/);
      }
    }
  });

  it('is not re-pointed or published by an overlay', () => {
    for (const file of COMPOSE_FILES.filter((f) => f !== 'docker-compose.yml')) {
      expect(code(read(file)), file).not.toMatch(/OPERATOR_SOCKET_PATH|jtt-operator/);
    }
  });
});

describe('the operator tooling the runbooks name', () => {
  const operations = read('docs/runbooks/private-beta-operations.md');

  it('defines `ops` on the CLI that exists', () => {
    const match = /^ops\(\) \{ prod exec -T api node \/app\/node_modules\/\.bin\/tsx (\S+) "\$@"; \}$/m.exec(operations);
    expect(match, 'private-beta-operations.md §1 defines ops()').not.toBeNull();
    expect(existsSync(path.join(REPO_ROOT, match![1]!))).toBe(true);
  });

  it('points at the diagnostics target and script that exist', () => {
    expect(operations).toMatch(/make private-beta-diagnostics/);
    expect(read('Makefile')).toMatch(/^private-beta-diagnostics:.*\n\t@bash scripts\/private-beta-diagnostics\.sh \$\(ARGS\)$/m);
    expect(existsSync(path.join(REPO_ROOT, 'scripts/private-beta-diagnostics.sh'))).toBe(true);
  });
});

describe('the incident runbook', () => {
  const incidents = read('docs/runbooks/private-beta-incident-response.md');
  const sections = new Map<string, string>();
  for (const match of incidents.matchAll(/^### ([A-U])\. [^\n]+\n([\s\S]*?)(?=^### [A-U]\. |^## |(?![\s\S]))/gm)) {
    sections.set(match[1]!, match[2]!);
  }

  it('covers every incident from A to U', () => {
    expect([...sections.keys()]).toEqual('ABCDEFGHIJKLMNOPQRSTU'.split(''));
  });

  // L (verification) is not a service and says so; it points elsewhere.
  it.each('ABCDEFGHIJKMNOPQRSTU'.split(''))('%s has a symptom, commands, a recovery, a stop condition and evidence', (id) => {
    const body = sections.get(id)!;
    for (const part of ['Symptom', 'Recovery', 'Stop when', 'Evidence', 'Follow-up']) {
      expect(body, `${id} lacks **${part}.**`).toMatch(new RegExp(`\\*\\*${part}\\.\\*\\*`));
    }
    expect(body, `${id} has commands`).toMatch(/```bash\n/);
  });

  it('links only to runbooks that exist', () => {
    for (const match of incidents.matchAll(/\]\(([^)#]+\.md)/g)) {
      expect(existsSync(path.join(REPO_ROOT, 'docs/runbooks', match[1]!)), match[1]).toBe(true);
    }
  });
});

describe('runbook code blocks hold no destructive command', () => {
  /*
   * A code block is what an operator pastes. Prose may say "never run
   * `down -v`"; a code block may not contain it. The allowances are the named,
   * bounded cases: the disposable databases of a restore check, and a
   * validation run's own sentinel container.
   */
  const FORBIDDEN = /down -v|volume prune|system prune|TRUNCATE|rm -rf|sandbox-clean|sandbox:clean|push --force|--force-with-lease/;
  const ALLOWED = [
    /DROP DATABASE jumptotech_labs_(?:check|prerestore)_/,
    /docker rm -f jtt-lab-<runid>/,
  ];

  const blocks: Array<{ file: string; line: number; text: string }> = [];
  for (const file of readdirSync(path.join(REPO_ROOT, 'docs/runbooks')).filter((f) => f.endsWith('.md'))) {
    let inBlock = false;
    read(`docs/runbooks/${file}`)
      .split('\n')
      .forEach((text, index) => {
        if (text.trim().startsWith('```')) {
          inBlock = !inBlock;
          return;
        }
        if (inBlock) blocks.push({ file, line: index + 1, text });
      });
  }

  it('has code blocks to check', () => {
    expect(blocks.length).toBeGreaterThan(200);
  });

  it('never pastes a destructive command', () => {
    const offending = blocks.filter(({ text }) => FORBIDDEN.test(text) && !ALLOWED.some((ok) => ok.test(text)));
    expect(offending.map(({ file, line, text }) => `${file}:${line} ${text.trim()}`)).toEqual([]);
  });

  it('drops only the disposable databases, by name', () => {
    const drops = blocks.filter(({ text }) => /DROP DATABASE/.test(text));
    for (const { text } of drops) expect(text).toMatch(ALLOWED[0]!);
  });
});
