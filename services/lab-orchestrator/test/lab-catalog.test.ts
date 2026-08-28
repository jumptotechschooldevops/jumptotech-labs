/**
 * PLATFORM-003 — catalog and schema.
 *
 * Covers story test requirements 1–12: discovery of multiple labs, loading
 * valid definitions, rejecting invalid ones, rejecting duplicate ids, filtering
 * by track, catalog-safe metadata, and validation of skills, prerequisites,
 * hints, documentation, setup, and verification requirements.
 *
 * The registry is exercised against real fixtures written to a temp directory,
 * not against a mock, so "the loader rejects this" means the loader actually
 * read the bytes and refused.
 *
 * Nothing here restates the current curriculum. What the catalog *contains* is
 * read off disk by `scanLabsDirectory` and compared against what the registry
 * produced, so adding a track or a lab needs no edit in this file — while a lab
 * that fails to load, or is dropped as a duplicate, still fails loudly. See
 * `catalog-shape.ts` for why that is stronger than the counts it replaced.
 */
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DISALLOWED_DOC_HOSTS,
  LabRegistry,
  OFFICIAL_DOC_HOSTS,
  parseLabDefinition,
  LabDefinitionError,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';
import { freshRealCatalog, realCatalog } from './real-catalog.js';
import {
  fixtureLabYaml,
  labsDirPlus,
  scanLabsDirectory,
  type DiscoveredCatalog,
  type DiscoveredLab,
} from './catalog-shape.js';

/** The order `TrackSummary.difficulties` promises. */
const DIFFICULTY_ORDER = ['beginner', 'intermediate', 'advanced'];

const DOC_URL = 'https://kubernetes.io/docs/concepts/workloads/pods/';

const BODY = `
task:
  summary: Do the thing.
  description: A longer description of the thing.
requirements:
  - type: pod_exists
    name: demo
    label: Pod demo exists
references:
  - title: Kubernetes Pods
    url: ${DOC_URL}
skills:
  - kubernetes.pods.create
environment:
  provider: kubernetes
`;

/** A minimal definition that passes every rule; tests override one field at a time. */
function labYaml(overrides: Record<string, string> = {}): string {
  const merged: Record<string, string> = {
    id: 'K8S-901',
    slug: 'k8s-901-demo',
    title: 'Demo Lab',
    track: 'kubernetes',
    topic: 'pods',
    difficulty: 'beginner',
    duration_minutes: '15',
    body: BODY,
    extra: '',
    ...overrides,
  };
  return [
    `id: ${merged.id}`,
    `slug: ${merged.slug}`,
    `title: ${merged.title}`,
    `track: ${merged.track}`,
    `topic: ${merged.topic}`,
    `difficulty: ${merged.difficulty}`,
    `duration_minutes: ${merged.duration_minutes}`,
    merged.body,
    merged.extra,
  ].join('\n');
}

/** Replace a fragment of the base document, for one-field-at-a-time mutations. */
function mutate(from: string, to: string): string {
  return labYaml().replace(from, to);
}

/**
 * Assert that parsing fails, and that one of the reported issues explains why.
 *
 * `LabDefinitionError.message` is only a summary ("failed validation, 3
 * issues"); the per-field explanations live in `.issues`, which is what
 * `format()` prints to the operator. Following the existing convention here
 * keeps assertions pointed at the text a developer actually reads.
 */
function expectIssue(yaml: string, pattern: RegExp): void {
  try {
    parseLabDefinition(yaml);
  } catch (error) {
    expect(error).toBeInstanceOf(LabDefinitionError);
    const issues = (error as LabDefinitionError).issues.join('\n');
    expect(issues, `issues were:\n${issues}`).toMatch(pattern);
    return;
  }
  throw new Error(`expected parseLabDefinition to reject, matching ${pattern}`);
}

/** Assert only that parsing fails — used where the schema, not a rule, refuses. */
function expectRejected(yaml: string): void {
  expect(() => parseLabDefinition(yaml)).toThrow(LabDefinitionError);
}

/**
 * Build a labs/ tree on disk: `{ 'kubernetes/k8s-901-demo': '<yaml>' }`.
 *
 * Each call gets its own `mkdtemp` directory and removes it when the test that
 * asked for it finishes, so no fixture here is reachable from another test —
 * in this file or in one running beside it.
 */
async function labsDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'jtt-labs-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [dir, contents] of Object.entries(files)) {
    const full = path.join(root, dir);
    await mkdir(full, { recursive: true });
    await writeFile(path.join(full, 'lab.yaml'), contents, 'utf8');
  }
  return root;
}

/**
 * The real catalog: one shared, immutable load per worker process.
 *
 * `realCatalog()` lives in `real-catalog.ts` because every suite in this
 * workspace needs the same thing, and each private copy of it was another full
 * validation pass over all 114 `lab.yaml` files. See that module for what the
 * duplication cost and why the shared instance is frozen.
 */
const realRegistry = realCatalog;

// ---------------------------------------------------------------- discovery

