/**
 * PLATFORM-006 — the UNIT / INTEGRATION / E2E split, enforced.
 *
 * The classification is only worth anything if it cannot rot. A suite that
 * quietly starts needing Docker, or an integration suite that loses its env
 * gate and starts running inside `npm test`, is exactly how main ended up with
 * unit tests shelling out to `kubectl`.
 *
 * The convention this pins:
 *
 *   UNIT         `<name>.test.ts`              — default. No host process, no
 *                                                network, no shared state. The
 *                                                host-execution guard enforces
 *                                                it at runtime; this enforces
 *                                                that nothing *claims* to need
 *                                                infrastructure without being
 *                                                classified for it.
 *   INTEGRATION  `<name>-integration.test.ts`  — real Docker / kind / Postgres.
 *                                                Must be gated on an opt-in
 *                                                variable, so `npm test` stays
 *                                                hermetic.
 *   E2E          an integration suite that mutates infrastructure it cannot
 *                isolate. Same gate, plus run-scoped resource names.
 *
 * Scanning the filesystem rather than maintaining a list is deliberate: a new
 * suite is covered the moment it is written.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './helpers.js';

/** Variables that unlock host execution — kept in step with the guard. */
const OPT_IN = ['RUN_INTEGRATION_TESTS', 'RUN_DOCKER_INTEGRATION_TESTS', 'RUN_DB_TESTS'];

const TEST_DIRS = [
  'services/lab-orchestrator/test',
  'services/verifier/test',
  'services/progress/test',
  'services/terminal/test',
  // Absent until 2026-08-27, which is why sandboxd ran unguarded for two months
  // without this suite noticing — the "guard installed for every workspace"
  // check below only ever looked at the directories named here. sandboxd is the
  // one service holding the Docker socket, so it was the worst omission.
  'services/sandboxd/test',
  'apps/api/test',
];

function testFiles(): string[] {
  const found: string[] = [];
  for (const dir of TEST_DIRS) {
    const full = path.join(REPO_ROOT, dir);
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(full, entry);
      if (statSync(file).isFile() && entry.endsWith('.test.ts')) found.push(file);
    }
  }
  return found.sort();
}

const isIntegrationName = (file: string) => /integration/.test(path.basename(file));

/**
 * Whether a suite actually *reads* a variable from the environment.
 *
 * Naming one in a string literal is not a dependency — the guard's own tests
 * pass `{ RUN_INTEGRATION_TESTS: '1' }` to a pure function to prove the opt-in
 * logic, and depend on no infrastructure at all. Only a `process.env` read
 * makes a suite environment-dependent, so that is what this looks for.
 */
function readsEnv(source: string, name: string): boolean {
  return new RegExp(`process\\.env(\\.${name}\\b|\\[['"\`]${name}['"\`]\\])`).test(source);
}

describe('test classification (PLATFORM-006)', () => {
  it('finds the suites it is supposed to be policing', () => {
    // A guard that silently scanned nothing would pass forever.
    const files = testFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some(isIntegrationName)).toBe(true);
  });

  it('gates every integration suite behind an opt-in variable', () => {
    for (const file of testFiles().filter(isIntegrationName)) {
      const source = readFileSync(file, 'utf8');
      expect(
        OPT_IN.some((name) => readsEnv(source, name)),
        `${path.relative(REPO_ROOT, file)} is named as an integration suite but reads none of ${OPT_IN.join(', ')} — it would run inside a plain \`npm test\``,
      ).toBe(true);
    }
  });

  it('lets no unit suite quietly depend on host infrastructure', () => {
    for (const file of testFiles().filter((f) => !isIntegrationName(f))) {
      const source = readFileSync(file, 'utf8');
      for (const name of OPT_IN) {
        expect(
          readsEnv(source, name),
          `${path.relative(REPO_ROOT, file)} reads ${name}, so it needs real infrastructure — rename it *-integration.test.ts so it is gated and isolated`,
        ).toBe(false);
      }
    }
  });

  it('keeps the guard installed for every workspace that runs node tests', () => {
    // A workspace without the setup file is a hole: its suites could reach the
    // host and nothing would say so.
    for (const dir of TEST_DIRS) {
      const workspace = path.join(REPO_ROOT, path.dirname(dir));
      const config = path.join(workspace, 'vitest.config.ts');
      const source = readFileSync(config, 'utf8');
      expect(
        source.includes('test-support/vitest.setup.ts'),
        `${path.relative(REPO_ROOT, config)} does not install the host-execution guard`,
      ).toBe(true);
    }
  });
});
