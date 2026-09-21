/**
 * Terraform shortcuts found by the 2026-09-20 lab certification pass, each
 * reproduced first with a real Terraform 1.9.8 apply in the lab image, then
 * graded here against the lab's own requirement: the shortcut fails, and the
 * solution the level-3 hint describes still passes.
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

/** The lab's requirement with this label — labels are unique within a lab. */
async function status(labId: string, label: string, files: Record<string, string>) {
  const lab = (await realCatalog()).get(labId);
  const found = lab.requirements.filter((r) => r.label === label);
  expect(found, `${labId}: ${label}`).toHaveLength(1);
  return (await verifyRequirement(found[0]!, sandbox(files))).status;
}

// ------------------------------------------------------------------ TF-018

describe('TF-018 — the derived values are computed, not typed in', () => {
  const LABEL = 'The four derived values are named local values';
  const VARS = `
variable "environment" {
  type    = string
  default = "production"
}
variable "services" {
  type = map(object({ tier = string, replicas = number }))
}
`;

  it('passes the locals the hint describes', async () => {
    const main = `${VARS}
locals {
  service_summary = [for name, s in var.services : format("%s(%d)", name, s.replicas)]
  gold_services   = sort([for name, s in var.services : name if s.tier == "gold"])
  replica_factor  = var.environment == "production" ? 2 : 1
  scaled_replicas = sum([for s in var.services : s.replicas]) * local.replica_factor
}
`;
    expect(await status('TF-018', LABEL, { 'main.tf': main })).toBe('pass');
  });

  it('fails the answers the task prints, typed into the locals', async () => {
    // Before: all fourteen checks passed on a real apply of exactly this.
    const main = `${VARS}
locals {
  service_summary = [for name, s in var.services : format("%s(%d)", name, s.replicas)]
  gold_services   = ["auth", "ledger"]
  replica_factor  = 2
  scaled_replicas = 12
}
`;
    expect(await status('TF-018', LABEL, { 'main.tf': main })).toBe('fail');
  });
});

// ------------------------------------------------------------------ TF-017

describe('TF-017 — the omitted attribute gets its value from the type', () => {
  const LABEL = 'The debug attribute is declared optional rather than required';
  const declared = (debug: string) => `
variable "environments" {
  type = map(object({
    region   = string
    replicas = number
    debug    = ${debug}
  }))
}
`;

  it('passes optional(bool, false), however it is spaced', async () => {
    expect(await status('TF-017', LABEL, { 'main.tf': declared('optional(bool, false)') })).toBe('pass');
    expect(await status('TF-017', LABEL, { 'main.tf': declared('optional( bool , false )') })).toBe('pass');
  });

  it('fails optional(bool) with no default', async () => {
    // Before: passed, and adding `debug = false` to the platform team's tfvars
    // — the file the task says not to edit — then produced the right manifest.
    expect(await status('TF-017', LABEL, { 'main.tf': declared('optional(bool)') })).toBe('fail');
  });
});

// ------------------------------------------------------------------ TF-025

describe('TF-025 — the postcondition asserts that a region was read', () => {
  const LABEL = 'The data source asserts what it actually read';
  const data = (condition: string) => `
data "local_file" "platform" {
  filename = "\${path.module}/platform.json"
  lifecycle {
    postcondition {
      condition     = ${condition}
      error_message = "platform.json does not name a region."
    }
  }
}
`;

  it.each([
    'can(jsondecode(self.content).region)',
    'contains(keys(jsondecode(self.content)), "region")',
    'strcontains(self.content, "region")',
  ])('passes %s', async (condition) => {
    expect(await status('TF-025', LABEL, { 'main.tf': data(condition) })).toBe('pass');
  });

  it('fails a postcondition that only asks whether anything was read', async () => {
    // Before: passed all eleven checks on a real apply.
    expect(await status('TF-025', LABEL, { 'main.tf': data('length(self.content) > 0') })).toBe('fail');
  });
});

// ------------------------------------------------------------------ TF-002

describe('TF-002 — each variable has the type the task names', () => {
  const variables = (environment: string, replicas: string, debug: string) => `
variable "environment" { type = ${environment} }
variable "replicas" {
  type    = ${replicas}
  default = 2
}
variable "debug" {
  type    = ${debug}
  default = true
}
`;
  const labels = [
    'A typed environment variable is declared, with no default',
    'A typed replicas variable is declared, with a default',
    'A typed debug variable is declared, with a default',
  ];

  it('passes string, number and bool', async () => {
    const files = { 'variables.tf': variables('string', 'number', 'bool') };
    for (const label of labels) expect(await status('TF-002', label, files)).toBe('pass');
  });

  it('fails `type = any`, which constrains nothing', async () => {
    const files = { 'variables.tf': variables('any', 'any', 'any') };
    for (const label of labels) expect(await status('TF-002', label, files)).toBe('fail');
  });
});

// ------------------------------------------------------------------ TF-003

describe('TF-003 — each output is taken from where the task says', () => {
  const labels = [
    'service_name is taken from a local value',
    'release_channel is taken from the input variable',
    "manifest_path is taken from the resource's own attribute",
    'deploy_token is taken from its variable',
  ];
  const BASE = `
variable "channel" { default = "stable" }
variable "deploy_token" { default = "not-a-real-token-placeholder" }
`;
  const grade = async (main: string) => {
    const out: string[] = [];
    for (const label of labels) out.push(await status('TF-003', label, { 'main.tf': BASE + main }));
    return out;
  };

  it('passes outputs built from the local, the variables and the resource', async () => {
    const main = `
locals { service = "ledger-api" }
resource "local_file" "release_manifest" { filename = "build/release-manifest.txt" }
output "service_name"    { value = local.service }
output "release_channel" { value = var.channel }
output "manifest_path"   { value = local_file.release_manifest.filename }
output "deploy_token" {
  value     = var.deploy_token
  sensitive = true
}
`;
    expect(await grade(main)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('passes a renamed resource and restructured locals, as the task allows', async () => {
    const main = `
locals {
  names   = { service = "ledger-api" }
  service = local.names.service
}
resource "local_file" "manifest" { filename = "build/release-manifest.txt" }
output "service_name"    { value = local.service }
output "release_channel" { value = upper(var.channel) == "STABLE" ? var.channel : "stable" }
output "manifest_path"   { value = abspath(local_file.manifest.filename) }
output "deploy_token" {
  value     = var.deploy_token
  sensitive = true
}
`;
    expect(await grade(main)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('fails outputs typed out as literals, which passed every check on a real apply', async () => {
    const main = `
output "service_name"    { value = "ledger-api" }
output "release_channel" { value = "stable" }
output "manifest_path"   { value = "build/release-manifest.txt" }
output "deploy_token" {
  value     = "not-a-real-token-placeholder"
  sensitive = true
}
`;
    expect(await grade(main)).toEqual(['fail', 'fail', 'fail', 'fail']);
  });
});
