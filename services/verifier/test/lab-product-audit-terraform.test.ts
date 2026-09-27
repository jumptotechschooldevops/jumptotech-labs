/**
 * Terraform labs: defects found by the 2026-09-21 lab product audit, pinned so
 * they stay closed. Each world is stated explicitly: files as the sandbox would
 * report them, directories where the lab needs them, and a `list` that returns
 * only the top-level `.tf` files of a directory (as the real port does).
 */
import { describe, expect, it } from 'vitest';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import type { SandboxPort } from '../src/sandbox-reader.js';

type World = { files: Record<string, string>; dirs?: string[] };

function port(world: World): SandboxPort {
  return {
    async read(relativePath) {
      if (world.dirs?.includes(relativePath)) {
        return { type: 'directory', mode: '755', owner: 'student', group: 'student', sizeBytes: 0 };
      }
      const content = world.files[relativePath];
      if (content === undefined) return null;
      return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
    },
    async list(dir, opts) {
      const prefix = `${dir}/`;
      return Object.keys(world.files)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
        .filter((n) => !n.includes('/') && (!opts?.suffix || n.endsWith(opts.suffix)));
    },
  };
}

async function run(labId: string, world: World) {
  const lab = (await realCatalog()).get(labId);
  const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001', sandbox: port(world) });
  expect(result.error).toBeUndefined();
  return result.checks;
}
const failing = (checks: Awaited<ReturnType<typeof run>>) =>
  checks.filter((c) => c.status !== 'pass').map((c) => ({ label: c.label, detail: c.detail }));

const INIT = {
  'terraform/.terraform.lock.hcl': '# lock\n',
};
const INIT_DIRS = ['terraform', 'terraform/.terraform'];

function state(resources: Array<{ type: string; name: string; mode?: string }>, outputs: Record<string, unknown> = {}) {
  return JSON.stringify(
    {
      version: 4,
      terraform_version: '1.9.8',
      serial: 2,
      lineage: 'x',
      outputs,
      resources: resources.map((r) => ({
        mode: r.mode ?? 'managed',
        type: r.type,
        name: r.name,
        provider: 'provider["registry.terraform.io/hashicorp/local"]',
        instances: [{ schema_version: 0, attributes: {} }],
      })),
    },
    null,
    2,
  );
}

describe('TF-003 — a forgotten sensitive = true is reported without printing the token', () => {
  const TOKEN = 'not-a-real-token-placeholder';
  // `terraform output` sorts by name, so deploy_token is the first line.
  const OUTPUTS_TXT_UNMARKED = [
    `deploy_token = "${TOKEN}"`,
    'manifest_path = "build/release-manifest.txt"',
    'release_channel = "stable"',
    'release_summary = {',
    '  "channel" = "stable"',
    '  "manifest" = "build/release-manifest.txt"',
    '  "service" = "ledger-api"',
    '}',
    'service_name = "ledger-api"',
    '',
  ].join('\n');

  it('fails the listing, and no failure detail anywhere in the lab repeats the token', async () => {
    const checks = await run('TF-003', {
      files: {
        ...INIT,
        'terraform/main.tf': 'locals { service = "ledger-api" }\n',
        'terraform/outputs.txt': OUTPUTS_TXT_UNMARKED,
        'terraform/manifest-path.txt': 'build/release-manifest.txt\n',
        'terraform/build/release-manifest.txt': 'service: ledger-api\n',
        'terraform/terraform.tfstate': state([{ type: 'local_file', name: 'release_manifest' }], {
          service_name: { value: 'ledger-api', type: 'string' },
          release_channel: { value: 'stable', type: 'string' },
          manifest_path: { value: 'build/release-manifest.txt', type: 'string' },
          release_summary: {
            value: { service: 'ledger-api', channel: 'stable', manifest: 'build/release-manifest.txt' },
            type: ['object', {}],
          },
          deploy_token: { value: TOKEN, type: 'string' },
        }),
      },
      dirs: INIT_DIRS,
    });
    const sensitive = checks.find((c) => c.label === 'An output is marked sensitive, so the listing redacts it')!;
    expect(sensitive.status).toBe('fail');
    // Before: this detail quoted the listing's first line — the token itself.
    for (const check of checks) expect(check.detail ?? '', check.label).not.toContain(TOKEN);
  });
});

// ------------------------------------------------------------------ TF-025

describe('TF-025 — the check block asserts something about the manifest', () => {
  const BASE = `
variable "environment" {
  type    = string
  default = "production"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

data "local_file" "platform" {
  filename = "platform.json"
  lifecycle {
    postcondition {
      condition     = can(jsondecode(self.content).region)
      error_message = "platform.json has no region."
    }
  }
}

locals {
  settings = jsondecode(data.local_file.platform.content)
}

resource "local_file" "release_manifest" {
  filename = "build/\${var.environment}.json"
  content = jsonencode({
    environment = var.environment
    region      = local.settings.region
    replicas    = local.settings.replicas
  })
  lifecycle {
    precondition {
      condition     = local.settings.replicas >= 0
      error_message = "replicas must be positive."
    }
  }
}
`;
  const world = (check: string): World => ({
    files: {
      ...INIT,
      'terraform/main.tf': BASE + check,
      'terraform/platform.json': '{"region":"eu-central-1","replicas":6}',
      'terraform/build/production.json': '{"environment":"production","region":"eu-central-1","replicas":6}',
      'terraform/terraform.tfstate': state([
        { type: 'local_file', name: 'release_manifest' },
        { type: 'local_file', name: 'platform', mode: 'data' },
      ]),
    },
    dirs: INIT_DIRS,
  });

  const check = (condition: string, scoped = '') => `
check "manifest_is_populated" {
${scoped}  assert {
    condition     = ${condition}
    error_message = "The manifest is empty."
  }
}
`;
  const status = async (hcl: string) =>
    (await run('TF-025', world(hcl))).find((c) => c.label === 'A check block reports on the manifest without blocking the apply')?.status;

  it('refuses `assert { condition = true }`', async () => {
    // Before: passed.
    expect(await status(check('true'))).toBe('fail');
  });

  it('passes an assertion on the resource content', async () => {
    expect(await status(check('length(local_file.release_manifest.content) > 0'))).toBe('pass');
  });

  it('passes an assertion through a data source scoped to the check', async () => {
    const scoped = '  data "local_file" "manifest" {\n    filename = local_file.release_manifest.filename\n  }\n';
    expect(await status(check('length(data.local_file.manifest.content) > 0', scoped))).toBe('pass');
  });
});
