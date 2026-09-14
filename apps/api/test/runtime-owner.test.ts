/**
 * BETA-P0-008 — the API's runtime owner, and the stack that hands it over.
 *
 * The defect: `docker-compose.yml` never passed `RUNTIME_OWNER_ID` to the api,
 * while `docker-compose.runtime.yml` passed `${RUNTIME_OWNER_ID:-jumptotech}` to
 * sandboxd. An operator following docs/runtime-ownership.md and setting it got
 * sandboxd on their owner and the api on `jumptotech`. sandboxd stamps its own
 * owner on every sandbox it creates, so the api's discovery and destroy then
 * refused every one of them, and brokered sandboxes leaked for good.
 *
 * Two halves are pinned here: the API resolves its owner exactly as sandboxd
 * does (and refuses to start in production without one), and the compose files
 * as shipped hand both services the same required variable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidRuntimeOwner, resolveRuntimeOwner } from '@jumptotech/lab-orchestrator';
import { loadConfig } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://issuer.example.com',
  OIDC_CLIENT_ID: 'jumptotech-labs',
  OIDC_AUDIENCE: 'jumptotech-labs',
  TERMINAL_SESSION_SECRET: 'a-terminal-session-secret-for-tests',
  PUBLIC_ORIGIN: 'https://labs.example.com',
  ALLOWED_ORIGINS: 'https://labs.example.com',
} as NodeJS.ProcessEnv;

describe('the api runtime owner', () => {
  it('refuses to start in production without one', () => {
    expect(() => loadConfig(PRODUCTION_ENV)).toThrow(/RUNTIME_OWNER_ID must be set/);
  });

  it('refuses an unsafe one in production', () => {
    expect(() => loadConfig({ ...PRODUCTION_ENV, RUNTIME_OWNER_ID: 'labs prod' })).toThrow(
      /not a valid runtime owner/,
    );
  });

  it('uses the configured owner in production', () => {
    const config = loadConfig({ ...PRODUCTION_ENV, RUNTIME_OWNER_ID: 'labs-prod' });
    expect(config.sandbox.runtimeOwner).toBe('labs-prod');
    expect(config.sandbox.runtimeOwnerSource).toBe('configured');
  });

  it('falls back to the shared development owner outside production, and says so', () => {
    const config = loadConfig({ TERMINAL_SESSION_SECRET: 'a-terminal-session-secret-for-tests' });
    expect(config.sandbox.runtimeOwner).toBe('jumptotech');
    expect(config.sandbox.runtimeOwnerSource).toBe('development-default');
  });

  it('agrees with the resolver sandboxd uses, for every shape of environment', () => {
    const dev = { TERMINAL_SESSION_SECRET: 'a-terminal-session-secret-for-tests' };
    for (const env of [
      dev,
      { ...dev, RUNTIME_OWNER_ID: 'wt-docker' },
      { ...PRODUCTION_ENV, RUNTIME_OWNER_ID: 'ci-42-api' },
    ]) {
      expect(loadConfig(env).sandbox.runtimeOwner).toBe(resolveRuntimeOwner(env).owner);
    }
  });
});

// --------------------------------------------------------------- compose

/**
 * One service's `environment:` block as `KEY -> raw value`.
 *
 * The same small reader `compose-scrape-token.test.ts` uses, for the same
 * reason: the assertion is about the literal line an operator runs.
 */
function environmentFor(composeFile: string, service: string): Map<string, string> {
  const lines = readFileSync(path.join(REPO_ROOT, composeFile), 'utf8').split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  expect(start, `${composeFile} defines '${service}'`).toBeGreaterThanOrEqual(0);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  const envStart = block.findIndex((line) => line === '    environment:');
  const env = new Map<string, string>();
  if (envStart < 0) return env;
  for (let i = envStart + 1; i < block.length; i += 1) {
    const line = block[i] ?? '';
    if (/^ {4}\S/.test(line)) break;
    const match = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (match?.[1]) env.set(match[1], match[2] ?? '');
  }
  return env;
}

/** Every service that stamps or checks ownership, and the file that defines it. */
const OWNER_SERVICES = [
  { service: 'api', composeFile: 'docker-compose.yml' },
  { service: 'sandboxd', composeFile: 'docker-compose.runtime.yml' },
] as const;

describe('the compose stack hands every owner-aware service the same required owner', () => {
  const values = OWNER_SERVICES.map(({ service, composeFile }) => ({
    service,
    value: environmentFor(composeFile, service).get('RUNTIME_OWNER_ID'),
  }));

  for (const { service, value } of values) {
    it(`${service} receives RUNTIME_OWNER_ID as a required variable with no default`, () => {
      expect(value, `${service} has RUNTIME_OWNER_ID`).toBeDefined();
      // `${VAR:?message}`: compose refuses to start when it is unset or empty.
      expect(value).toMatch(/^\$\{RUNTIME_OWNER_ID:\?[^}]+\}$/);
      // A default in either file is how the two drift apart again.
      expect(value).not.toContain(':-');
    });
  }

  it('the two services read the identical expression', () => {
    expect(new Set(values.map((v) => v.value)).size).toBe(1);
  });

  it('the terminal is not given an owner it has no use for', () => {
    // It attaches through sandboxd, which checks ownership itself.
    expect(environmentFor('docker-compose.yml', 'terminal').has('RUNTIME_OWNER_ID')).toBe(false);
    expect(environmentFor('docker-compose.runtime.yml', 'terminal').has('RUNTIME_OWNER_ID')).toBe(false);
  });

  it('.env.example ships a valid owner, and make setup writes one', () => {
    const example = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    const line = example.split('\n').find((l) => l.startsWith('RUNTIME_OWNER_ID='));
    expect(line).toBeDefined();
    expect(isValidRuntimeOwner(line!.slice('RUNTIME_OWNER_ID='.length))).toBe(true);

    const makefile = readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8');
    const setup = makefile.slice(makefile.indexOf('\nsetup:'), makefile.indexOf('\nobservability-token:'));
    expect(setup).toContain('RUNTIME_OWNER_ID=');
  });

  it('no operator cleanup command sweeps managed resources without an owner filter', () => {
    const makefile = readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8');
    const manifest = readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    for (const text of [makefile, manifest]) {
      expect(text).not.toMatch(/managed=true\s*\|\s*xargs[^\n]*docker rm/);
    }
    const script = readFileSync(path.join(REPO_ROOT, 'scripts/sandbox-clean.sh'), 'utf8');
    expect(script).toContain('label=jumptotech.io/runtime-owner=${OWNER}');
  });
});
