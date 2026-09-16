/**
 * Baked images — capability **N18**, and the one place a baked archive's path
 * is known.
 *
 * A Docker lab declares its images in `setup.docker.images`, and until N18 the
 * provider obtained each one with a registry pull from inside the sandbox, at
 * the moment a student clicked Start. N18 ships the archives for the images the
 * whole Docker track uses *inside the sandbox image*, and loads the one a lab
 * needs into the session's daemon with no network fetch.
 *
 * The full investigation — including the two designs that were measured and
 * rejected, and the race that decided this one — is in
 * `docs/development/n18-design.md`.
 *
 * ## Why this is a closed map
 *
 * A lab never names a path. It names an image reference, which it already did,
 * and the archive's location is *looked up* here. There is no field anywhere in
 * a lab definition, the broker protocol or sandboxd's payload that carries a
 * filesystem path, so there is nothing to traverse and nothing to point at a
 * file the platform did not put there. A reference outside this map simply has
 * no baked copy, and is obtained exactly as it always was.
 *
 * ## Keeping the map, the build and the image in step
 *
 * Four things must agree: this map; `infrastructure/docker/baked-images.txt`,
 * which the build script reads (so a bash script never has to parse
 * TypeScript); `scripts/sandbox-build.sh`, which `docker save`s each image; and
 * `infrastructure/docker/sandbox-docker.Dockerfile`, which copies the archives
 * in and checks every one. `docker-baked-images.test.ts` asserts the map and the
 * text file are identical, so adding an image is two edits a test will not let
 * drift apart.
 */

/** Where baked archives live inside the sandbox image. */
export const BAKED_IMAGE_DIR = '/opt/jumptotech/images';

/**
 * Every image the platform ships an archive for, by reference.
 *
 * These are the three images the Docker track's labs already use. Nothing here
 * is new supply: each is `docker save` output of a reference a lab already
 * names, produced by the operator's build rather than fetched at lab time.
 */
export const BAKED_IMAGES: Readonly<Record<string, string>> = Object.freeze({
  'busybox:1.36': 'busybox-1.36.tar',
  'alpine:3.20': 'alpine-3.20.tar',
  'nginx:1.27-alpine': 'nginx-1.27-alpine.tar',
});

/**
 * A baked archive's filename: a bare basename, lowercase, ending `.tar`.
 *
 * Asserted over every map entry at module load, so a mistake here is a startup
 * failure rather than a path that reaches `docker load`.
 */
const BAKED_FILENAME = /^[a-z0-9][a-z0-9.-]*\.tar$/;

for (const [reference, filename] of Object.entries(BAKED_IMAGES)) {
  if (!BAKED_FILENAME.test(filename)) {
    throw new Error(`baked image '${reference}' has an unsafe archive name '${filename}'`);
  }
}

export type BakedImageResult = 'loaded' | 'not-baked';

/**
 * The archive path for a reference, or `null` when the platform ships none.
 *
 * `Object.hasOwn` rather than `reference in BAKED_IMAGES`, so an inherited key
 * such as `constructor` or `__proto__` can never be mistaken for an entry.
 */
export function bakedImagePath(reference: string): string | null {
  if (typeof reference !== 'string' || !Object.hasOwn(BAKED_IMAGES, reference)) return null;
  const filename = BAKED_IMAGES[reference];
  if (filename === undefined) return null;
  return `${BAKED_IMAGE_DIR}/${filename}`;
}

/** The references the platform ships archives for, sorted, for the build script. */
export function bakedImageReferences(): string[] {
  return Object.keys(BAKED_IMAGES).sort();
}

export class BakedImageError extends Error {
  readonly code = 'BAKED_IMAGE_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'BakedImageError';
  }
}
