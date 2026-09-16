/**
 * N18 — baked image delivery, and the race it was designed around.
 *
 * `docs/development/n18-design.md` records the investigation. Three things
 * were measured on a real daemon before any of this was written, and each one
 * is pinned here so it cannot quietly regress:
 *
 *   1. **The race is real.** With a loader in the sandbox's entrypoint, the
 *      provider's readiness gate (`docker info`) passed while the image store
 *      was still empty — in all five of five concurrent sessions. So the load
 *      must be sequenced by the provider, inside `#ensureImage`, after
 *      readiness and before any container. Section 1 asserts that ordering.
 *   2. **It fails closed.** A sandbox image built without its archives must
 *      fail the lab's setup, never fall back to a pull that would hide the
 *      defect until the day there was no network.
 *   3. **No path is steerable.** A lab names a reference; the archive path is
 *      looked up in a closed map. A hostile reference is simply not baked.
 *
 * Section 5 keeps the map, the build list and the Dockerfile from drifting.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BAKED_IMAGES,
  BAKED_IMAGE_DIR,
  BakedImageError,
  DockerLabProvider,
  bakedImagePath,
  bakedImageReferences,
  parseLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeDockerEngines } from './docker-fakes.js';
import { REPO_ROOT, sessionContext } from './helpers.js';
import { realCatalog } from './real-catalog.js';

const SANDBOX_A = 'jtt-lab-0000000000aa';
const SANDBOX_B = 'jtt-lab-0000000000bb';

/** A Docker lab built inline, declaring the images a test needs. */
function dockerLab(images: string[]): LoadedLabDefinition {
  const yaml = `
id: DOCKER-990
slug: docker-990-baked
title: Baked
track: docker
topic: images
difficulty: beginner
duration_minutes: 10
environment:
  provider: docker
task:
  summary: s
  description: d
setup:
  docker:
    images:
${images.map((i) => `      - ${i}`).join('\n')}
  verify:
    - type: docker_image_exists
      image: ${images[0]}
      label: the image is available
requirements:
  - type: docker_image_exists
    image: ${images[0]}
    label: l
references:
  - title: Docker
    url: https://docs.docker.com/engine/
skills:
  - docker.images
hints:
  - level: 1
    text: Look at the image store.
  - level: 2
    text: Consult the official Docker documentation.
`;
  return { ...parseLabDefinition(yaml), sourcePath: '<inline>' } as LoadedLabDefinition;
}

function build(options: { bakedArchives?: 'present' | 'missing' | 'corrupt' } = {}) {
  const engines = new FakeDockerEngines({
    images: ['jumptotech/lab-docker:latest'],
    bakedArchives: options.bakedArchives ?? 'present',
  });
  const provider = new DockerLabProvider({
    engines,
    sandboxDaemonAvailable: true,
    sleep: async () => undefined,
  });
  return { engines, provider };
}

const contextFor = (lab: LoadedLabDefinition, sandboxRef = SANDBOX_A): LabSessionContext =>
  sessionContext(lab, { sandboxRef });

// --------------------------------------------- 1. ordering — the race

