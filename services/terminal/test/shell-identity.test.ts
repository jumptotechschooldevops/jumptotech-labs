/**
 * The terminal's side of SEC-ARCH-2, as code: when it will and will not start,
 * and exactly what a session's shell is started as.
 *
 * The kernel half — that a shell started this way cannot read, write, list or
 * signal another session's, and that End leaves nothing of it running — is
 * proven in a real container by `shell-isolation-container-integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { SHELL_UID_MAX, SHELL_UID_MIN } from '@jumptotech/lab-orchestrator';
import {
  ENV,
  PRLIMIT,
  REQUIRED_CAPABILITIES,
  SETPRIV,
  ShellIdentityError,
  detectShellIsolation,
  ownerFor,
  parseProcessStatus,
  sessionShellCommand,
} from '../src/shell-identity.js';

/** A `/proc/self/status` excerpt. */
function status(opts: { uid?: number; gid?: number; capEff?: bigint; nnp?: 0 | 1 } = {}): string {
  const uid = opts.uid ?? 1002;
  const gid = opts.gid ?? uid;
  return [
    'Name:\tnode',
    `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`,
    `Gid:\t${gid}\t${gid}\t${gid}\t${gid}`,
    `CapInh:\t${(opts.capEff ?? REQUIRED_CAPABILITIES).toString(16).padStart(16, '0')}`,
    `CapPrm:\t${(opts.capEff ?? REQUIRED_CAPABILITIES).toString(16).padStart(16, '0')}`,
    `CapEff:\t${(opts.capEff ?? REQUIRED_CAPABILITIES).toString(16).padStart(16, '0')}`,
    `NoNewPrivs:\t${opts.nnp ?? 1}`,
  ].join('\n');
}

const production = (text: string) =>
  detectShellIsolation({ production: true, maxProcesses: 128, platform: 'linux', readStatus: () => text });
const development = (text: string, platform: NodeJS.Platform = 'linux') =>
  detectShellIsolation({ production: false, maxProcesses: 128, platform, readStatus: () => text });

describe('reading this process’ credentials', () => {
  it('reads the uid, gid, effective capabilities and no_new_privs', () => {
    expect(parseProcessStatus(status())).toEqual({
      uid: 1002,
      gid: 1002,
      capEff: 0xc1n,
      noNewPrivs: true,
    });
  });

  it('names exactly SETUID, SETGID and CHOWN as what the service needs', () => {
    expect(REQUIRED_CAPABILITIES).toBe(0xc1n);
  });
});

describe('when the terminal will run shells per session', () => {
  it('does, in production, as its own account holding exactly the three capabilities', () => {
    expect(production(status())).toEqual({
      mode: 'per-session',
      serviceUid: 1002,
      serviceGid: 1002,
      maxProcesses: 128,
    });
  });

  it.each([
    ['as root', status({ uid: 0 }), /runs as root/],
    ['without SETUID', status({ capEff: 0x41n }), /does not hold SETUID, SETGID and CHOWN/],
    ['without CHOWN', status({ capEff: 0xc0n }), /does not hold SETUID, SETGID and CHOWN/],
    ['with DAC_OVERRIDE as well', status({ capEff: 0xc3n }), /beyond SETUID, SETGID and CHOWN \(0x2\)/],
    ['with SYS_ADMIN as well', status({ capEff: 0xc1n | (1n << 21n) }), /beyond SETUID, SETGID and CHOWN/],
    ['without no_new_privs', status({ nnp: 0 }), /no_new_privs is not set/],
    ['as a uid a session could be given', status({ uid: SHELL_UID_MIN + 3 }), /in the session shell range/],
    ['as the old shared student account without capabilities', status({ uid: 1001, capEff: 0n }), /does not hold/],
  ])('refuses to start in production %s', (_label, text, reason) => {
    expect(() => production(text)).toThrow(ShellIdentityError);
    expect(() => production(text)).toThrow(reason);
  });

  it('refuses to start in production on a platform with no per-session uids', () => {
    expect(() =>
      detectShellIsolation({ production: true, maxProcesses: 128, platform: 'darwin', readStatus: () => status() }),
    ).toThrow(/need Linux/);
  });

  it('refuses in production when its credentials cannot be read', () => {
    expect(() =>
      detectShellIsolation({
        production: true,
        maxProcesses: 128,
        platform: 'linux',
        readStatus: () => {
          throw new Error('EACCES');
        },
      }),
    ).toThrow(/Could not read/);
  });

  it('shares one uid in development, and says why, rather than failing a laptop', () => {
    expect(development(status({ uid: 501, capEff: 0n }))).toEqual({
      mode: 'shared',
      reason: 'it does not hold SETUID, SETGID and CHOWN',
    });
    expect(development(status(), 'darwin')).toMatchObject({ mode: 'shared' });
    // Extra capabilities and a missing no_new_privs are production's rules only.
    expect(development(status({ capEff: 0xc3n, nnp: 0 }))).toMatchObject({ mode: 'per-session' });
  });
});

