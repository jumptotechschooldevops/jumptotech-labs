/**
 * The quality gates are wired to the code they claim to cover.
 *
 * Each of these was a way for CI to stay green while checking less than it
 * said, found in the release-engineering audit:
 *
 *   · `npm run typecheck` walked the workspaces only. scripts/ is not one, so
 *     validate-labs, production-config-check, verify-network-policy, tls-check
 *     and the five-student gate ran under tsx — which strips types without
 *     checking them — and were never typechecked at all.
 *   · `test:security` names its suites as vitest filters. vitest exits 0 when
 *     one filter matches nothing as long as another matches something, so a
 *     renamed security suite would silently leave the gate (measured:
 *     `vitest run test/does-not-exist.test.ts test/protocol.test.ts` → exit 0).
 *   · `sandbox-image-binaries-integration.test.ts` (BETA-P0-019: the suite that
 *     found `/usr/bin/stat` missing from the Alpine images) was never invoked by
 *     any CI job, Make target or npm script.
 *
 * Read from the files, not by running CI: what is asserted is the wiring.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

interface Manifest {
  workspaces?: string[];
  scripts?: Record<string, string>;
}
const rootManifest = JSON.parse(read('package.json')) as Manifest;
const rootScripts = rootManifest.scripts ?? {};
const workflow = read('.github/workflows/quality-gates.yml');
const makefile = read('Makefile');

/** Workspace directories, resolved from the same globs npm uses. */
function workspaces(): string[] {
  const found: string[] = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    const segments = pattern.split('/');
    const candidates =
      segments.length === 2 && segments[1] === '*'
        ? readdirSync(path.join(REPO_ROOT, segments[0]!)).map((entry) => `${segments[0]}/${entry}`)
        : [pattern];
    for (const candidate of candidates) {
      if (existsSync(path.join(REPO_ROOT, candidate, 'package.json'))) found.push(candidate);
    }
  }
  return found.sort();
}

function workspaceScripts(workspace: string): Record<string, string> {
  return (JSON.parse(read(`${workspace}/package.json`)) as Manifest).scripts ?? {};
}

/** Every `--root <ws> ... test/x.test.ts` pair in a command string. */
function suitesNamedBy(command: string): string[] {
  const suites: string[] = [];
  for (const segment of command.split('&&')) {
    const tokens = segment.trim().split(/\s+/);
    const root = tokens[tokens.indexOf('--root') + 1];
    if (!tokens.includes('--root') || !root) continue;
    for (const token of tokens) if (/^test\/.+\.test\.tsx?$/.test(token)) suites.push(`${root}/${token}`);
  }
  return suites;
}

/** A Make target's recipe: the indented lines under `name:`. */
function makeRecipe(target: string): string {
  const lines = makefile.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${target}:`));
  if (start < 0) return '';
  const recipe: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) break;
    recipe.push(line);
  }
  return recipe.join('\n');
}

/**
 * Everything the workflow runs, with the Make targets and npm scripts it calls
 * expanded (recursively), and the terminal test image's default command for
 * the targets that run that image without naming a suite.
 */
function expandedWorkflow(): string {
  const seen = new Set<string>();
  let text = workflow;
  for (let pass = 0; pass < 5; pass += 1) {
    let added = '';
    for (const [, target] of text.matchAll(/\bmake ([a-z][a-z0-9-]*)/g)) {
      if (seen.has(`make:${target}`)) continue;
      seen.add(`make:${target}`);
      added += `\n${makeRecipe(target!)}`;
    }
    for (const [, script] of text.matchAll(/\bnpm run (?:--silent )?([a-z][a-z0-9:-]*)/g)) {
      if (seen.has(`npm:${script}`) || !rootScripts[script!]) continue;
      seen.add(`npm:${script}`);
      added += `\n${rootScripts[script!]}`;
    }
    if (text.includes('terminal-test.Dockerfile') && !seen.has('image:terminal-test')) {
      seen.add('image:terminal-test');
      const cmd = /^CMD \[(.+)\]$/m.exec(read('infrastructure/docker/terminal-test.Dockerfile'));
      added += `\n${(cmd?.[1] ?? '').replace(/[",]/g, ' ')}`;
    }
    if (!added) break;
    text += added;
  }
  return text;
}

function integrationSuites(): string[] {
  const suites: string[] = [];
  for (const workspace of workspaces()) {
    const dir = path.join(REPO_ROOT, workspace, 'test');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (/-integration\.test\.tsx?$/.test(file)) suites.push(`${workspace}/test/${file}`);
    }
  }
  return suites.sort();
}

