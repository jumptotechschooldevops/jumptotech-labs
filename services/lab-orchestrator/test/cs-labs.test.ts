/**
 * The Computer Science Fundamentals track.
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
  OFFICIAL_DOC_HOSTS,
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

/** Every CS lab shipped so far, so track-wide rules are checked once. */
const CS_IDS = [
  'CS-001',
  'CS-002',
  'CS-003',
  'CS-004',
  'CS-005',
  'CS-006',
  'CS-007',
  'CS-008',
  'CS-009',
  'CS-010',
  'CS-011',
];

async function csLabs(): Promise<LoadedLabDefinition[]> {
  const registry = await realRegistry();
  return CS_IDS.map((id) => registry.get(id));
}

// -------------------------------------------------------- the definition loads

describe('the CS track loads', () => {
  it('registers CS-001 with no definition errors anywhere in the catalog', async () => {
    const registry = await realRegistry();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.labsForTrack('cs').map((l) => l.id)).toEqual(CS_IDS);
  });

  it('sequences the track, each lab building on one that comes before it', async () => {
    const labs = await csLabs();

    for (const [index, lab] of labs.entries()) {
      expect(lab.order, lab.id).toBe(index + 1);
      if (index === 0) {
        expect(lab.prerequisites, lab.id).toEqual([]);
        continue;
      }
      // The curriculum plan's prerequisite graph is a DAG rather than a strict
      // chain — a lab may build on an earlier one without depending on its
      // immediate predecessor. What must hold is that it never depends on
      // itself or on something later in the track.
      expect(lab.prerequisites.length, lab.id).toBeGreaterThan(0);
      for (const prerequisite of lab.prerequisites) {
        const position = CS_IDS.indexOf(prerequisite);
        expect(position, `${lab.id} requires ${prerequisite}`).toBeGreaterThanOrEqual(0);
        expect(position, `${lab.id} requires ${prerequisite}`).toBeLessThan(index);
      }
    }
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
    for (const lab of await csLabs()) {
    expect(lab.environment.provider).toBe('linux');
    // Never declared in the YAML: derived from the provider, so a lab cannot
    // claim an isolation model its provider does not deliver.
    expect(lab.environment.isolation).toBe('container');
    }
  });

  it('gives every CS lab a student account with no route to root', async () => {
    // The verifier reads state back by running binaries inside the student's
    // own container, so a student who can become root can replace them and
    // forge a pass. CS teaches what a system is, never how to administer one,
    // so no CS lab has a reason to hand out sudo — and a new one that forgets
    // to say so should fail here rather than ship a forgeable grade.
    for (const lab of await csLabs()) {
      expect(lab.environment.capabilities, lab.id).toContain('unprivileged_shell');
      expect(lab.environment.capabilities, lab.id).not.toContain('rbac_authoring');
    }
  });

  it('asks only for checks the Linux sandbox can already answer', async () => {
    const all = (await csLabs()).flatMap((lab) => [...lab.requirements, ...lab.setup.verify]);

    for (const requirement of all) {
      const family = requirementFamily(requirement.type);
      expect(
        PROVIDER_REQUIREMENT_FAMILIES.linux.includes(family),
        `${requirement.type} is a ${family} check`,
      ).toBe(true);
    }
  });

  it('needs no requirement type that did not already exist', async () => {
    // Adding the CS track cost the platform no new verifier vocabulary. Every
    // type below shipped before CS-001 did, and this test is what says so.
    //
    // The list is deliberately hand-maintained rather than derived from the
    // schema: derived from the schema it would accept a type someone adds
    // tomorrow, which is the thing it exists to catch. Adding an entry here
    // means checking that the type predates the track — `command_output` was
    // added by 558a5f7 (the Linux track) and is present in the tree at
    // 5930406^, the commit before CS-001.
    const shipped = new Set([
      'file_exists',
      'file_content',
      'file_content_absent',
      'script_executable',
      'script_runs',
      'command_output',
    ]);

    for (const lab of await csLabs()) {
      for (const requirement of lab.requirements) {
        expect(shipped, `${lab.id}: ${requirement.type}`).toContain(requirement.type);
      }
    }
  });
});

// ------------------------------------------------------------ content policy

