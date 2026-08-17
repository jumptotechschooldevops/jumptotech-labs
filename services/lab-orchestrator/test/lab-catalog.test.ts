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
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LabRegistry,
  LabDefinitionError,
  OFFICIAL_DOC_HOSTS,
  parseLabDefinition,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

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

const tempDirs: string[] = [];

/** Build a labs/ tree on disk: `{ 'kubernetes/k8s-901-demo': '<yaml>' }`. */
async function labsDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'jtt-labs-'));
  tempDirs.push(root);
  for (const [dir, contents] of Object.entries(files)) {
    const full = path.join(root, dir);
    await mkdir(full, { recursive: true });
    await writeFile(path.join(full, 'lab.yaml'), contents, 'utf8');
  }
  return root;
}

/** The real catalog, loaded fresh. */
async function realRegistry(): Promise<LabRegistry> {
  const registry = new LabRegistry(LABS_DIR);
  await registry.load();
  return registry;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------- discovery

describe('catalog — discovery (test requirements 1, 2)', () => {
  it('discovers every lab in the real labs/ directory', async () => {
    const registry = await realRegistry();

    expect(registry.loadErrors).toEqual([]);
    // Asserted per track rather than as one flat list: a new track must be
    // able to arrive without this test needing to know it did, while a lab
    // disappearing from an existing track still fails loudly.
    expect(registry.labsForTrack('kubernetes').map((l) => l.id)).toEqual([
      'K8S-001',
      'K8S-002',
      'K8S-003',
      'K8S-004',
      'K8S-005',
      'K8S-006',
      'K8S-007',
      'K8S-008',
      'K8S-009',
      'K8S-010',
    ]);
    expect(registry.size).toBe(
      registry.tracks().reduce((total, track) => total + track.labCount, 0),
    );
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
    const registry = await realRegistry();
    // Order is *within* a track; across tracks the sort is by track name, so a
    // flat list of orders is not monotonic once a second track exists.
    for (const track of registry.tracks()) {
      const orders = registry.labsForTrack(track.track).map((l) => l.order);
      expect(orders, track.track).toEqual([...orders].sort((a, b) => a - b));
    }
    expect(registry.all().map((l) => l.track)).toEqual(
      [...registry.all().map((l) => l.track)].sort(),
    );
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
  it('filters by track', async () => {
    const registry = await realRegistry();

    expect(registry.list({ track: 'kubernetes' })).toHaveLength(10);
    expect(registry.list({ track: 'terraform' })).toHaveLength(0);
    expect(registry.labsForTrack('kubernetes')).toHaveLength(10);
  });

  it('filters by topic, difficulty and free text', async () => {
    const registry = await realRegistry();

    expect(registry.list({ topic: 'batch' }).map((l) => l.id)).toEqual(['K8S-006', 'K8S-007']);
    // Difficulty spans tracks, so this is scoped to one — otherwise the
    // assertion would have to be rewritten every time a track is added.
    expect(registry.list({ track: 'kubernetes', difficulty: 'intermediate' }).map((l) => l.id)).toEqual([
      'K8S-008',
      'K8S-009',
      'K8S-010',
    ]);
    expect(registry.list({ q: 'cronjob' }).map((l) => l.id)).toEqual(['K8S-007']);
  });

  it('reports tracks with their topics and difficulties', async () => {
    const registry = await realRegistry();
    const track = registry.track('kubernetes');

    expect(track).toMatchObject({ track: 'kubernetes', title: 'Kubernetes', labCount: 10 });
    expect(track?.difficulties).toEqual(['beginner', 'intermediate']);
    expect(track?.topics.map((t) => t.topic)).toContain('troubleshooting');
    expect(registry.track('nope')).toBeNull();
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

  it('points every shipped lab at official documentation only', async () => {
    const registry = await realRegistry();

    // Each track has its own set of official hosts (OFFICIAL_DOC_HOSTS), and
    // the loader enforces that a lab cites at least one of its own track's.
    // The assertion is written the same way, so it covers a track that does
    // not exist yet without being rewritten.
    for (const lab of registry.all()) {
      expect(lab.references.length, lab.id).toBeGreaterThan(0);
      for (const ref of lab.references) expect(ref.url, lab.id).toMatch(/^https:\/\//);

      const official = OFFICIAL_DOC_HOSTS[lab.track];
      expect(official, `no official hosts declared for track '${lab.track}'`).toBeTruthy();
      const hosts = lab.references.map((ref) => new URL(ref.url).hostname);
      expect(
        hosts.some((host) => official!.some((allowed) => host === allowed || allowed.startsWith(`${host}/`))),
        `${lab.id}: ${hosts.join(', ')}`,
      ).toBe(true);
    }
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
