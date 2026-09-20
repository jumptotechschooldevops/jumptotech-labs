/**
 * A runtime image carries every dependency the services it ships import.
 *
 * npm does not hoist every dependency to the root of the tree. A workspace's
 * own dependency can be installed inside that workspace, and one is today:
 * the lockfile places `prom-client` — imported by
 * services/observability/src/metrics.ts — at
 * `services/observability/node_modules/prom-client`, not at the root. A fresh
 * resolve puts it there too, so this is npm's stable placement rather than a
 * stale lockfile.
 *
 * The multi-stage images install into a build stage and copy the result
 * forward with `COPY --from=build /app/node_modules ./node_modules`. That
 * copies the root of the tree and nothing else, so the nested install was left
 * behind and sandboxd exited on boot with
 *
 *     ERR_MODULE_NOT_FOUND: Cannot find package 'prom-client'
 *
 * It was invisible for as long as the host's own `node_modules` reached the
 * build context: `COPY services/observability services/observability` carried
 * the host's copy in, so the image ran on a host-built dependency it had never
 * installed. Excluding host build state from the context (release-engineering
 * audit) removed that accident and exposed the missing copy.
 *
 * Asserted from the lockfile and the Dockerfiles rather than by building an
 * image, so the check is a unit test: whichever dependency npm nests, and in
 * whichever workspace, the image that ships that workspace must carry it. If
 * npm later hoists everything, `nestedInstalls` is empty and there is nothing
 * to require — the test follows the lockfile instead of naming a package.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

interface Lockfile {
  packages?: Record<string, unknown>;
}

/**
 * Workspace directory → the dependencies npm installs *inside* it.
 *
 * Lockfile keys are install paths: `node_modules/ws` is the hoisted root,
 * `services/observability/node_modules/prom-client` is a nested install.
 */
function nestedInstalls(): Map<string, string[]> {
  const lock = JSON.parse(read('package-lock.json')) as Lockfile;
  const nested = new Map<string, string[]>();
  for (const installPath of Object.keys(lock.packages ?? {})) {
    if (installPath.startsWith('node_modules/')) continue; // the hoisted root
    const split = installPath.indexOf('/node_modules/');
    if (split < 0) continue; // the workspace's own entry
    const workspace = installPath.slice(0, split);
    const dependency = installPath.slice(split + '/node_modules/'.length);
    if (dependency.includes('/node_modules/')) continue; // deeper still; the top copy covers it
    nested.set(workspace, [...(nested.get(workspace) ?? []), dependency]);
  }
  return nested;
}

interface Dockerfile {
  name: string;
  lines: string[];
  /** Copies the installed root forward from an earlier stage. */
  installsInAnEarlierStage: boolean;
  /** Workspaces whose source the final image carries. */
  ships: string[];
  /** Workspaces whose nested `node_modules` it copies from a stage. */
  carriesNested: string[];
}

function dockerfiles(): Dockerfile[] {
  const dir = path.join(REPO_ROOT, 'infrastructure/docker');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.Dockerfile'))
    .sort()
    .map((name) => {
      const lines = readFileSync(path.join(dir, name), 'utf8').split('\n');
      const ships: string[] = [];
      const carriesNested: string[] = [];
      let installsInAnEarlierStage = false;
      for (const line of lines) {
        if (/^\s*COPY\s+--from=\S+\s+\/app\/node_modules\b/.test(line)) installsInAnEarlierStage = true;
        const nested = /^\s*COPY\s+--from=\S+\s+\/app\/((?:apps|services|test-support|e2e)[^\s]*?)\/node_modules\b/.exec(line);
        if (nested) carriesNested.push(nested[1]!);
        // `COPY services/observability services/observability` — a whole workspace's source.
        const source = /^\s*COPY\s+((?:apps|services)\/[\w-]+)\s+\1\s*$/.exec(line.trimEnd());
        if (source) ships.push(source[1]!);
      }
      return { name, lines, installsInAnEarlierStage, ships, carriesNested };
    });
}

describe('npm workspace installs', () => {
  it('still nest at least one dependency, which is what these images must carry', () => {
    // Not a requirement, a premise: if npm ever hoists everything this test
    // stops proving anything, and the message below says so out loud.
    const nested = nestedInstalls();
    expect(
      nested.size,
      'npm now hoists every dependency — the nested-install copies in the Dockerfiles are dead weight and can go',
    ).toBeGreaterThan(0);
  });

  it('place prom-client inside services/observability, not at the root', () => {
    // The specific case that broke sandboxd, pinned so a lockfile change is seen.
    expect(nestedInstalls().get('services/observability')).toContain('prom-client');
  });
});

describe('every runtime image', () => {
  const nested = nestedInstalls();

  it('copies the nested installs of every workspace it ships', () => {
    const missing: string[] = [];
    for (const image of dockerfiles()) {
      // An image that runs `npm ci` in its final stage already has them in place.
      if (!image.installsInAnEarlierStage) continue;
      for (const workspace of image.ships) {
        if (!nested.has(workspace)) continue;
        if (!image.carriesNested.includes(workspace)) {
          missing.push(
            `${image.name}: ships ${workspace} but never copies ${workspace}/node_modules ` +
              `(npm nests ${nested.get(workspace)!.join(', ')} there)`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('copies a nested install from a build stage, never from the host context', () => {
    // The host's node_modules is excluded from every build context, so a COPY
    // of one without `--from` would fail the build rather than ship host state.
    for (const image of dockerfiles()) {
      for (const line of image.lines) {
        if (!/^\s*(COPY|ADD)\s/.test(line) || !/node_modules/.test(line)) continue;
        expect(line, image.name).toMatch(/--from=/);
      }
    }
  });

  it('is proven to need the copy: sandboxd and terminal ship observability', () => {
    // Guards the test above against quietly matching nothing.
    const shipping = dockerfiles()
      .filter((image) => image.installsInAnEarlierStage && image.ships.includes('services/observability'))
      .map((image) => image.name);
    expect(shipping).toContain('sandboxd.Dockerfile');
    expect(shipping).toContain('terminal.Dockerfile');
  });
});
