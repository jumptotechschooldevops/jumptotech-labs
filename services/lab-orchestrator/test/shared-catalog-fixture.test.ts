/**
 * The shared catalog fixture, enforced.
 *
 * The flake this closes was not a race. `lab-orchestrator` loaded, parsed and
 * schema-validated the whole shipped catalog 137 times per run, at ~1.3s each,
 * and the tests that did it twice inside one test body sat on vitest's 5s
 * default timeout. Whichever of them was running when the machine got busy
 * failed, which is why it moved between `lab-catalog.test.ts` and
 * `runtime-owner.test.ts` and reproduced only once every 6–16 runs.
 *
 * The fix has two halves, because sharing alone was not enough. Loading once
 * per test file removed the repetition, but the one remaining load per file was
 * still *charged to a test*, so at 4x oversubscription it could exceed the 5s
 * `testTimeout` on its own — the same failure, just rarer. Moving that load into
 * the fixture's own `beforeAll` is what actually closes it: setup work is now
 * billed to setup. Neither half survives on good intentions:
 *
 *   1. nothing goes around the fixture and loads `labs/` for itself, or the
 *      cost — and the flake — comes straight back;
 *   2. nothing can mutate what the fixture shares, or one test corrupts every
 *      test after it in the same worker, which is a far worse failure than a
 *      timeout because it is silent.
 *
 * Both are checked here. The scan covers every workspace's tests, not just this
 * one, because `apps/api` and `services/verifier` load the same catalog.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './helpers.js';
import { labsDirPlus } from './catalog-shape.js';
import { LABS_DIR, freshRealCatalog, realCatalog } from './real-catalog.js';

/** The one module allowed to load the shipped catalog directly. */
const FIXTURE = 'services/lab-orchestrator/test/real-catalog.ts';

/** Every workspace test directory, derived from the npm workspaces globs. */
function testDirectories(): string[] {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const dirs: string[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    const [head, tail] = pattern.split('/');
    const candidates =
      tail === '*'
        ? readdirSync(path.join(REPO_ROOT, head!)).map((entry) => `${head}/${entry}`)
        : [pattern];
    for (const workspace of candidates) {
      const dir = path.join(REPO_ROOT, workspace, 'test');
      if (existsSync(dir)) dirs.push(path.join(workspace, 'test'));
    }
  }
  return dirs.sort();
}

function testSources(): Array<{ file: string; text: string }> {
  const sources: Array<{ file: string; text: string }> = [];
  for (const dir of testDirectories()) {
    for (const entry of readdirSync(path.join(REPO_ROOT, dir))) {
      if (!entry.endsWith('.ts')) continue;
      const file = path.join(dir, entry);
      sources.push({ file, text: readFileSync(path.join(REPO_ROOT, file), 'utf8') });
    }
  }
  return sources;
}

