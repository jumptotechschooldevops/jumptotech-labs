/**
 * `docker_image_layers`, and the DOCKER-013 contract built on it.
 *
 * This is the only Docker check that reads two images, and it exists because
 * build-cache behaviour is not a property of an image. Cache reuse only shows
 * up in the relationship between what was built before a change and what was
 * built after it, so the check compares the daemon's ordered `RootFS.Layers`
 * digests for a pair.
 *
 * Layer *count* was measured against a real daemon and rejected. With only the
 * application source changed between builds:
 *
 *     cache-friendly ordering   5 layers   1 trailing layer changed
 *     cache-hostile ordering    4 layers   2 trailing layers changed
 *
 * The hostile Dockerfile has fewer layers, so a `max_layers` check would have
 * passed it. Counting is not a weak proxy for this skill — it points the wrong
 * way. These tests pin the comparison that does work.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryWorkspace,
  LabRegistry,
  requirementSchema,
  type LoadedLabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerDaemon, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { DockerVerifyReader, verifyLab, verifyRequirement } from '../src/index.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const SANDBOX_A = 'jtt-lab-00000000000a';
const SANDBOX_B = 'jtt-lab-00000000000b';
const SESSION_A = 'sess-000000000000000a';

let lab: LoadedLabDefinition;

beforeAll(async () => {
  const registry = await realCatalog();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('DOCKER-013');
});

const check = (docker: FakeDockerDaemon, requirement: Requirement, sandbox = SANDBOX_A) =>
  verifyRequirement(requirement, new DockerVerifyReader(docker, sandbox));
const passed = (result: { status: string }) => result.status === 'pass';

/**
 * Layer digests measured from real builds, rounded to their shape.
 *
 * base + workdir + manifest COPY + dependency RUN + source COPY.
 */
const BASE = ['sha256:aa', 'sha256:bb', 'sha256:cc', 'sha256:dd'];
const FRIENDLY_BEFORE = [...BASE, 'sha256:src-v1'];
const FRIENDLY_AFTER = [...BASE, 'sha256:src-v2'];
/** Hostile: the copy of everything sits below the dependency step. */
const HOSTILE_BEFORE = ['sha256:aa', 'sha256:bb', 'sha256:all-v1', 'sha256:deps-1'];
const HOSTILE_AFTER = ['sha256:aa', 'sha256:bb', 'sha256:all-v2', 'sha256:deps-2'];

function daemonWith(pairs: Record<string, string[]>) {
  const docker = new FakeDockerDaemon();
  for (const [tag, layers] of Object.entries(pairs)) docker.addImage(tag, { layers });
  return docker;
}

const layersCheck = (extra: Record<string, unknown> = {}) =>
  ({
    type: 'docker_image_layers',
    image: 'app:after',
    shares_prefix_with: 'app:before',
    maximum_changed_suffix: 1,
    must_differ: true,
    ...extra,
  }) as Requirement;

// --------------------------------------------------------- prefix semantics