describe('catalog — discovery (test requirements 1, 2)', () => {
  it('registers exactly the labs that are on disk, and nothing else', async () => {
    const registry = await realRegistry();
    const disk = await scanLabsDirectory();

    expect(registry.loadErrors).toEqual([]);
    // Both sides are derived: the left from the loader, the right from a plain
    // walk of labs/. Adding a lab changes both together and needs no edit here,
    // but a lab that fails to load — or loses a duplicate-id race — leaves its
    // file on disk with its id missing from the registry, and fails.
    expect(registry.size).toBe(disk.labCount);
    expect(registry.all().map((l) => l.id)).toEqual(disk.ids);

    // Every id is unique, and every lab belongs to the track whose directory
    // holds it: `labs/<track>/<lab>/lab.yaml` must agree with `track:` inside.
    expect(new Set(disk.ids).size).toBe(disk.ids.length);
    for (const lab of registry.all()) {
      const onDisk = disk.labs.find((l) => l.id === lab.id);
      expect(onDisk, `${lab.id} is registered but not on disk`).toBeDefined();
      expect(lab.track, lab.id).toBe(onDisk?.track);
      expect(path.dirname(path.dirname(onDisk!.file)), lab.id).toBe(
        path.join(LABS_DIR, lab.track),
      );
    }
  });

  // The second, independent load is setup: a full validation pass over all 114
  // labs, which does not belong on a 5s test clock any more than the first one
  // did. The assertion below is what the test is about.
  let independent: Awaited<ReturnType<typeof freshRealCatalog>>;
  beforeAll(async () => {
    independent = await freshRealCatalog();
  }, 60_000);

  it('loads deterministically: two loads of one directory agree exactly', async () => {
    // One of the two loads is the shared one every other test here reads, so
    // this compares an independent load against it rather than paying for two
    // of its own. The property is unchanged — two separate `LabRegistry`
    // instances, each having walked labs/ for itself, agree exactly — and the
    // shared instance being frozen is what makes reusing it as one side safe.
    const [a, b] = [await realRegistry(), independent];

    expect(a).not.toBe(b);
    expect(a.all().map((l) => l.id)).toEqual(b.all().map((l) => l.id));
    expect(a.tracks()).toEqual(b.tracks());
  });

  it('discovers every shipped track, in its declared order', async () => {
    const tracks = (await realRegistry()).tracks();
    const disk = await scanLabsDirectory();

    // Order comes from labs/<track>/track.yaml, not from a table in code — and
    // a track without one still appears, sorting after the annotated tracks
    // alphabetically. Both the list and the counts are read off disk.
    expect(tracks.map((t) => t.track)).toEqual(disk.trackIds);
    expect(tracks.map((t) => t.labCount)).toEqual(disk.tracks.map((t) => t.labCount));

    for (const [index, track] of tracks.entries()) {
      const onDisk = disk.tracks[index]!;
      // Declared presentation metadata is honoured verbatim; a track that
      // declares none is still given a usable title rather than nothing.
      if (onDisk.declaredTitle) expect(track.title, track.track).toBe(onDisk.declaredTitle);
      else expect(track.title, track.track).toBeTruthy();
      if (onDisk.declaredTagline) expect(track.tagline, track.track).toBe(onDisk.declaredTagline);
      expect(track.order, track.track).toBe(onDisk.declaredOrder);

      // A track's own numbers are internally consistent: its topics account for
      // every one of its labs, and it declares at least one difficulty.
      expect(track.labCount, track.track).toBe(onDisk.labs.length);
      expect(track.topics.reduce((sum, t) => sum + t.labCount, 0), track.track).toBe(
        track.labCount,
      );
      expect(track.difficulties.length, track.track).toBeGreaterThan(0);
    }
  });

  it('discovers multiple labs from nested directories', async () => {
    const root = await labsDir({
      'kubernetes/k8s-901-demo': labYaml(),
      'kubernetes/k8s-902-other': labYaml({ id: 'K8S-902', slug: 'k8s-902-other' }),
    });
    const registry = new LabRegistry(root);
    await registry.load();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.all().map((l) => l.id)).toEqual(['K8S-901', 'K8S-902']);
  });

  it('loads a valid definition with every field populated', async () => {
    const lab = (await realRegistry()).get('K8S-010');

    expect(lab.title).toBe('Repair a Broken Deployment');
    expect(lab.difficulty).toBe('intermediate');
    expect(lab.prerequisites).toEqual(['K8S-003', 'K8S-008']);
    expect(lab.story).toContain('on call');
    expect(lab.objectives.length).toBeGreaterThan(0);
    expect(lab.setup.manifests).toEqual(['setup/ledger-api.yaml']);
  });

  it('orders labs by track then declared order', async () => {
    const labs = (await realRegistry()).all();

    // `all()` groups labs by track slug, in a stable order…
    expect([...new Set(labs.map((l) => l.track))]).toEqual(
      [...new Set(labs.map((l) => l.track))].sort((a, b) => a.localeCompare(b)),
    );

    // …each as one contiguous run, rather than interleaved.
    const trackRuns = labs.map((l) => l.track).filter((track, i, list) => track !== list[i - 1]);
    expect(trackRuns).toEqual([...new Set(trackRuns)]);

    // …and within each track, `order` ascends. Checking per track rather than
    // globally is the point: every track restarts at 1.

    for (const track of new Set(labs.map((l) => l.track))) {
      const orders = labs.filter((l) => l.track === track).map((l) => l.order);
      expect(orders, `labs in track '${track}'`).toEqual([...orders].sort((a, b) => a - b));
    }
  });
});

