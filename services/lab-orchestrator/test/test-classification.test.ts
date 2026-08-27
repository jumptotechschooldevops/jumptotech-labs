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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './helpers.js';

/** Variables that unlock host execution — kept in step with the guard. */
const OPT_IN = ['RUN_INTEGRATION_TESTS', 'RUN_DOCKER_INTEGRATION_TESTS', 'RUN_DB_TESTS'];

/** The setup module every workspace's config has to install. */
const SETUP_FILE = 'test-support/vitest.setup.ts';

/**
 * Where a workspace may keep its vitest configuration.
 *
 * Two names, because `apps/web` keeps its test config inside `vite.config.ts`
 * alongside the dev server. The old check hardcoded `vitest.config.ts`, so even
 * listing `apps/web` would have thrown ENOENT rather than checked it.
 */
const CONFIG_NAMES = ['vitest.config.ts', 'vite.config.ts'] as const;

/** The runtime proof each workspace owes — see `test-support/guard-contract.ts`. */
const GUARD_TEST = 'host-execution-guard.test.ts';

/**
 * Every workspace that runs vitest, discovered rather than listed.
 *
 * This used to be a hand-maintained array of test directories, and the header
 * above claimed the scan meant "a new suite is covered the moment it is
 * written". That was true of *files inside the listed directories* and false of
 * *workspaces*: a whole workspace absent from the array was invisible. It cost
 * two months of `services/sandboxd` running unguarded, and `apps/web` was
 * missing for longer than that.
 *
 * So the list is derived from the same `workspaces` globs npm resolves, and a
 * workspace counts if it has a `test` script that runs vitest. Adding a
 * workspace now opts it into every check below without anyone remembering to.
 */
function vitestWorkspaces(): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { workspaces?: string[] };

  const found: string[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    // The globs in use are exactly `dir/*` or a literal directory. Anything
    // else would silently match nothing, so it is rejected rather than ignored.
    const segments = pattern.split('/');
    const head = segments[0] ?? '';
    const candidates =
      segments.length === 2 && segments[1] === '*'
        ? readdirSync(path.join(REPO_ROOT, head)).map((entry) => `${head}/${entry}`)
        : [pattern];

    for (const workspace of candidates) {
      const pkg = path.join(REPO_ROOT, workspace, 'package.json');
      if (!existsSync(pkg)) continue;
      const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> })
        .scripts;
      if (scripts?.test?.includes('vitest')) found.push(workspace);
    }
  }
  return found.sort();
}

/** A workspace's vitest config, whichever of the two names it uses. */
function configFor(workspace: string): string {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(REPO_ROOT, workspace, name);
    if (existsSync(candidate)) return candidate;
  }
  // Reported as a failure by the caller rather than thrown here, so the message
  // names the workspace instead of a bare ENOENT.
  return path.join(REPO_ROOT, workspace, CONFIG_NAMES[0]);
}

const TEST_DIRS = vitestWorkspaces().map((workspace) => `${workspace}/test`);

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

  it('discovers every workspace that runs vitest, including apps/web', () => {
    // The check that matters is that discovery is not a list someone has to
    // remember to extend. Naming the two that were historically missed keeps a
    // regression from being silent: a scan that quietly stopped finding them
    // would otherwise still pass every assertion below, vacuously.
    const workspaces = vitestWorkspaces();
    expect(workspaces).toContain('apps/web');
    expect(workspaces).toContain('services/sandboxd');
    expect(workspaces.length).toBeGreaterThanOrEqual(7);
  });

  it('keeps the guard installed for every workspace that runs vitest', () => {
    // A workspace without the setup file is a hole: its suites could reach the
    // host and nothing would say so.
    for (const workspace of vitestWorkspaces()) {
      const config = configFor(workspace);
      expect(
        existsSync(config),
        `${workspace} runs vitest but has none of ${CONFIG_NAMES.join(' / ')} — it cannot be installing the guard`,
      ).toBe(true);

      const source = readFileSync(config, 'utf8');
      // Not a bare `includes`: the setup file has to be reached from a
      // `setupFiles` entry, on a line that is not commented out. A config that
      // merely mentions the path in prose used to satisfy this.
      const installs = source
        .split('\n')
        .some(
          (line) =>
            line.includes(SETUP_FILE) &&
            !line.trimStart().startsWith('*') &&
            !line.trimStart().startsWith('//'),
        );
      expect(
        installs,
        `${path.relative(REPO_ROOT, config)} does not install the host-execution guard`,
      ).toBe(true);
      expect(
        source.includes('setupFiles'),
        `${path.relative(REPO_ROOT, config)} names ${SETUP_FILE} but has no setupFiles entry`,
      ).toBe(true);
    }
  });

  it('makes every workspace prove the guard at runtime, not just declare it', () => {
    // Configuration is a claim; the guard test is the evidence. A config can
    // point `setupFiles` at a path that no longer resolves and still read as
    // correct — this is what fails when that happens, in the workspace where it
    // happened. See `test-support/guard-contract.ts`.
    for (const workspace of vitestWorkspaces()) {
      const guardTest = path.join(REPO_ROOT, workspace, 'test', GUARD_TEST);
      expect(
        existsSync(guardTest),
        `${workspace} has no test/${GUARD_TEST} — nothing proves its guard is actually installed`,
      ).toBe(true);

      const source = readFileSync(guardTest, 'utf8');
      expect(
        source.includes('@jumptotech/test-support/guard-contract') ||
          source.includes('@jumptotech/test-support/host-execution'),
        `${workspace}/test/${GUARD_TEST} does not use the shared guard contract, so it may assert nothing`,
      ).toBe(true);
    }
  });
});
