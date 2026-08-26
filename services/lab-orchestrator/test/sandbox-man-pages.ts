/**
 * What the Linux sandbox image guarantees `man` can answer.
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
 *      `linux-man-pages.test.ts`, which reads the shipped labs and compares
 *      what they cite against the manifest below;
 *   2. someone changes the image and the pages stop being installed — caught by
 *      `linux-man-pages-integration.test.ts`, which asks the real image.
 *
 * Those are a UNIT suite and an INTEGRATION suite under PLATFORM-006, so they
 * are separate files and this module is what they share. The manifest is
 * deliberately here rather than in `src`: it describes what the *image*
 * guarantees, and no production code reads it.
 */
import path from 'node:path';
import type { LoadedLabDefinition } from '../src/index.js';
import { LABS_DIR } from './helpers.js';

/** The image definition itself — the unit suite reads it. */
export const DOCKERFILE = path.resolve(
  LABS_DIR,
  '../infrastructure/docker/sandbox-linux.Dockerfile',
);

/** The sandbox image to interrogate. Matches what the provider would use. */
export const SANDBOX_IMAGE =
  process.env.LINUX_SANDBOX_IMAGE ?? 'jumptotech/lab-linux:latest';

/**
 * Manual pages the Linux sandbox image guarantees.
 *
 * Every entry is cited by at least one shipped lab, and the integration suite
 * asks the real image for each one. Adding a lab that cites something outside
 * this list fails the unit suite until either the citation changes or the image
 * starts shipping the page.
 */
export const SANDBOX_MAN_PAGES = [
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
export function citedManPages(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\bman\s+(?:([1-8])\s+)?`?([a-z][a-z0-9_.-]*)`?/g;
  for (const match of text.matchAll(pattern)) {
    const page = match[2];
    if (page) found.add(page);
  }
  return [...found];
}

/** Every piece of student-visible prose in a lab that could cite a page. */
export function labProse(lab: LoadedLabDefinition): string {
  return [
    lab.story,
    lab.task.summary,
    lab.task.description,
    ...lab.objectives,
    ...lab.hints.map((h) => h.text),
  ].join('\n');
}
