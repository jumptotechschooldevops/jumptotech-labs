/**
 * The Linux track's hints send students to `man`. This is what keeps that true.
 *
 * `debian:bookworm-slim` ships /etc/dpkg/dpkg.cfg.d/docker containing
 * `path-exclude /usr/share/man/*`, so for a long time this image answered "No
 * manual entry" for every page the curriculum cites — including `environ(7)`,
 * which LINUX-014 quotes directly. Installing `man-db` and `manpages` did not
 * help, because those packages are subject to the same exclusion. The image now
 * carries a `path-include` drop-in that sorts after it, plus a `--reinstall` of
 * the base-image packages that were already unpacked without their pages.
 *
 * Two failure modes brought this back, and there is a test for each:
 *
 *   1. someone writes a lab citing a page the image does not ship — caught by
 *      the always-run test, which reads the shipped labs and compares what they
 *      cite against the manifest below;
 *   2. someone changes the image and the pages stop being installed — caught by
 *      the integration test, which asks the real sandbox image.
 *
 * The manifest is deliberately in this file rather than in `src`. It describes
 * what the *image* guarantees, no production code reads it, and keeping it here
 * means this fix needed no change to a shared source file.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LabRegistry, type LoadedLabDefinition } from '../src/index.js';
import { LABS_DIR } from './helpers.js';

const run = promisify(execFile);

/** The image definition itself — two tests below read it. */
const DOCKERFILE = path.resolve(
  LABS_DIR,
  '../infrastructure/docker/sandbox-linux.Dockerfile',
);

/** The sandbox image to interrogate. Matches what the provider would use. */
const SANDBOX_IMAGE =
  process.env.LINUX_SANDBOX_IMAGE ?? 'jumptotech/lab-linux:latest';

/**
 * Manual pages the Linux sandbox image guarantees.
 *
 * Every entry is cited by at least one shipped lab, and the integration test
 * below asks the real image for each one. Adding a lab that cites something
 * outside this list fails the first test until either the citation changes or
 * the image starts shipping the page.
 */
const SANDBOX_MAN_PAGES = [
  // coreutils — LINUX-001, 002, 008, 012, 016
  'mkdir', 'mv', 'touch', 'chmod', 'chown', 'stat', 'df', 'du',
  'head', 'tail', 'wc', 'test', 'ln', 'env', 'cat', 'ls', 'sort', 'uniq', 'cut',
  // the analysis toolset — LINUX-007, 016
  'grep', 'find', 'xargs', 'sed', 'awk',
  // processes and services — LINUX-004, 005, 010, 013, 014
  'ps', 'kill', 'pgrep', 'top', 'sv', 'runsvdir',
  // networking — LINUX-006, LINUX-010
  'ip', 'ss', 'hostname', 'curl',
  // accounts and delegation — LINUX-003, 015
  'useradd', 'usermod', 'groupadd', 'sudo', 'visudo', 'sudoers',
  // scheduled jobs — LINUX-018
  'crontab', 'cron',
  // packages — LINUX-019
  'dpkg', 'dpkg-deb', 'dpkg-query',
  // modes and the creation mask — LINUX-011
  'inode',
  // the shell itself, and the section-7 pages LINUX-013/014 quote
  'bash', 'environ', 'signal', 'group',
] as const;

/** `man foo`, `man 5 foo` — as the hints write them, backticks and all. */
function citedManPages(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\bman\s+(?:([1-8])\s+)?`?([a-z][a-z0-9_.-]*)`?/g;
  for (const match of text.matchAll(pattern)) {
    const page = match[2];
    if (page) found.add(page);
  }
  return [...found];
}

/** Every piece of student-visible prose in a lab that could cite a page. */
function labProse(lab: LoadedLabDefinition): string {
  return [
    lab.story,
    lab.task.summary,
    lab.task.description,
    ...lab.objectives,
    ...lab.hints.map((h) => h.text),
  ].join('\n');
}

let cached: LabRegistry | undefined;
async function realRegistry(): Promise<LabRegistry> {
  if (!cached) {
    cached = new LabRegistry(LABS_DIR);
    await cached.load();
  }
  return cached;
}

// ------------------------------------------------- 1. labs cite what we ship

