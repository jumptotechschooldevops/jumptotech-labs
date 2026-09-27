/**
 * An integration test that cannot run says so: it is SKIPPED, never PASSED.
 *
 * vitest counts a test that returns early as passed. Two suites opened every
 * test with `if (!enabled) return;` after probing for Docker or a PTY, so on a
 * host without them — any macOS laptop for sandboxd, any runner without the
 * images for the api sandbox suite — they reported 13 and 7 passes having run
 * nothing, and `test-support/strict-vitest.ts`, which fails a CI step on any
 * skip, saw only passes. Measured, with no daemon reachable:
 *
 *   DOCKER_HOST=unix:///nonexistent RUN_INTEGRATION_TESTS=1 \
 *     npx tsx test-support/strict-vitest.ts test/sandbox-integration.test.ts --root apps/api
 *   → before: "Tests 13 passed", exit 0   after: "Tests 13 skipped", exit 1
 *
 * The fix is `context.skip(reason)`, which sandbox-image-binaries already used.
 * This pins it for every integration suite: a test body whose first statement
 * is a bare conditional `return` is the pattern, wherever it appears.
 *
 * Hermetic: it reads the repository and runs nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function integrationSuites(): string[] {
  const found: string[] = [];
  for (const top of ['apps', 'services']) {
    for (const workspace of readdirSync(path.join(REPO_ROOT, top))) {
      const testDir = path.join(REPO_ROOT, top, workspace, 'test');
      let entries: string[];
      try {
        entries = readdirSync(testDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (/-integration\.test\.tsx?$/.test(entry)) found.push(`${top}/${workspace}/test/${entry}`);
      }
    }
  }
  return found.sort();
}

/** `it(…, async (…) => {` or `test(…)` directly followed by `if (…) return;`. */
function earlyReturns(source: string): string[] {
  const lines = source.split('\n');
  const hits: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*(?:it|test)(?:\.\w+)*\(.*=>\s*\{\s*$/.test(lines[i]!)) continue;
    const next = lines[i + 1]!;
    if (/^\s*if \(.*\)\s*return;\s*$/.test(next)) hits.push(`${i + 2}: ${next.trim()}`);
  }
  return hits;
}

describe('integration suites report what they did not run as skipped', () => {
  const suites = integrationSuites();

  it('finds the suites it polices', () => {
    expect(suites).toContain('apps/api/test/sandbox-integration.test.ts');
    expect(suites).toContain('services/sandboxd/test/sandboxd-integration.test.ts');
    expect(suites.length).toBeGreaterThan(20);
  });

  it('detects the pattern it forbids', () => {
    const sample = ["  it('x', async () => {", '    if (!enabled) return;', '  });'].join('\n');
    expect(earlyReturns(sample)).toHaveLength(1);
    const nested = ["  it('x', async () => {", '    await Promise.all(xs.map(async (x) => {', '      if (x) return;'].join('\n');
    expect(earlyReturns(nested)).toHaveLength(0);
  });

  it.each(integrationSuites())('%s never opens a test with a bare conditional return', (suite) => {
    const source = readFileSync(path.join(REPO_ROOT, suite), 'utf8');
    expect(earlyReturns(source), `${suite}: use context.skip(reason), which vitest reports as skipped`).toEqual([]);
  });
});