describe('docker_image_layers — a prefix is a prefix', () => {
  it('shares the leading run up to the first difference', async () => {
    // [A,B,C,D] vs [A,B,C,E] -> three shared, one changed.
    const docker = daemonWith({ 'app:before': FRIENDLY_BEFORE, 'app:after': FRIENDLY_AFTER });
    const result = await check(docker, layersCheck({ minimum_shared_prefix: 4 }));
    expect(passed(result)).toBe(true);
    expect(result.detail).toContain('4 of 5 layers reused');
  });

  it('stops at the first difference, so an early insertion shares almost nothing', async () => {
    // [A,B,C] vs [A,X,B,C] must NOT count as three shared. Order matters, and
    // the run ends at index 1.
    const docker = daemonWith({
      'app:before': ['sha256:A', 'sha256:B', 'sha256:C'],
      'app:after': ['sha256:A', 'sha256:X', 'sha256:B', 'sha256:C'],
    });
    const result = await check(docker, layersCheck({ minimum_shared_prefix: 2 }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('shares only 1 leading layer');
  });

  it('treats the same layers in a different order as not shared', async () => {
    const docker = daemonWith({
      'app:before': ['sha256:A', 'sha256:B', 'sha256:C'],
      'app:after': ['sha256:C', 'sha256:B', 'sha256:A'],
    });
    expect(passed(await check(docker, layersCheck({ minimum_shared_prefix: 1 })))).toBe(false);
  });

  it('fails when nothing at all is shared', async () => {
    const docker = daemonWith({
      'app:before': ['sha256:A', 'sha256:B'],
      'app:after': ['sha256:Y', 'sha256:Z'],
    });
    const result = await check(docker, layersCheck({ minimum_shared_prefix: 1 }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('shares only 0 leading layers');
  });

  it('accepts identical arrays when the images are allowed to be the same', async () => {
    const docker = daemonWith({ 'app:before': FRIENDLY_BEFORE, 'app:after': FRIENDLY_BEFORE });
    expect(
      passed(await check(docker, layersCheck({ must_differ: false, minimum_shared_prefix: 5 }))),
    ).toBe(true);
  });
});

// ------------------------------------------------------- cache-friendly vs not

describe('docker_image_layers — friendly and hostile orderings separate cleanly', () => {
  it('PASSES the cache-friendly rebuild: only the source layer changed', async () => {
    const docker = daemonWith({ 'app:before': FRIENDLY_BEFORE, 'app:after': FRIENDLY_AFTER });
    expect(passed(await check(docker, layersCheck()))).toBe(true);
  });

  it('FAILS the cache-hostile rebuild, which a layer count would have passed', async () => {
    // Note the hostile image has FEWER layers than the friendly one — this is
    // exactly why `max_layers` was rejected as a grading requirement.
    expect(HOSTILE_AFTER.length).toBeLessThan(FRIENDLY_AFTER.length);

    const docker = daemonWith({ 'app:before': HOSTILE_BEFORE, 'app:after': HOSTILE_AFTER });
    const result = await check(docker, layersCheck());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('changed the last 2 layers');
    expect(result.detail).toContain('rebuilt instead of reused');
  });

  it('FAILS a dependency change, because the dependency layer should be invalidated', async () => {
    // Editing requirements.txt legitimately rebuilds the install step and
    // everything after it. Measured on a real daemon: 3 trailing layers change.
    const dependencyChanged = [...BASE.slice(0, 2), 'sha256:deps-v2', 'sha256:install-v2', 'sha256:src-v1'];
    const docker = daemonWith({ 'app:before': FRIENDLY_BEFORE, 'app:after': dependencyChanged });

    const result = await check(docker, layersCheck());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('changed the last 3 layers');
  });

  it('FAILS two identical images, because a rebuild that changed nothing proves nothing', async () => {
    const docker = new FakeDockerDaemon();
    const image = docker.addImage('app:before', { layers: FRIENDLY_BEFORE });
    // Same image, second tag — exactly what `docker tag` produces.
    docker.images.set('app:after', image);

    const result = await check(docker, layersCheck());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('are the same image');
  });
});

// ------------------------------------------------------------- failing safely

describe('docker_image_layers — fails safely', () => {
  it('reports a missing target image', async () => {
    const docker = daemonWith({ 'app:before': FRIENDLY_BEFORE });
    const result = await check(docker, layersCheck());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain("No image named 'app:after'");
  });

  it('reports a missing comparison image', async () => {
    const docker = daemonWith({ 'app:after': FRIENDLY_AFTER });
    const result = await check(docker, layersCheck());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain("No image named 'app:before'");
  });

  it('says so when the daemon reports no layers, rather than failing the student', async () => {
    const docker = daemonWith({ 'app:before': FRIENDLY_BEFORE, 'app:after': [] });
    const result = await check(docker, layersCheck());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Could not read the filesystem layers');
    expect(result.detail).toContain('cache reuse cannot be established');
  });

  it('never puts a layer digest in the result', async () => {
    const docker = daemonWith({ 'app:before': HOSTILE_BEFORE, 'app:after': HOSTILE_AFTER });
    const result = await check(docker, layersCheck());
    const body = JSON.stringify(result);
    for (const digest of [...HOSTILE_BEFORE, ...HOSTILE_AFTER]) {
      expect(body).not.toContain(digest);
    }
  });

  it('rejects a schema that constrains nothing, or compares an image to itself', () => {
    const base = { type: 'docker_image_layers', image: 'a:1', shares_prefix_with: 'b:1' };
    expect(requirementSchema.safeParse(base).success).toBe(false);
    expect(requirementSchema.safeParse({ ...base, maximum_changed_suffix: 1 }).success).toBe(true);
    expect(
      requirementSchema.safeParse({
        type: 'docker_image_layers',
        image: 'a:1',
        shares_prefix_with: 'a:1',
        maximum_changed_suffix: 1,
      }).success,
    ).toBe(false);
    // And no field can carry anything executable.
    expect(
      requirementSchema.safeParse({ ...base, maximum_changed_suffix: 1, command: 'docker build' })
        .success,
    ).toBe(false);
  });
});

// --------------------------------------------------------- the lab contract

describe('DOCKER-013 — the lab', () => {
  const GREETER_BEFORE = [...BASE, 'sha256:greeter-src-v1'];
  const GREETER_AFTER = [...BASE, 'sha256:greeter-src-v2'];

  function build(overrides: {
    before?: string[];
    after?: string[];
    sameImage?: boolean;
    containerImage?: string;
    exitCode?: number;
    dockerfile?: string;
    files?: Record<string, string>;
  } = {}) {
    const docker = new FakeDockerDaemon();
    const port = new InMemoryWorkspace();
    const before = docker.addImage('jumptotech/greeter:1.0', {
      layers: overrides.before ?? GREETER_BEFORE,
    });
    if (overrides.sameImage) docker.images.set('jumptotech/greeter:1.1', before);
    else docker.addImage('jumptotech/greeter:1.1', { layers: overrides.after ?? GREETER_AFTER });

    docker.addContainer(
      containerSpec({ name: 'greeter', image: overrides.containerImage ?? 'jumptotech/greeter:1.1' }),
      'exited',
      overrides.exitCode ?? 0,
    );
    port.write(
      SESSION_A,
      'Dockerfile',
      overrides.dockerfile ??
        'FROM alpine:3.20\nWORKDIR /app\nCOPY requirements.txt /app/\nRUN sort /app/requirements.txt > /app/.installed\nCOPY src /app/src\nCMD ["/bin/sh", "/app/src/greeter.sh"]\n',
    );
    for (const [name, content] of Object.entries(overrides.files ?? {})) port.write(SESSION_A, name, content);
    return { docker, workspace: { port, sessionId: SESSION_A } };
  }

  const verify = (built: ReturnType<typeof build>, sandbox = SANDBOX_A) =>
    verifyLab({ lab, namespace: sandbox, docker: built.docker, workspace: built.workspace });
  const failing = (r: Awaited<ReturnType<typeof verify>>) =>
    r.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  it('passes a correct source-only rebuild', async () => {
    const result = await verify(build());
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails an untouched environment', async () => {
    const result = await verifyLab({
      lab,
      namespace: SANDBOX_A,
      docker: new FakeDockerDaemon(),
      workspace: { port: new InMemoryWorkspace(), sessionId: SESSION_A },
    });
    expect(result.passed).toBe(false);
    expect(failing(result)).toHaveLength(result.checks.length);
  });

  // ------------------------------------------------------------ adversarial

  it('fails the cache-hostile ordering', async () => {
    const result = await verify(build({ before: HOSTILE_BEFORE, after: HOSTILE_AFTER }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['The source-only rebuild reused the dependency layers']);
  });

  it('fails when the same image is tagged twice instead of rebuilt', async () => {
    const result = await verify(build({ sameImage: true }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('The source-only rebuild reused the dependency layers');
  });

  it('fails when the dependency manifest was changed instead of the source', async () => {
    const result = await verify(build({ after: [...BASE.slice(0, 2), 'sha256:d2', 'sha256:i2', 'sha256:s1'] }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('The source-only rebuild reused the dependency layers');
  });

  it('fake evidence files change nothing', async () => {
    // Copied `docker history` output, a claimed layer list, a hand-written hash.
    const cheating = build({
      before: HOSTILE_BEFORE,
      after: HOSTILE_AFTER,
      files: {
        'layers.json': JSON.stringify({ shared: 4, layers: GREETER_BEFORE }),
        'history.txt': 'CACHED  COPY requirements.txt /app/\nCACHED  RUN sort ...',
        'proof.txt': 'sha256:aa sha256:bb sha256:cc sha256:dd',
      },
    });
    const result = await verify(cheating);
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('The source-only rebuild reused the dependency layers');
  });

  it('a no-op RUN cannot manufacture a shared prefix', async () => {
    // Padding the image with cheap layers does not change *where* the first
    // difference falls, which is the only thing the check reads.
    const padded = ['sha256:aa', 'sha256:noop1', 'sha256:noop2', 'sha256:all-v2', 'sha256:deps-2'];
    const result = await verify(build({ before: HOSTILE_BEFORE, after: padded }));
    expect(result.passed).toBe(false);
  });

  it('the right layers with the wrong container does not pass', async () => {
    // Built correctly, then ran the stale image.
    const result = await verify(build({ containerImage: 'jumptotech/greeter:1.0' }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['Container greeter runs the rebuilt image']);
  });

  it('an image that no longer runs does not pass', async () => {
    const result = await verify(build({ exitCode: 1 }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['The rebuilt image still runs successfully']);
  });

  it('a Dockerfile that no longer builds the service does not pass', async () => {
    const result = await verify(build({ dockerfile: 'FROM alpine:3.20\nCMD ["true"]\n' }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('The Dockerfile still builds the service on alpine:3.20');
  });

  it('is graded against the session that did the work, and no other', async () => {
    expect((await verify(build(), SANDBOX_B)).passed).toBe(true);

    const other = await verifyLab({
      lab,
      namespace: SANDBOX_A,
      docker: new FakeDockerDaemon(),
      workspace: { port: new InMemoryWorkspace(), sessionId: 'sess-000000000000000b' },
    });
    expect(other.passed).toBe(false);
  });

  it('does not grade a layer count anywhere', () => {
    for (const requirement of lab.requirements as readonly Requirement[]) {
      expect(Object.keys(requirement)).not.toContain('max_layers');
    }
    const layerChecks = (lab.requirements as readonly Requirement[]).filter(
      (r) => r.type === 'docker_image_layers',
    );
    expect(layerChecks).toHaveLength(1);
    expect(layerChecks[0]).toHaveProperty('maximum_changed_suffix');
    expect(layerChecks[0]).toHaveProperty('must_differ', true);
  });

  it('removes both built images on reset, so a stale pass cannot linger', () => {
    expect(lab.reset.docker?.images).toBe(true);
    expect(lab.reset.docker?.containers).toBe(true);
    expect(lab.reset.docker?.workspace).toBe(true);
  });
});
