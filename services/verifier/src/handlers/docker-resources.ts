/**
 * Image, volume, and network checks, plus the Docker `absent` case.
 *
 * `docker_image_config` deserves a note: it grades a Dockerfile by reading the
 * image the student *built*, not the text they wrote. A student who reaches the
 * same result with a different base image, a different instruction order, or an
 * ENTRYPOINT instead of a CMD is graded on what they produced — which is the
 * same principle that makes the Kubernetes verifier accept a manifest, an
 * imperative command, or a script equally.
 */
import type { DockerVerifierHandler } from '../contract.js';
import { fail, missingDocker, pass } from '../contract.js';
import { imageMatches } from '../image.js';

/** Render an argv the way a Dockerfile would, for a readable detail. */
const showArgv = (argv: readonly string[]): string =>
  argv.length === 0 ? '(none)' : `[${argv.map((a) => JSON.stringify(a)).join(', ')}]`;

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const dockerImageExists: DockerVerifierHandler<'docker_image_exists'> = {
  type: 'docker_image_exists',
  label: (r) => `Image ${r.image} exists`,
  async run(r, reader) {
    const image = await reader.image(r.image);
    if (!image) return missingDocker('image', r.image);
    return pass(image.tags.length > 0 ? `tags: ${image.tags.join(', ')}` : undefined);
  },
};

export const dockerImageConfig: DockerVerifierHandler<'docker_image_config'> = {
  type: 'docker_image_config',
  label: (r) => `Image ${r.image} is configured correctly`,
  async run(r, reader) {
    const image = await reader.image(r.image);
    if (!image) return missingDocker('image', r.image);
    const problems: string[] = [];

    if (r.working_dir !== undefined && image.workingDir !== r.working_dir) {
      problems.push(
        `working directory is '${image.workingDir || '/'}', expected '${r.working_dir}'`,
      );
    }

    if (r.cmd_contains !== undefined) {
      // CMD and ENTRYPOINT combine into what the container actually runs, so
      // both forms of writing the same startup command are accepted.
      const argv = [...image.entrypoint, ...image.cmd];
      const missing = r.cmd_contains.filter((token) => !argv.includes(token));
      if (missing.length > 0) {
        problems.push(
          `start command is [${argv.join(' ')}], which is missing ${missing.map((m) => `'${m}'`).join(', ')}`,
        );
      }
    }

    // Exact, and separately: the point of asserting these rather than
    // `cmd_contains` is to show which half a value came from, and to tell exec
    // form from shell form.
    if (r.entrypoint !== undefined && !sameArgv(image.entrypoint, r.entrypoint)) {
      problems.push(`ENTRYPOINT is ${showArgv(image.entrypoint)}`);
    }
    if (r.cmd !== undefined && !sameArgv(image.cmd, r.cmd)) {
      problems.push(`CMD is ${showArgv(image.cmd)}`);
    }

    for (const [key, value] of Object.entries(r.env ?? {})) {
      const actual = image.env[key];
      if (actual === undefined) problems.push(`no ENV '${key}'`);
      else if (actual !== value) problems.push(`ENV ${key}='${actual}', expected '${value}'`);
    }

    if (r.exposed_port !== undefined) {
      const exposed = image.exposedPorts.map((p) => Number.parseInt(p, 10));
      if (!exposed.includes(r.exposed_port)) {
        problems.push(
          exposed.length === 0
            ? `no ports are exposed, expected ${r.exposed_port}`
            : `exposed ports are ${image.exposedPorts.join(', ')}, expected ${r.exposed_port}`,
        );
      }
    }

    for (const [key, value] of Object.entries(r.labels ?? {})) {
      const actual = image.labels[key];
      if (actual === undefined) problems.push(`no LABEL '${key}'`);
      else if (actual !== value) problems.push(`LABEL ${key}='${actual}', expected '${value}'`);
    }

    return problems.length === 0 ? pass() : fail(`Image '${r.image}': ${problems.join('; ')}`);
  },
};

/**
 * How many leading layers two images share, in order.
 *
 * Stops at the first difference, which is what makes it a *prefix*: an image
 * that inserted a layer early shares only what came before the insertion, even
 * if every later digest also appears in the other image.
 */
function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * Did a rebuild preserve the layers before the one that changed?
 *
 * This is the only check in the Docker family that reads two images, and it is
 * the only way to observe the build cache: cache reuse is a property of a
 * rebuild, not of an image. The digests come from the daemon's `RootFS.Layers`
 * — immutable content identifiers the student cannot author.
 *
 * Failure detail describes the property and reports counts. It never prints a
 * digest: a layer digest is not information a student can act on, and dumping
 * image metadata into a check result is how internal detail leaks to a browser.
 */
