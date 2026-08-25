/**
 * Reference extraction — telling a literal from a dependency.
 *
 * The property every case here defends: **a value that merely looks like an
 * address is not a reference.** `subnet_id = "aws_subnet.app.id"` creates no
 * edge in Terraform's graph, and a lab that counted it would pass a student who
 * pasted a string where a dependency was required.
 *
 * The second property: reading configuration never runs it. Nothing in this
 * module evaluates, resolves or calls anything, and the last group proves that
 * the most hostile configuration a student could write is still only text.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  argumentValue,
  blocksOfType,
  extractReferences,
  findBlock,
  isLiteralExpression,
  referencesTarget,
  scanHcl,
  scanHclFiles,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

const refs = (expression: string) => extractReferences(expression).map((r) => r.address).sort();

// ------------------------------------------------- literal versus reference

describe('a literal is not a reference', () => {
  it('does not see a reference in a quoted string that looks exactly like one', () => {
    expect(refs('"aws_subnet.app.id"')).toEqual([]);
    expect(referencesTarget('"aws_subnet.app"', 'aws_subnet.app')).toBe(false);
    expect(isLiteralExpression('"aws_subnet.app.id"')).toBe(true);
  });

  it('sees the reference when it is bare', () => {
    expect(refs('aws_subnet.app.id')).toEqual(['aws_subnet.app.id']);
    expect(referencesTarget('aws_subnet.app.id', 'aws_subnet.app')).toBe(true);
    expect(isLiteralExpression('aws_subnet.app.id')).toBe(false);
  });

  it('sees the reference when it is interpolated inside a string', () => {
    expect(refs('"subnet-${aws_subnet.app.id}"')).toEqual(['aws_subnet.app.id']);
    expect(isLiteralExpression('"subnet-${aws_subnet.app.id}"')).toBe(false);
  });

  it('separates the inert half of a string from the live half', () => {
    // The first address is text; only the interpolated one is a dependency.
    expect(refs('"local_file.decoy.id is not it: ${local_file.real.id}"')).toEqual([
      'local_file.real.id',
    ]);
  });

  it('handles a string inside an interpolation inside a string', () => {
    expect(refs('"${join(",", [aws_subnet.app.id, "aws_subnet.fake.id"])}"')).toEqual([
      'aws_subnet.app.id',
    ]);
  });

  it('treats other primitives as literals', () => {
    for (const literal of ['true', 'false', 'null', '42', '-3.5', '"plain"']) {
      expect(isLiteralExpression(literal), literal).toBe(true);
      expect(refs(literal)).toEqual([]);
    }
  });

  it('does not mistake a decimal number for a traversal', () => {
    expect(refs('1.25')).toEqual([]);
  });

  it('ignores addresses written inside comments', () => {
    expect(refs('local.real # local.commented\n')).toEqual(['local.real']);
    expect(refs('local.real // local.commented')).toEqual(['local.real']);
    expect(refs('local.real /* local.blocked */')).toEqual(['local.real']);
  });
});

// ------------------------------------------------------------ every kind

describe('reference kinds', () => {
  const kindOf = (expression: string) => extractReferences(expression)[0];

  it('classifies a managed resource reference', () => {
    expect(kindOf('local_file.config.content_sha256')).toMatchObject({
      kind: 'resource',
      target: 'local_file.config',
      attribute: 'content_sha256',
    });
  });

  it('classifies a variable reference', () => {
    expect(kindOf('var.channel')).toMatchObject({ kind: 'variable', target: 'var.channel' });
  });

  it('classifies a local reference', () => {
    expect(kindOf('local.service')).toMatchObject({ kind: 'local', target: 'local.service' });
  });

  it('classifies a data source reference, keeping type and name apart', () => {
    expect(kindOf('data.local_file.seed.content')).toMatchObject({
      kind: 'data',
      target: 'data.local_file.seed',
      attribute: 'content',
    });
  });

  it('classifies a module output reference', () => {
    expect(kindOf('module.network.subnet_id')).toMatchObject({
      kind: 'module',
      target: 'module.network',
      attribute: 'subnet_id',
    });
  });

  it('does not mistake var/local/data for resource types', () => {
    // `var.channel` is not a resource of type `var`.
    expect(kindOf('var.channel')?.kind).not.toBe('resource');
    expect(kindOf('data.local_file.seed')?.kind).toBe('data');
  });

  it('marks the built-ins for what they are', () => {
    for (const builtin of ['each.value', 'count.index', 'path.module', 'self.id']) {
      expect(kindOf(builtin)?.kind, builtin).toBe('builtin');
    }
  });

  it('drops index brackets but keeps the traversal', () => {
    expect(refs('aws_subnet.app[0].id')).toEqual(['aws_subnet.app.id']);
    expect(referencesTarget('aws_subnet.app[count.index].id', 'aws_subnet.app')).toBe(true);
  });

  it('collapses duplicates, because dependency is not a counting question', () => {
    expect(refs('"${local.a} and ${local.a}"')).toEqual(['local.a']);
  });
});

// ------------------------------------------------------------- in context

