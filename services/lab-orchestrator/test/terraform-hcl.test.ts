/**
 * The HCL block scanner.
 *
 * These tests are mostly about the cases that make line-based matching wrong —
 * comments, strings containing braces, heredocs, interpolation — because that
 * is the whole reason this is a lexer rather than a set of regular expressions.
 *
 * The last group scans the actual seeded lab workspaces, so a lab whose
 * configuration the scanner cannot read fails here rather than at a student's
 * Check Solution.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  argumentNames,
  argumentValue,
  blocksOfType,
  findBlock,
  findNestedBlock,
  hasArgument,
  literalString,
  referencedNames,
  scanHcl,
  scanHclFiles,
} from '../src/index.js';
import { LABS_DIR } from './helpers.js';

describe('hcl — block structure', () => {
  it('reads a resource block with its labels and arguments', () => {
    const doc = scanHcl(`
      resource "local_file" "welcome" {
        filename = "welcome.txt"
        content  = "JumpToTech Bank platform"
      }
    `);

    const block = findBlock(doc, 'resource', 'local_file', 'welcome');
    expect(block).not.toBeNull();
    expect(block!.labels).toEqual(['local_file', 'welcome']);
    expect(argumentNames(block!)).toEqual(['filename', 'content']);
    expect(literalString(argumentValue(block!, 'filename'))).toBe('welcome.txt');
  });

  it('reads variable, output, locals, module and data blocks', () => {
    const doc = scanHcl(`
      variable "environment" {
        type    = string
        default = "dev"
      }

      variable "service_name" {
        type = string
      }

      locals {
        service_prefix = "jumptotech"
        service_slug   = "\${local.service_prefix}-ledger"
      }

      data "local_file" "platform" {
        filename = "platform.json"
      }

      module "ledger" {
        source   = "./modules/application"
        app_name = "ledger"
      }

      output "release_file" {
        value = local_file.welcome.filename
      }
    `);

    expect(blocksOfType(doc, 'variable').map((b) => b.labels[0])).toEqual([
      'environment',
      'service_name',
    ]);
    expect(hasArgument(findBlock(doc, 'variable', 'environment')!, 'default')).toBe(true);
    expect(hasArgument(findBlock(doc, 'variable', 'service_name')!, 'default')).toBe(false);
    expect(argumentNames(blocksOfType(doc, 'locals')[0]!)).toEqual([
      'service_prefix',
      'service_slug',
    ]);
    expect(findBlock(doc, 'data', 'local_file', 'platform')).not.toBeNull();
    expect(literalString(argumentValue(findBlock(doc, 'module', 'ledger')!, 'source'))).toBe(
      './modules/application',
    );
    expect(findBlock(doc, 'output', 'release_file')).not.toBeNull();
  });

  it('reads a nested lifecycle block and its arguments', () => {
    const doc = scanHcl(`
      resource "local_file" "audit_log" {
        filename = "audit.log"

        lifecycle {
          prevent_destroy = true
          ignore_changes  = [content, file_permission]
        }
      }
    `);

    const resource = findBlock(doc, 'resource', 'local_file', 'audit_log')!;
    const lifecycle = findNestedBlock(resource, 'lifecycle')!;
    expect(lifecycle).not.toBeNull();
    expect(argumentValue(lifecycle, 'prevent_destroy')).toBe('true');
    expect(referencedNames(argumentValue(lifecycle, 'ignore_changes')!)).toEqual([
      'content',
      'file_permission',
    ]);
  });

  it('keeps nested required_providers out of the top-level block list', () => {
    const doc = scanHcl(`
      terraform {
        required_providers {
          local = {
            source  = "hashicorp/local"
            version = "2.5.2"
          }
        }
      }
    `);

    expect(doc.blocks.map((b) => b.type)).toEqual(['terraform']);
    expect(findNestedBlock(doc.blocks[0]!, 'required_providers')).not.toBeNull();
  });
});

describe('hcl — the cases that defeat regular expressions', () => {
  it('ignores braces inside comments', () => {
    const doc = scanHcl(`
      # resource "local_file" "commented" {
      // output "also_commented" {
      /* module "block_comment" {
         still a comment }
      */
      resource "local_file" "real" {
        filename = "real.txt"
      }
    `);

    expect(doc.blocks.map((b) => b.labels.join('.'))).toEqual(['local_file.real']);
  });

  it('ignores braces and quotes inside strings', () => {
    const doc = scanHcl(`
      resource "local_file" "tricky" {
        content = "a { brace } and a \\" quote"
        other   = "resource \\"local_file\\" \\"fake\\" {"
      }
    `);

    expect(doc.blocks).toHaveLength(1);
    expect(argumentNames(doc.blocks[0]!)).toEqual(['content', 'other']);
  });

  it('ignores braces inside string interpolation', () => {
    const doc = scanHcl(`
      resource "local_file" "interp" {
        content = "\${jsonencode({ a = 1, b = 2 })} trailing"
      }

      resource "local_file" "after" {
        filename = "after.txt"
      }
    `);

    // The interpolation's braces must not close the first resource early, or
    // the second resource would be read as nested inside it.
    expect(doc.blocks.map((b) => b.labels[1])).toEqual(['interp', 'after']);
  });

  it('ignores braces and hashes inside a heredoc', () => {
    const doc = scanHcl(`
      resource "local_file" "doc" {
        content = <<-EOT
          # not a comment
          resource "local_file" "not_real" {
            still inside the heredoc }
        EOT
        filename = "doc.md"
      }
    `);

    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]!.labels[1]).toBe('doc');
    expect(hasArgument(doc.blocks[0]!, 'filename')).toBe(true);
  });

  it('reads a multi-line object or list argument whole', () => {
    const doc = scanHcl(`
      resource "null_resource" "smoke" {
        triggers = {
          environment_id = random_pet.environment_id.id
          channel        = var.channel
        }
      }
    `);

    const value = argumentValue(doc.blocks[0]!, 'triggers')!;
    expect(value).toContain('environment_id');
    expect(value).toContain('channel');
    // The object literal must not have been read as a nested block.
    expect(doc.blocks[0]!.blocks).toHaveLength(0);
  });

  it('does not mistake a comparison for an assignment', () => {
    const doc = scanHcl(`
      locals {
        is_prod = var.environment == "prod"
      }
    `);

    expect(argumentNames(doc.blocks[0]!)).toEqual(['is_prod']);
    expect(argumentValue(doc.blocks[0]!, 'is_prod')).toContain('==');
  });

  it('recovers what it can from a malformed file rather than throwing', () => {
    // A student mid-edit, and TF-010's seeded fault: an unclosed block.
    const doc = scanHcl(`
      variable "environment" {
        type = string
      }

      output "broken" {
        value = local_file.settings.filename
    `);

    expect(findBlock(doc, 'variable', 'environment')).not.toBeNull();
    expect(() => scanHcl('}{}{ "" ')).not.toThrow();
  });
});

describe('hcl — merging several files', () => {
  it('merges top-level blocks and records which file each came from', () => {
    const doc = scanHclFiles([
      { path: 'variables.tf', text: 'variable "a" { type = string }' },
      { path: 'main.tf', text: 'resource "local_file" "x" { filename = "x" }' },
    ]);

    expect(doc.blocks).toHaveLength(2);
    expect(findBlock(doc, 'variable', 'a')!.file).toBe('variables.tf');
    expect(findBlock(doc, 'resource', 'local_file', 'x')!.file).toBe('main.tf');
  });
});

describe('hcl — the shipped lab workspaces', () => {
  const read = (relative: string) =>
    readFile(path.join(LABS_DIR, 'terraform', relative), 'utf8');

  it('reads the lifecycle lab exactly as the verifier will', async () => {
    const doc = scanHcl(await read('tf-008-lifecycle/setup/main.tf'));

    // The seed deliberately has no lifecycle blocks yet — that is the exercise.
    for (const name of ['audit_log', 'release', 'config_watch'] as const) {
      const type = name === 'audit_log' ? 'local_file' : name === 'release' ? 'random_pet' : 'null_resource';
      const block = findBlock(doc, 'resource', type, name);
      expect(block, `${type}.${name} must be readable`).not.toBeNull();
      expect(findNestedBlock(block!, 'lifecycle')).toBeNull();
    }
  });

  it('reads the state lab, which must declare exactly three file resources', async () => {
    const doc = scanHcl(await read('tf-004-state/setup/main.tf'));
    expect(blocksOfType(doc, 'resource').map((b) => b.labels[1])).toEqual([
      'accounts_config',
      'ledger_config',
      'legacy_config',
    ]);
  });

  it('reads the troubleshooting lab despite its seeded faults', async () => {
    const main = scanHcl(await read('tf-010-troubleshooting/setup/main.tf'));
    const outputs = scanHcl(await read('tf-010-troubleshooting/setup/outputs.tf'));

    // The module call is missing `retention_days` — the fault the student fixes.
    const audit = findBlock(main, 'module', 'audit')!;
    expect(audit).not.toBeNull();
    expect(hasArgument(audit, 'retention_days')).toBe(false);
    expect(hasArgument(audit, 'environment')).toBe(true);

    // outputs.tf has an unclosed block; the first output is still readable,
    // which is what lets a check report a goal rather than a parser crash.
    expect(findBlock(outputs, 'output', 'settings_path')).not.toBeNull();
  });
});
