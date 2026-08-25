/**
 * CS-001 — the Computer Science Fundamentals track's first lab.
 *
 * The CS track is FOUNDATIONAL SKILL content: it teaches what sits underneath
 * the other tracks and claims no certification objective. These tests pin the
 * three things that could quietly stop being true as the track grows:
 *
 *   1. the lab loads, on the `linux` provider, asking only for checks that
 *      provider can actually answer — no new provider, no new requirement type;
 *   2. it claims no certification coverage, and cites primary documentation
 *      only;
 *   3. its baseline script is real, self-contained content the platform will
 *      ship into one throwaway container.
 *
 * What a *student* can and cannot get away with is graded by the verifier, and
 * is tested in `services/verifier/test/cs-001-verification.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  LabRegistry,
  MAX_SEED_SCRIPT_BYTES,
  PROVIDER_REQUIREMENT_FAMILIES,
  loadSeedScripts,
  requirementFamily,
  type LoadedLabDefinition,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

let cached: LabRegistry | undefined;
async function realRegistry(): Promise<LabRegistry> {
  if (!cached) {
    cached = new LabRegistry(LABS_DIR);
    await cached.load();
  }
  return cached;
}

async function cs001(): Promise<LoadedLabDefinition> {
  return (await realRegistry()).get('CS-001');
}

// -------------------------------------------------------- the definition loads

describe('the CS track loads', () => {
  it('registers CS-001 with no definition errors anywhere in the catalog', async () => {
    const registry = await realRegistry();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.labsForTrack('cs').map((l) => l.id)).toEqual(['CS-001']);
  });

  it('presents itself as the foundation track, ahead of the others', async () => {
    const registry = await realRegistry();
    const track = registry.track('cs');

    expect(track?.title).toBe('Computer Science Fundamentals');
    expect(track?.tagline).toBeTruthy();

    // What actually matters is the position, not the number: a beginner meets
    // this track first, and every other track assumes what it teaches. Asserted
    // as "first in the catalog" rather than "order === 6" so that renumbering
    // the shipped tracks stays a one-file change.
    expect(registry.tracks().at(0)?.track).toBe('cs');
    // It must still declare *an* order — an undeclared track sorts last.
    expect(track?.order).toBeLessThan(10);
  });

  it('runs on the existing Linux provider and gets container isolation from it', async () => {
    const lab = await cs001();

    expect(lab.environment.provider).toBe('linux');
    // Never declared in the YAML: derived from the provider, so a lab cannot
    // claim an isolation model its provider does not deliver.
    expect(lab.environment.isolation).toBe('container');
    expect(lab.environment.capabilities).toEqual([]);
  });

  it('asks only for checks the Linux sandbox can already answer', async () => {
    const lab = await cs001();

    for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
      const family = requirementFamily(requirement.type);
      expect(
        PROVIDER_REQUIREMENT_FAMILIES.linux.includes(family),
        `${requirement.type} is a ${family} check`,
      ).toBe(true);
    }
  });

  it('needs no requirement type that did not already exist', async () => {
    const lab = await cs001();

    // The whole lab is graded by reading files back. Adding the CS track cost
    // the platform no new verifier vocabulary, and this test is what says so.
    expect(new Set(lab.requirements.map((r) => r.type))).toEqual(
      new Set(['file_exists', 'file_content']),
    );
  });
});

// ------------------------------------------------------------ content policy

describe('CS-001 content policy', () => {
  it('claims no certification objective', async () => {
    const lab = await cs001();

    // FOUNDATIONAL SKILL, not exam preparation. A CS lab that starts claiming
    // coverage of a published objective has to justify it against that exam's
    // current official objective list first — see labs/cs/SOURCES.md.
    expect(lab.certification).toEqual([]);
  });

  it('cites primary documentation and nothing commercial', async () => {
    const lab = await cs001();
    const primary = ['man7.org', 'docs.kernel.org', 'www.gnu.org', 'kubernetes.io'];

    expect(lab.references.length).toBeGreaterThan(0);
    for (const reference of lab.references) {
      expect(reference.url).toMatch(/^https:\/\//);
      const host = new URL(reference.url).hostname;
      expect(primary, `${reference.url} is not a primary source`).toContain(host);
    }
  });

  it('ships a progressive hint ladder that never starts with the answer', async () => {
    const lab = await cs001();

    expect(lab.hints.length).toBeGreaterThanOrEqual(3);
    expect(lab.hints.map((h) => h.level)).toEqual([1, 2, 3]);
    // No hint may contain a graded value. A student who opens every hint still
    // has to read the capture and do the arithmetic.
    const graded = ['15885', '16656', 'SCAN01_CPUS', 'VERDICT=', '/var'];
    for (const hint of lab.hints) {
      for (const answer of graded) {
        expect(hint.text, `hint ${hint.level} leaks ${answer}`).not.toContain(answer);
      }
    }
  });

  it('gives every student-visible check its own wording, and none of them the answer', async () => {
    const lab = await cs001();

    const labels = lab.requirements.map((r) => r.label ?? '');
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    // A label is shown before the student has solved anything, so it may name
    // what is being checked but never what the value is.
    for (const label of labels) {
      expect(label).not.toMatch(/15885|16656|jumptotech-lab|=8\b/);
    }
  });
});

// ------------------------------------------------------------- the baseline

describe('CS-001 baseline script', () => {
  it('loads from the lab’s own directory, as a real script within the size limit', async () => {
    const lab = await cs001();
    const scripts = await loadSeedScripts(lab);

    expect(scripts).toHaveLength(1);
    const script = scripts.at(0)!;
    expect(script.name).toBe('seed.sh');
    expect(script.source).toBe('setup/seed.sh');
    expect(script.content.startsWith('#!')).toBe(true);
    expect(Buffer.byteLength(script.content, 'utf8')).toBeLessThanOrEqual(MAX_SEED_SCRIPT_BYTES);
  });

  it('plants the capture without pre-creating the student’s working directory', async () => {
    const script = (await loadSeedScripts(await cs001())).at(0)!;

    expect(script.content).toContain('/srv/kestrel/scan-01');
    // Making the directory they are going to work in is the student's first
    // act on the machine; seeding it would remove that.
    expect(script.content).not.toMatch(/install -d[^\n]*\/home\/student\/ops/);
  });

  it('states the lab’s starting condition through setup verification', async () => {
    const lab = await cs001();

    // Setup checks run before the student is let in, so a capture that failed
    // to land is reported as a broken environment rather than as their fault.
    expect(lab.setup.verify.length).toBeGreaterThanOrEqual(4);
    for (const check of lab.setup.verify) {
      expect(String((check as { path?: string }).path ?? '')).toMatch(/^\/srv\/kestrel\/scan-01\//);
    }
  });
});