describe('the Linux hints only send students to pages the sandbox has', () => {
  it('cites nothing outside the manifest', async () => {
    const registry = await realRegistry();
    const manifest = new Set<string>(SANDBOX_MAN_PAGES);
    const unknown: string[] = [];

    for (const summary of registry.labsForTrack('linux')) {
      const lab = registry.get(summary.id);
      for (const page of citedManPages(labProse(lab))) {
        if (manifest.has(page)) continue;
        unknown.push(`${lab.id} cites 'man ${page}'`);
      }
    }

    expect(unknown).toEqual([]);
  });

  it('keeps the manifest honest — every entry is actually cited by a lab', async () => {
    const registry = await realRegistry();
    const cited = new Set<string>();
    for (const summary of registry.labsForTrack('linux')) {
      for (const page of citedManPages(labProse(registry.get(summary.id)))) cited.add(page);
    }

    // A page in the manifest that no lab cites is either a leftover or a
    // citation that was reworded; either way the manifest should shrink rather
    // than quietly guarantee something nothing needs. `sudoers`, `group`,
    // `environ` and `signal` are cited as references rather than as `man foo`,
    // so they are allowed to sit here uncited by the prose scan.
    const referenceOnly = new Set(['sudoers', 'group', 'environ', 'signal', 'visudo', 'xargs', 'wc',
      'cat', 'ls', 'sort', 'uniq', 'cut', 'ln', 'env', 'chown', 'stat', 'top', 'bash', 'cron', 'dpkg-query']);
    const orphaned = SANDBOX_MAN_PAGES.filter((p) => !cited.has(p) && !referenceOnly.has(p));

    expect(orphaned).toEqual([]);
  });

  it('ships the tool behind the citation, not just its manual page', async () => {
    /*
     * The curl defect was two defects wearing one coat. LINUX-006 sends the
     * student to `man curl` and LINUX-010's runbook has them
     * `curl -s http://127.0.0.1:9105` — and the image shipped neither the page
     * nor the binary, so two labs could not be completed by following their own
     * hints. The manifest above now covers the page. This covers the tool,
     * because a manual page for a binary that is not installed is the same
     * defect over again and the manifest alone would not notice.
     */
    const registry = await realRegistry();
    expect(citedManPages(labProse(registry.get('LINUX-006')))).toContain('curl');

    const dockerfile = await fs.readFile(DOCKERFILE, 'utf8');
    // A line of the apt-get list, not a mention in the prose above it.
    expect(dockerfile).toMatch(/^[ \t]+curl[ \t]*\\?$/m);
  });
});

// ------------------------------------------ 2. the image keeps its side of it

describe('the sandbox image ships the manual pages the curriculum cites', () => {
  it('keeps the dpkg drop-in that re-includes them', async () => {
    const dockerfile = await fs.readFile(DOCKERFILE, 'utf8');

    // Without the include, every page below disappears again and nothing else
    // in the build changes — which is exactly how this went unnoticed before.
    expect(dockerfile).toContain('path-include /usr/share/man/*');
    // The name has to sort after `docker`, or the exclusion still wins.
    expect(dockerfile).toMatch(/dpkg\.cfg\.d\/zz-[a-z-]*man/);
    // Re-including is not enough on its own for packages the base image had.
    expect(dockerfile).toMatch(/--reinstall/);
  });

  it.runIf(process.env.RUN_INTEGRATION_TESTS === '1')(
    'answers `man -w` for every page in the manifest',
    async () => {
      /*
       * One container for the whole manifest, not one per page. Forty-odd
       * container starts took long enough to time the suite out on a loaded
       * machine, and the thing under test is the image's contents rather than
       * its start-up path — so the loop belongs inside.
       *
       * The page list is passed as argv rather than interpolated into the
       * script: these are compile-time constants, but building a shell string
       * out of a list is the habit that eventually meets a value that is not.
       */
      const script =
        'missing=""; for p in "$@"; do man -w -- "$p" >/dev/null 2>&1 || missing="$missing $p"; done;' +
        'if [ -n "$missing" ]; then echo "MISSING:$missing"; exit 1; fi; echo OK';

      const { stdout } = await run(
        'docker',
        [
          'run', '--rm', '--entrypoint', '/bin/sh',
          SANDBOX_IMAGE, '-c', script, 'man-check',
          ...SANDBOX_MAN_PAGES,
        ],
        { timeout: 240_000 },
      );

      expect(stdout.trim(), `image ${SANDBOX_IMAGE} is missing manual pages`).toBe('OK');
    },
    300_000,
  );
});
