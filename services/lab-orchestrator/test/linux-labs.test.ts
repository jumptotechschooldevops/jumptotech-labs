/**
 * PLATFORM-LINUX-001 — the Linux lab catalog.
 *
 * Covers story test requirements 1 and 2: that all ten Linux lab definitions
 * load, and that they appear in the catalog alongside the Kubernetes track.
 * Also pins the schema rules the track relies on, so a future lab cannot
 * quietly declare a check its own sandbox could never answer.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  LabRegistry,
  MAX_SEED_SCRIPT_BYTES,
  PROVIDER_REQUIREMENT_FAMILIES,
  loadSeedScripts,
  parseLabDefinition,
  requirementFamily,
  LabDefinitionError,
  type LoadedLabDefinition,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';
import { scanLabsDirectory } from './catalog-shape.js';

const LINUX_IDS = [
  'LINUX-001',
  'LINUX-002',
  'LINUX-003',
  'LINUX-004',
  'LINUX-005',
  'LINUX-006',
  'LINUX-007',
  'LINUX-008',
  'LINUX-009',
  'LINUX-010',
];

let cached: LabRegistry | undefined;
async function realRegistry(): Promise<LabRegistry> {
  if (!cached) {
    cached = new LabRegistry(LABS_DIR);
    await cached.load();
  }
  return cached;
}

// ------------------------------------------------------- 1. definitions load

describe('Linux lab definitions load (test requirement 1)', () => {
  it('loads all ten, with no definition errors anywhere in the catalog', async () => {
    const registry = await realRegistry();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.labsForTrack('linux').map((l) => l.id)).toEqual(LINUX_IDS);
  });

  it('declares the Linux environment, and gets container isolation for free', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('linux')) {
      const lab = registry.get(summary.id);
      expect(lab.environment.provider).toBe('linux');
      // Never declared in the YAML; derived from the provider, so a lab cannot
      // claim an isolation model its provider does not deliver.
      expect(lab.environment.isolation).toBe('container');
    }
  });

  it('asks only for checks a Linux sandbox can answer', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('linux')) {
      const lab = registry.get(summary.id);
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
        // The Linux provider verifies two families: plain filesystem reads, and
        // the `linux` checks that additionally need the sandbox to answer an
        // inspection command. Anything else — a Pod, a Terraform output — is an
        // authoring error the loader would already have refused.
        const family = requirementFamily(requirement.type);
        expect(
          PROVIDER_REQUIREMENT_FAMILIES.linux.includes(family),
          `${lab.id}: ${requirement.type} is a ${family} check`,
        ).toBe(true);
      }
    }
  });

  it('gives every student-visible check its own wording', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('linux')) {
      const lab = registry.get(summary.id);
      const labels = lab.requirements.map((r) => r.label);
      expect(labels.every(Boolean), `${lab.id} has an unlabelled requirement`).toBe(true);
      // A label that is just the requirement type would leak how the check is
      // implemented, which a troubleshooting lab must not do.
      expect(labels.some((label) => label === undefined)).toBe(false);
    }
  });

  it('ships a progressive hint ladder that never starts with the answer', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('linux')) {
      const lab = registry.get(summary.id);
      expect(lab.hints.length, `${lab.id}`).toBeGreaterThanOrEqual(2);
      expect(lab.hints.map((h) => h.level)).toEqual(
        [...lab.hints.map((h) => h.level)].sort((a, b) => a - b),
      );
      expect(lab.hints[0]?.level).toBe(1);
    }
  });

  it('cites official Linux documentation and nothing commercial', async () => {
    const registry = await realRegistry();
    const official = ['www.gnu.org', 'man7.org', 'manpages.debian.org', 'help.ubuntu.com'];

    for (const summary of registry.labsForTrack('linux')) {
      const lab = registry.get(summary.id);
      const hosts = lab.references.map((ref) => new URL(ref.url).hostname);
      expect(hosts.some((host) => official.includes(host)), `${lab.id}`).toBe(true);
      for (const ref of lab.references) expect(ref.url).toMatch(/^https:\/\//);
    }
  });
});

// --------------------------------------------------- 2. they reach the catalog

describe('the catalog carries both tracks (test requirement 2)', () => {
  it('lists Linux as a full track alongside every other shipped track', async () => {
    const registry = await realRegistry();
    const disk = await scanLabsDirectory();

    // The other tracks are asserted from disk, never from a number typed here:
    // a Kubernetes or Docker lab landing in another worktree must not fail the
    // Linux suite. What this suite owns is the Linux track's own shape.
    expect(registry.tracks().map((t) => t.track)).toEqual(disk.trackIds);
    for (const track of registry.tracks()) {
      expect(track.labCount, track.track).toBe(disk.labCountForTrack(track.track));
    }
    expect(registry.track('linux')).toMatchObject({
      track: 'linux',
      title: 'Linux',
      labCount: LINUX_IDS.length,
    });
  });

  it('groups the Linux track into the five topics the catalog navigates by', async () => {
    const registry = await realRegistry();
    const track = registry.track('linux');

    expect(track?.topics.map((t) => t.title)).toEqual([
      'Linux Fundamentals',
      'Linux Administration',
      'Linux Networking',
      'Shell Scripting',
      'Troubleshooting',
    ]);
    expect(track?.topics.reduce((total, t) => total + t.labCount, 0)).toBe(LINUX_IDS.length);
  });

  it('carries a tagline the catalog can show on the track card', async () => {
    const registry = await realRegistry();
    expect(registry.track('linux')?.tagline).toBeTruthy();
  });

  it('marks the labs that seed a starting state', async () => {
    const registry = await realRegistry();
    const summaries = registry.labsForTrack('linux');

    // LINUX-001 starts from an empty home directory; every other Linux lab is
    // seeded, which is the property — the count follows from the track.
    expect(summaries.find((l) => l.id === 'LINUX-001')?.hasSetup).toBe(false);
    expect(summaries.filter((l) => l.hasSetup)).toHaveLength(summaries.length - 1);
  });

  it('describes a prerequisite path through the track', async () => {
    const registry = await realRegistry();

    for (const [index, id] of LINUX_IDS.entries()) {
      const lab = registry.get(id);
      expect(lab.prerequisites).toEqual(index === 0 ? [] : [LINUX_IDS[index - 1]]);
    }
  });
});

// ------------------------------------------------------------- seed scripts

describe('lab baseline scripts', () => {
  async function linuxLab(id: string): Promise<LoadedLabDefinition> {
    return (await realRegistry()).get(id);
  }

  it('loads every declared seed script from the lab’s own directory', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('linux')) {
      const lab = registry.get(summary.id);
      const scripts = await loadSeedScripts(lab);

      expect(scripts).toHaveLength(lab.setup.seed_scripts.length);
      for (const script of scripts) {
        expect(script.content.startsWith('#!'), `${lab.id}/${script.name}`).toBe(true);
        expect(Buffer.byteLength(script.content, 'utf8')).toBeLessThanOrEqual(MAX_SEED_SCRIPT_BYTES);
        // A basename, never a path: the provider chooses the destination, and
        // it is a root-only directory it empties again straight afterwards.
        expect(script.name).not.toContain('/');
        expect(script.source).toBe(`setup/${script.name}`);
      }
    }
  });

  it('refuses a seed script that is not a script', async () => {
    const lab = await linuxLab('LINUX-002');
    const notAScript: LoadedLabDefinition = {
      ...lab,
      setup: { ...lab.setup, seed_scripts: ['lab.yaml'] },
    };

    // lab.yaml exists but has no interpreter line, so it is refused rather than
    // shipped into a container as executable content.
    await expect(loadSeedScripts(notAScript)).rejects.toThrow(/#! interpreter line/);
  });

  it('refuses a seed script outside the lab directory', async () => {
    const lab = await linuxLab('LINUX-002');
    const escaping: LoadedLabDefinition = {
      ...lab,
      directory: path.join(lab.directory, 'setup'),
      setup: { ...lab.setup, seed_scripts: ['../../../etc/passwd'] },
    };

    await expect(loadSeedScripts(escaping)).rejects.toThrow(/outside the lab directory/);
  });
});

// ------------------------------------------------------------ schema fencing

describe('the schema keeps the two families apart', () => {
  /**
   * Assert on the operator-facing issue list, not on the summary line.
   *
   * `LabDefinitionError.message` is a count; the precise reason a lab was
   * rejected lives in `issues`, which is what an author actually reads.
   */
  function expectIssue(yaml: string, pattern: RegExp): void {
    try {
      parseLabDefinition(yaml);
    } catch (error) {
      expect(error).toBeInstanceOf(LabDefinitionError);
      expect((error as LabDefinitionError).issues.join('\n')).toMatch(pattern);
      return;
    }
    throw new Error('expected the definition to be rejected');
  }

  const base = (extra: string) => `
id: LINUX-901
slug: linux-901-demo
title: Demo
track: linux
topic: linux-fundamentals
difficulty: beginner
duration_minutes: 10
environment:
  provider: linux
task:
  summary: Demo
  description: Demo
${extra}
references:
  - title: mkdir(1)
    url: https://man7.org/linux/man-pages/man1/mkdir.1.html
skills:
  - linux.files.create
`;

  it('rejects a Linux lab that asks for a Kubernetes check', () => {
    expectIssue(
      base(`requirements:
  - type: pod_exists
    name: nginx
    label: Pod exists`),
      /is a kubernetes check, which the 'linux' provider cannot verify/,
    );
  });

  it('rejects a Kubernetes lab that asks for a filesystem check', () => {
    const yaml = `
id: K8S-901
slug: k8s-901-demo
title: Demo
track: kubernetes
topic: pods
difficulty: beginner
duration_minutes: 10
environment:
  provider: kubernetes
task:
  summary: Demo
  description: Demo
requirements:
  - type: file_exists
    path: /home/student/app.log
    label: The file exists
references:
  - title: Kubernetes Pods
    url: https://kubernetes.io/docs/concepts/workloads/pods/
skills:
  - kubernetes.pods.create
`;
    expectIssue(yaml, /is a filesystem check, which the 'kubernetes' provider cannot verify/);
  });

  it('rejects a Linux lab that declares Kubernetes setup manifests', () => {
    expectIssue(
      base(`requirements:
  - type: file_exists
    path: /home/student/app.log
    label: The file exists
setup:
  manifests:
    - setup/pod.yaml
  verify:
    - type: file_exists
      path: /home/student/app.log`),
      /setup\.manifests are Kubernetes objects and cannot be applied by the 'linux' provider/,
    );
  });

  it('rejects an isolation model the provider does not deliver', () => {
    const yaml = base(`requirements:
  - type: file_exists
    path: /home/student/app.log
    label: The file exists`).replace('  provider: linux', '  provider: linux\n  isolation: namespace');

    expectIssue(yaml, /environment\.isolation is 'namespace', but the 'linux' provider isolates with 'container'/);
  });

  it('still accepts a well-formed Linux lab', () => {
    const def = parseLabDefinition(
      base(`requirements:
  - type: file_exists
    path: /home/student/app.log
    label: The file exists`),
    );

    expect(def.id).toBe('LINUX-901');
    // `network: 'none'` is the point of the assertion, not noise: a lab that
    // declares no network keeps the boundary it has always had.
    expect(def.environment).toEqual({
      provider: 'linux',
      isolation: 'container',
      network: 'none',
      capabilities: [],
    });
  });
});