describe('a session’s owner', () => {
  const perSession = production(status());

  it('is the uid the api assigned, as both user and group', () => {
    expect(ownerFor(perSession, SHELL_UID_MIN + 7)).toEqual({ uid: SHELL_UID_MIN + 7, gid: SHELL_UID_MIN + 7 });
  });

  it.each([undefined, null, 0, 1001, 1002, 65534, SHELL_UID_MIN - 1, SHELL_UID_MAX + 1, `${SHELL_UID_MIN}`, 1.5, NaN])(
    'is refused — never defaulted — for %s',
    (value) => {
      expect(() => ownerFor(perSession, value)).toThrow(ShellIdentityError);
    },
  );

  it('is nobody when shells are shared', () => {
    expect(ownerFor({ mode: 'shared', reason: 'laptop' }, undefined)).toBeNull();
  });
});

describe('what a session’s shell is started as', () => {
  const owner = { uid: SHELL_UID_MIN + 42, gid: SHELL_UID_MIN + 42 };
  const plan = { command: '/bin/bash', args: ['--norc', '--noprofile'], cwd: '/home/student/workspaces/ws-abc' };

  it('is the session’s uid and group, no supplementary groups, no capabilities, no_new_privs, a process ceiling', () => {
    const spawn = sessionShellCommand(owner, 96, plan);
    expect(spawn).toEqual({
      command: PRLIMIT,
      args: [
        '--nproc=96:96',
        '--',
        SETPRIV,
        `--reuid=${owner.uid}`,
        `--regid=${owner.gid}`,
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        ENV,
        '-C',
        plan.cwd,
        '--',
        '/bin/bash',
        '--norc',
        '--noprofile',
      ],
      // The service cannot enter the session's 0700 home; the shell's uid can.
      cwd: '/',
    });
  });

  it('clears the ambient and inheritable sets: a uid change between two non-root uids would keep them', () => {
    const { args } = sessionShellCommand(owner, 96, plan);
    const setprivArgs = args.slice(args.indexOf(SETPRIV) + 1, args.indexOf(ENV));
    expect(setprivArgs).toContain('--ambient-caps=-all');
    expect(setprivArgs).toContain('--inh-caps=-all');
    expect(setprivArgs.indexOf('--ambient-caps=-all')).toBeLessThan(setprivArgs.lastIndexOf('--'));
  });

  it.each([
    [{ uid: 0, gid: 0 }],
    [{ uid: 1001, gid: 1001 }],
    [{ uid: SHELL_UID_MAX + 1, gid: SHELL_UID_MAX + 1 }],
    [{ uid: SHELL_UID_MIN, gid: 0 }],
    [{ uid: SHELL_UID_MIN, gid: SHELL_UID_MIN + 1 }],
  ])('refuses %j', (bad) => {
    expect(() => sessionShellCommand(bad, 96, plan)).toThrow(ShellIdentityError);
  });

  it('refuses a relative program or directory, and a ceiling too small to use', () => {
    expect(() => sessionShellCommand(owner, 96, { ...plan, command: 'bash' })).toThrow(/absolute/);
    expect(() => sessionShellCommand(owner, 96, { ...plan, cwd: 'ws-abc' })).toThrow(/absolute/);
    expect(() => sessionShellCommand(owner, 2, plan)).toThrow(/process ceiling/);
  });
});
