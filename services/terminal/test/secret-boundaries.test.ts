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
 *   · identity — the process drops to the student account *itself*, because a
 *     same-uid process that did not change uid leaves `/proc/<pid>/environ` open
 *     to every student shell. The kernel behaviour was verified in a container;
 *     this pins the code path and the image/compose wiring that depend on it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TERMINAL_FORBIDDEN_SECRETS, loadTerminalConfig } from '../src/config.js';
import { ProcessIdentityError, dropServiceIdentity, type IdentityOps } from '../src/process-identity.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

const PRODUCTION = {
  NODE_ENV: 'production',
  TERMINAL_SESSION_SECRET: hex('terminal-session'),
  INTERNAL_SERVICE_SECRET: hex('internal-service'),
  SANDBOXD_ATTACH_SECRET: hex('attach').slice(0, 48),
  TERMINAL_SANDBOX_BROKER_ENABLED: 'true',
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape'),
  TERMINAL_DROP_TO_UID: '1001',
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
    expect(config.dropToUid).toBe(1001);
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

  it('rejects a drop target that is not an unprivileged numeric id', () => {
    for (const value of ['0', 'student', '-1', '10.5']) {
      expect(() =>
        loadTerminalConfig({ TERMINAL_SESSION_SECRET: 'a-long-enough-secret', TERMINAL_DROP_TO_UID: value } as NodeJS.ProcessEnv),
      ).toThrow(/TERMINAL_DROP_TO_UID/);
    }
  });
});

/** A fake `process` that records the order of identity changes. */
function fakeProcess(start: { uid: number; gid: number }, options: { ignoreSetuid?: boolean } = {}) {
  const calls: string[] = [];
  let uid = start.uid;
  let gid = start.gid;
  const ops: Required<IdentityOps> = {
    getuid: () => uid,
    getgid: () => gid,
    setgroups: (groups) => calls.push(`setgroups:[${groups.join(',')}]`),
    setgid: (id) => {
      calls.push(`setgid:${id}`);
      gid = id;
    },
    setuid: (id) => {
      calls.push(`setuid:${id}`);
      if (!options.ignoreSetuid) uid = id;
    },
  };
  return { calls, ops };
}

describe('the terminal drops to the student account itself', () => {
  it('clears supplementary groups, then the group, then the user — uid last', () => {
    const { calls, ops } = fakeProcess({ uid: 0, gid: 0 });
    expect(dropServiceIdentity({ uid: 1001, production: true, ops })).toEqual({
      kind: 'dropped',
      uid: 1001,
      gid: 1001,
    });
    expect(calls).toEqual(['setgroups:[]', 'setgid:1001', 'setuid:1001']);
  });

  it('uses an explicit group when one is configured', () => {
    const { ops } = fakeProcess({ uid: 0, gid: 0 });
    expect(dropServiceIdentity({ uid: 1001, gid: 2002, production: true, ops })).toMatchObject({ gid: 2002 });
  });

  it('refuses, in production, to run as the student account without having dropped to it', () => {
    const { calls, ops } = fakeProcess({ uid: 1001, gid: 1001 });
    expect(() => dropServiceIdentity({ uid: 1001, production: true, ops })).toThrow(/started as uid 1001/);
    expect(calls).toEqual([]);
  });

  it('refuses, in production, to run with no drop target at all', () => {
    const { ops } = fakeProcess({ uid: 0, gid: 0 });
    expect(() => dropServiceIdentity({ uid: undefined, production: true, ops })).toThrow(
      /TERMINAL_DROP_TO_UID is not set/,
    );
  });

  it('refuses, in production, a platform that cannot change identity', () => {
    expect(() => dropServiceIdentity({ uid: 1001, production: true, ops: {} })).toThrow(ProcessIdentityError);
  });

  it('refuses a drop that did not take effect', () => {
    const { ops } = fakeProcess({ uid: 0, gid: 0 }, { ignoreSetuid: true });
    expect(() => dropServiceIdentity({ uid: 1001, production: false, ops })).toThrow(/did not take effect/);
  });

  it('leaves a development process as it was, and says why', () => {
    expect(dropServiceIdentity({ uid: undefined, production: false, ops: fakeProcess({ uid: 501, gid: 20 }).ops })).toEqual({
      kind: 'unchanged',
      reason: 'not-configured',
      uid: 501,
    });
    expect(dropServiceIdentity({ uid: 1001, production: false, ops: fakeProcess({ uid: 501, gid: 20 }).ops })).toMatchObject({
      kind: 'unchanged',
      reason: 'not-root',
    });
    expect(dropServiceIdentity({ uid: 1001, production: false, ops: {} })).toMatchObject({
      reason: 'unsupported-platform',
    });
  });
});

describe('the shipped terminal image and compose service are wired for the drop', () => {
  const dockerfile = readFileSync(path.join(REPO_ROOT, 'infrastructure/docker/terminal.Dockerfile'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('does not start as the student account', () => {
    expect(dockerfile).not.toMatch(/^USER\s+(student|1001)\b/m);
    expect(dockerfile).toMatch(/^USER\s+root\s*$/m);
  });

  it('names the account to drop to', () => {
    expect(dockerfile).toMatch(/TERMINAL_DROP_TO_UID=1001/);
    expect(dockerfile).toMatch(/TERMINAL_DROP_TO_GID=1001/);
  });

  it('grants exactly SETUID and SETGID on top of cap_drop: ALL, and keeps no-new-privileges', () => {
    const compose = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8').split('\n');
    const start = compose.indexOf('  terminal:');
    const end = compose.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
    const block = compose.slice(start, end).filter((line) => !/^\s*#/.test(line)).join('\n');

    expect(block).toMatch(/cap_drop:\n\s+- ALL\n/);
    const added = /cap_add:\n((?:\s+- [A-Z_]+\n)+)/.exec(block)?.[1] ?? '';
    expect(added.match(/[A-Z_]+/g)?.sort()).toEqual(['SETGID', 'SETUID']);
    expect(block).toContain('no-new-privileges:true');
    expect(block).not.toMatch(/^\s+user:/m);
  });
});