// ------------------------------------------ adding a track is a data change

/**
 * The property the whole platform rests on: a new track is *added*, never
 * *declared*.
 *
 * Each test here starts from a copy of the real labs directory and adds files
 * to it, so the new track has to coexist with everything already shipped rather
 * than being discovered in an empty directory. None of the assertions name a
 * count — the same derived checks that describe the shipped catalog describe
 * the extended one, which is exactly what makes a curriculum worktree able to
 * add `labs/<track>/` without touching a shared test.
 */
describe('catalog — a valid new track is discovered without a code or test change', () => {
  /*
   * Every fixture in this describe is built once, here.
   *
   * Each of these scenarios needs its own temporary catalog — a copy of all 114
   * shipped labs, plus the overlay under test, then a full `LabRegistry.load()`
   * over the result and sometimes a rescan. That is three catalog-sized
   * operations per scenario, and while they sat inside the `it`s they were
   * charged to vitest's 5s `testTimeout`. On an idle machine that fit; at 4x
   * oversubscription it did not, and this was the last describe still timing
   * out once the shared catalog and the shared disk scan had been moved into
   * setup.
   *
   * So the construction moves too, and the tests below are assertions only.
   * The fixtures stay one-per-scenario — they are deliberately different
   * catalogs — but building them is setup, and setup gets a setup-sized budget
   * rather than a test-sized one. Not one assertion changed.
   */
  const FIXTURE_BUILD_TIMEOUT_MS = 60_000;

  let baseline: DiscoveredCatalog;
  let added: { registry: LabRegistry; disk: DiscoveredCatalog };
  let untitled: LabRegistry;
  let invalid: LabRegistry;
  let duplicateId: { registry: LabRegistry; shipped: DiscoveredLab };
  let duplicateSlug: { registry: LabRegistry; shipped: DiscoveredLab };

  async function registryOver(files: Record<string, string>): Promise<LabRegistry> {
    const registry = new LabRegistry(await labsDirPlus(files));
    await registry.load();
    return registry;
  }

  beforeAll(async () => {
    baseline = await scanLabsDirectory();
    // The lab whose file sorts first, so the shipped definition is the one that
    // registers and the impostor is the one refused. `zz-` guarantees the
    // fixture directory is walked last whatever tracks ship.
    const shipped = [...baseline.labs].sort((a, b) => a.file.localeCompare(b.file))[0]!;

    // Five independent catalogs. Built concurrently because they share nothing
    // and the work is largely filesystem latency: serially this hook exceeded a
    // minute under 4x oversubscription.
    const [addedPair, untitledRegistry, invalidRegistry, dupId, dupSlug] = await Promise.all([
      (async () => {
        const root = await labsDirPlus({
          'fixture-track/track.yaml':
            'title: Fixture Track\ntagline: A track that exists only in a temp directory.\norder: 5\n',
          'fixture-track/fixture-901-demo/lab.yaml': fixtureLabYaml(),
        });
        const registry = new LabRegistry(root);
        await registry.load();
        return { registry, disk: await scanLabsDirectory(root) };
      })(),
      registryOver({ 'fixture-track/fixture-901-demo/lab.yaml': fixtureLabYaml() }),
      registryOver({
        // Two ways to be invalid, one per lab: a key the schema does not know
        // (and which could carry a command), and a substrate with no provider.
        'fixture-track/fixture-901-demo/lab.yaml': fixtureLabYaml({ extra: 'command: rm -rf /\n' }),
        'fixture-track/fixture-902-demo/lab.yaml': fixtureLabYaml({
          id: 'FIXTURE-902',
          slug: 'fixture-902-demo',
        }).replace('provider: linux', 'provider: firecracker'),
      }),
      registryOver({
        'zz-fixture/fixture-901-demo/lab.yaml': fixtureLabYaml({
          id: shipped.id,
          track: 'zz-fixture',
        }),
      }),
      registryOver({
        'zz-fixture/fixture-901-demo/lab.yaml': fixtureLabYaml({
          slug: shipped.slug,
          track: 'zz-fixture',
        }),
      }),
    ]);

    added = addedPair;
    untitled = untitledRegistry;
    invalid = invalidRegistry;
    duplicateId = { registry: dupId, shipped };
    duplicateSlug = { registry: dupSlug, shipped };
  }, FIXTURE_BUILD_TIMEOUT_MS);

  it('picks up an additional track, additively, with no expected count edited', async () => {
    const { registry, disk } = added;

    // The shipped-catalog assertions, verbatim, against a catalog with one more
    // track in it.
    expect(registry.loadErrors).toEqual([]);
    expect(registry.size).toBe(disk.labCount);
    expect(registry.all().map((l) => l.id)).toEqual(disk.ids);
    expect(registry.tracks().map((t) => t.track)).toEqual(disk.trackIds);
    expect(registry.tracks().map((t) => t.labCount)).toEqual(disk.tracks.map((t) => t.labCount));

    // …and it really is additive: one more track, one more lab, and every track
    // that already shipped keeps exactly the labs it had.
    expect(disk.trackCount).toBe(baseline.trackCount + 1);
    expect(disk.labCount).toBe(baseline.labCount + 1);
    for (const track of baseline.trackIds) {
      expect(registry.labsForTrack(track).map((l) => l.id), track).toEqual(
        baseline.idsForTrack(track),
      );
    }

    // The new track's own metadata is honoured, including where it sorts.
    expect(registry.track('fixture-track')).toMatchObject({
      track: 'fixture-track',
      title: 'Fixture Track',
      labCount: 1,
      order: 5,
    });
    expect(registry.tracks()[0]?.track).toBe('fixture-track');
    expect(registry.get('FIXTURE-901').track).toBe('fixture-track');
    expect(registry.list({ track: 'fixture-track' }).map((l) => l.id)).toEqual(['FIXTURE-901']);
  });

  it('appears with no track.yaml at all, titled from its slug', async () => {
    const registry = untitled;

    expect(registry.loadErrors).toEqual([]);
    // No declared order, so it sorts after the annotated tracks, alphabetically.
    expect(registry.track('fixture-track')).toMatchObject({
      track: 'fixture-track',
      title: 'Fixture Track',
      labCount: 1,
    });
    expect(registry.track('fixture-track')?.order).toBeUndefined();
  });

  it('rejects an invalid lab in a new track, and keeps the rest of the catalog', async () => {
    const registry = invalid;

    // A new track being data-driven does not make its YAML trusted: neither lab
    // registers, the track never reaches the catalog, and the shipped catalog
    // is untouched.
    expect(registry.has('FIXTURE-901')).toBe(false);
    expect(registry.has('FIXTURE-902')).toBe(false);
    expect(registry.tracks().map((t) => t.track)).toEqual(baseline.trackIds);
    expect(registry.size).toBe(baseline.labCount);
    expect(registry.loadErrors).toHaveLength(2);
    expect(registry.loadErrors.join('\n')).toContain('LAB_DEFINITION_INVALID');
  });

  it('rejects a new track reusing a shipped lab id, and keeps the original', async () => {
    const { registry, shipped } = duplicateId;

    expect(registry.loadErrors.join('\n')).toContain('duplicate lab id');
    expect(registry.size).toBe(baseline.labCount);
    // `/api/labs/:id` stays unambiguous: the id still resolves to its own track.
    expect(registry.get(shipped.id).track).toBe(shipped.track);
    expect(registry.tracks().map((t) => t.track)).toEqual(baseline.trackIds);
  });

  it('rejects a new track reusing a shipped slug, so catalog links stay stable', async () => {
    const { registry, shipped } = duplicateSlug;

    expect(registry.loadErrors.join('\n')).toContain(`duplicate slug '${shipped.slug}'`);
    expect(registry.size).toBe(baseline.labCount);
    expect(registry.getBySlug(shipped.slug)?.id).toBe(shipped.id);
  });
});

