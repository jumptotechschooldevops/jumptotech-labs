/**
 * PLATFORM-003 — the catalog API.
 *
 * Story test requirements 30–33: `GET /api/labs` returns the catalog,
 * `GET /api/labs/:id` returns the correct student-safe definition, an unknown
 * lab returns an appropriate error, and the PLATFORM-002 session APIs still
 * work unchanged.
 *
 * The cluster is faked here: these tests assert routing, projection, and the
 * catalog-safety rules. Cluster behaviour is proved against real kind in the
 * orchestrator's integration suite.
 *
 * What the catalog *contains* is never restated here. Counts and id lists are
 * derived from the labs directory (`scanLabsDirectory`), so the assertion is
 * "the API serves the catalog that was actually discovered" rather than "the
 * API serves the four tracks we happened to ship the day this was written".
 * Adding a track or a lab therefore needs no edit in this file.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import {
  fixtureLabYaml,
  labsDirPlus,
  scanLabsDirectory,
  temporaryLabsDirs,
} from '@jumptotech/lab-orchestrator/testing/catalog';
import { rm } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

let registry: LabRegistry;
/** The catalog as it is on disk — the source every expected count comes from. */
let disk: Awaited<ReturnType<typeof scanLabsDirectory>>;

interface BuildOptions {
  k8s?: FakeKubernetes;
  /** Serve a different catalog, for the "a new track just appears" tests. */
  registry?: LabRegistry;
  labsDir?: string;
}

function buildApp(options: FakeKubernetes | BuildOptions = {}) {
  const opts: BuildOptions = options instanceof FakeKubernetes ? { k8s: options } : options;
  const k8s = opts.k8s ?? new FakeKubernetes();
  const catalog = opts.registry ?? registry;
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: opts.labsDir ?? path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
    waitForRequirements: async () => ({ ok: true, checks: [] }),
  });
  provider.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const sessions = new SessionManager({
    registry: catalog,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });

  return { app: createApp({ registry: catalog, sessions, k8s, config }), k8s, sessions };
}

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
  disk = await scanLabsDirectory();
});

