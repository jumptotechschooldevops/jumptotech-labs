/**
 * Terraform labs whose task says "from the variable / the data / the
 * structure, not from a literal" — held to it.
 *
 * Each lab already checked that the resource *references* the right thing.
 * The second lab-quality audit found that one reference beside typed-in
 * values satisfied that: TF-006's region and tier transcribed next to one
 * read of the data source, TF-017's settings hard-coded next to one
 * `var.environments`, TF-018's `PRODUCTION` in capitals, TF-002's values
 * under their own keys with the variables tucked into extra ones. These tests
 * run each lab's own requirement against the shortcut and a correct solution.
 */
import { describe, expect, it } from 'vitest';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyRequirement } from '../src/registry.js';
import { SandboxReader, type SandboxPort } from '../src/sandbox-reader.js';

const DIR = 'terraform';

function sandbox(files: Record<string, string>): SandboxReader {
  const port: SandboxPort = {
    async read(relativePath) {
      const name = relativePath.startsWith(`${DIR}/`) ? relativePath.slice(DIR.length + 1) : null;
      if (name === null || files[name] === undefined) return null;
      const content = files[name];
      return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
    },
    async list(dir, opts) {
      if (dir !== DIR) return [];
      return Object.keys(files).filter((n) => !n.includes('/') && (!opts?.suffix || n.endsWith(opts.suffix)));
    },
  };
  return new SandboxReader(port);
}

async function rule(labId: string, type: string) {
  const lab = (await realCatalog()).get(labId);
  const found = lab.requirements.filter((r) => r.type === type);
  expect(found, `${labId} ${type}`).toHaveLength(1);
  return found[0]!;
}

const status = async (labId: string, type: string, files: Record<string, string>) =>
  (await verifyRequirement(await rule(labId, type), sandbox(files))).status;

describe('TF-006 — the manifest types in none of what it reads', () => {
  const PREAMBLE = `
data "local_file" "platform" { filename = "\${path.module}/platform.json" }
locals {
  service_prefix = "jumptotech"
  environment    = "prod"
  service_slug   = "\${local.service_prefix}-ledger-\${local.environment}"
  platform       = jsondecode(data.local_file.platform.content)
}
`;
  const manifest = (region: string, tier: string) => `
resource "local_file" "service_manifest" {
  filename = "build/\${local.service_slug}.json"
  content  = jsonencode({ slug = local.service_slug, region = ${region}, tier = ${tier} })
}
`;

  it('passes a manifest built from the local and the data source', async () => {
    const files = { 'main.tf': PREAMBLE + manifest('local.platform.region', 'local.platform.tier') };
    expect(await status('TF-006', 'terraform_resource_literal_absent', files)).toBe('pass');
    expect(await status('TF-006', 'terraform_locals_declared', files)).toBe('pass');
  });

  it('fails the tier transcribed beside one read of the data source', async () => {
    const files = { 'main.tf': PREAMBLE + manifest('local.platform.region', '"gold"') };
    expect(await status('TF-006', 'terraform_resource_literal_absent', files)).toBe('fail');
  });

  it('fails a slug written out rather than composed', async () => {
    const written = PREAMBLE.replace(
      'service_slug   = "${local.service_prefix}-ledger-${local.environment}"',
      'service_slug   = "jumptotech-ledger-prod"',
    );
    expect(written).not.toBe(PREAMBLE);
    const files = { 'main.tf': written + manifest('local.platform.region', 'local.platform.tier') };
    expect(await status('TF-006', 'terraform_locals_declared', files)).toBe('fail');
  });

  it('accepts the slug composed with join, through another local', async () => {
    const joined = PREAMBLE.replace(
      'service_slug   = "${local.service_prefix}-ledger-${local.environment}"',
      'parts          = [local.service_prefix, "ledger", local.environment]\n  service_slug   = join("-", local.parts)',
    );
    const files = { 'main.tf': joined + manifest('local.platform.region', 'local.platform.tier') };
    expect(await status('TF-006', 'terraform_locals_declared', files)).toBe('pass');
  });
});

describe('TF-017 — every key comes from the selected entry', () => {
  const VARS = `
variable "target" { type = string }
variable "environments" {
  type = map(object({ region = string, replicas = number, debug = optional(bool, false) }))
}
`;
  it('passes a manifest built from the structure', async () => {
    const main = `${VARS}
resource "local_file" "environment_manifest" {
  filename = "build/\${var.target}.json"
  content = jsonencode({
    environment = var.target
    region      = var.environments[var.target].region
    replicas    = var.environments[var.target].replicas
    debug       = var.environments[var.target].debug
  })
}
`;
    expect(await status('TF-017', 'terraform_resource_literal_absent', { 'main.tf': main })).toBe('pass');
  });

  it('fails the settings hard-coded beside one reference to the structure', async () => {
    const main = `${VARS}
resource "local_file" "environment_manifest" {
  filename = "build/\${var.target}.json"
  content = jsonencode({
    environment = "production"
    region      = "eu-central-1"
    replicas    = 6
    debug       = var.environments[var.target].debug
  })
}
`;
    expect(await status('TF-017', 'terraform_resource_literal_absent', { 'main.tf': main })).toBe('fail');
  });
});

describe('TF-018 — the environment line is not typed in capitals', () => {
  const LOCALS = `
variable "environment" { type = string }
variable "services" { type = map(object({ replicas = number, tier = string })) }
locals {
  service_summary = sort([for n, s in var.services : format("%s(%d)", n, s.replicas)])
  gold_services   = sort([for n, s in var.services : n if s.tier == "gold"])
  replica_factor  = var.environment == "production" ? 2 : 1
  scaled_replicas = sum([for s in values(var.services) : s.replicas]) * local.replica_factor
}
`;
  const resource = (environment: string) => `
resource "local_file" "release_manifest" {
  filename = "build/manifest.txt"
  content = templatefile("\${path.module}/manifest.tftpl", {
    environment = ${environment}
    services    = local.service_summary
    gold        = local.gold_services
    replicas    = local.scaled_replicas
  })
}
`;
  it('passes the variable upper-cased, with the comparison left in the local', async () => {
    expect(await status('TF-018', 'terraform_resource_literal_absent', { 'main.tf': LOCALS + resource('upper(var.environment)') })).toBe('pass');
  });

  it('fails PRODUCTION typed in, however the variable is still reached', async () => {
    expect(await status('TF-018', 'terraform_resource_literal_absent', { 'main.tf': LOCALS + resource('"PRODUCTION"') })).toBe('fail');
  });
});

describe('TF-002 — exactly the four keys it had', () => {
  it('passes the document jsonencode writes for production', async () => {
    const lab = (await realCatalog()).get('TF-002');
    const equals = lab.requirements.find((r) => r.type === 'file_content' && 'equals' in r && r.equals !== undefined);
    expect(equals).toBeDefined();
    const result = await verifyRequirement(
      equals!,
      sandbox({ 'build/production.json': '{"debug":false,"environment":"production","replicas":4,"service":"ledger-api"}' }),
    );
    expect(result.status).toBe('pass');
    const decoy = await verifyRequirement(
      equals!,
      sandbox({
        'build/production.json':
          '{"debug":false,"environment":"production","replicas":4,"service":"ledger-api","x_debug":true,"x_replicas":2}',
      }),
    );
    expect(decoy.status).toBe('fail');
  });
});