// --------------------------------------------------------------- rejection

describe('catalog — invalid definitions are rejected (test requirement 3)', () => {
  it('rejects a lab and records why, without failing the whole load', async () => {
    const root = await labsDir({
      'kubernetes/k8s-901-demo': labYaml(),
      'kubernetes/k8s-902-broken': labYaml({
        id: 'K8S-902',
        slug: 'k8s-902-broken',
        body: 'task:\n  summary: Missing everything else.\n',
      }),
    });
    const registry = new LabRegistry(root);
    await registry.load();

    // The good lab still registers — one bad file does not take down the catalog.
    expect(registry.all().map((l) => l.id)).toEqual(['K8S-901']);
    expect(registry.loadErrors).toHaveLength(1);
    expect(registry.loadErrors[0]).toContain('LAB_DEFINITION_INVALID');
    expect(registry.loadErrors[0]).toContain('K8S-902');
  });

  it('rejects an unknown requirement type with a precise developer error', () => {
    expectIssue(
      mutate('  - type: pod_exists', '  - type: pod_teleports'),
      /requirements\[0\]\.type is not supported/,
    );
  });

  it('rejects unknown keys rather than silently ignoring them', () => {
    expectRejected(labYaml({ extra: 'command: rm -rf /' }));
  });

  it('rejects malformed YAML with the parser message', () => {
    expect(() => parseLabDefinition('id: [unclosed')).toThrow(/Invalid YAML/);
  });
});

describe('catalog — duplicate ids and slugs are rejected (test requirement 4)', () => {
  it('rejects a second lab claiming an id that is already registered', async () => {
    const root = await labsDir({
      'kubernetes/k8s-901-demo': labYaml(),
      'kubernetes/k8s-901-copy': labYaml({ slug: 'k8s-901-copy' }),
    });
    const registry = new LabRegistry(root);
    await registry.load();

    expect(registry.size).toBe(1);
    expect(registry.loadErrors.join('\n')).toContain('duplicate lab id');
  });

  it('rejects a second lab claiming a slug that is already registered', async () => {
    const root = await labsDir({
      'kubernetes/k8s-901-demo': labYaml(),
      'kubernetes/other': labYaml({ id: 'K8S-902' }),
    });
    const registry = new LabRegistry(root);
    await registry.load();

    expect(registry.size).toBe(1);
    expect(registry.loadErrors.join('\n')).toContain("duplicate slug 'k8s-901-demo'");
  });
});

