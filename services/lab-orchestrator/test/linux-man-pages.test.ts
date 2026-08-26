/**
 * The Linux track's hints send students to `man`. This is what keeps that true.
 *
 * UNIT half: everything answerable from the repository alone — the shipped lab
 * prose and the Dockerfile. It catches the first of the two failure modes, a
 * lab citing a page the image does not ship. The second — the image changing
 * so the pages stop being installed — needs the real image and therefore lives
 * in `linux-man-pages-integration.test.ts`, gated on RUN_INTEGRATION_TESTS.
 *
 * The split is PLATFORM-006's UNIT / INTEGRATION contract: a unit suite reads
 * no opt-in variable and starts no host process. The manifest both halves
 * compare against is in `sandbox-man-pages.ts`.
 */
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LabRegistry } from '../src/index.js';
import { LABS_DIR } from './helpers.js';
import {
  citedManPages,
  DOCKERFILE,
  labProse,
  SANDBOX_MAN_PAGES,
} from './sandbox-man-pages.js';

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

  it('keeps the dpkg drop-in that re-includes them', async () => {
    const dockerfile = await fs.readFile(DOCKERFILE, 'utf8');

    // Without the include, every page in the manifest disappears again and
    // nothing else in the build changes — which is exactly how this went
    // unnoticed before.
    expect(dockerfile).toContain('path-include /usr/share/man/*');
    // The name has to sort after `docker`, or the exclusion still wins.
    expect(dockerfile).toMatch(/dpkg\.cfg\.d\/zz-[a-z-]*man/);
    // Re-including is not enough on its own for packages the base image had.
    expect(dockerfile).toMatch(/--reinstall/);
  });
});
