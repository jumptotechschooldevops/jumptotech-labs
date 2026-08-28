/**
 * NET — the Networking lab catalog.
 *
 * The Networking track is the one track whose subject matter is *the thing the
 * sandbox deliberately does not have*: the Linux sandbox runs `--network none`
 * and cannot be granted `NET_ADMIN`. NET-002 is the first lab, and it is the
 * proof that a networking lab can be real without asking for any of that — it
 * runs on the stock Linux sandbox, reads the kernel's own local routing table,
 * and grades arithmetic the student can only have done.
 *
 * These tests pin the boundary. A future networking lab that quietly reaches
 * for a privileged capability, a seed script, a Docker daemon or a shell has to
 * break one of them first.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  LabDefinitionError,
  MAX_SEED_SCRIPT_BYTES,
  OFFICIAL_DOC_HOSTS,
  PROVIDER_REQUIREMENT_FAMILIES,
  VERIFIER_COMMANDS,
  loadSeedScripts,
  parseLabDefinition,
  requirementFamily,
  type LoadedLabDefinition,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';
import { scanLabsDirectory, type DiscoveredCatalog } from './catalog-shape.js';
import { realCatalog } from './real-catalog.js';

/**
 * What is on disk, read independently of the registry.
 *
 * The shared catalog suite derives its expectations this way rather than
 * restating the curriculum as literals, and this suite follows it: adding
 * NET-003 must not require editing a list here.
 */
let discovered: DiscoveredCatalog | undefined;
async function catalogOnDisk(): Promise<DiscoveredCatalog> {
  discovered ??= await scanLabsDirectory(LABS_DIR);
  return discovered;
}

const realRegistry = realCatalog;

async function net002(): Promise<LoadedLabDefinition> {
  const registry = await realRegistry();
  return registry.get('NET-002');
}

// ------------------------------------------------------------ 1. the catalog

describe('the Networking track appears in the catalog', () => {
  it('loads with no definition errors anywhere in the catalog', async () => {
    const registry = await realRegistry();

    const onDisk = await catalogOnDisk();

    expect(registry.loadErrors).toEqual([]);
    // Every networking lab.yaml on disk reached the catalog, in catalog order.
    expect(registry.labsForTrack('networking').map((l) => l.id)).toEqual(
      onDisk.idsForTrack('networking'),
    );
    expect(onDisk.idsForTrack('networking')).toContain('NET-002');
  });

  it('is a track in its own right, alongside the existing ones', async () => {
    const registry = await realRegistry();

    const onDisk = await catalogOnDisk();
    const tracks = registry.tracks().map((t) => t.track);

    expect(tracks).toContain('networking');
    // Adding this track must not drop or reorder the tracks already on disk.
    expect(tracks).toEqual(onDisk.trackIds);
  });

  it('reads its display metadata from labs/networking/track.yaml', async () => {
    const registry = await realRegistry();

    const track = registry.tracks().find((t) => t.track === 'networking');
    const onDisk = await catalogOnDisk();

    expect(track?.title).toBe('Networking');
    expect(track?.labCount).toBe(onDisk.labCountForTrack('networking'));
  });

  it('declares no prerequisite it cannot resolve', async () => {
    const lab = await net002();

    // NET-001 is designed but not implemented. The registry refuses a
    // prerequisite that does not resolve, so this stays empty until it lands.
    expect(lab.prerequisites).toEqual([]);
  });
});

// -------------------------------------------------- 2. the sandbox boundary