// ------------------------------------------------------------------ filters

describe('catalog — filtering (test requirement 5)', () => {
  it('filters by track, returning exactly that track’s labs in catalog order', async () => {
    const registry = await realRegistry();
    const disk = await scanLabsDirectory();

    // Every shipped track, checked the same way — no track named in a literal.
    for (const track of disk.trackIds) {
      expect(registry.list({ track }).map((l) => l.id), track).toEqual(disk.idsForTrack(track));
      expect(registry.labsForTrack(track).map((l) => l.id), track).toEqual(
        disk.idsForTrack(track),
      );
    }

    // A track nothing ships matches nothing rather than erroring. The name is
    // synthetic on purpose: this assertion used to use 'ansible', and silently
    // became vacuous the moment that track shipped.
    const unshipped = 'track-that-ships-nothing';
    expect(disk.trackIds).not.toContain(unshipped);
    expect(registry.list({ track: unshipped })).toHaveLength(0);
  });

  it('filters by topic, difficulty and level consistently with the catalog', async () => {
    const registry = await realRegistry();
    const all = registry.list();

    // Each facet is checked against the catalog itself, not against a
    // remembered answer — so a second track widening a facet is the filter
    // working, not a regression to edit out.
    const facets: Array<[string, (lab: (typeof all)[number]) => string]> = [
      ['topic', (l) => l.topic],
      ['difficulty', (l) => l.difficulty],
      ['level', (l) => l.level],
    ];
    for (const [facet, valueOf] of facets) {
      for (const value of new Set(all.map(valueOf))) {
        expect(
          registry.list({ [facet]: value }).map((l) => l.id),
          `${facet}=${value}`,
        ).toEqual(all.filter((l) => valueOf(l) === value).map((l) => l.id));
      }
    }
  });

  it('matches free text over id, title, summary and topic', async () => {
    const registry = await realRegistry();
    const all = registry.list();
    const lab = all[0]!;

    // An id is the narrowest query there is: it must select exactly one lab.
    expect(registry.list({ q: lab.id }).map((l) => l.id)).toEqual([lab.id]);

    // Any term drawn from a real title selects a set that all genuinely contain
    // it, which is the property — the size of that set is curriculum, not
    // behaviour.
    const term = lab.title.split(' ')[0]!.toLowerCase();
    const hits = registry.list({ q: term });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(`${hit.id} ${hit.title} ${hit.summary} ${hit.topic}`.toLowerCase()).toContain(term);
    }
    expect(registry.list({ q: 'no-lab-anywhere-mentions-this' })).toEqual([]);
  });

  it('combines a track filter with the other facets without leaking across tracks', async () => {
    const registry = await realRegistry();
    const disk = await scanLabsDirectory();

    for (const track of disk.trackIds) {
      const inTrack = registry.list({ track });

      for (const difficulty of new Set(inTrack.map((l) => l.difficulty))) {
        const combined = registry.list({ track, difficulty });
        expect(combined.map((l) => l.id), `${track}/${difficulty}`).toEqual(
          inTrack.filter((l) => l.difficulty === difficulty).map((l) => l.id),
        );
        expect(combined.every((l) => l.track === track)).toBe(true);
      }
      for (const topic of new Set(inTrack.map((l) => l.topic))) {
        const combined = registry.list({ track, topic });
        expect(combined.map((l) => l.id), `${track}/${topic}`).toEqual(
          inTrack.filter((l) => l.topic === topic).map((l) => l.id),
        );
      }
      // A free-text term never widens a track filter back out again.
      expect(registry.list({ track, q: 'a' }).every((l) => l.track === track)).toBe(true);
    }
  });

  it('reports every track with its own topics, difficulties and providers', async () => {
    const registry = await realRegistry();

    for (const track of registry.tracks()) {
      const labs = registry.labsForTrack(track.track);

      expect(track.labCount, track.track).toBe(labs.length);
      // Topics and providers are in first-appearance order; difficulties are
      // ranked, easiest first.
      expect(track.topics.map((t) => t.topic), track.track).toEqual([
        ...new Set(labs.map((l) => l.topic)),
      ]);
      expect(track.providers, track.track).toEqual([...new Set(labs.map((l) => l.provider))]);
      expect(track.difficulties, track.track).toEqual(
        [...new Set(labs.map((l) => l.difficulty))].sort(
          (a, b) => DIFFICULTY_ORDER.indexOf(a) - DIFFICULTY_ORDER.indexOf(b),
        ),
      );
    }

    expect(registry.track('nope')).toBeNull();
  });

  it('reports every track through one code path, with no per-track special case', async () => {
    const registry = await realRegistry();

    // `track(name)` and `tracks()` are the same projection; if a track ever
    // needed a branch, these would drift.
    for (const summary of registry.tracks()) {
      expect(registry.track(summary.track), summary.track).toEqual(summary);
    }
  });
});

// ------------------------------------------------------------ catalog-safe

