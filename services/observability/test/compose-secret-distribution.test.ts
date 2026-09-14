/**
 * BETA-P0-010 — each service receives exactly the secrets it uses.
 *
 * `infrastructure/secret-distribution.json` is the allowlist; this proves the
 * compose files as shipped agree with it, on every `npm test`, without Docker.
 * `make secrets-check` proves the same thing through `docker compose config`.
 *
 * Two failures this exists for, both of which passed every earlier test:
 *
 *   · `INTERNAL_SERVICE_SECRET: ${INTERNAL_SERVICE_SECRET:-${TERMINAL_SESSION_SECRET}}`
 *     — a secret *defaulted to another secret*. The stack started, every request
 *     succeeded, and three secrets were one;
 *   · a secret added to a service that never reads it. Nothing fails; the
 *     credential simply sits in one more process a bug could leak it from.
 *
 * Like `compose-scrape-token.test.ts`, a small reader rather than a YAML
 * dependency: the assertion is about literal text in the files an operator
 * runs. Comment lines are ignored — the files discuss secrets at length.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Contract {
  secrets: string[];
  optionalEmpty: string[];
  stacks: Record<string, { files: string[]; services: Record<string, string[]> }>;
  credentialMounts: Record<string, string[] | string>;
}

const contract = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'infrastructure/secret-distribution.json'), 'utf8'),
) as Contract;

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.runtime.yml', 'docker-compose.observability.yml'];

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** Each top-level service's non-comment lines, from one compose file. */
function serviceBlocks(file: string): Map<string, string[]> {
  const lines = read(file).split('\n');
  const blocks = new Map<string, string[]>();
  let inServices = false;
  let current: string | null = null;

  for (const line of lines) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (service?.[1]) {
      current = service[1];
      blocks.set(current, blocks.get(current) ?? []);
      continue;
    }
    if (current && !/^\s*#/.test(line)) blocks.get(current)!.push(line);
  }
  return blocks;
}

/** Every secret a block references, however it is spelled inside a value. */
function referencedSecrets(lines: readonly string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/\$\{([A-Z0-9_]+)/g)) {
      if (contract.secrets.includes(match[1]!)) found.add(match[1]!);
    }
  }
  return [...found].sort();
}

describe('the secret distribution contract', () => {
  for (const [stackName, stack] of Object.entries(contract.stacks)) {
    describe(`the ${stackName} stack (${stack.files.join(' + ')})`, () => {
      const merged = new Map<string, Set<string>>();
      for (const file of stack.files) {
        for (const [service, lines] of serviceBlocks(file)) {
          const set = merged.get(service) ?? new Set<string>();
          for (const name of referencedSecrets(lines)) set.add(name);
          merged.set(service, set);
        }
      }

      it('names every service it defines, so a new one cannot arrive unreviewed', () => {
        expect([...merged.keys()].sort()).toEqual(Object.keys(stack.services).sort());
      });

      for (const [service, allowed] of Object.entries(stack.services)) {
        it(`${service} receives exactly ${allowed.length ? allowed.join(', ') : 'no secrets'}`, () => {
          expect([...(merged.get(service) ?? [])].sort()).toEqual([...allowed].sort());
        });
      }
    });
  }

  it('lists the same services in the contract as the matrix in .env.example documents', () => {
    const example = read('.env.example');
    const full = contract.stacks.observability!.services;
    for (const name of contract.secrets) {
      const holders = Object.entries(full)
        .filter(([, secrets]) => secrets.includes(name))
        .map(([service]) => service);
      // Two or more spaces: the matrix is aligned, prose mentioning a name is not.
      const documented = new RegExp(`^#\\s+${name}\\s{2,}(\\S.*)$`, 'm').exec(example)?.[1] ?? '';
      for (const holder of holders) {
        if (holder === 'prometheus') continue;
        expect(documented, `.env.example documents ${holder} as holding ${name}`).toContain(holder);
      }
    }
  });
});

describe('no secret is defaulted', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file} requires every secret it references, and defaults none to another`, () => {
      const problems: string[] = [];
      for (const [service, lines] of serviceBlocks(file)) {
        for (const line of lines) {
          for (const match of line.matchAll(/\$\{([A-Z0-9_]+)([^}]*)\}?/g)) {
            const name = match[1]!;
            if (!contract.secrets.includes(name)) continue;
            const modifier = line.slice(match.index! + 2 + name.length);
            const required = modifier.startsWith(':?');
            const optionalEmpty = modifier.startsWith(':-}') && contract.optionalEmpty.includes(name);
            if (!required && !optionalEmpty) problems.push(`${service}: ${name}`);
          }
        }
      }
      expect(problems, 'secrets referenced without `:?` (or `:-}` for an optional one)').toEqual([]);
    });
  }

  it('never lets a secret fall back to another variable', () => {
    for (const file of COMPOSE_FILES) {
      const offending = read(file)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .filter((line) => contract.secrets.some((name) => line.includes(`\${${name}:-\${`)));
      expect(offending, file).toEqual([]);
    }
  });

  it('uses no env_file, which would hand a service every variable in it', () => {
    for (const file of COMPOSE_FILES) {
      const lines = read(file).split('\n').filter((line) => !/^\s*#/.test(line));
      expect(lines.filter((line) => /^\s+env_file:/.test(line)), file).toEqual([]);
    }
  });
});

describe('credentials delivered as files', () => {
  for (const [source, owners] of Object.entries(contract.credentialMounts)) {
    if (source === '$comment') continue;
    it(`${source} is mounted only into ${(owners as string[]).join(', ')}`, () => {
      const holders = new Set<string>();
      for (const file of COMPOSE_FILES) {
        const text = read(file);
        // A YAML anchor carries the mount into whichever service aliases it.
        const anchor = new RegExp(`^x-[a-z-]+: &([a-z-]+)\\n(?:[ \\t].*\\n)*?[ \\t]+source: ${source.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`, 'm').exec(text)?.[1];
        for (const [service, lines] of serviceBlocks(file)) {
          if (lines.some((line) => line.includes(`source: ${source}`))) holders.add(service);
          if (anchor && lines.some((line) => line.includes(`*${anchor}`))) holders.add(service);
        }
      }
      expect([...holders].sort()).toEqual([...(owners as string[])].sort());
    });
  }
});
