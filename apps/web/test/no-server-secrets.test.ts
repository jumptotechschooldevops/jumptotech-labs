/**
 * BETA-P0-010 — no server secret can reach the browser bundle.
 *
 * Vite inlines `import.meta.env.VITE_*` into the generated JavaScript at build
 * time, and anything a `define` or a widened `envPrefix` names besides. So the
 * boundary is: the bundle may read two public URLs, the build is given nothing
 * else, and no secret is ever spelled with the prefix that would publish it.
 *
 * Checked on the sources rather than a build so it runs on every `npm test`; the
 * release checklist in docs/secret-boundaries.md builds with sentinel secrets in
 * the environment and searches `dist/` as well.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');

/** What the bundle is allowed to read from its build environment. */
const PUBLIC_BUILD_VARIABLES = ['VITE_API_URL', 'VITE_TERMINAL_WS_URL'];
/** Vite's own built-ins, which carry no deployment value. */
const VITE_BUILTINS = ['DEV', 'PROD', 'MODE', 'BASE_URL', 'SSR'];

const SERVER_SECRETS = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'infrastructure/secret-distribution.json'), 'utf8'),
).secrets as string[];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?|mjs|cjs)$/.test(entry) ? [full] : [];
  });
}

describe('the browser bundle', () => {
  const files = sourceFiles(path.join(WEB_ROOT, 'src'));

  it('reads only the public build variables', () => {
    const read = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g)) {
        read.add(match[1]!);
      }
    }
    expect([...read].filter((name) => ![...PUBLIC_BUILD_VARIABLES, ...VITE_BUILTINS].includes(name))).toEqual([]);
  });

  it('never reads process.env, which a bundler define could inline', () => {
    expect(files.filter((file) => /\bprocess\.env\b/.test(readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('is built by a config that publishes nothing beyond the VITE_ prefix', () => {
    const config = readFileSync(path.join(WEB_ROOT, 'vite.config.ts'), 'utf8');
    expect(config).not.toMatch(/\bdefine\s*:/);
    expect(config).not.toMatch(/\benvPrefix\b/);
    expect(config).not.toMatch(/\bloadEnv\b/);
  });

  it('is built by an image given only the public build variables', () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, 'infrastructure/docker/web.Dockerfile'), 'utf8');
    const args = [...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((match) => match[1]);
    expect(args.sort()).toEqual([...PUBLIC_BUILD_VARIABLES].sort());
    for (const name of SERVER_SECRETS) expect(dockerfile).not.toContain(name);
  });

  it('never spells a secret with the prefix that would publish it', () => {
    for (const file of ['.env.example', 'docker-compose.yml', 'docker-compose.runtime.yml', 'docker-compose.observability.yml']) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(text.match(/\bVITE_[A-Z0-9_]*(SECRET|PASSWORD|TOKEN|KEY)\b/g) ?? [], file).toEqual([]);
    }
  });
});