describe('catalog — the summary projection is student-safe (test requirement 6)', () => {
  it('carries what a card needs', async () => {
    const registry = await realRegistry();
    const summary = registry.list({ q: 'K8S-010' })[0]!;

    expect(summary).toMatchObject({
      id: 'K8S-010',
      track: 'kubernetes',
      topic: 'troubleshooting',
      topicTitle: 'Troubleshooting',
      difficulty: 'intermediate',
      durationMinutes: 45,
      certifications: ['CKA'],
      hasSetup: true,
      hintCount: 3,
    });
    expect(summary.skills.length).toBeGreaterThan(0);
  });

  it('never exposes requirements, setup manifests, or reset policy', async () => {
    const serialised = JSON.stringify((await realRegistry()).list());

    // The requirement objects are the expected end state in machine-readable
    // form. `hasSetup` says *that* a lab seeds an environment; the manifests
    // that do it — the injected fault, for a troubleshooting lab — stay server-side.
    expect(serialised).not.toContain('requirements');
    expect(serialised).not.toContain('setup/');
    expect(serialised).not.toContain('purge_namespaced_resources');
    expect(serialised).not.toContain('protected_resources');
    expect(serialised).not.toContain('hints');
  });

  it('does not reveal the fault a troubleshooting lab injects', async () => {
    const registry = await realRegistry();
    const card = JSON.stringify(registry.list({ q: 'K8S-010' }));

    // The lab's own definition knows the correct image and the correct
    // selector; the catalog card must not, or the challenge is over before the
    // student starts it.
    expect(registry.get('K8S-010').requirements).toContainEqual(
      expect.objectContaining({ type: 'deployment_image', image: 'nginx:stable' }),
    );
    expect(card).not.toContain('nginx:stable');
    expect(card).not.toContain('nginx:stabel');
    expect(card).not.toContain('app: ledger');
  });

  it('resolves prerequisite ids to titles', async () => {
    const registry = await realRegistry();
    const summary = registry.summarise(registry.get('K8S-010'));

    expect(summary.prerequisites).toEqual([
      { id: 'K8S-003', title: 'Expose a Workload with a Service', available: true },
      { id: 'K8S-008', title: 'Signal Readiness with a Probe', available: true },
    ]);
  });
});

// ------------------------------------------------------------------ schema

describe('schema — skills (test requirement 7)', () => {
  it('requires at least one skill', () => {
    expectRejected(mutate('skills:\n  - kubernetes.pods.create', 'skills: []'));
  });

  it('requires dotted lowercase skill ids', () => {
    expectIssue(mutate('kubernetes.pods.create', 'Pods!'), /skill must be dotted lowercase/);
  });

  it('rejects duplicate skills', () => {
    expectIssue(
      mutate(
        'skills:\n  - kubernetes.pods.create',
        'skills:\n  - kubernetes.pods.create\n  - kubernetes.pods.create',
      ),
      /skills contains duplicates/,
    );
  });

  it('accepts the skills every shipped lab declares', async () => {
    for (const lab of (await realRegistry()).all()) {
      expect(lab.skills.length).toBeGreaterThan(0);
      for (const skill of lab.skills) expect(skill).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
    }
  });
});

describe('schema — prerequisites (test requirement 8)', () => {
  it('requires prerequisites to look like lab ids', () => {
    expectIssue(
      labYaml({ extra: 'prerequisites: [not-a-lab-id]' }),
      /prerequisite must be a lab id/,
    );
  });

  it('rejects a lab listing itself as its own prerequisite', () => {
    expectIssue(
      labYaml({ extra: 'prerequisites: [K8S-901]' }),
      /must not include the lab's own id/,
    );
  });

  it('rejects duplicate prerequisites', () => {
    expectIssue(
      labYaml({ extra: 'prerequisites: [K8S-001, K8S-001]' }),
      /prerequisites contains duplicates/,
    );
  });

  it('unregisters a lab whose prerequisite does not exist', async () => {
    const root = await labsDir({
      'kubernetes/k8s-901-demo': labYaml({ extra: 'prerequisites: [K8S-777]' }),
    });
    const registry = new LabRegistry(root);
    await registry.load();

    expect(registry.size).toBe(0);
    expect(registry.loadErrors.join('\n')).toContain('unknown lab(s): K8S-777');
  });

  it('unregisters labs whose prerequisites form a cycle', async () => {
    const root = await labsDir({
      'kubernetes/k8s-901-demo': labYaml({ extra: 'prerequisites: [K8S-902]' }),
      'kubernetes/k8s-902-other': labYaml({
        id: 'K8S-902',
        slug: 'k8s-902-other',
        extra: 'prerequisites: [K8S-901]',
      }),
    });
    const registry = new LabRegistry(root);
    await registry.load();

    expect(registry.size).toBe(0);
    expect(registry.loadErrors.join('\n')).toContain('cycle');
  });

  it('accepts the shipped prerequisite graph', async () => {
    const registry = await realRegistry();

    expect(registry.loadErrors).toEqual([]);
    for (const lab of registry.all()) {
      for (const prerequisite of lab.prerequisites) {
        expect(registry.has(prerequisite)).toBe(true);
      }
    }
  });
});

