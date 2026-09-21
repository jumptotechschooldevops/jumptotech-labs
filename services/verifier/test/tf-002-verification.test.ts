/**
 * TF-002 — the "names no particular environment" rule is graded on the
 * configuration, not on the file's text.
 *
 * The seeded `main.tf` carries a comment that mentions production. A raw-text
 * check on the file failed every correct solution that kept it, and a
 * raw-text check cannot tell a note from a value in either direction. These
 * tests hold the lab's own requirement against the starter, a correct
 * solution, and solutions whose comments say the opposite of their code.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, loadSetupFiles } from '@jumptotech/lab-orchestrator';
import { verifyRequirement } from '../src/registry.js';
import { SandboxReader, type SandboxPort } from '../src/sandbox-reader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TF_002 = path.resolve(here, '../../../labs/terraform/tf-002-variables/lab.yaml');
const DIR = 'terraform';

/** A sandbox holding the given `terraform/` files. */
function config(files: Record<string, string>): SandboxReader {
  const port: SandboxPort = {
    async read(relativePath) {
      const name = relativePath.startsWith(`${DIR}/`) ? relativePath.slice(DIR.length + 1) : null;
      if (name === null || files[name] === undefined) return null;
      const content = files[name];
      return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
    },
    async list(dir, opts) {
      if (dir !== DIR) return [];
      return Object.keys(files).filter((n) => !opts?.suffix || n.endsWith(opts.suffix));
    },
  };
  return new SandboxReader(port);
}

async function lab() {
  return loadLabDefinition(TF_002);
}

/** The lab's own environment-literal requirement, exactly as shipped. */
async function literalRule() {
  const rules = (await lab()).requirements.filter((r) => r.type === 'terraform_resource_literal_absent');
  expect(rules).toHaveLength(1);
  return rules[0]!;
}

/** Every static configuration check the lab ships (the ones a file can decide). */
async function configRules() {
  return (await lab()).requirements.filter(
    (r) => r.type === 'terraform_resource_literal_absent' || r.type === 'terraform_resource_references' || r.type === 'terraform_variable_declared',
  );
}

async function seededMain(): Promise<string> {
  const files = await loadSetupFiles(await lab());
  return files.find((f) => f.path === 'terraform/main.tf')!.content.toString();
}

const VARIABLES = `
variable "environment" {
  type = string
}

variable "replicas" {
  type    = number
  default = 2
}

variable "debug" {
  type    = bool
  default = true
}
`;

const RESOURCE = `
resource "local_file" "service_config" {
  filename = "build/\${var.environment}.json"

  content = jsonencode({
    service     = "ledger-api"
    environment = var.environment
    replicas    = var.replicas
    debug       = var.debug
  })
}
`;

/** The seeded header comment, kept as a student editing in place would keep it. */
async function seededHeader(): Promise<string> {
  const main = await seededMain();
  return main.slice(0, main.indexOf('resource "'));
}