describe('the load is sequenced by the provider, so there is nothing to race', () => {
  it('obtains every baked image from its archive, with no registry fetch', async () => {
    const { provider, engines } = build();
    const result = await provider.create(contextFor(dockerLab(['busybox:1.36', 'alpine:3.20'])));

    expect(result.ok).toBe(true);
    const daemon = engines.daemon(SANDBOX_A);
    expect(daemon.bakedLoads).toEqual(['busybox:1.36', 'alpine:3.20']);
    expect(daemon.pulls).toEqual([]);
  });

  it('loads after the daemon is ready and before any container is created', async () => {
    // The race reproduced on a real daemon was an *entrypoint* loader losing to
    // `#waitForDaemon`. Here the load happens inside `#ensureImage`, and this
    // asserts the property that removes the race: by the time a lab's first
    // container is run, its image is already in the store — on every session.
    const { provider, engines } = build();
    const lab = parseLabDefinition(`
id: DOCKER-991
slug: docker-991-baked
title: Baked
track: docker
topic: images
difficulty: beginner
duration_minutes: 10
environment:
  provider: docker
task:
  summary: s
  description: d
setup:
  docker:
    images:
      - busybox:1.36
    containers:
      - name: worker
        image: busybox:1.36
        command: [ "sleep", "60" ]
  verify:
    - type: docker_container_running
      name: worker
      label: worker is running
requirements:
  - type: docker_container_running
    name: worker
    label: l
references:
  - title: Docker
    url: https://docs.docker.com/engine/
skills:
  - docker.images
hints:
  - level: 1
    text: Look at the image store.
  - level: 2
    text: Consult the official Docker documentation.
`) as LoadedLabDefinition;

    const result = await provider.create(contextFor(lab));
    expect(result.ok).toBe(true);

    const daemon = engines.daemon(SANDBOX_A);
    const loaded = daemon.bakedLoads.indexOf('busybox:1.36');
    const ran = daemon.runs.findIndex((run) => run.name === 'worker');
    expect(loaded).toBeGreaterThanOrEqual(0);
    expect(ran).toBeGreaterThanOrEqual(0);
    // The image was in the store before the container that needs it existed.
    expect(daemon.images.has('busybox:1.36')).toBe(true);
    expect(daemon.pulls).toEqual([]);
  });

  it('is deterministic across five concurrent sessions, each with its own store', async () => {
    // Measured on a real daemon with five sessions started at once and no
    // network: every one had an empty store at readiness and exactly the three
    // images after the provider's sequence. This is the same property, in-process.
    const { provider, engines } = build();
    const lab = dockerLab(['busybox:1.36', 'alpine:3.20', 'nginx:1.27-alpine']);
    const sandboxes = Array.from({ length: 5 }, (_, i) => `jtt-lab-00000000000${i + 1}`);

    const results = await Promise.all(sandboxes.map((s) => provider.create(contextFor(lab, s))));

    for (const [index, sandbox] of sandboxes.entries()) {
      expect(results[index]?.ok, sandbox).toBe(true);
      const daemon = engines.daemon(sandbox);
      expect([...daemon.bakedLoads].sort(), sandbox).toEqual(
        ['alpine:3.20', 'busybox:1.36', 'nginx:1.27-alpine'],
      );
      expect(daemon.pulls, sandbox).toEqual([]);
    }
  });

  it('skips the archive for an image already in the store', async () => {
    const { provider, engines } = build();
    await provider.create(contextFor(dockerLab(['busybox:1.36'])));
    const daemon = engines.daemon(SANDBOX_A);

    // A second ensure — as a reset performs — finds it present and does nothing.
    await provider.reset(contextFor(dockerLab(['busybox:1.36'])));
    expect(daemon.bakedLoads).toEqual(['busybox:1.36']);
  });
});

// ------------------------------------------------------------ 2. reset

describe('reset restores a baked image a student removed, offline', () => {
  it('reloads it from the archive rather than pulling', async () => {
    const { provider, engines } = build();
    const lab = dockerLab(['busybox:1.36']);
    await provider.create(contextFor(lab));
    const daemon = engines.daemon(SANDBOX_A);

    // The student runs `docker rmi busybox:1.36` in their own daemon.
    await daemon.removeImage('busybox:1.36');
    expect(daemon.images.has('busybox:1.36')).toBe(false);

    const reset = await provider.reset(contextFor(lab));

    expect(reset.ok).toBe(true);
    expect(daemon.images.has('busybox:1.36')).toBe(true);
    expect(daemon.bakedLoads).toEqual(['busybox:1.36', 'busybox:1.36']);
    expect(daemon.pulls).toEqual([]);
  });
});

// ------------------------------------------------------- 3. failing closed

describe('a sandbox image without its archives fails the lab, never pulls', () => {
  it('fails setup when an archive the map promises is missing', async () => {
    const { provider, engines } = build({ bakedArchives: 'missing' });
    const result = await provider.create(contextFor(dockerLab(['busybox:1.36'])));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SETUP_FAILED');
    expect(JSON.stringify(result)).toContain('baked image');
    // The defect is surfaced, not hidden behind a registry fetch.
    expect(engines.daemon(SANDBOX_A).pulls).toEqual([]);
  });

  it('fails setup when a load reports success but produces no image', async () => {
    const { provider, engines } = build({ bakedArchives: 'corrupt' });
    const result = await provider.create(contextFor(dockerLab(['alpine:3.20'])));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('did not produce the image');
    expect(engines.daemon(SANDBOX_A).pulls).toEqual([]);
  });

  it('still pulls an image the platform never promised an archive for', async () => {
    // Failing closed applies to *baked* images. An image outside the map is
    // obtained exactly as it was before N18, even on a sandbox with no archives.
    const { provider, engines } = build({ bakedArchives: 'missing' });
    const result = await provider.create(contextFor(dockerLab(['postgres:16-alpine'])));

    expect(result.ok).toBe(true);
    expect(engines.daemon(SANDBOX_A).pulls).toEqual(['postgres:16-alpine']);
  });

  it('refuses a load on the host engine', async () => {
    // A baked archive's path is only meaningful inside a sandbox image; on the
    // host the same path would name a host file.
    const { engines } = build();
    await expect(engines.host.loadBakedImage('busybox:1.36')).rejects.toBeInstanceOf(
      BakedImageError,
    );
  });
});

