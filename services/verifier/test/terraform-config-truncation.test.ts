/**
 * A Terraform file too large to be read whole cannot pass a configuration check.
 *
 * The configuration scan asks for 256 KiB per file, the sandbox read returns at
 * most 64 KiB, and the scan never looked at `truncated`: it parsed the first
 * 64 KiB as the whole file. Padding a resource block past the cap with comments
 * hid what came after it, so TF-002's `terraform_resource_literal_absent`
 * passed on a `main.tf` that still hard-coded `"production"`.
 */
import { describe, expect, it } from 'vitest';
import { verifyRequirement } from '../src/index.js';
import { SandboxReader, type SandboxPort } from '../src/sandbox-reader.js';

const CAP = 64 * 1024;

function sandboxWith(files: Record<string, string>): SandboxReader {
  const port: SandboxPort = {
    async read(path, options) {
      const text = files[path];
      if (text === undefined) return null;
      const max = Math.min(options?.maxBytes ?? CAP, CAP);
      return {
        type: 'file',
        mode: '644',
        owner: 'student',
        group: 'student',
        sizeBytes: text.length,
        content: text.slice(0, max),
        ...(text.length > max ? { truncated: true } : {}),
      };
    },
    async list(dir) {
      return Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1));
    },
  };
  return new SandboxReader(port);
}

const HEADER =
  'variable "environment" { type = string }\n' +
  'resource "local_file" "service_config" {\n' +
  '  filename = "${path.module}/build/${var.environment}.json"\n';

const LITERAL_ABSENT = {
  type: 'terraform_resource_literal_absent',
  dir: 'terraform',
  resource_type: 'local_file',
  name: 'service_config',
  literals: ['staging', 'production'],
} as const;

describe('a Terraform configuration larger than the read cap', () => {
  it('fails rather than judging only the part that was read', async () => {
    let padded = HEADER;
    while (padded.length < CAP + 1_000) padded += `  # ${'x'.repeat(78)}\n`;
    padded += '  content  = "production"\n}\n';

    const result = await verifyRequirement(LITERAL_ABSENT as never, {
      sandbox: sandboxWith({ 'terraform/main.tf': padded }),
    }, 0);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/too large/);
  });

  it('still judges a file of ordinary size on all of it', async () => {
    const hardcoded = await verifyRequirement(LITERAL_ABSENT as never, {
      sandbox: sandboxWith({ 'terraform/main.tf': `${HEADER}  content = "production"\n}\n` }),
    }, 0);
    expect(hardcoded.status).toBe('fail');

    const fixed = await verifyRequirement(LITERAL_ABSENT as never, {
      sandbox: sandboxWith({ 'terraform/main.tf': `${HEADER}  content = var.environment\n}\n` }),
    }, 0);
    expect(fixed.status).toBe('pass');
  });
});