describe('schema — hints (test requirement 9)', () => {
  const withHints = (hints: string) => labYaml({ extra: `hints:\n${hints}` });

  it('accepts an ascending ladder starting at level 1', () => {
    const def = parseLabDefinition(
      withHints('  - level: 1\n    text: Nudge.\n  - level: 2\n    text: Where to look.'),
    );
    expect(def.hints.map((h) => h.level)).toEqual([1, 2]);
  });

  it('rejects duplicate hint levels', () => {
    expectIssue(
      withHints('  - level: 1\n    text: A.\n  - level: 1\n    text: B.'),
      /distinct levels/,
    );
  });

  it('rejects hints that are out of order', () => {
    expectIssue(
      withHints('  - level: 2\n    text: B.\n  - level: 1\n    text: A.'),
      /ascending level/,
    );
  });

  it('rejects a ladder that does not start at level 1', () => {
    expectIssue(withHints('  - level: 2\n    text: B.'), /start at level 1/);
  });

  it('gives every shipped lab a progressive ladder that never pastes a solution', async () => {
    for (const lab of (await realRegistry()).all()) {
      expect(lab.hints.length).toBeGreaterThanOrEqual(2);
      expect(lab.hints.map((h) => h.level)).toEqual(lab.hints.map((_, index) => index + 1));

      // A hint may name commands that *inspect* state, but must never hand over
      // the command that completes the lab.
      for (const hint of lab.hints) {
        expect(hint.text).not.toMatch(/kubectl (run|create deployment|expose|scale)\s+\S/);
        // The Docker track's equivalent: naming `docker ps` to inspect state is
        // fine, handing over the `docker run …` that completes the lab is not.
        expect(hint.text).not.toMatch(
          /docker (run|build|volume create|network create|image tag)\s+-?-?\S/,
        );
      }
    }
  });
});