afterEach(async () => {
  await Promise.all(
    temporaryLabsDirs().map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// -------------------------------------------------------- 30. GET /api/labs

describe('GET /api/labs — the catalog (test requirement 30)', () => {
  it('returns every discovered lab, grouped into every discovered track', async () => {
    const res = await request(buildApp().app).get('/api/labs');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The count is the catalog's, not a number remembered here.
    expect(res.body.data.count).toBe(disk.labCount);
    expect(res.body.data.labs).toHaveLength(disk.labCount);
    expect(res.body.data.labs.map((l: { id: string }) => l.id)).toEqual(disk.ids);

    // Catalog order is by track slug, then by each lab's `order`, so each
    // track's labs come back as one contiguous run in its own declared order.
    const idsForTrack = (track: string) =>
      res.body.data.labs
        .filter((l: { track: string }) => l.track === track)
        .map((l: { id: string }) => l.id);
    for (const track of disk.trackIds) {
      expect(idsForTrack(track), track).toEqual(disk.idsForTrack(track));
    }

    // Tracks are ordered by their track.yaml `order`; those without one follow
    // alphabetically. Both the order and the counts come from disk.
    expect(res.body.data.tracks.map((t: { track: string }) => t.track)).toEqual(disk.trackIds);
    expect(res.body.data.tracks.map((t: { labCount: number }) => t.labCount)).toEqual(
      disk.tracks.map((t) => t.labCount),
    );
    // Every lab belongs to a track the payload also describes: no lab can be
    // served under a track the catalog does not list.
    expect([...new Set(res.body.data.labs.map((l: { track: string }) => l.track))].sort()).toEqual(
      [...disk.trackIds].sort(),
    );
  });

  it('gives a Docker card the same shape as a Kubernetes one', async () => {
    const res = await request(buildApp().app).get('/api/labs');
    const card = res.body.data.labs.find((l: { id: string }) => l.id === 'DOCKER-001');

    // Nothing in the catalog projection branches on track: the same fields are
    // populated from the same lab.yaml keys whatever substrate the lab runs on.
    expect(card).toMatchObject({
      id: 'DOCKER-001',
      title: 'Run Your First Container',
      track: 'docker',
      topic: 'containers',
      difficulty: 'beginner',
    });
    expect(card.skills).toContain('docker.containers.run');
    expect(card.durationMinutes).toBeGreaterThan(0);
  });

  it('gives a card everything it needs to render', async () => {
    const res = await request(buildApp().app).get('/api/labs');
    const card = res.body.data.labs.find((l: { id: string }) => l.id === 'K8S-002');

    expect(card).toMatchObject({
      id: 'K8S-002',
      title: 'Run an Application with a Deployment',
      track: 'kubernetes',
      topic: 'workloads',
      difficulty: 'beginner',
      durationMinutes: 30,
      certifications: ['CKA'],
    });
    expect(card.skills).toContain('kubernetes.deployments.scale');
    expect(card.prerequisites).toEqual([
      { id: 'K8S-001', title: 'Create Your First Pod', available: true },
    ]);
  });

  it('filters by track, topic, difficulty and free text', async () => {
    const { app } = buildApp();

    // Per-track counts come from disk, so a new track or lab changes both sides.
    for (const track of disk.trackIds) {
      const byTrack = await request(app).get(`/api/labs?track=${track}`);
      expect(byTrack.body.data.count, track).toBe(disk.labCountForTrack(track));
      expect(byTrack.body.data.labs.map((l: { id: string }) => l.id), track).toEqual(
        disk.idsForTrack(track),
      );
    }

    // The other facets are checked against the catalog the API just served,
    // rather than against a remembered answer that a second track would widen.
    const all = (await request(app).get('/api/labs')).body.data.labs as Array<{
      id: string;
      track: string;
      topic: string;
      difficulty: string;
    }>;

    const topic = all[0]!.topic;
    const byTopic = await request(app).get(`/api/labs?topic=${topic}`);
    expect(byTopic.body.data.labs.map((l: { id: string }) => l.id)).toEqual(
      all.filter((l) => l.topic === topic).map((l) => l.id),
    );

    for (const track of disk.trackIds) {
      const inTrack = all.filter((l) => l.track === track);
      for (const difficulty of new Set(inTrack.map((l) => l.difficulty))) {
        const scoped = await request(app).get(`/api/labs?track=${track}&difficulty=${difficulty}`);
        expect(scoped.body.data.count, `${track}/${difficulty}`).toBe(
          inTrack.filter((l) => l.difficulty === difficulty).length,
        );
        expect(
          scoped.body.data.labs.every((l: { track: string }) => l.track === track),
          `${track}/${difficulty}`,
        ).toBe(true);
      }
    }

    // Free text: an id is the narrowest query there is.
    const one = all[0]!;
    const byQuery = await request(app).get(`/api/labs?q=${one.id}`);
    expect(byQuery.body.data.labs.map((l: { id: string }) => l.id)).toEqual([one.id]);
  });

  it('treats an unknown filter value as matching nothing, not as an error', async () => {
    const res = await request(buildApp().app).get('/api/labs?track=does-not-exist');

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(0);
  });

  it('states plainly that prerequisites are not enforced', async () => {
    const res = await request(buildApp().app).get('/api/labs');
    expect(res.body.data.prerequisitesEnforced).toBe(false);
  });

  it('never leaks requirements, setup manifests, or reset policy', async () => {
    const body = JSON.stringify((await request(buildApp().app).get('/api/labs')).body);

    expect(body).not.toContain('requirements');
    expect(body).not.toContain('setup/');
    expect(body).not.toContain('purge_namespaced_resources');
    // K8S-010's faults are not discoverable from the catalog.
    expect(body).not.toContain('nginx:stabel');
  });

  it('creates nothing in the cluster', async () => {
    const { app, k8s } = buildApp();
    await request(app).get('/api/labs');
    await request(app).get('/api/labs/K8S-010');

    // Browsing the catalog must cost nothing — no namespace, no API object.
    expect(k8s.deletedNamespaces).toEqual([]);
    expect([...k8s.applied.keys()]).toEqual([]);
    expect([...k8s.namespaces.keys()].sort()).toEqual(['default', 'kube-system']);
  });
});

// ---------------------------------------------------- 31. GET /api/labs/:id

describe('GET /api/labs/:id — the student-safe definition (test requirement 31)', () => {
  it('returns the full brief for a lab', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-003');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 'K8S-003',
      title: 'Expose a Workload with a Service',
      topic: 'networking',
      topicTitle: 'Networking',
      difficulty: 'beginner',
      durationMinutes: 30,
      hasSetup: true,
      prerequisitesEnforced: false,
    });
    expect(res.body.data.story).toContain('accounts service');
    expect(res.body.data.objectives.length).toBeGreaterThan(0);
    expect(res.body.data.certifications).toEqual([
      { certification: 'CKA', domains: ['services-and-networking'] },
    ]);
  });

  it('serves requirements as student-facing labels only', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-003');

    expect(res.body.data.requirements).toEqual([
      'Service accounts exists',
      'Service type is ClusterIP',
      'Service selects the accounts Pods',
      'Service accepts port 80 and forwards to container port 80',
      'Both accounts Pods are registered as ready endpoints',
    ]);
    // Never the requirement objects themselves.
    for (const requirement of res.body.data.requirements) {
      expect(typeof requirement).toBe('string');
    }
  });

  it('serves the progressive hint ladder in order', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-006');

    expect(res.body.data.hints.map((h: { level: number }) => h.level)).toEqual([1, 2, 3]);
    expect(res.body.data.hints[0].text).toBeTruthy();
  });

  it('serves only official documentation links', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-010');

    expect(res.body.data.references.length).toBeGreaterThan(0);
    for (const ref of res.body.data.references) {
      expect(new URL(ref.url).hostname).toBe('kubernetes.io');
    }
  });

  it('resolves prerequisites to titles', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-010');

    expect(res.body.data.prerequisites).toEqual([
      { id: 'K8S-003', title: 'Expose a Workload with a Service', available: true },
      { id: 'K8S-008', title: 'Signal Readiness with a Probe', available: true },
    ]);
  });

  it('does not reveal a troubleshooting lab\'s injected fault', async () => {
    const body = JSON.stringify((await request(buildApp().app).get('/api/labs/K8S-010')).body);

    // The student is told what "working" looks like, never what is broken or
    // which manifest broke it.
    expect(body).not.toContain('nginx:stabel');
    expect(body).not.toContain('setup/ledger-api.yaml');
    expect(body).not.toContain('purge_namespaced_resources');
    expect(body).toContain('Deployment runs the correct application image');
  });

  it('renders every shipped lab through the same projection', async () => {
    const { app } = buildApp();

    for (const lab of registry.all()) {
      const res = await request(app).get(`/api/labs/${lab.id}`);
      expect(res.status, lab.id).toBe(200);
      expect(res.body.data.id).toBe(lab.id);
      // The generic lab page needs these on every lab, with no special cases.
      expect(Array.isArray(res.body.data.requirements)).toBe(true);
      expect(Array.isArray(res.body.data.objectives)).toBe(true);
      expect(Array.isArray(res.body.data.hints)).toBe(true);
      expect(Array.isArray(res.body.data.prerequisites)).toBe(true);
      expect(res.body.data.task.summary).toBeTruthy();
    }
  });
});