describe('CS-001 content policy', () => {
  it('claims no certification objective', async () => {
    // FOUNDATIONAL SKILL, not exam preparation. A CS lab that starts claiming
    // coverage of a published objective has to justify it against that exam's
    // current official objective list first — see labs/cs/SOURCES.md.
    for (const lab of await csLabs()) expect(lab.certification, lab.id).toEqual([]);
  });

  it('cites primary documentation and nothing commercial', async () => {
    // Derived from the platform's own per-track allowlist rather than a copy
    // of it, so this test cannot drift away from what the loader enforces.
    const primary = OFFICIAL_DOC_HOSTS.cs ?? [];
    expect(primary.length, 'OFFICIAL_DOC_HOSTS has no cs entry').toBeGreaterThan(0);

    for (const lab of await csLabs()) {
      expect(lab.references.length, lab.id).toBeGreaterThan(0);
      for (const reference of lab.references) {
        expect(reference.url).toMatch(/^https:\/\//);
        const host = new URL(reference.url).hostname;
        expect(primary, `${lab.id}: ${reference.url} is not a primary source`).toContain(host);
      }
    }
  });

  it('ships a progressive hint ladder that never starts with the answer', async () => {
    // No hint may contain a graded value. A student who opens every hint still
    // has to read the evidence and do the arithmetic themselves.
    const graded: Record<string, string[]> = {
      'CS-001': ['15885', '16656', 'SCAN01_CPUS', 'VERDICT=', '/var'],
      'CS-002': ['536870912', '536.87', '512.00', '1073.74', '4d69', '537M', 'VERDICT='],
      'CS-009': ['RECONCILED=6', 'TOTAL=8484', 'line=3', 'IsADirectoryError', 'UNCAUGHT_EXIT='],
      'CS-010': [
        'd8cd267fcd4ffad806d82ef8601ea3209b72be782ff0847cb4badf779e02269c',
        'key=region',
        'key=enabled',
        'DUPLICATE_KEY=',
        'COUNTRY_BECAME=',
        'VERSION_BECAME=',
        'TAB_DEPOT=',
      ],
      'CS-011': [
        'RAW=1792',
        'RAW=768',
        'STATUS=7',
        'CHILD_STATE=Z',
        'ZOMBIE_STATE=',
        'RAW_WAIT_STATUS=',
        'ORPHAN_PARENT=',
        'STATE_AFTER_SIGKILL=',
      ],
      'CS-008': ['TOTAL=16', 'ERRORS=4', 'SLOWEST=R-1007', 'LONGEST_MSG=R-1012', 'ERROR_PATHS='],
      'CS-007': ['ORDER=leeds,bristol', 'ORDER=york,cardiff', 'TOTAL=26', 'COUNT=9', 'leeds,9'],
      'CS-006': ['DECISION=scale-down', 'DECISION=scale-up', 'current=10 target=9', 'current=12 target=9', 'DECISION=invalid'],
      'CS-005': ['DEPLOY_CHECK=misconfigured', 'limit=5', 'exit 2', 'exit 3', 'export KESTREL'],
      'CS-004': ['OPENED=61', 'OPENED=125', 'ERRNO=24', 'EMFILE', 'LEAK_KIND=', 'COLLECTOR_SOFT_LIMIT', 'REAL_FIX=', '256'],
      'CS-003': [
        'c3bc',
        'e69db1',
        'U+00FC',
        'CHARS=18',
        'BYTES=37',
        'TOTAL_BYTES=87',
        'TOTAL_CHARS=61',
        'OVER_LIMIT_LINE=',
        'LIMIT_COUNTS=',
      ],
    };

    for (const lab of await csLabs()) {
      expect(lab.hints.length, lab.id).toBeGreaterThanOrEqual(3);
      expect(lab.hints.map((h) => h.level), lab.id).toEqual([1, 2, 3]);
      for (const hint of lab.hints) {
        for (const answer of graded[lab.id] ?? []) {
          expect(hint.text, `${lab.id} hint ${hint.level} leaks ${answer}`).not.toContain(answer);
        }
      }
    }
  });

  it('gives every student-visible check its own wording, and none of them the answer', async () => {
    for (const lab of await csLabs()) {
      const labels = lab.requirements.map((r) => r.label ?? '');
      expect(labels.every((label) => label.length > 0), lab.id).toBe(true);
      expect(new Set(labels).size, lab.id).toBe(labels.length);
      // A label is shown before the student has solved anything, so it may name
      // what is being checked but never what the value is.
      for (const label of labels) {
        expect(label, lab.id).not.toMatch(
          /15885|16656|jumptotech-lab|536870912|4d69|537M|c3bc|e69db1|00FC|=8\b/,
        );
      }
    }
  });
});

// ------------------------------------------------------------- the baseline

describe('CS-001 baseline script', () => {
  it('loads from the lab’s own directory, as a real script within the size limit', async () => {
    for (const lab of await csLabs()) {
    const scripts = await loadSeedScripts(lab);

    expect(scripts).toHaveLength(1);
    const script = scripts.at(0)!;
    expect(script.name).toBe('seed.sh');
    expect(script.source).toBe('setup/seed.sh');
    expect(script.content.startsWith('#!')).toBe(true);
    expect(Buffer.byteLength(script.content, 'utf8')).toBeLessThanOrEqual(MAX_SEED_SCRIPT_BYTES);
    }
  });

  it('plants the evidence without pre-creating the student’s working directory', async () => {
    // Making the directory they are going to work in is the student's first
    // act on the machine; seeding it would remove that. Where the evidence
    // itself lives is up to the lab — CS-001 to CS-003 stage files under
    // /srv/kestrel, CS-004 installs a running service — so only the student's
    // own home is off limits.
    for (const lab of await csLabs()) {
      const script = (await loadSeedScripts(lab)).at(0)!;
      expect(script.content, lab.id).not.toMatch(/install -d[^\n]*\/home\/student\//);
      expect(script.content, lab.id).not.toMatch(/mkdir[^\n]*\/home\/student\/(ops|py)/);
    }
  });

  it('states the lab’s starting condition through setup verification', async () => {
    // Setup checks run before the student is let in, so evidence that failed to
    // land is reported as a broken environment rather than as their fault. They
    // must describe platform-seeded state — never anything under the student's
    // home, which is empty at that point and is theirs to fill.
    for (const lab of await csLabs()) {
      expect(lab.setup.verify.length, lab.id).toBeGreaterThanOrEqual(4);
      for (const check of lab.setup.verify) {
        const target = String((check as { path?: string }).path ?? '');
        if (target) expect(target, `${lab.id}: ${target}`).not.toMatch(/^\/home\/student\//);
      }
    }
  });
});

// ------------------------------------------------- CS-004's leaking fixture

describe('CS-004 seeded leaking process', () => {
  async function seed(): Promise<string> {
    const registry = await realRegistry();
    const scripts = await loadSeedScripts(registry.get('CS-004'));
    return scripts.at(0)!.content;
  }

  it('is confirmed running before the student is let in', async () => {
    const lab = (await realRegistry()).get('CS-004');
    const types = lab.setup.verify.map((c) => c.type);

    // A lab whose whole subject is a running process must not hand the student
    // a sandbox where that process failed to start: setup verification checks
    // the process table and the listening socket, not just files on disk.
    expect(types).toContain('process_running');
    expect(types).toContain('port_listening');
  });

  it('runs as the student, because /proc/<pid>/fd is only readable by its owner', async () => {
    const content = await seed();

    // Running the fixture as root would leave the student unable to see the
    // descriptor table they are asked to investigate.
    expect(content).toMatch(/su student -c/);
  });

  it('bounds the leak well below the limit it runs under', async () => {
    const content = await seed();
    const soft = Number(/SOFT_LIMIT=(\d+)/.exec(content)?.[1]);
    const batches = Number(/LEAK_BATCHES=(\d+)/.exec(content)?.[1]);

    expect(Number.isFinite(soft)).toBe(true);
    expect(Number.isFinite(batches)).toBe(true);
    // Two descriptors per batch plus a listener, a couple of spool files and
    // the three standard ones. It must stop short of its own ceiling so the
    // process stays alive to be investigated — and nowhere near a host one.
    expect(batches * 2 + 8).toBeLessThan(soft);
  });

  it('keeps the graded soft limit out of every file the student can read', async () => {
    const content = await seed();
    const soft = /SOFT_LIMIT=(\d+)/.exec(content)?.[1] ?? '';

    // The number is set here, in a script the provider deletes from a
    // root-only directory before the terminal opens, so afterwards it exists
    // only in the running process. The service the student *can* read must not
    // repeat it.
    const service = content.slice(content.indexOf('scan-collector <<'), content.indexOf('chmod 0755 /usr/local/bin'));
    expect(service).not.toContain(soft);
    expect(service).not.toMatch(/RLIMIT|ulimit|setrlimit/);
  });

  it('leaks a mix, so the dominant kind has to be counted rather than guessed', async () => {
    const content = await seed();

    // Sockets and ordinary files both, which is why reading the service's
    // source cannot answer "which kind dominates".
    expect(content).toMatch(/create_connection/);
    expect(content).toMatch(/\.spool/);
  });
});
