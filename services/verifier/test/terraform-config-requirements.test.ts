/**
 * Terraform configuration checks — semantic, static, and inert.
 *
 * Three properties are defended here, in order of how much damage their loss
 * would do:
 *
 *   1. **A literal is not a reference.** `content = "local_file.a.id"` must not
 *      satisfy a dependency requirement that `content = local_file.a.id` does.
 *      This is the whole reason the capability exists, and it is what closes
 *      TF-005's known limitation.
 *   2. **Reading configuration never runs it.** Student configuration is
 *      untrusted input; a provisioner, an external data source and a function
 *      call are all just text.
 *   3. **Nothing leaks.** A failure names blocks, arguments and files — never
 *      an expected value and never the student's expression.
 */
import { describe, expect, it } from 'vitest';
import { verifyRequirement } from '../src/registry.js';
import { SandboxReader, type SandboxPort } from '../src/sandbox-reader.js';

const DIR = 'terraform';

/** A sandbox whose configuration is the files a test names. */
function config(files: Record<string, string>, options: { canList?: boolean } = {}): SandboxReader {
  const reads: string[] = [];
  const port: SandboxPort = {
    async read(relativePath) {
      reads.push(relativePath);
      const name = relativePath.startsWith(`${DIR}/`) ? relativePath.slice(DIR.length + 1) : null;
      if (name === null || files[name] === undefined) return null;
      return {
        type: 'file',
        mode: '644',
        owner: 'student',
        group: 'student',
        sizeBytes: files[name].length,
        content: files[name],
      };
    },
  };
  if (options.canList !== false) {
    port.list = async (dir, opts) => {
      if (dir !== DIR) return [];
      return Object.keys(files).filter((n) => !opts?.suffix || n.endsWith(opts.suffix));
    };
  }
  const reader = new SandboxReader(port);
  (reader as unknown as { reads: string[] }).reads = reads;
  return reader;
}

const check = (reader: SandboxReader, requirement: Record<string, unknown>) =>
  verifyRequirement({ dir: DIR, ...requirement } as never, reader);

// ================================================ literal versus reference

describe('a dependency requirement is not satisfied by a literal', () => {
  const REQ = {
    type: 'terraform_resource_references',
    resource_type: 'local_file',
    name: 'b',
    attribute: 'content',
    references: 'local_file.a',
  };

  it('passes on a bare reference', async () => {
    const reader = config({
      'main.tf': 'resource "local_file" "b" { content = local_file.a.id }',
    });
    expect((await check(reader, REQ)).status).toBe('pass');
  });

  it('passes on an interpolated reference', async () => {
    const reader = config({
      'main.tf': 'resource "local_file" "b" { content = "sha: ${local_file.a.content_sha256}" }',
    });
    expect((await check(reader, REQ)).status).toBe('pass');
  });

  it('FAILS on a literal string that looks exactly like the address', async () => {
    const reader = config({
      'main.tf': 'resource "local_file" "b" { content = "local_file.a.id" }',
    });
    const result = await check(reader, REQ);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('is not a reference');
  });

  it('FAILS on a hardcoded value even when it is the right value', async () => {
    // This is TF-005's limitation, closed.
    const reader = config({
      'main.tf':
        'resource "local_file" "b" { content = "sha: d0e6aa155b3c5c346148dc7165a8a0bd33b9ce295eaddd8a72aba4ffdd53118f" }',
    });
    expect((await check(reader, REQ)).status).toBe('fail');
  });

  it('can require the reference to reach a particular attribute', async () => {
    const reader = config({
      'main.tf': 'resource "local_file" "b" { content = local_file.a.id }',
    });
    const wrong = await check(reader, { ...REQ, referenced_attribute: 'content_sha256' });
    expect(wrong.status).toBe('fail');
    const right = await check(reader, { ...REQ, referenced_attribute: 'id' });
    expect(right.status).toBe('pass');
  });

  it('follows a reference through a local value, because Terraform does', async () => {
    // `local.digest` is a named expression. Referring to it creates the same
    // edge as referring to the resource directly, so factoring a configuration
    // this way must not fail a dependency check.
    const reader = config({
      'main.tf': `
        locals { digest = local_file.a.content_sha256 }
        resource "local_file" "b" { content = "sha: \${local.digest}" }
      `,
    });
    expect((await check(reader, REQ)).status).toBe('pass');
    expect(
      (await check(reader, { ...REQ, referenced_attribute: 'content_sha256' })).status,
    ).toBe('pass');
  });

  it('follows a chain of locals, and is not hung by a cycle', async () => {
    const chained = config({
      'main.tf': `
        locals {
          one = local_file.a.id
          two = local.one
        }
        resource "local_file" "b" { content = local.two }
      `,
    });
    expect((await check(chained, REQ)).status).toBe('pass');

    const cyclic = config({
      'main.tf': `
        locals {
          x = local.y
          y = local.x
        }
        resource "local_file" "b" { content = local.x }
      `,
    });
    expect((await check(cyclic, REQ)).status).toBe('fail');
  });

  it('does not follow a local that leads somewhere else', async () => {
    const reader = config({
      'main.tf': `
        locals { digest = local_file.other.id }
        resource "local_file" "b" { content = local.digest }
      `,
    });
    expect((await check(reader, REQ)).status).toBe('fail');
  });

  it('reports a missing resource and a missing argument differently', async () => {
    const noResource = await check(config({ 'main.tf': 'resource "local_file" "z" {}' }), REQ);
    expect(noResource.detail).toContain('No resource');
    const noArgument = await check(
      config({ 'main.tf': 'resource "local_file" "b" { filename = "x" }' }),
      REQ,
    );
    expect(noArgument.detail).toContain("sets no 'content'");
  });
});