export const dockerImageLayers: DockerVerifierHandler<'docker_image_layers'> = {
  type: 'docker_image_layers',
  label: (r) => `Image ${r.image} reuses the layers it should from ${r.shares_prefix_with}`,
  async run(r, reader) {
    const after = await reader.image(r.image);
    if (!after) return missingDocker('image', r.image);
    const before = await reader.image(r.shares_prefix_with);
    if (!before) return missingDocker('image', r.shares_prefix_with);

    // A daemon that reports no layers cannot answer the question. Saying so is
    // honest; treating it as "nothing was shared" would fail a student for a
    // reading the platform could not take.
    if (after.layers.length === 0 || before.layers.length === 0) {
      return fail(
        `Could not read the filesystem layers of ${after.layers.length === 0 ? r.image : r.shares_prefix_with}, so cache reuse cannot be established`,
      );
    }

    if (r.must_differ && after.id === before.id) {
      return fail(
        `'${r.image}' and '${r.shares_prefix_with}' are the same image — a rebuild that changed nothing does not show anything was cached`,
      );
    }

    const shared = sharedPrefixLength(before.layers, after.layers);
    const changed = after.layers.length - shared;

    if (r.minimum_shared_prefix !== undefined && shared < r.minimum_shared_prefix) {
      return fail(
        `'${r.image}' shares only ${shared} leading layer${shared === 1 ? '' : 's'} with '${r.shares_prefix_with}', so the earlier build steps were not reused`,
      );
    }

    if (r.maximum_changed_suffix !== undefined && changed > r.maximum_changed_suffix) {
      return fail(
        `rebuilding changed the last ${changed} layers of '${r.image}', not at most ${r.maximum_changed_suffix} — the steps before the change were rebuilt instead of reused`,
      );
    }

    return pass(`${shared} of ${after.layers.length} layers reused`);
  },
};

export const dockerVolumeExists: DockerVerifierHandler<'docker_volume_exists'> = {
  type: 'docker_volume_exists',
  label: (r) => `Volume ${r.name} exists`,
  async run(r, reader) {
    const volume = await reader.volume(r.name);
    return volume ? pass(`driver: ${volume.driver}`) : missingDocker('volume', r.name);
  },
};

export const dockerNetworkExists: DockerVerifierHandler<'docker_network_exists'> = {
  type: 'docker_network_exists',
  label: (r) =>
    r.driver === undefined
      ? `Network ${r.name} exists`
      : `Network ${r.name} exists and uses the ${r.driver} driver`,
  async run(r, reader) {
    const network = await reader.network(r.name);
    if (!network) return missingDocker('network', r.name);
    if (r.driver !== undefined && network.driver !== r.driver) {
      return fail(`Network '${r.name}' uses the ${network.driver} driver, expected ${r.driver}`);
    }
    return pass(`driver: ${network.driver}`);
  },
};

/** How each Docker kind is read, and how it is named in student-facing text. */
const DOCKER_LOOKUPS = {
  container: { title: 'Container', read: read('container') },
  image: { title: 'Image', read: read('image') },
  volume: { title: 'Volume', read: read('volume') },
  network: { title: 'Network', read: read('network') },
} as const;

function read(kind: 'container' | 'image' | 'volume' | 'network') {
  return async (
    reader: Parameters<DockerVerifierHandler<'docker_resource_absent'>['run']>[1],
    name: string,
  ): Promise<unknown | null> => {
    switch (kind) {
      case 'container':
        return reader.container(name);
      case 'image':
        return reader.image(name);
      case 'volume':
        return reader.volume(name);
      case 'network':
        return reader.network(name);
    }
  };
}

export const dockerResourceAbsent: DockerVerifierHandler<'docker_resource_absent'> = {
  type: 'docker_resource_absent',
  label: (r) => `${DOCKER_LOOKUPS[r.kind].title} ${r.name} no longer exists`,
  async run(r, reader) {
    const lookup = DOCKER_LOOKUPS[r.kind];
    const found = await lookup.read(reader, r.name);
    return found === null
      ? pass()
      : fail(`${lookup.title} '${r.name}' still exists in sandbox '${reader.namespace}'`);
  },
};

/** Re-exported so the image lab can reuse the shared normalisation rules. */
export { imageMatches };