describe('NET-002 asks the platform for nothing it does not already have', () => {
  it('runs on the stock Linux sandbox, with container isolation derived by the loader', async () => {
    const lab = await net002();

    expect(lab.environment.provider).toBe('linux');
    // Never declared in the YAML; the loader fills it in from the provider.
    expect(lab.environment.isolation).toBe('container');
    // No extra session capability — the RBAC overlay and friends stay off.
    expect(lab.environment.capabilities).toEqual([]);
  });

  it('asks only for checks a Linux sandbox can answer', async () => {
    const lab = await net002();

    for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
      const family = requirementFamily(requirement.type);
      expect(
        PROVIDER_REQUIREMENT_FAMILIES.linux.includes(family),
        `${requirement.type} is a ${family} check`,
      ).toBe(true);
    }
  });

  it('executes nothing at all — no scripts, no commands, no Docker, no manifests', async () => {
    const lab = await net002();

    // The three requirement types that *run* something are the ones a
    // networking lab would be most tempted by. NET-002 uses none of them, so
    // there is no argv anywhere in this lab for an operand to leak into.
    const executing = ['script_runs', 'command_exit_code', 'command_output'];
    for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
      expect(executing).not.toContain(requirement.type);
    }

    expect(lab.setup.seed_scripts).toEqual([]);
    expect(lab.setup.manifests).toEqual([]);
    expect(lab.setup.docker).toBeUndefined();
  });

  it('seeds only non-executable starter files, inside the sandbox home', async () => {
    const lab = await net002();

    expect(lab.setup.files.map((f) => f.path)).toEqual([
      'subnets/brief.txt',
      'subnets/plan.txt',
      'subnets/classify.txt',
    ]);

    for (const file of lab.setup.files) {
      expect(path.isAbsolute(file.path)).toBe(false);
      expect(file.path.split('/')).not.toContain('..');
      expect(file.source.split('/')).not.toContain('..');
      // Execute bits are stripped when written, but a lab should not ask.
      expect(Number.parseInt(file.mode, 8) & 0o111).toBe(0);
    }
  });

  it('leaves reset at its default, so a reset is a genuinely fresh container', async () => {
    const lab = await net002();

    // The Linux provider resets by replacing the container and re-seeding, so
    // the Docker reset knobs are inert here. What matters is that the lab did
    // not opt into anything: these are exactly the schema defaults.
    expect(lab.reset.docker).toEqual({
      containers: true,
      volumes: true,
      networks: true,
      images: false,
      workspace: true,
    });
    expect(lab.reset.protected_resources).toEqual([]);
  });
});

// --------------------------------------------------- 3. operands are inert

describe('NET-002 operands cannot become syntax', () => {
  it('names only absolute sandbox paths, with no shell metacharacters', async () => {
    const lab = await net002();

    const paths = [...lab.requirements, ...lab.setup.verify]
      .map((r) => (r as { path?: string }).path)
      .filter((p): p is string => typeof p === 'string');

    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p).toMatch(/^\/(home\/student\/subnets|proc\/net\/fib_trie)(\/|$)/);
      expect(p).not.toMatch(/[;&|`$()<>*?\\'"\s]/);
      expect(p.split('/')).not.toContain('..');
      expect(p).not.toContain('~');
    }
  });

  it('grades literal text only — no expression, no pattern, no interpolation', async () => {
    const lab = await net002();

    for (const requirement of lab.requirements) {
      const contains = (requirement as { contains?: string }).contains;
      expect(typeof contains).toBe('string');
      expect(contains).not.toMatch(/[;&|`$\\]/);
      expect(contains).not.toContain('\n');
    }
  });
});

// ------------------------------------------------- 4. malicious definitions

/** A minimal networking lab, with one field swapped per test. */
function labYaml(overrides: { path?: string; extra?: string } = {}): string {
  return `
id: NET-999
slug: net-999-probe
title: Probe
track: networking
topic: addressing
difficulty: beginner
duration_minutes: 10
environment:
  provider: linux
task:
  summary: s
  description: d
requirements:
  - type: file_content
    path: ${overrides.path ?? '/home/student/subnets/plan.txt'}
    contains: "x"
    label: l
${overrides.extra ?? ''}references:
  - title: RFC 4632
    url: https://www.rfc-editor.org/info/rfc4632
skills:
  - net.cidr.prefix-length
`;
}