// ============================================================== discovery

describe('block discovery', () => {
  it('finds variables, and reports shape without quoting values', async () => {
    const reader = config({
      'variables.tf': `
        variable "channel" {
          type    = string
          default = "stable"
        }
        variable "envs" {
          type = map(object({ replicas = number }))
        }
      `,
    });
    expect((await check(reader, { type: 'terraform_variable_declared', name: 'channel' })).status).toBe('pass');
    expect(
      (await check(reader, { type: 'terraform_variable_declared', name: 'channel', has_default: true })).status,
    ).toBe('pass');
    expect(
      (await check(reader, { type: 'terraform_variable_declared', name: 'envs', has_default: true })).status,
    ).toBe('fail');
    expect(
      (await check(reader, {
        type: 'terraform_variable_declared',
        name: 'envs',
        type_contains: 'map(object(',
      })).status,
    ).toBe('pass');
    const missing = await check(reader, { type: 'terraform_variable_declared', name: 'nope' });
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain('channel');
  });

  it('finds locals across files', async () => {
    const reader = config({
      'a.tf': 'locals { service = "ledger" }',
      'b.tf': 'locals { region = "eu-west-1" }',
    });
    expect(
      (await check(reader, { type: 'terraform_locals_declared', names: ['service', 'region'] })).status,
    ).toBe('pass');
    expect(
      (await check(reader, { type: 'terraform_locals_declared', names: ['service', 'absent'] })).status,
    ).toBe('fail');
  });

  it('finds data sources, and does not confuse them with resources', async () => {
    const reader = config({
      'main.tf': `
        resource "local_file" "seed" { filename = "x" }
        data "local_file" "seed" { filename = "x" }
      `,
    });
    expect(
      (await check(reader, { type: 'terraform_data_source_declared', data_type: 'local_file', name: 'seed' })).status,
    ).toBe('pass');
    expect(
      (await check(reader, { type: 'terraform_data_source_declared', data_type: 'local_file', name: 'other' })).status,
    ).toBe('fail');
  });

  it('finds depends_on and the addresses it names', async () => {
    const reader = config({
      'main.tf': 'resource "local_file" "b" { depends_on = [null_resource.db, local_file.a] }',
    });
    expect(
      (await check(reader, {
        type: 'terraform_resource_depends_on',
        resource_type: 'local_file',
        name: 'b',
        references: ['null_resource.db'],
      })).status,
    ).toBe('pass');
    expect(
      (await check(reader, {
        type: 'terraform_resource_depends_on',
        resource_type: 'local_file',
        name: 'b',
        references: ['null_resource.missing'],
      })).status,
    ).toBe('fail');
  });

  it('finds validation, preconditions and check blocks', async () => {
    const reader = config({
      'main.tf': `
        variable "env" {
          type = string
          validation {
            condition     = contains(["dev", "prod"], var.env)
            error_message = "env must be dev or prod."
          }
        }
        resource "local_file" "a" {
          filename = "x"
          lifecycle {
            precondition {
              condition     = length(var.env) > 0
              error_message = "needs an env."
            }
          }
        }
        check "health" {
          assert {
            condition     = fileexists("x")
            error_message = "missing."
          }
        }
      `,
    });
    expect((await check(reader, { type: 'terraform_variable_validation', name: 'env' })).status).toBe('pass');
    expect(
      (await check(reader, { type: 'terraform_variable_validation', name: 'env', condition_mentions: ['contains'] })).status,
    ).toBe('pass');
    expect(
      (await check(reader, { type: 'terraform_variable_validation', name: 'env', condition_mentions: ['startswith'] })).status,
    ).toBe('fail');
    expect(
      (await check(reader, {
        type: 'terraform_resource_condition',
        resource_type: 'local_file',
        name: 'a',
        condition: 'precondition',
      })).status,
    ).toBe('pass');
    expect(
      (await check(reader, {
        type: 'terraform_resource_condition',
        resource_type: 'local_file',
        name: 'a',
        condition: 'postcondition',
      })).status,
    ).toBe('fail');
    expect((await check(reader, { type: 'terraform_check_declared', name: 'health' })).status).toBe('pass');
    expect(
      (await check(reader, { type: 'terraform_check_declared', name: 'health', min_assertions: 2 })).status,
    ).toBe('fail');
  });
});