describe('schema — documentation (test requirement 10)', () => {
  it('requires at least one reference', () => {
    expectRejected(mutate(`references:\n  - title: Kubernetes Pods\n    url: ${DOC_URL}`, 'references: []'));
  });

  it('requires an official kubernetes.io link on a kubernetes lab', () => {
    expectIssue(
      mutate(DOC_URL, 'https://example.com/pods'),
      /official kubernetes documentation link/,
    );
  });

  it('treats a path-narrowed entry as a path, not as its bare host', () => {
    /*
     * `OFFICIAL_DOC_HOSTS.kubernetes` contains `github.com/kubernetes`, meaning
     * the Kubernetes project on GitHub. Before PLATFORM-006 the matcher
     * compared it against the *hostname*, so every github.com URL satisfied the
     * official-documentation rule — a stranger's cheatsheet repo and the bare
     * site root included.
     */
    const withUrl = (url: string) => mutate(DOC_URL, url);

    // The entry's own project still qualifies, at the root and below it.
    expect(() => parseLabDefinition(withUrl('https://github.com/kubernetes'))).not.toThrow();
    expect(() =>
      parseLabDefinition(withUrl('https://github.com/kubernetes/kubernetes')),
    ).not.toThrow();

    // Anything else on the same host does not.
    for (const url of [
      'https://github.com/some-random-user/k8s-cheatsheet',
      'https://github.com/',
      'https://github.com/kubernetes-sigs-lookalike/x',
    ]) {
      expectIssue(withUrl(url), /official kubernetes documentation link/);
    }
  });

  it('rejects links to commercial training platforms', () => {
    expectIssue(
      mutate(
        'references:\n  - title: Kubernetes Pods',
        'references:\n  - title: Someone else\n    url: https://kodekloud.com/lab\n  - title: Kubernetes Pods',
      ),
      /kodekloud\.com/,
    );
  });

  it('requires https', () => {
    expectRejected(mutate('https://kubernetes.io', 'http://kubernetes.io'));
  });

  it('points every shipped lab at its own track\'s official documentation only', async () => {
    for (const lab of (await realRegistry()).all()) {
      expect(lab.references.length).toBeGreaterThan(0);

      // The rule is per-track, not "kubernetes.io or bust": a Docker lab must
      // cite docs.docker.com the same way a Kubernetes lab cites kubernetes.io.
      // `OFFICIAL_DOC_HOSTS` is the same table the loader enforces at parse
      // time, so this cannot drift away from what is actually accepted.
      const official = OFFICIAL_DOC_HOSTS[lab.track];
      expect(
        official,
        `track '${lab.track}' has no entry in OFFICIAL_DOC_HOSTS. A new track is ` +
          'discovered from its labs alone, but the documentation-host allowlist ' +
          'is a deliberate gate: add the track\'s official hosts to ' +
          'OFFICIAL_DOC_HOSTS in src/lab-definition.ts before shipping its labs.',
      ).toBeDefined();

      const cited = lab.references.map((ref) => new URL(ref.url).hostname);
      expect(
        cited.some((host) => (official ?? []).some((allowed) => host === allowed.split('/')[0])),
        `${lab.id} cites ${cited.join(', ')}, none of which is official for '${lab.track}'`,
      ).toBe(true);

      for (const ref of lab.references) expect(ref.url).toMatch(/^https:\/\//);
    }
  });
});

/**
 * The allowlist itself, independent of which tracks currently ship labs.
 *
 * Entries are added ahead of a track's first lab, so nothing else exercises
 * them until that lab lands. This is the guard in the meantime: an entry is
 * only allowed to name concrete documentation hosts, and adding a track must
 * never be a way to smuggle a commercial training platform onto the official
 * list or to open the policy up with a wildcard.
 */
describe('schema — the official documentation allowlist cannot be widened', () => {
  it('lists only concrete hostnames, with no wildcard or scheme', () => {
    for (const [track, hosts] of Object.entries(OFFICIAL_DOC_HOSTS)) {
      expect(hosts.length, track).toBeGreaterThan(0);
      expect(new Set(hosts).size, track).toBe(hosts.length);

      for (const host of hosts) {
        // An entry is a hostname, optionally narrowed by a path prefix
        // (`github.com/kubernetes`). Never a scheme, never a wildcard, and
        // never a bare label that would match more than one site.
        const bare = host.split('/')[0]!;
        expect(host, `${track}: ${host}`).not.toContain('*');
        expect(host, `${track}: ${host}`).not.toContain('://');
        expect(bare, `${track}: ${host}`).toMatch(
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/,
        );
      }
    }
  });

  it('never names a host the platform has explicitly disallowed', () => {
    // The two tables must not intersect: a commercial training platform must
    // not be able to become "official" by appearing in a new track's entry.
    for (const [track, hosts] of Object.entries(OFFICIAL_DOC_HOSTS)) {
      for (const host of hosts) {
        const bare = host.split('/')[0]!;
        for (const banned of DISALLOWED_DOC_HOSTS) {
          expect(
            bare === banned || bare.endsWith(`.${banned}`),
            `${track} lists '${host}', which is a disallowed host`,
          ).toBe(false);
        }
      }
    }
  });

  it('still refuses a lab citing a disallowed host, whatever else it cites', () => {
    // The official-host rule is satisfied here; the ban is what refuses it.
    expectIssue(
      mutate(
        'references:\n  - title: Kubernetes Pods',
        'references:\n  - title: A course\n    url: https://www.udemy.com/course/k8s\n  - title: Kubernetes Pods',
      ),
      /udemy\.com/,
    );
  });
});

describe('schema — setup definitions (test requirement 11)', () => {
  const withSetup = (manifests: string, verify = '\n  verify:\n    - type: pod_exists\n      name: demo') =>
    labYaml({ extra: `setup:\n  manifests: ${manifests}${verify}` });

  it('rejects an absolute manifest path', () => {
    expectIssue(withSetup('[/etc/passwd.yaml]'), /relative to the lab directory/);
  });

  it('rejects parent traversal in a manifest path', () => {
    expectIssue(withSetup('["../../secrets.yaml"]'), /traverse upwards/);
  });

  it('rejects a non-YAML manifest path', () => {
    expectIssue(withSetup('[setup/run.sh]'), /must be a \.yaml file/);
  });

  it('requires setup verification whenever setup applies manifests', () => {
    expectIssue(withSetup('[setup/app.yaml]', ''), /setup\.verify must describe at least one check/);
  });

  it('has no field anywhere that could carry a command', () => {
    for (const smuggled of ['command: id', 'script: id', 'exec: id', 'shell: id']) {
      expectRejected(labYaml({ extra: smuggled }));
    }
  });

  it('verifies the starting condition of every shipped lab that has one', async () => {
    for (const lab of (await realRegistry()).all()) {
      if (lab.setup.manifests.length === 0) continue;
      expect(lab.setup.verify.length).toBeGreaterThan(0);
      for (const manifest of lab.setup.manifests) {
        expect(manifest.startsWith('setup/')).toBe(true);
      }
    }
  });
});

describe('schema — verification requirements (test requirement 12)', () => {
  /** Swap the single base requirement for another. */
  const withRequirement = (body: string) =>
    mutate('  - type: pod_exists\n    name: demo\n    label: Pod demo exists', body);

  it('requires at least one requirement', () => {
    expectRejected(
      mutate('requirements:\n  - type: pod_exists\n    name: demo\n    label: Pod demo exists', 'requirements: []'),
    );
  });

  it('requires a student-facing label on every requirement', () => {
    expectIssue(mutate('    label: Pod demo exists', ''), /requirements\[0\]\.label is required/);
  });

  it('rejects extra keys on a requirement', () => {
    expectRejected(mutate('    label: Pod demo exists', '    label: L\n    namespace: kube-system'));
  });

  it('validates the shape of each requirement type', () => {
    // replicas must be a number within range
    expectRejected(
      withRequirement('  - type: deployment_replicas\n    name: web\n    replicas: "three"\n    label: L'),
    );

    // service type must be a known enum member
    expectRejected(
      withRequirement('  - type: service_type\n    name: web\n    expected: Gateway\n    label: L'),
    );

    // a resource requirement must ask for something
    expectRejected(withRequirement('  - type: deployment_resources\n    name: web\n    label: L'));

    // a valid one parses
    expect(
      parseLabDefinition(
        withRequirement('  - type: cronjob_schedule\n    name: nightly\n    schedule: "*/5 * * * *"\n    label: L'),
      ).requirements[0],
    ).toMatchObject({ type: 'cronjob_schedule', schedule: '*/5 * * * *' });
  });

  it('has a label on every requirement of every shipped lab', async () => {
    for (const lab of (await realRegistry()).all()) {
      for (const requirement of lab.requirements) {
        expect(requirement.label).toBeTruthy();
      }
    }
  });
});