describe('a malicious networking lab definition is refused at load time', () => {
  it('accepts the shape NET-002 actually uses', () => {
    expect(() => parseLabDefinition(labYaml())).not.toThrow();
  });

  it('refuses a networking lab that cites no official documentation', () => {
    // OFFICIAL_DOC_HOSTS gained a `networking` row when this track was added.
    // The loader enforces it, so a lab citing a blog cannot ship.
    const unofficial = labYaml().replace(
      'https://www.rfc-editor.org/info/rfc4632',
      'https://example.com/some-blog-post',
    );
    expect(() => parseLabDefinition(unofficial)).toThrow(LabDefinitionError);
  });

  it('pins the official documentation hosts the track may cite', async () => {
    const lab = await net002();
    const allowed = OFFICIAL_DOC_HOSTS.networking ?? [];

    expect(allowed).toContain('www.rfc-editor.org');
    expect(allowed).toContain('www.iana.org');
    for (const reference of lab.references) {
      const url = new URL(reference.url);
      expect(url.protocol).toBe('https:');
      expect(allowed, `${reference.url} is not an official source`).toContain(url.hostname);
    }
  });

  it.each([
    ['command chaining', '/home/student/x.txt;id'],
    ['and-chaining', '/home/student/x.txt&&id'],
    ['a pipe', '/home/student/x.txt|id'],
    ['command substitution', '/home/student/$(id).txt'],
    ['backticks', '/home/student/`id`.txt'],
    ['parent traversal', '/home/student/../../etc/shadow'],
    ['a home shortcut', '~/plan.txt'],
    ['a backslash', '/home/student\\plan.txt'],
    ['newline injection', '/home/student/plan.txt\nid'],
    ['a quote', "/home/student/'plan'.txt"],
    ['a glob', '/home/student/*.txt'],
  ])('refuses %s in a graded path', (_name, malicious) => {
    expect(() => parseLabDefinition(labYaml({ path: malicious }))).toThrow(LabDefinitionError);
  });

  it('refuses an executing check that names a command outside the allow-list', () => {
    const extra = `  - type: command_output
    command: bash
    args: ["-c", "id"]
    contains: "uid"
    label: l
`;
    expect(() => parseLabDefinition(labYaml({ extra }))).toThrow(LabDefinitionError);
  });

  it('refuses an unknown key, so a lab cannot smuggle a shell in beside a path', () => {
    const extra = `  - type: file_content
    path: /home/student/subnets/plan.txt
    contains: "x"
    shell: "id"
    label: l
`;
    expect(() => parseLabDefinition(labYaml({ extra }))).toThrow(LabDefinitionError);
  });

  it('refuses a setup file that tries to land outside the sandbox home', () => {
    const withFile = labYaml().replace(
      'task:',
      `setup:
  files:
    - source: setup/brief.txt
      path: ../../etc/profile.d/evil.sh
task:`,
    );
    expect(() => parseLabDefinition(withFile)).toThrow(LabDefinitionError);
  });
});

// ------------------------------------------------- 5. every networking lab

describe('every Networking lab keeps the track-wide boundary', () => {
  it('runs on the stock Linux sandbox and asks for no extra session capability', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('networking')) {
      const lab = registry.get(summary.id);
      expect(lab.environment.provider, lab.id).toBe('linux');
      expect(lab.environment.isolation, lab.id).toBe('container');
      expect(lab.environment.capabilities, lab.id).toEqual([]);
      expect(lab.setup.manifests, lab.id).toEqual([]);
      expect(lab.setup.docker, lab.id).toBeUndefined();
    }
  });

  it('asks only for checks a Linux sandbox can answer', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('networking')) {
      const lab = registry.get(summary.id);
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
        const family = requirementFamily(requirement.type);
        expect(
          PROVIDER_REQUIREMENT_FAMILIES.linux.includes(family),
          `${lab.id}: ${requirement.type} is a ${family} check`,
        ).toBe(true);
      }
    }
  });

  it('never names a graded answer in a check label', async () => {
    const registry = await realRegistry();

    // Labels are rendered next to every check on Check Solution. A label that
    // repeats the value it grades is a free answer.
    for (const summary of registry.labsForTrack('networking')) {
      const lab = registry.get(summary.id);
      for (const requirement of lab.requirements) {
        const answer = (requirement as { contains?: string }).contains;
        if (!answer) continue;
        for (const other of lab.requirements) {
          expect(
            other.label?.includes(answer),
            `${lab.id}: label '${other.label}' contains the graded value '${answer}'`,
          ).not.toBe(true);
        }
      }
    }
  });

  it('cites at least one official networking source, over https, and no banned host', async () => {
    const registry = await realRegistry();
    const allowed = OFFICIAL_DOC_HOSTS.networking ?? [];

    for (const summary of registry.labsForTrack('networking')) {
      const lab = registry.get(summary.id);
      const hosts = lab.references.map((r) => new URL(r.url).hostname);
      expect(hosts.some((h) => allowed.includes(h)), lab.id).toBe(true);
      for (const reference of lab.references) {
        expect(reference.url.startsWith('https://'), `${lab.id}: ${reference.url}`).toBe(true);
      }
    }
  });
});