// ============================================================ normalisation

describe('formatting must not decide the outcome', () => {
  const REQ = {
    type: 'terraform_resource_references',
    resource_type: 'local_file',
    name: 'b',
    attribute: 'content',
    references: 'local_file.a',
  };

  it('is unaffected by whitespace and comments', async () => {
    const tidy = config({ 'main.tf': 'resource "local_file" "b" {\n  content = local_file.a.id\n}' });
    const messy = config({
      'main.tf':
        '\n\n# a note about local_file.decoy\nresource   "local_file"   "b"   {\n\n\t content=local_file.a.id   // trailing\n\n}\n',
    });
    expect((await check(tidy, REQ)).status).toBe('pass');
    expect((await check(messy, REQ)).status).toBe('pass');
  });

  it('is unaffected by which .tf file a block lives in, or their order', async () => {
    const split = config({
      'z-resources.tf': 'resource "local_file" "b" { content = local_file.a.id }',
      'a-variables.tf': 'variable "channel" { default = "stable" }',
    });
    expect((await check(split, REQ)).status).toBe('pass');
    expect((await check(split, { type: 'terraform_variable_declared', name: 'channel' })).status).toBe('pass');
  });

  it('does not require main.tf to exist at all', async () => {
    const odd = config({ 'everything-else.tf': 'resource "local_file" "b" { content = local_file.a.id }' });
    expect((await check(odd, REQ)).status).toBe('pass');
  });

  it('reads whatever structure it can from invalid HCL rather than crashing', async () => {
    const broken = config({ 'main.tf': 'resource "local_file" "b" { content = "unterminated' });
    const result = await check(broken, REQ);
    expect(['pass', 'fail']).toContain(result.status);
  });
});

// ================================================================ security

describe('security', () => {
  it('never executes configuration — a provisioner is only text', async () => {
    const reader = config({
      'main.tf': `
        resource "null_resource" "x" {
          provisioner "local-exec" { command = "touch /tmp/PWNED" }
          triggers = { f = file("/etc/passwd"), n = timestamp() }
        }
        data "external" "e" { program = ["/bin/sh", "-c", "id"] }
      `,
    });
    const result = await check(reader, {
      type: 'terraform_resource_references',
      resource_type: 'null_resource',
      name: 'x',
      attribute: 'triggers',
      references: 'local_file.a',
    });
    // It read the block and reported a missing reference. Nothing ran.
    expect(result.status).toBe('fail');
  });

  it('only ever reads inside the directory the lab named', async () => {
    const reader = config({ 'main.tf': 'resource "local_file" "b" { content = local_file.a.id }' });
    await check(reader, {
      type: 'terraform_resource_references',
      resource_type: 'local_file',
      name: 'b',
      attribute: 'content',
      references: 'local_file.a',
    });
    const reads = (reader as unknown as { reads: string[] }).reads;
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.startsWith(`${DIR}/`)).toBe(true);
  });

  it('cannot be pointed outside its own sandbox — the port is fixed at construction', async () => {
    // Two readers, two worlds. A requirement names a directory, never a sandbox.
    const solved = config({ 'main.tf': 'resource "local_file" "b" { content = local_file.a.id }' });
    const unsolved = config({ 'main.tf': 'resource "local_file" "b" { content = "local_file.a.id" }' });
    const requirement = {
      type: 'terraform_resource_references',
      resource_type: 'local_file',
      name: 'b',
      attribute: 'content',
      references: 'local_file.a',
    };
    expect((await check(solved, requirement)).status).toBe('pass');
    expect((await check(unsolved, requirement)).status).toBe('fail');
  });

  it('skips rather than fails when the sandbox cannot list files', async () => {
    const reader = config({ 'main.tf': 'resource "local_file" "b" {}' }, { canList: false });
    const result = await check(reader, { type: 'terraform_variable_declared', name: 'x' });
    // A platform gap must never be reported as the student's mistake.
    expect(result.status).toBe('skipped');
  });

  it('never discloses the expected value or the student’s expression', async () => {
    const SECRET = 'NOT-A-REAL-SECRET-placeholder';
    const reader = config({
      'main.tf': `resource "local_file" "b" { content = "${SECRET}" }`,
    });
    const result = await check(reader, {
      type: 'terraform_resource_references',
      resource_type: 'local_file',
      name: 'b',
      attribute: 'content',
      references: 'local_file.a',
    });
    expect(result.status).toBe('fail');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