describe('TF-002 — the starter state', () => {
  it('keeps a comment that mentions production, which is what a raw-text check tripped on', async () => {
    expect((await seededMain()).toLowerCase()).toContain('production');
  });

  it('fails the rule because of its staging literals, not because of that comment', async () => {
    const rule = await literalRule();
    const main = await seededMain();
    const result = await verifyRequirement(rule, config({ 'main.tf': main }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('filename');
    expect(result.detail).toContain('content');

    // The starter with its literals parameterised but its comment intact
    // passes, so the comment was never what decided it.
    const withoutLiterals = main
      .replace('"build/staging.json"', '"build/${var.environment}.json"')
      .replace('environment = "staging"', 'environment = var.environment');
    expect((await verifyRequirement(rule, config({ 'main.tf': withoutLiterals }))).status).toBe('pass');
  });
});

describe('TF-002 — a correct solution', () => {
  it('passes every configuration check with the seeded production comment still in place', async () => {
    const reader = config({ 'main.tf': `${await seededHeader()}${VARIABLES}${RESOURCE}` });
    for (const rule of await configRules()) {
      const result = await verifyRequirement(rule, reader);
      expect({ label: rule.label, status: result.status }).toEqual({ label: rule.label, status: 'pass' });
    }
  });

  it('passes with an allowed-values validation that names both environments', async () => {
    const validated = VARIABLES.replace(
      'variable "environment" {\n  type = string\n}',
      'variable "environment" {\n  type = string\n  validation {\n    condition     = contains(["staging", "production"], var.environment)\n    error_message = "Unknown environment."\n  }\n}',
    );
    expect(validated).toContain('"production"');
    const result = await verifyRequirement(await literalRule(), config({ 'main.tf': `${validated}${RESOURCE}` }));
    expect(result.status).toBe('pass');
  });

  it('passes when the variables live in their own file', async () => {
    const result = await verifyRequirement(
      await literalRule(),
      config({ 'main.tf': RESOURCE, 'variables.tf': VARIABLES }),
    );
    expect(result.status).toBe('pass');
  });
});

describe('TF-002 — comments do not decide the result', () => {
  it('fails a hard-coded environment even when every comment claims otherwise', async () => {
    const hardCoded = `# This file names no environment.
${VARIABLES}
resource "local_file" "service_config" {
  // parameterised: see var.environment
  filename = "build/\${var.environment}.json"

  content = jsonencode({
    service     = "ledger-api"
    /* environment comes from var.environment */
    environment = var.environment == "" ? "Production" : var.environment
    replicas    = var.replicas
    debug       = var.debug
  })
}
`;
    const result = await verifyRequirement(await literalRule(), config({ 'main.tf': hardCoded }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('content');
    expect(result.detail).not.toContain('filename');
    // The failure names where, not what.
    expect(result.detail?.toLowerCase()).not.toContain('production');
  });

  it('does not let a comment inside a multi-line expression hide a literal after it', async () => {
    const hidden = `${VARIABLES}
resource "local_file" "service_config" {
  filename = "build/\${var.environment}.json"
  content = jsonencode({
    service     = "ledger-api" # comment before the hard-coded value
    environment = "staging"
    replicas    = var.replicas
    debug       = var.debug
  })
}
`;
    const result = await verifyRequirement(await literalRule(), config({ 'main.tf': hidden }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('content');
  });

  it('passes a correct solution whose comments, in every style, mention both environments', async () => {
    const commented = `# production and staging both build from this file.
// staging: -var environment=staging
/* production: -var environment=production */
${VARIABLES}
resource "local_file" "service_config" {
  filename = "build/\${var.environment}.json" # e.g. build/production.json

  content = jsonencode({
    service     = "ledger-api"
    environment = var.environment // staging or production
    replicas    = var.replicas    /* 4 in production */
    debug       = var.debug
  })
}
`;
    const result = await verifyRequirement(await literalRule(), config({ 'main.tf': commented }));
    expect(result.status).toBe('pass');
  });

  it('fails a literal filename, whatever the case it is written in', async () => {
    const literal = RESOURCE.replace('"build/${var.environment}.json"', '"build/PRODUCTION.json"');
    const result = await verifyRequirement(await literalRule(), config({ 'main.tf': `${VARIABLES}${literal}` }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('filename');
  });

  it('fails a hard-coded value in a heredoc', async () => {
    const heredoc = `${VARIABLES}
resource "local_file" "service_config" {
  filename = "build/\${var.environment}.json"
  content  = <<-EOT
    {"environment": "production", "e": "\${var.environment}", "r": \${var.replicas}, "d": \${var.debug}}
  EOT
}
`;
    const result = await verifyRequirement(await literalRule(), config({ 'main.tf': heredoc }));
    expect(result.status).toBe('fail');
  });
});

describe('TF-002 — a comment inside a multi-line expression is not part of it', () => {
  it('passes a correct solution with an end-of-line comment inside jsonencode', async () => {
    // Collapsed onto one line, the comment used to swallow every reference
    // after it: replicas and debug read as not taken from their variables.
    const commented = `${VARIABLES}
resource "local_file" "service_config" {
  filename = "build/\${var.environment}.json"

  content = jsonencode({
    service     = "ledger-api"
    environment = var.environment   # set per workspace
    replicas    = var.replicas
    debug       = var.debug
  })
}
`;
    for (const rule of await configRules()) {
      const result = await verifyRequirement(rule, config({ 'main.tf': commented }));
      expect(result.status, `${rule.type}: ${result.detail ?? ''}`).toBe('pass');
    }
  });
});