describe('typecheck', () => {
  it('reaches every workspace', () => {
    const missing = workspaces().filter((workspace) => !workspaceScripts(workspace).typecheck);
    expect(missing, 'workspaces with no `typecheck` script are skipped by --if-present').toEqual([]);
  });

  it('reaches the TypeScript under scripts/, which is not a workspace', () => {
    expect(rootScripts.typecheck).toMatch(/npm run typecheck:scripts\b/);
    expect(rootScripts['typecheck:scripts']).toBe('tsc -p scripts');
    const tsconfig = read('scripts/tsconfig.json');
    expect(tsconfig).toMatch(/"include":\s*\[\s*"\*\*\/\*\.ts"\s*\]/);
    expect(tsconfig).toMatch(/"noEmit":\s*true/);
  });

  it('is what CI runs', () => {
    expect(workflow).toMatch(/run: npm run typecheck\n/);
  });
});

describe('test', () => {
  it('reaches every workspace that has tests', () => {
    const missing = workspaces().filter((workspace) => {
      const dir = path.join(REPO_ROOT, workspace, 'test');
      return existsSync(dir) && !workspaceScripts(workspace).test;
    });
    expect(missing).toEqual([]);
  });
});

describe('test:security', () => {
  const suites = suitesNamedBy(rootScripts['test:security'] ?? '');

  it('names suites, and every one of them exists', () => {
    expect(suites.length).toBeGreaterThan(40);
    const missing = suites.filter((suite) => !existsSync(path.join(REPO_ROOT, suite)));
    expect(missing, 'vitest would drop these filters without failing').toEqual([]);
  });

  it('chains every workspace run with &&, so one failure fails the gate', () => {
    const script = rootScripts['test:security'] ?? '';
    expect(script).not.toMatch(/;|\|\||(?<!&)&(?!&)/);
    expect(script.split('&&').every((part) => /^\s*vitest run /.test(part))).toBe(true);
  });

  it('names only unit suites, which `npm test` in the gates job also runs', () => {
    // CI has no separate `test:security` step: the gates job's `npm test` runs
    // every one of these. An integration suite listed here would skip itself
    // there (no RUN_*_TESTS) and only ever run on a laptop.
    expect(suites.filter((suite) => /-integration\.test\.tsx?$/.test(suite))).toEqual([]);
    expect(workflow).toMatch(/run: npm test\n/);
  });
});

describe('suites named by CI, Make and npm scripts', () => {
  it('all exist', () => {
    const named = [
      ...Object.values(rootScripts).flatMap(suitesNamedBy),
      ...[...workflow.matchAll(/\btest\/[A-Za-z0-9_.-]+\.test\.tsx?/g)].map(([match]) => match),
    ];
    const missing: string[] = [];
    for (const suite of named) {
      if (suite.startsWith('test/')) {
        // A workflow reference; its --root is on the same or the next line, so
        // check the file exists in some workspace.
        if (!workspaces().some((ws) => existsSync(path.join(REPO_ROOT, ws, suite)))) missing.push(suite);
      } else if (!existsSync(path.join(REPO_ROOT, suite))) {
        missing.push(suite);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('every integration suite', () => {
  it('is run by some CI job', () => {
    const text = expandedWorkflow();
    // `vitest run --root <ws>` with no file filter runs the whole workspace.
    const wholeWorkspaces = [...text.matchAll(/vitest run --root (\S+?)(?=\s*(?:&&|$|\n))/gm)].map(([, ws]) => ws);
    const unwired = integrationSuites().filter((suite) => {
      const file = path.basename(suite);
      const stem = file.replace(/-integration\.test\.tsx?$/, '');
      const workspace = suite.slice(0, suite.indexOf('/test/'));
      return !(
        text.includes(file) ||
        // `for suite in docker009 docker010 …; do … "test/${suite}-integration.test.ts"`
        new RegExp(`for suite in [^\\n;]*\\b${stem}\\b`).test(text) ||
        wholeWorkspaces.includes(workspace)
      );
    });
    expect(unwired, 'suites no CI job runs — add them to .github/workflows/quality-gates.yml').toEqual([]);
  });

  it('runs strictly in CI, where a skip means the job did not do its one job', () => {
    expect(workflow).not.toMatch(/\bnpx vitest\b/);
    expect(workflow).toContain('npx tsx test-support/strict-vitest.ts');
    for (const target of ['test-terminal-container', 'test-sandboxd-container']) {
      expect(makeRecipe(target), target).toContain('npx tsx test-support/strict-vitest.ts');
    }
  });

  it('includes the sandbox-image binaries suite, in the job that builds those images', () => {
    const job = workflow.slice(workflow.indexOf('\n  sandbox-integration:'), workflow.indexOf('\n  networking-integration:'));
    expect(job).toContain('npm run sandbox:build');
    expect(job).toContain('test/sandbox-image-binaries-integration.test.ts');
  });
});