// ------------------------------------------------------------ 6. NET-003

describe('NET-003 reproduces real failures without new platform capability', () => {
  it('seeds its baseline with one script and three starter files', async () => {
    const registry = await realRegistry();
    const lab = registry.get('NET-003');

    expect(lab.setup.seed_scripts).toEqual(['setup/seed.sh']);
    expect(lab.setup.files.map((f) => f.path)).toEqual([
      'triage/brief.txt',
      'triage/triage.txt',
      'triage/model.txt',
    ]);
    for (const file of lab.setup.files) {
      // A starter file is never executable, and never lands outside the home.
      expect(Number.parseInt(file.mode, 8) & 0o111).toBe(0);
      expect(file.path.split('/')).not.toContain('..');
    }

    const scripts = await loadSeedScripts(lab);
    expect(scripts).toHaveLength(1);
    for (const script of scripts) {
      expect(script.content.length).toBeLessThanOrEqual(MAX_SEED_SCRIPT_BYTES);
    }
  });

  it('verifies its own baseline before the student sees it', async () => {
    const registry = await realRegistry();
    const lab = registry.get('NET-003');

    const types = lab.setup.verify.map((v) => v.type);
    // The service must be up, the closed port must genuinely be closed, and the
    // resolver must be pinned — otherwise the failures the lab teaches are not
    // the failures the student would reproduce.
    expect(types).toContain('port_listening');
    expect(types).toContain('port_not_listening');
    expect(types).toContain('file_content');
  });

  it('executes exactly one allow-listed inspection, as argv with no shell', async () => {
    const registry = await realRegistry();
    const lab = registry.get('NET-003');

    const executing = lab.requirements.filter((r) =>
      ['script_runs', 'command_exit_code', 'command_output'].includes(r.type),
    );
    expect(executing).toHaveLength(1);

    const inspection = executing[0] as { type: string; command: string; args: string[] };
    expect(inspection.type).toBe('command_exit_code');
    expect(VERIFIER_COMMANDS).toContain(inspection.command);
    for (const arg of inspection.args) {
      expect(arg).not.toMatch(/[;&|`$()<>*?\\'"\s]/);
      expect(arg.split('/')).not.toContain('..');
    }
    // Nothing in this lab runs a student-authored script.
    expect(lab.requirements.some((r) => r.type === 'script_runs')).toBe(false);
  });

  it('keeps the answers out of the seeded content the student can read', async () => {
    const registry = await realRegistry();
    const lab = registry.get('NET-003');
    const labDir = path.dirname(lab.sourcePath);

    const seeded = await Promise.all(
      lab.setup.files.map((f) => readFile(path.join(labDir, f.source), 'utf8')),
    );
    const readable = seeded.join('\n');

    // The graded values must not be sitting in a file the student is handed.
    for (const requirement of lab.requirements) {
      const answer = (requirement as { contains?: string }).contains;
      if (!answer || requirement.type === 'file_content_absent') continue;
      expect(readable.includes(answer), `seeded content contains '${answer}'`).toBe(false);
    }

    // Nor in the hints or objectives.
    const prose = [...lab.hints.map((h) => h.text), ...lab.objectives].join('\n');
    for (const answer of ['= L4', '= L3', '= L7', 'JTT-LEDGER-503-7F2A', '3 = packet']) {
      expect(prose.includes(answer), `hint or objective contains '${answer}'`).toBe(false);
    }
  });

  it('declares NET-002 as its prerequisite, and the registry resolves it', async () => {
    const registry = await realRegistry();
    const lab = registry.get('NET-003');

    expect(lab.prerequisites).toEqual(['NET-002']);
    const resolved = registry.prerequisitesOf(lab);
    expect(resolved.every((p) => p.available)).toBe(true);
  });
});
