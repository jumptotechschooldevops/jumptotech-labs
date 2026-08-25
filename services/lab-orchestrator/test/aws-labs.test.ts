/**
 * AWS-001 — the AWS track's first lab definition.
 *
 * AWS-001 is SIMULATED. It runs in the ordinary Linux sandbox, creates no AWS
 * resources, holds no AWS credentials, and calls no AWS API. These tests pin
 * exactly that, so the track cannot quietly acquire a real-AWS dependency: the
 * `aws` provider stays with no requirement families, and every check AWS-001
 * asks for is one a Linux sandbox can already answer.
 *
 * They also pin what the lab may *claim*. AWS-001 maps to no current SOA-C03
 * task statement, so it must carry no `certification` block — a lab that
 * implies exam coverage it does not have is a content defect.
 */
import { describe, expect, it } from 'vitest';
import {
  DISALLOWED_DOC_HOSTS,
  LabDefinitionError,
  LabRegistry,
  MAX_SEED_SCRIPT_BYTES,
  OFFICIAL_DOC_HOSTS,
  PROVIDER_REQUIREMENT_FAMILIES,
  loadSeedScripts,
  parseLabDefinition,
  requirementFamily,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';
import { scanLabsDirectory } from './catalog-shape.js';

let cached: LabRegistry | undefined;
async function realRegistry(): Promise<LabRegistry> {
  if (!cached) {
    cached = new LabRegistry(LABS_DIR);
    await cached.load();
  }
  return cached;
}

// ------------------------------------------------------- 1. definition loads

describe('AWS lab definitions load', () => {
  it('loads AWS-001 with no definition errors anywhere in the catalog', async () => {
    const registry = await realRegistry();

    expect(registry.loadErrors).toEqual([]);
    expect(registry.labsForTrack('aws').map((l) => l.id)).toEqual(['AWS-001', 'AWS-002', 'AWS-003', 'AWS-004', 'AWS-005']);
  });

  it('declares the Linux sandbox, and gets container isolation for free', async () => {
    const registry = await realRegistry();

    for (const id of ['AWS-001', 'AWS-002', 'AWS-003', 'AWS-004', 'AWS-005']) {
      const lab = registry.get(id);
      // Simulated: an AWS-track lab, deliberately backed by a local container.
      expect(lab.environment.provider, id).toBe('linux');
      // Never declared in the YAML; derived from the provider, so the lab
      // cannot claim an isolation model its provider does not deliver.
      expect(lab.environment.isolation, id).toBe('container');
    }
  });

  it('appears in the catalog under a track that declares its own title', async () => {
    const registry = await realRegistry();
    const track = registry.tracks().find((t) => t.track === 'aws');

    expect(track).toBeDefined();
    expect(track?.title).toBe('AWS');
    expect(track?.labCount).toBe(5);
  });
});

// ------------------------------------------- 2. no real-AWS dependency at all

describe('AWS-001 needs nothing from AWS', () => {
  it('asks only for checks the Linux sandbox can already answer', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('aws')) {
      const lab = registry.get(summary.id);
      const supported = PROVIDER_REQUIREMENT_FAMILIES[lab.environment.provider];
      const families = [...lab.requirements, ...lab.setup.verify].map((r) =>
        requirementFamily(r.type),
      );

      for (const family of families) {
        expect(supported, `${lab.id} declares a ${family} check`).toContain(family);
        expect(['filesystem', 'iam']).toContain(family);
      }
    }
  });

  it('grades the policy labs entirely through the IAM family', async () => {
    const registry = await realRegistry();

    for (const id of ['AWS-002', 'AWS-003', 'AWS-004']) {
      const families = new Set(registry.get(id).requirements.map((r) => requirementFamily(r.type)));
      expect(families, id).toEqual(new Set(['iam']));
    }
  });

  it('adds no requirement type beyond the five already committed', async () => {
    const registry = await realRegistry();
    const used = new Set(
      registry
        .labsForTrack('aws')
        .flatMap((l) => [...registry.get(l.id).requirements, ...registry.get(l.id).setup.verify])
        .map((r) => r.type)
        .filter((t) => t.startsWith('iam_')),
    );

    expect([...used].sort()).toEqual(
      ['iam_policy_allows', 'iam_policy_document', 'iam_policy_no_wildcard', 'iam_policy_not_allows', 'iam_policy_statement']
        .filter((t) => used.has(t as never))
        .sort(),
    );
    for (const type of used) {
      expect([
        'iam_policy_allows', 'iam_policy_document', 'iam_policy_no_wildcard',
        'iam_policy_not_allows', 'iam_policy_statement',
      ]).toContain(type);
    }
  });

  it('lets the Linux provider answer IAM checks, because they are a file parse', () => {
    expect(PROVIDER_REQUIREMENT_FAMILIES.linux).toContain('iam');
  });

  it('refuses an IAM check that points outside the sandbox', () => {
    const base = {
      id: 'AWS-999',
      slug: 'aws-999-probe',
      title: 'Probe',
      track: 'aws',
      topic: 'aws-identity',
      difficulty: 'beginner',
      duration_minutes: 10,
      environment: { provider: 'linux' },
      story: 'x',
      objectives: ['x'],
      task: { summary: 'x', description: 'x' },
      hints: [{ level: 1, text: 'x' }],
      references: [{ title: 'AWS', url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies.html' }],
    };

    for (const escape of ['../../../etc/passwd', '~/.aws/credentials', '/etc/shadow; cat /etc/passwd']) {
      const yaml = JSON.stringify({
        ...base,
        requirements: [{ type: 'iam_policy_document', path: escape }],
      });
      expect(() => parseLabDefinition(yaml, 'probe.yaml'), escape).toThrow(LabDefinitionError);
    }
  });

  it('does not require the aws provider family, which is still empty', () => {
    // The real-AWS verifier is Gate C work and is deliberately not built. If
    // this ever becomes non-empty, that decision was taken somewhere else and
    // this lab's SIMULATED claim needs re-reading.
    expect(PROVIDER_REQUIREMENT_FAMILIES.aws).toEqual([]);
  });

  it('names no AWS credential, account id or region in its seed scripts', async () => {
    const registry = await realRegistry();
    const loaded = await Promise.all(
      registry.labsForTrack('aws').map((l) => loadSeedScripts(registry.get(l.id))),
    );
    const body = loaded.flat().map((s) => s.content).join('\n');

    // The fixtures use AWS's own documentation example keys and the
    // documentation placeholder account id, and nothing else.
    expect(body).not.toMatch(/AKIA(?!I|IOSFODNN7EXAMPLE)[A-Z0-9]{16}/);
    expect(body).toContain('SIMULATED ENVIRONMENT');
    expect(body).not.toContain('aws sts assume-role');
  });

  it('ships an executable seed script inside the size cap for every lab', async () => {
    const registry = await realRegistry();

    for (const summary of registry.labsForTrack('aws')) {
      const scripts = await loadSeedScripts(registry.get(summary.id));
      expect(scripts, summary.id).toHaveLength(1);
      expect(scripts[0]!.content.startsWith('#!'), summary.id).toBe(true);
      expect(Buffer.byteLength(scripts[0]!.content, 'utf8')).toBeLessThanOrEqual(MAX_SEED_SCRIPT_BYTES);
    }
  });
});

// --------------------------------------------- 3. official-source compliance

describe('AWS-001 official documentation validation', () => {
  it('cites at least one official AWS documentation host in every lab', async () => {
    const registry = await realRegistry();
    const official = OFFICIAL_DOC_HOSTS.aws ?? [];
    expect(official.length).toBeGreaterThan(0);

    for (const summary of registry.labsForTrack('aws')) {
      const hosts = registry
        .get(summary.id)
        .references.map((r) => new URL(r.url).hostname.toLowerCase());
      expect(hosts.some((h) => official.includes(h)), summary.id).toBe(true);
    }
  });

  it('cites no banned third-party training host, and uses https throughout', async () => {
    const registry = await realRegistry();
    const references = registry
      .labsForTrack('aws')
      .flatMap((summary) => registry.get(summary.id).references);

    for (const reference of references) {
      const host = new URL(reference.url).hostname.toLowerCase();
      expect(reference.url.startsWith('https://')).toBe(true);
      for (const banned of DISALLOWED_DOC_HOSTS) {
        expect(host === banned || host.endsWith(`.${banned}`)).toBe(false);
      }
    }
  });

  it('claims no certification objective for the production-skill labs', async () => {
    const registry = await realRegistry();

    // AWS-001: SOA-C03 has no task statement for ARN anatomy or the CLI
    // credential provider chain. AWS-005: privilege-escalation analysis via
    // iam:PassRole is likewise unnamed by any current task statement, and
    // 4.1.2 requires AWS tools neither lab uses.
    expect(registry.get('AWS-001').certification).toEqual([]);
    expect(registry.get('AWS-005').certification).toEqual([]);
  });

  it('claims only SOA-C03 for the policy-authoring labs', async () => {
    const registry = await realRegistry();

    for (const id of ['AWS-002', 'AWS-003', 'AWS-004']) {
      const claims = registry.get(id).certification;
      expect(claims, id).toHaveLength(1);
      expect(claims[0]?.certification, id).toBe('SOA-C03');
      expect(claims[0]?.relevant, id).toBe(true);
    }
  });
});

// ----------------------------------------------- 4. other tracks unaffected

describe('adding the AWS track leaves the shipped tracks alone', () => {
  it('keeps every other track exactly as the labs directory declares it', async () => {
    const registry = await realRegistry();
    const disk = await scanLabsDirectory(LABS_DIR);

    for (const track of ['kubernetes', 'docker', 'linux', 'terraform']) {
      expect(registry.labsForTrack(track).map((l) => l.id)).toEqual(disk.idsForTrack(track));
      expect(registry.labsForTrack(track)).toHaveLength(disk.labCountForTrack(track));
    }
  });

  it('does not disturb the relative order of the tracks that were already here', async () => {
    const registry = await realRegistry();
    const order = registry.tracks().map((t) => t.track);
    const withoutAws = order.filter((t) => t !== 'aws');

    expect(withoutAws).toEqual(['kubernetes', 'docker', 'linux', 'terraform']);
  });

  it('uses a lab id and slug no other track had', async () => {
    const disk = await scanLabsDirectory(LABS_DIR);

    expect(disk.ids.filter((id) => id === 'AWS-001')).toHaveLength(1);
    const slugs = disk.labs.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
