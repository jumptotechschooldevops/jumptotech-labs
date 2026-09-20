/**
 * Secrets and host state stay out of every Docker build context.
 *
 * Every image builds with the repository root as its context, and the
 * Dockerfiles copy whole directories (`COPY apps/api apps/api`,
 * `COPY services/terminal services/terminal`). `.dockerignore` excluded only
 * the web tier's TLS directory, so an environment file or a credential that
 * ended up inside a copied directory would have been baked into an image.
 *
 * Proven here by reading the files, not by building an image: the rules are
 * present, and no Dockerfile copies a path they exclude (a COPY of an excluded
 * path would fail the build, so the exclusions cannot break one).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const rules = (file: string): string[] =>
  read(file)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

const EXCLUDED = [
  '.git',
  '**/.env',
  '**/.env.*',
  'infrastructure/kind/generated/',
  'infrastructure/observability/secrets/',
  'infrastructure/observability/alertmanager/secrets/',
  'backups/',
  'e2e/.stack/',
];

describe('Docker build contexts', () => {
  it('exclude environment files, kubeconfigs, secret directories and backups', () => {
    const present = rules('.dockerignore');
    for (const rule of EXCLUDED) expect(present, rule).toContain(rule);
    // The TLS exclusion BETA-P0-017 added is still there.
    expect(present).toContain('infrastructure/docker/nginx/tls/');
  });

  it('exclude host build state, which the images build for themselves', () => {
    // A workspace's own node_modules was copied over the image's `npm ci`
    // install by `COPY services/<ws> services/<ws>` (release-engineering audit).
    const present = rules('.dockerignore');
    for (const rule of ['node_modules', '**/node_modules', '**/dist', '**/coverage']) {
      expect(present, rule).toContain(rule);
    }
    // Every node_modules an image has, it installed: only ever copied between stages.
    const dockerDir = path.join(REPO_ROOT, 'infrastructure/docker');
    for (const name of readdirSync(dockerDir).filter((file) => file.endsWith('.Dockerfile'))) {
      for (const line of readFileSync(path.join(dockerDir, name), 'utf8').split('\n')) {
        if (/^\s*(COPY|ADD)\s/.test(line) && /node_modules/.test(line)) expect(line, name).toMatch(/--from=/);
      }
    }
  });

  it('are never asked to copy an excluded path', () => {
    const dockerDir = path.join(REPO_ROOT, 'infrastructure/docker');
    const excludedPrefixes = EXCLUDED.filter((rule) => !rule.startsWith('**')).map((rule) => rule.replace(/\/$/, ''));
    const problems: string[] = [];
    for (const name of readdirSync(dockerDir).filter((file) => file.endsWith('.Dockerfile'))) {
      for (const line of readFileSync(path.join(dockerDir, name), 'utf8').split('\n')) {
        const copy = /^\s*(?:COPY|ADD)\s+(.+)$/.exec(line);
        if (!copy || /--from=/.test(copy[1]!)) continue;
        const parts = copy[1]!.split(/\s+/).filter((part) => !part.startsWith('--'));
        for (const source of parts.slice(0, -1)) {
          const normalised = source.replace(/^\.\//, '').replace(/\/$/, '');
          const excluded =
            excludedPrefixes.some((prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`)) ||
            /(^|\/)\.env(\.|$)/.test(normalised);
          if (excluded) problems.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('git', () => {
  it('ignores every environment file except the template', () => {
    const present = rules('.gitignore');
    expect(present).toContain('.env');
    expect(present).toContain('.env.*');
    expect(present).toContain('!.env.example');
    // The negation must come after the rule it carves out of.
    expect(present.indexOf('!.env.example')).toBeGreaterThan(present.indexOf('.env.*'));
  });
});