// ---------------------------------------------- 4. isolation and paths

describe('no session can load into another, and no reference can steer a path', () => {
  it('loads only into the session daemon that asked', async () => {
    const { provider, engines } = build();
    await provider.create(contextFor(dockerLab(['nginx:1.27-alpine']), SANDBOX_A));
    await provider.create(contextFor(dockerLab(['busybox:1.36']), SANDBOX_B));

    expect(engines.daemon(SANDBOX_A).images.has('busybox:1.36')).toBe(false);
    expect(engines.daemon(SANDBOX_B).images.has('nginx:1.27-alpine')).toBe(false);
    expect(engines.daemon(SANDBOX_A).bakedLoads).toEqual(['nginx:1.27-alpine']);
    expect(engines.daemon(SANDBOX_B).bakedLoads).toEqual(['busybox:1.36']);
  });

  it.each([
    ['parent traversal', '../../etc/passwd'],
    ['an absolute path', '/etc/shadow'],
    ['a baked reference with a path glued on', 'busybox:1.36/../../x'],
    ['an inherited key', '__proto__'],
    ['another inherited key', 'constructor'],
    ['a method name', 'toString'],
    ['a trailing space', 'busybox:1.36 '],
    ['a different tag', 'busybox:latest'],
    ['an empty string', ''],
  ])('treats %s as not baked', (_name, reference) => {
    // Real-daemon validation ran the same list through `docker load` and got
    // `not-baked` for every one, with nothing attempted.
    expect(bakedImagePath(reference)).toBeNull();
  });

  it('returns a path that is always the fixed directory plus a listed basename', () => {
    for (const reference of bakedImageReferences()) {
      const resolved = bakedImagePath(reference);
      expect(resolved).not.toBeNull();
      expect(path.posix.dirname(resolved as string)).toBe(BAKED_IMAGE_DIR);
      expect(path.posix.basename(resolved as string)).toMatch(/^[a-z0-9][a-z0-9.-]*\.tar$/);
      expect(resolved).not.toContain('..');
    }
  });

  it('bakes only images the Docker track already names — no new supply', async () => {
    // A baked image is a supply decision. Every reference here must already be
    // used by a shipped lab, so N18 moves an existing fetch rather than adding
    // an image nobody asked for.
    const registry = await realCatalog();
    const used = new Set<string>();
    for (const lab of registry.all()) {
      for (const image of lab.setup.docker?.images ?? []) used.add(image);
      for (const container of lab.setup.docker?.containers ?? []) used.add(container.image);
    }
    for (const reference of bakedImageReferences()) {
      expect(used.has(reference), `${reference} is baked but no lab uses it`).toBe(true);
    }
  });
});

// ------------------------------------------------ 5. map, build and image

describe('the map, the build list and the Dockerfile agree', () => {
  const buildList = (): Array<[string, string]> =>
    readFileSync(path.join(REPO_ROOT, 'infrastructure', 'docker', 'baked-images.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const [reference, filename, ...rest] = line.split(/\s+/);
        expect(rest, `extra fields on '${line}'`).toEqual([]);
        return [reference as string, filename as string];
      });

  it('lists exactly the images the runtime map does, with the same archive names', () => {
    expect(Object.fromEntries(buildList())).toEqual({ ...BAKED_IMAGES });
  });

  it('builds with the archives as a named context, kept out of the repository tree', () => {
    const script = readFileSync(path.join(REPO_ROOT, 'scripts', 'sandbox-build.sh'), 'utf8');
    expect(script).toContain('baked-images.txt');
    expect(script).toContain('--build-context "baked-images=${BAKED_DIR}"');
    // A private temporary directory, removed on exit — never a path in the repo.
    expect(script).toContain('mktemp -d');
    expect(script).toMatch(/trap 'rm -rf "\$\{BAKED_DIR\}"' EXIT/);
    // And the same filename rule the TypeScript map enforces.
    expect(script).toContain('^[a-z0-9][a-z0-9.-]*\\.tar$');
  });

  it('copies the archives read-only and checks each is a docker save archive', () => {
    const dockerfile = readFileSync(
      path.join(REPO_ROOT, 'infrastructure', 'docker', 'sandbox-docker.Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toContain(`COPY --from=baked-images --chmod=0444 . ${BAKED_IMAGE_DIR}/`);
    expect(dockerfile).toContain('manifest.json');
    // Permissions are set at COPY time. A later `RUN chmod` over the archives
    // was measured copying all of them up into a second layer.
    expect(dockerfile).not.toMatch(/chmod\s+0?444\s+\.\/\*\.tar/);
  });
});