/**
 * Registry constructions whose argument names the *shipped* labs directory.
 *
 * A registry over a temporary directory is exactly what a test that needs to
 * change a catalog should build, so those are left alone; what this looks for
 * is the shipped one, named either by the `LABS_DIR` constant or by joining a
 * repository root with the literal `labs`.
 *
 * Comments are stripped first. Prose about this rule — the header above, and
 * the failure message below — otherwise trips it, which would make the check
 * fail on files that do nothing wrong.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function shippedCatalogLoads(text: string): string[] {
  return [...withoutComments(text).matchAll(/new LabRegistry\(([^;]*?)\)[;,\s]/g)]
    .map((match) => match[1] ?? '')
    .filter((argument) => /\bLABS_DIR\b/.test(argument) || /['"]labs['"]/.test(argument));
}

describe('the shipped catalog is loaded once per test file, through the fixture', () => {
  // FIRST, deliberately. Any earlier test that awaited realCatalog() would
  // settle the promise itself and leave this passing whether or not the
  // `beforeAll` exists — which is exactly how this assertion was wrong the
  // first time it was written.
  it('is already loaded before any test body runs, so no test is charged for it', async () => {
    // If the load were still pending here it would be running on this test's
    // 5s clock: the failure that survived at 4x oversubscription.
    //
    // Deterministic rather than timed: `Promise.race` queues its reactions in
    // argument order, so an already-settled first entry always beats an
    // already-settled second one. PENDING can therefore only win when the
    // catalog genuinely has not finished loading — no clock involved, so this
    // does not get flakier as the machine gets busier.
    const PENDING = Symbol('pending');
    const winner = await Promise.race([realCatalog(), Promise.resolve(PENDING)]);

    expect(winner).not.toBe(PENDING);
  });

  it('is not loaded directly by any test in any workspace', () => {
    const offenders = testSources()
      .filter(({ file }) => file !== FIXTURE)
      .flatMap(({ file, text }) => shippedCatalogLoads(text).map((arg) => `${file}: new LabRegistry(${arg})`));

    expect(
      offenders,
      'Load the shipped catalog with realCatalog() from ' +
        "'@jumptotech/lab-orchestrator/testing/real-catalog'. Constructing a " +
        'LabRegistry over labs/ costs a full validation of every lab, which is ' +
        'what made this suite fail intermittently under load. A test that needs ' +
        'a catalog it can change builds one with labsDirPlus().',
    ).toEqual([]);
  });

  it('hands every caller the same instance', async () => {
    expect(await realCatalog()).toBe(await realCatalog());
  });

  it('really did load the shipped catalog, so sharing is not hiding a failure', async () => {
    const catalog = await realCatalog();

    expect(catalog.loadErrors).toEqual([]);
    expect(catalog.size).toBeGreaterThan(0);
    expect(catalog.get('K8S-001').id).toBe('K8S-001');
  });
});

describe('what the fixture shares cannot be mutated', () => {
  it('refuses a write to a lab definition', async () => {
    const lab = (await realCatalog()).get('K8S-001');

    // Not a style rule: this object is the same object every later test in
    // this worker reads, so a write here would change what they see.
    expect(() => {
      (lab as unknown as { title: string }).title = 'rewritten';
    }).toThrow(TypeError);
    expect(lab.title).not.toBe('rewritten');
  });

  it('refuses a write nested inside a lab definition', async () => {
    const lab = (await realCatalog()).get('K8S-001');

    expect(() => (lab.objectives as string[]).push('injected')).toThrow(TypeError);
    expect(() => {
      (lab.task as unknown as { summary: string }).summary = 'rewritten';
    }).toThrow(TypeError);
  });

  it('refuses to be reloaded out from under a test running beside it', async () => {
    const catalog = await realCatalog();

    await expect(catalog.load(true)).rejects.toThrow(/immutable/i);
    // A non-forcing load stays a no-op rather than an error: it is what a
    // caller handed a loaded registry harmlessly does.
    await expect(catalog.load()).resolves.toBeUndefined();
    expect(catalog.size).toBeGreaterThan(0);
  });

  // The independent load is fixture setup, not the assertion — the assertion is
  // that it is a different, unfrozen registry. Doing it in `beforeAll` keeps a
  // second full validation pass off a 5s test clock, the same rule the fixture
  // itself follows.
  let fresh: Awaited<ReturnType<typeof freshRealCatalog>>;
  beforeAll(async () => {
    fresh = await freshRealCatalog();
  }, 30_000);

  it('leaves an independent load unfrozen, so the escape hatch is real', async () => {
    const lab = fresh.get('K8S-001');

    expect(fresh).not.toBe(await realCatalog());
    expect(Object.isFrozen(lab)).toBe(false);
  });
});

describe('a test that needs a changeable catalog gets its own copy', () => {
  it('builds it outside the shipped directory', async () => {
    const root = await labsDirPlus({
      'fixture-track/fixture-901-demo/lab.yaml': 'id: FIXTURE-901\n',
    });

    expect(root.startsWith(LABS_DIR)).toBe(false);
    expect(existsSync(path.join(root, 'fixture-track', 'fixture-901-demo', 'lab.yaml'))).toBe(true);
    // The shipped directory gained nothing.
    expect(existsSync(path.join(LABS_DIR, 'fixture-track'))).toBe(false);
  });
});