// ------------------------------------------------------------- 32. errors

describe('GET /api/labs/:id — unknown labs (test requirement 32)', () => {
  it('returns 404 LAB_NOT_FOUND for a well-formed id that does not exist', async () => {
    const res = await request(buildApp().app).get('/api/labs/K8S-999');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('LAB_NOT_FOUND');
  });

  it('returns 400 INVALID_LAB_ID for a malformed id', async () => {
    for (const bad of ['not-a-lab', '../../etc/passwd', 'k8s-1']) {
      const res = await request(buildApp().app).get(`/api/labs/${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error.code).toBe('INVALID_LAB_ID');
    }
  });

  it('refuses to start an unknown lab, and creates nothing', async () => {
    const { app, k8s } = buildApp();
    const res = await request(app).post('/api/labs/K8S-999/start');

    expect(res.status).toBe(404);
    expect([...k8s.namespaces.keys()].sort()).toEqual(['default', 'kube-system']);
  });
});

// -------------------------------------------------------------- tracks API

describe('GET /api/tracks', () => {
  it('lists every discovered track, with the metadata each declares', async () => {
    const res = await request(buildApp().app).get('/api/tracks');

    expect(res.status).toBe(200);
    // Count and order are the catalog's, so a new track is additive here.
    expect(res.body.data.count).toBe(disk.trackCount);
    expect(res.body.data.tracks.map((t: { track: string }) => t.track)).toEqual(disk.trackIds);

    for (const [index, track] of (
      res.body.data.tracks as Array<{
        track: string;
        title: string;
        tagline?: string;
        labCount: number;
        topics: Array<{ topic: string; labCount: number }>;
      }>
    ).entries()) {
      const onDisk = disk.tracks[index]!;
      expect(track.labCount, track.track).toBe(onDisk.labCount);
      // Title, tagline, and position come from track.yaml when it declares
      // them; a track without one is still given a usable title.
      if (onDisk.declaredTitle) expect(track.title, track.track).toBe(onDisk.declaredTitle);
      else expect(track.title, track.track).toBeTruthy();
      if (onDisk.declaredTagline) expect(track.tagline, track.track).toBe(onDisk.declaredTagline);
      // A track's topics account for exactly its own labs.
      expect(track.topics.length, track.track).toBeGreaterThan(0);
      expect(
        track.topics.reduce((sum, t) => sum + t.labCount, 0),
        track.track,
      ).toBe(track.labCount);
    }
  });

  it('returns each track with its own labs, and only its own', async () => {
    const { app } = buildApp();

    for (const track of disk.trackIds) {
      const res = await request(app).get(`/api/tracks/${track}`);

      expect(res.status, track).toBe(200);
      expect(res.body.data.track, track).toMatchObject({
        track,
        labCount: disk.labCountForTrack(track),
      });
      expect(res.body.data.labs.map((l: { id: string }) => l.id), track).toEqual(
        disk.idsForTrack(track),
      );
      expect(
        res.body.data.labs.every((l: { track: string }) => l.track === track),
        track,
      ).toBe(true);
    }
  });

  it('returns the labs in a track', async () => {
    const { app } = buildApp();

    for (const track of disk.trackIds) {
      const res = await request(app).get(`/api/tracks/${track}/labs`);

      expect(res.status, track).toBe(200);
      expect(res.body.data.track, track).toBe(track);
      expect(res.body.data.count, track).toBe(disk.labCountForTrack(track));
      expect(res.body.data.prerequisitesEnforced, track).toBe(false);
    }
  });

  it('applies filters within the track', async () => {
    const { app } = buildApp();
    const track = disk.trackIds[0]!;
    const all = (await request(app).get(`/api/tracks/${track}/labs`)).body.data.labs as Array<{
      id: string;
      difficulty: string;
    }>;
    const difficulty = all[all.length - 1]!.difficulty;

    const res = await request(app).get(`/api/tracks/${track}/labs?difficulty=${difficulty}`);
    expect(res.body.data.labs.map((l: { id: string }) => l.id)).toEqual(
      all.filter((l) => l.difficulty === difficulty).map((l) => l.id),
    );
  });

  it('ignores a track query parameter that contradicts the path', async () => {
    // The path pins the track; a query parameter must not widen the result.
    const [first, second] = disk.trackIds;
    const res = await request(buildApp().app).get(
      `/api/tracks/${first}/labs?track=${second ?? first}`,
    );

    expect(res.body.data.track).toBe(first);
    expect(res.body.data.count).toBe(disk.labCountForTrack(first!));
    expect(res.body.data.labs.map((l: { id: string }) => l.id)).toEqual(
      disk.idsForTrack(first!),
    );
  });

  it('returns 404 for an unknown track and 400 for a malformed one', async () => {
    // A track nothing ships — asserted, not assumed, so this test starts
    // failing the day `ansible` becomes real rather than silently passing.
    expect(disk.trackIds).not.toContain('ansible');
    const missing = await request(buildApp().app).get('/api/tracks/ansible');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('TRACK_NOT_FOUND');

    const malformed = await request(buildApp().app).get('/api/tracks/NOT_A_TRACK');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_TRACK_ID');

    const missingLabs = await request(buildApp().app).get('/api/tracks/ansible/labs');
    expect(missingLabs.status).toBe(404);
  });

  it('never leaks lab internals through the track endpoints, on any track', async () => {
    const { app } = buildApp();

    // Every track, not just the first one written: catalog safety is a property
    // of the projection, so a new track must not be able to opt out of it.
    for (const track of disk.trackIds) {
      const body = JSON.stringify((await request(app).get(`/api/tracks/${track}/labs`)).body);

      expect(body, track).not.toContain('requirements');
      expect(body, track).not.toContain('setup/');
      expect(body, track).not.toContain('nginx:stabel');
    }
  });
});

// ------------------------------- the API follows the catalog it discovered

/**
 * The API contract is a *shape*, not a track list.
 *
 * `/api/labs`, `/api/tracks`, `/api/tracks/:track` and `/api/labs/:id` are
 * generic routes over whatever the registry found. These tests prove that by
 * serving a labs directory with one extra track in it and asserting the same
 * generic properties — no route added, no response field added, no count typed
 * anywhere. That is what lets a curriculum worktree add `labs/<track>/` without
 * touching this file or any other shared test.
 */
describe('the catalog API serves whatever the labs directory contains', () => {
  async function extendedApp(files: Record<string, string>) {
    const labsDir = await labsDirPlus(files);
    const extended = new LabRegistry(labsDir);
    await extended.load();
    return {
      ...buildApp({ registry: extended, labsDir }),
      registry: extended,
      extendedDisk: await scanLabsDirectory(labsDir),
    };
  }

  it('serves an additional valid track through the same routes, with no code change', async () => {
    const { app, registry: extended, extendedDisk } = await extendedApp({
      'fixture-track/track.yaml':
        'title: Fixture Track\ntagline: A track that exists only in a temp directory.\norder: 5\n',
      'fixture-track/fixture-901-demo/lab.yaml': fixtureLabYaml(),
    });

    expect(extended.loadErrors).toEqual([]);

    // /api/labs — one more lab, one more track, everything else unchanged.
    const labs = await request(app).get('/api/labs');
    expect(labs.body.data.count).toBe(extendedDisk.labCount);
    expect(labs.body.data.count).toBe(disk.labCount + 1);
    expect(labs.body.data.tracks.map((t: { track: string }) => t.track)).toEqual(
      extendedDisk.trackIds,
    );
    expect(labs.body.data.tracks).toHaveLength(disk.trackCount + 1);
    for (const track of disk.trackIds) {
      const ids = labs.body.data.labs
        .filter((l: { track: string }) => l.track === track)
        .map((l: { id: string }) => l.id);
      expect(ids, track).toEqual(disk.idsForTrack(track));
    }

    // /api/tracks — the new track carries the metadata it declared for itself.
    const tracks = await request(app).get('/api/tracks');
    expect(tracks.body.data.count).toBe(disk.trackCount + 1);
    expect(
      tracks.body.data.tracks.find((t: { track: string }) => t.track === 'fixture-track'),
    ).toMatchObject({ track: 'fixture-track', title: 'Fixture Track', labCount: 1 });

    // /api/tracks/:track and /api/labs/:id — no new route, no special case.
    const one = await request(app).get('/api/tracks/fixture-track');
    expect(one.status).toBe(200);
    expect(one.body.data.labs.map((l: { id: string }) => l.id)).toEqual(['FIXTURE-901']);

    const detail = await request(app).get('/api/labs/FIXTURE-901');
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id: 'FIXTURE-901', track: 'fixture-track' });

    // And it is student-safe on exactly the same terms as every shipped lab:
    // the requirement's *label* is served, never the machine-readable check.
    expect(detail.body.data.requirements).toEqual(['The project directory exists']);
    const serialised = JSON.stringify(detail.body);
    expect(serialised).not.toContain('file_exists');
    expect(serialised).not.toContain('"path"');

    // /health counts what was loaded, not a constant.
    const health = await request(app).get('/health');
    expect(health.body.data.labsLoaded).toBe(extendedDisk.labCount);
  });

  it('does not serve an additional track whose lab is invalid', async () => {
    const { app, registry: extended } = await extendedApp({
      'fixture-track/fixture-901-demo/lab.yaml': fixtureLabYaml({ extra: 'command: rm -rf /\n' }),
    });

    // Discovery being data-driven does not make the YAML trusted: the lab is
    // refused, the track never reaches the catalog, and the API still serves
    // exactly the shipped one.
    expect(extended.loadErrors.join('\n')).toContain('LAB_DEFINITION_INVALID');

    const labs = await request(app).get('/api/labs');
    expect(labs.body.data.count).toBe(disk.labCount);
    expect(labs.body.data.tracks.map((t: { track: string }) => t.track)).toEqual(disk.trackIds);

    expect((await request(app).get('/api/tracks/fixture-track')).status).toBe(404);
    expect((await request(app).get('/api/labs/FIXTURE-901')).status).toBe(404);
  });

  it('does not serve an additional track that reuses a shipped lab id', async () => {
    const shipped = [...disk.labs].sort((a, b) => a.file.localeCompare(b.file))[0]!;
    const { app, registry: extended } = await extendedApp({
      // `zz-` so the fixture is always walked after the shipped definition.
      'zz-fixture/fixture-901-demo/lab.yaml': fixtureLabYaml({
        id: shipped.id,
        track: 'zz-fixture',
      }),
    });

    expect(extended.loadErrors.join('\n')).toContain('duplicate lab id');

    const labs = await request(app).get('/api/labs');
    expect(labs.body.data.count).toBe(disk.labCount);
    expect(labs.body.data.tracks.map((t: { track: string }) => t.track)).toEqual(disk.trackIds);

    // `/api/labs/:id` stays unambiguous: the id resolves to its own track.
    const detail = await request(app).get(`/api/labs/${shipped.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.track).toBe(shipped.track);
  });
});

// ------------------------------------------ 33. PLATFORM-002 still intact

describe('PLATFORM-002 session APIs still work (test requirement 33)', () => {
  it('starts, checks, resets and ends a session on a PLATFORM-003 lab', async () => {
    const harness = buildApp();

    const started = await request(harness.app).post('/api/labs/K8S-002/start');
    expect(started.status).toBe(200);
    const { sessionId, namespace } = started.body.data.session;

    // Every PLATFORM-002 property still holds for a new lab.
    expect(sessionId).toMatch(/^sess-[0-9a-f]+$/);
    expect(namespace).toMatch(/^lab-[0-9a-f]+$/);
    expect(namespace).not.toBe('default');
    expect(started.body.data.terminal.token).toBeTruthy();

    const status = await request(harness.app).get(`/api/sessions/${sessionId}`);
    expect(status.status).toBe(200);
    expect(status.body.data.session.status).toBe('ACTIVE');

    const check = await request(harness.app).post(`/api/sessions/${sessionId}/check`);
    expect(check.status).toBe(200);
    expect(check.body.data.labId).toBe('K8S-002');
    expect(check.body.data.namespace).toBe(namespace);
    expect(check.body.data.passed).toBe(false);

    const activity = await request(harness.app).post(`/api/sessions/${sessionId}/activity`);
    expect(activity.status).toBe(200);

    const reset = await request(harness.app).post(`/api/sessions/${sessionId}/reset`);
    expect(reset.status).toBe(200);

    const ended = await request(harness.app).delete(`/api/sessions/${sessionId}`);
    expect(ended.status).toBe(200);
    expect(ended.body.data.session.status).toBe('ENDED');
    expect(harness.k8s.deletedNamespaces).toContain(namespace);
  });

  it('gives two sessions of the same lab two namespaces', async () => {
    const harness = buildApp();

    const a = await request(harness.app).post('/api/labs/K8S-010/start');
    const b = await request(harness.app).post('/api/labs/K8S-010/start');

    expect(a.body.data.session.namespace).not.toBe(b.body.data.session.namespace);
    expect(a.body.data.session.sessionId).not.toBe(b.body.data.session.sessionId);
  });

  it('seeds a lab fixture into the starting session namespace only', async () => {
    const harness = buildApp();

    const a = await request(harness.app).post('/api/labs/K8S-010/start');
    const b = await request(harness.app).post('/api/labs/K8S-002/start');
    const nsA = a.body.data.session.namespace;
    const nsB = b.body.data.session.namespace;

    // K8S-010 seeds a fixture; K8S-002 does not. Neither can see the other's.
    expect(harness.k8s.appliedKinds(nsA, 'Deployment').map((o) => o.metadata.name)).toEqual([
      'ledger-api',
    ]);
    expect(harness.k8s.appliedKinds(nsB, 'Deployment')).toEqual([]);
  });

  it('verifies each session against its own namespace only', async () => {
    const harness = buildApp();

    const a = await request(harness.app).post('/api/labs/K8S-001/start');
    const b = await request(harness.app).post('/api/labs/K8S-001/start');
    const nsA = a.body.data.session.namespace;

    // Only session A has the correct Pod.
    harness.k8s.pods.set(nsA, [podSnapshot({ namespace: nsA })]);

    const checkA = await request(harness.app).post(`/api/sessions/${a.body.data.session.sessionId}/check`);
    const checkB = await request(harness.app).post(`/api/sessions/${b.body.data.session.sessionId}/check`);

    expect(checkA.body.data.passed).toBe(true);
    expect(checkB.body.data.passed).toBe(false);
  });

  it('still exposes no endpoint that executes a command', async () => {
    const { app } = buildApp();

    for (const route of ['/api/labs/K8S-002/exec', '/api/sessions/sess-0000000a/exec', '/api/exec']) {
      const res = await request(app).post(route).send({ command: 'id' });
      expect(res.status, route).toBe(404);
    }
  });
});
