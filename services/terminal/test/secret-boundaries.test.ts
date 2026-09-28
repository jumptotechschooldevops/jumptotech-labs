/**
 * BETA-P0-010 — the terminal holds only what it uses, and a student shell
 * cannot read even that.
 *
 * Two halves:
 *
 *   · configuration — under NODE_ENV=production the terminal refuses a missing,
 *     placeholder or shared secret, and any secret that belongs to another
 *     service. In development `INTERNAL_SERVICE_SECRET` may still fall back to
 *     the session secret, and the config says so.
 *   · identity — SEC-ARCH-2 replaced BETA-P0-010's "drop the whole process to
 *     the student account": the service runs as its own account with exactly
 *     SETUID, SETGID and CHOWN, and every session's shell as a uid of its own.
 *     `shell-identity.test.ts` pins the code path and
 *     `shell-isolation-container-integration.test.ts` proves it on a real
 *     kernel; this pins the image and compose wiring that depend on it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TERMINAL_FORBIDDEN_SECRETS, loadTerminalConfig } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

const PRODUCTION = {
  NODE_ENV: 'production',
  TERMINAL_SESSION_SECRET: hex('terminal-session'),
  INTERNAL_SERVICE_SECRET: hex('internal-service'),
  SANDBOXD_ATTACH_SECRET: hex('attach').slice(0, 48),
  TERMINAL_SANDBOX_BROKER_ENABLED: 'true',
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape'),
} as NodeJS.ProcessEnv;

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadTerminalConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadTerminalConfig to refuse');
}

describe('terminal secrets under NODE_ENV=production', () => {
  it('accepts exactly the secrets the terminal uses', () => {
    const config = loadTerminalConfig(PRODUCTION);
    expect(config.internalServiceSecret).toBe(PRODUCTION.INTERNAL_SERVICE_SECRET);
    expect(config.developmentSecretFallbacks).toEqual([]);
  });

  it('refuses to fall back to the session secret for INTERNAL_SERVICE_SECRET', () => {
    expect(refusal({ ...PRODUCTION, INTERNAL_SERVICE_SECRET: undefined })).toMatch(
      /INTERNAL_SERVICE_SECRET is not set/,
    );
  });

  it('refuses INTERNAL_SERVICE_SECRET equal to TERMINAL_SESSION_SECRET', () => {
    expect(
      refusal({ ...PRODUCTION, INTERNAL_SERVICE_SECRET: PRODUCTION.TERMINAL_SESSION_SECRET }),
    ).toMatch(/same value/);
  });

  it('refuses a padded secret instead of trimming it one way here and another in sandboxd or the api', () => {
    for (const name of ['TERMINAL_SESSION_SECRET', 'INTERNAL_SERVICE_SECRET', 'SANDBOXD_ATTACH_SECRET'] as const) {
      expect(refusal({ ...PRODUCTION, [name]: `${PRODUCTION[name]} ` })).toMatch(
        new RegExp(`${name} has leading or trailing whitespace`),
      );
    }
  });

  it('refuses the placeholder .env.example ships', () => {
    expect(
      refusal({ ...PRODUCTION, TERMINAL_SESSION_SECRET: 'dev-only-insecure-secret-change-me' }),
    ).toMatch(/TERMINAL_SESSION_SECRET is a placeholder/);
  });

  it('requires the attach credential only when shells are brokered', () => {
    expect(refusal({ ...PRODUCTION, SANDBOXD_ATTACH_SECRET: '' })).toMatch(/SANDBOXD_ATTACH_SECRET is not set/);
    expect(() =>
      loadTerminalConfig({ ...PRODUCTION, SANDBOXD_ATTACH_SECRET: '', TERMINAL_SANDBOX_BROKER_ENABLED: 'false' }),
    ).not.toThrow();
  });

  for (const name of TERMINAL_FORBIDDEN_SECRETS) {
    it(`refuses to hold ${name}`, () => {
      expect(refusal({ ...PRODUCTION, [name]: hex(name) })).toContain(`${name} is set, but terminal`);
    });
  }

  it('never echoes a value in the refusal', () => {
    const message = refusal({
      ...PRODUCTION,
      INTERNAL_SERVICE_SECRET: PRODUCTION.TERMINAL_SESSION_SECRET,
      SANDBOXD_RUNTIME_SECRET: hex('runtime'),
    });
    for (const value of [PRODUCTION.TERMINAL_SESSION_SECRET!, hex('runtime')]) {
      expect(message).not.toContain(value);
    }
  });
});

describe('terminal secrets in development', () => {
  it('may fall back to the session secret, and reports that it did', () => {
    const config = loadTerminalConfig({ TERMINAL_SESSION_SECRET: 'a-long-enough-secret' } as NodeJS.ProcessEnv);
    expect(config.internalServiceSecret).toBe('a-long-enough-secret');
    expect(config.developmentSecretFallbacks).toEqual(['INTERNAL_SERVICE_SECRET']);
  });

});

describe('the shipped terminal image and compose service run shells per session (SEC-ARCH-2)', () => {
  const dockerfile = readFileSync(path.join(REPO_ROOT, 'infrastructure/docker/terminal.Dockerfile'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  const composeBlock = (): string => {
    const compose = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8').split('\n');
    const start = compose.indexOf('  terminal:');
    const end = compose.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
    return compose.slice(start, end).filter((line) => !/^\s*#/.test(line)).join('\n');
  };

  it('starts the container as root only to launch the service as its own account', () => {
    expect(dockerfile).not.toMatch(/^USER\s+(student|1001|jtt-terminal)\b/m);
    expect(dockerfile).toMatch(/^USER\s+root\s*$/m);
    expect(dockerfile.replace(/\\\n\s*/g, ' ')).toMatch(/useradd[^\n]*--uid 1002[^\n]*jtt-terminal/);
    expect(dockerfile).not.toMatch(/TERMINAL_DROP_TO_(UID|GID)/);
  });

  it('launches it holding exactly SETUID, SETGID and CHOWN as ambient capabilities', () => {
    const cmd = /^CMD\s+(\[[\s\S]*?\])\s*$/m.exec(dockerfile.replace(/\\\n\s*/g, ' '))?.[1];
    const argv = JSON.parse(cmd ?? '[]') as string[];
    expect(argv.slice(0, 6)).toEqual([
      '/usr/bin/setpriv',
      '--reuid=jtt-terminal',
      '--regid=jtt-terminal',
      '--clear-groups',
      '--inh-caps=-all,+setuid,+setgid,+chown',
      '--ambient-caps=-all,+setuid,+setgid,+chown',
    ]);
    expect(argv.slice(6)).toEqual(['--', 'node', '--import', 'tsx', '/app/services/terminal/src/index.ts']);
  });

  it('grants exactly SETUID, SETGID and CHOWN on top of cap_drop: ALL, and keeps no-new-privileges', () => {
    const block = composeBlock();
    expect(block).toMatch(/cap_drop:\n\s+- ALL\n/);
    const added = /cap_add:\n((?:\s+- [A-Z_]+\n)+)/.exec(block)?.[1] ?? '';
    expect(added.match(/[A-Z_]+/g)?.sort()).toEqual(['CHOWN', 'SETGID', 'SETUID']);
    expect(block).toContain('no-new-privileges:true');
    expect(block).not.toMatch(/^\s+user:/m);
  });

  it('gives the service, not a student, the directories every session lives under — traversable, never listable', () => {
    const block = composeBlock();
    expect(block).toMatch(/- \/home\/student:[^\n]*mode=0711,uid=1002,gid=1002/);
    expect(block).toMatch(/- \/run\/jumptotech:[^\n]*mode=0711,uid=1002,gid=1002/);
    expect(block).not.toMatch(/uid=1001/);
  });
});