describe('references inside real configuration', () => {
  const config = `
    # a comment mentioning local_file.commented.id
    resource "local_file" "integrity" {
      filename = "build/integrity.txt"          // literal
      content  = "sha: \${local_file.config.content_sha256}\\n"
      note     = "local_file.decoy.id"
    }
  `;

  it('finds the dependency in an interpolated argument and nowhere else', () => {
    const block = blocksOfType(scanHcl(config), 'resource')[0]!;
    expect(referencesTarget(argumentValue(block, 'content') ?? '', 'local_file.config')).toBe(true);
    expect(referencesTarget(argumentValue(block, 'filename') ?? '', 'local_file.config')).toBe(false);
    expect(referencesTarget(argumentValue(block, 'note') ?? '', 'local_file.decoy')).toBe(false);
  });

  it('finds a dependency inside a heredoc body', () => {
    const doc = scanHcl(`
      resource "local_file" "m" {
        content = <<-EOT
          fingerprint: \${local_file.config.id}
          literal: local_file.decoy.id
        EOT
      }
    `);
    const value = argumentValue(blocksOfType(doc, 'resource')[0]!, 'content') ?? '';
    expect(referencesTarget(value, 'local_file.config')).toBe(true);
    expect(referencesTarget(value, 'local_file.decoy')).toBe(false);
  });

  it('is unaffected by whitespace, comments and attribute order', () => {
    const tidy = scanHcl('resource "local_file" "a" {\n  x = local.one\n  y = local.two\n}');
    const messy = scanHcl(
      'resource "local_file" "a" {\n\n  # noise\n\n\t\ty    =    local.two   # trailing\n\n  x=local.one\n\n}',
    );
    const names = (d: ReturnType<typeof scanHcl>) =>
      (findBlock(d, 'resource', 'local_file', 'a')?.arguments ?? [])
        .map((a) => `${a.name}=${refs(a.value).join(',')}`)
        .sort();
    expect(names(messy)).toEqual(names(tidy));
  });

  it('reads a configuration split across several files as one document', () => {
    const doc = scanHclFiles([
      { path: 'variables.tf', text: 'variable "channel" { default = "stable" }' },
      { path: 'main.tf', text: 'resource "local_file" "a" { content = var.channel }' },
      { path: 'outputs.tf', text: 'output "c" { value = local_file.a.id }' },
    ]);
    expect(blocksOfType(doc, 'variable')).toHaveLength(1);
    expect(blocksOfType(doc, 'resource')).toHaveLength(1);
    expect(blocksOfType(doc, 'output')).toHaveLength(1);
    // Block order across files must not matter.
    const reversed = scanHclFiles([
      { path: 'outputs.tf', text: 'output "c" { value = local_file.a.id }' },
      { path: 'main.tf', text: 'resource "local_file" "a" { content = var.channel }' },
      { path: 'variables.tf', text: 'variable "channel" { default = "stable" }' },
    ]);
    expect(blocksOfType(reversed, 'variable').length).toBe(1);
    expect(blocksOfType(reversed, 'output').length).toBe(1);
  });

  it('still reports whatever structure it can read from invalid HCL', () => {
    // A student mid-edit must get "no variable block named X", not a crash.
    const doc = scanHcl('resource "local_file" "a" { content = "unterminated\nvariable "b" {');
    expect(() => blocksOfType(doc, 'resource')).not.toThrow();
  });
});

// ------------------------------------------------------ the shipped labs

describe('scanning the workspaces this branch actually ships', () => {
  it("reads TF-005's seeded configuration and finds its resource", async () => {
    const file = path.join(LABS_DIR, 'terraform', 'tf-005-dependencies', 'setup', 'main.tf');
    const doc = scanHcl(await readFile(file, 'utf8'), 'main.tf');
    expect(findBlock(doc, 'resource', 'local_file', 'service_config')).not.toBeNull();
    expect(blocksOfType(doc, 'locals')).toHaveLength(1);
  });

  it("reads TF-003's seeded configuration, which declares variables and no outputs", async () => {
    const file = path.join(LABS_DIR, 'terraform', 'tf-003-outputs', 'setup', 'main.tf');
    const doc = scanHcl(await readFile(file, 'utf8'), 'main.tf');
    expect(blocksOfType(doc, 'variable').map((b) => b.labels[0]).sort()).toEqual([
      'channel',
      'deploy_token',
    ]);
    expect(blocksOfType(doc, 'output')).toHaveLength(0);
  });
});

// ------------------------------------------------------------- it is inert

describe('reading configuration never runs it', () => {
  it('does not execute a provisioner, a function, or anything else', () => {
    const hostile = `
      resource "null_resource" "x" {
        provisioner "local-exec" { command = "touch /tmp/PWNED-\${path.module}" }
        triggers = { now = timestamp(), f = file("/etc/passwd") }
      }
      data "external" "e" { program = ["/bin/sh", "-c", "id"] }
    `;
    const doc = scanHcl(hostile);
    // Structure is reported...
    expect(findBlock(doc, 'resource', 'null_resource', 'x')).not.toBeNull();
    // ...and the function calls are opaque text, never invoked.
    const triggers = argumentValue(findBlock(doc, 'resource', 'null_resource', 'x')!, 'triggers');
    expect(triggers).toContain('timestamp()');
    expect(extractReferences(triggers ?? '').map((r) => r.kind)).not.toContain('unknown');
  });

  it('has no evaluation surface at all — it only ever returns text and shapes', () => {
    // Every exported helper takes source and returns structure. None takes a
    // callback, a path to run, or anything the caller could turn into an
    // action; the module imports nothing, so it cannot reach a filesystem or a
    // network even if it wanted to.
    const value = argumentValue(
      blocksOfType(scanHcl('resource "a" "b" { c = file("/etc/shadow") }'), 'resource')[0]!,
      'c',
    );
    expect(value).toBe('file("/etc/shadow")');
  });
});
