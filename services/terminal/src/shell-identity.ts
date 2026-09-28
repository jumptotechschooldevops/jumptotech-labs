/**
 * Each session's shell runs as a uid of its own — SEC-ARCH-2.
 *
 * ## What was wrong
 *
 * Kubernetes- and Docker-track shells are PTYs this service spawns in its own
 * container. BETA-P0-010 dropped the whole service to the `student` account
 * (1001), which closed the service's environment to its shells, but left every
 * shell running as that one uid. So one student could:
 *
 * ```text
 *   ls /run/jumptotech                           every session's credentials
 *   tr '\0' '\n' < /proc/<their bash>/environ   KUBECONFIG / DOCKER_CERT_PATH
 *   KUBECONFIG=<theirs> kubectl …               act in their namespace
 *   echo x > <their workspace>/Dockerfile       change their work and grade
 *   kill -9 <any shell, or this service>
 * ```
 *
 * and a `nohup`ed process outlived its session and could read the next ones'.
 *
 * ## The model now
 *
 * ```text
 *   container (root, cap_drop ALL + SETUID SETGID CHOWN, no-new-privileges)
 *     └─ setpriv → this service: uid jtt-terminal, those 3 caps as *ambient*
 *          └─ prlimit → setpriv → env -C <home> → bash
 *               uid = the session's shell uid (from the API, per session)
 *               no capabilities of any kind, no supplementary groups,
 *               no_new_privs, a process-count ceiling of its own
 * ```
 *
 *   - The service is not root and is not any student. It holds exactly the
 *     three capabilities it needs: SETUID and SETGID to start a shell as the
 *     session's uid, CHOWN to hand that session its files and take them back.
 *   - A shell holds nothing. `setpriv` clears the inheritable and ambient sets
 *     before it `exec`s, which matters: a child that changes uid between two
 *     non-zero uids *keeps* its ambient capabilities, so spawning with
 *     node-pty's or libuv's own `uid` option would have handed every student
 *     CAP_SETUID. Every shell goes through `sessionShellCommand` below.
 *   - Every file of a session — its kubeconfig or Docker client key, its home
 *     or workspace — is owned by the session's uid, `0600`/`0700`, under
 *     service-owned directories that are traversable but not listable (`0711`).
 *   - A uid belongs to one session, forever (the api's sequence does not
 *     cycle), so ending a session can kill *every* process of its uid
 *     (`kill -9 -1`, run as that uid) without touching anyone else's, and
 *     nothing a session leaves behind can be inherited by a later one.
 *
 * Verified on a real kernel, in a container launched as production launches
 * this one: `test/shell-isolation-container-integration.test.ts`.
 *
 * ## Development
 *
 * A laptop runs this service as its own user with no capabilities. There the
 * mode is `shared`: shells run as the service's uid, exactly as before, and a
 * warning says so. Production refuses to start in that mode.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, lchown, lstat, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isValidShellUid } from '@jumptotech/lab-orchestrator';

const execFileAsync = promisify(execFile);

/** `capabilities(7)` bit numbers for the three capabilities this service holds. */
const CAP_CHOWN = 0n;
const CAP_SETGID = 6n;
const CAP_SETUID = 7n;
/** SETUID | SETGID | CHOWN = 0xc1. */
export const REQUIRED_CAPABILITIES = (1n << CAP_SETUID) | (1n << CAP_SETGID) | (1n << CAP_CHOWN);

/** Absolute paths only: the service never resolves a program through PATH. */
export const SETPRIV = '/usr/bin/setpriv';
export const PRLIMIT = '/usr/bin/prlimit';
export const ENV = '/usr/bin/env';
export const SH = '/bin/sh';

export class ShellIdentityError extends Error {
  readonly code = 'SHELL_IDENTITY_UNSAFE';
  constructor(message: string) {
    super(message);
    this.name = 'ShellIdentityError';
  }
}

/** The owner a session's files and processes get. */
export interface SessionOwner {
  uid: number;
  gid: number;
}

export type ShellIsolation =
  | {
      mode: 'per-session';
      /** This service's own identity: what reclaimed files are handed back to. */
      serviceUid: number;
      serviceGid: number;
      /** RLIMIT_NPROC for each shell's uid. */
      maxProcesses: number;
    }
  | { mode: 'shared'; reason: string };

/** What `/proc/self/status` says about this process. */
export interface ProcessStatus {
  uid: number;
  gid: number;
  capEff: bigint;
  noNewPrivs: boolean;
}

export function parseProcessStatus(text: string): ProcessStatus {
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim();
  const firstId = (name: string): number => Number.parseInt((field(name) ?? '').split(/\s+/)[0] ?? '', 10);
  const capEff = field('CapEff');
  return {
    uid: firstId('Uid'),
    gid: firstId('Gid'),
    capEff: capEff && /^[0-9a-f]+$/i.test(capEff) ? BigInt(`0x${capEff}`) : 0n,
    noNewPrivs: field('NoNewPrivs') === '1',
  };
}

/**
 * Decide how shells are isolated, once, at startup.
 *
 * `per-session` needs this process to be non-root and to hold SETUID, SETGID
 * and CHOWN. Production additionally requires that it holds *nothing else*,
 * that no_new_privs is set, and that its own uid is not one a session could be
 * assigned — and refuses to start otherwise, rather than run every student as
 * one uid.
 */
export function detectShellIsolation(options: {
  production: boolean;
  maxProcesses: number;
  platform?: NodeJS.Platform;
  readStatus?: () => string;
}): ShellIsolation {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') {
    if (options.production) {
      throw new ShellIdentityError('Per-session shell identities need Linux; refusing to start in production.');
    }
    return { mode: 'shared', reason: `platform ${platform} has no per-session uids` };
  }

  let status: ProcessStatus;
  try {
    status = parseProcessStatus((options.readStatus ?? (() => readProcSelfStatus()))());
  } catch (error) {
    if (options.production) {
      throw new ShellIdentityError(`Could not read this process' credentials: ${String(error)}`);
    }
    return { mode: 'shared', reason: 'could not read /proc/self/status' };
  }

  const hasRequired = (status.capEff & REQUIRED_CAPABILITIES) === REQUIRED_CAPABILITIES;
  const extra = status.capEff & ~REQUIRED_CAPABILITIES;
  const problems: string[] = [];
  if (!Number.isSafeInteger(status.uid)) problems.push('its uid could not be read');
  if (status.uid === 0) problems.push('it runs as root; it must be launched as its own non-root account');
  if (isValidShellUid(status.uid)) problems.push(`its uid ${status.uid} is in the session shell range`);
  if (!hasRequired) problems.push('it does not hold SETUID, SETGID and CHOWN');

  if (options.production) {
    if (extra !== 0n) problems.push(`it holds capabilities beyond SETUID, SETGID and CHOWN (0x${extra.toString(16)})`);
    if (!status.noNewPrivs) problems.push('no_new_privs is not set');
    if (problems.length > 0) {
      throw new ShellIdentityError(
        `The terminal cannot give each session's shell a uid of its own: ${problems.join('; ')}. ` +
          'Launch it as the image does (setpriv, ambient SETUID/SETGID/CHOWN, no-new-privileges).',
      );
    }
  } else if (problems.length > 0) {
    return { mode: 'shared', reason: problems.join('; ') };
  }

  return {
    mode: 'per-session',
    serviceUid: status.uid,
    serviceGid: status.gid,
    maxProcesses: options.maxProcesses,
  };
}

function readProcSelfStatus(): string {
  // Synchronous on purpose: this runs once, before anything listens.
  return readFileSync('/proc/self/status', 'utf8');
}

/** The owner for a session in this isolation mode, or `null` when shells are shared. */
export function ownerFor(isolation: ShellIsolation, shellUid: unknown): SessionOwner | null {
  if (isolation.mode === 'shared') return null;
  if (!isValidShellUid(shellUid)) {
    throw new ShellIdentityError('This session has no valid shell uid; refusing to open a shell it would share.');
  }
  return { uid: shellUid, gid: shellUid };
}

/** `setpriv` arguments that make the next program `owner`, holding nothing. */
function dropTo(owner: SessionOwner): string[] {
  return [
    `--reuid=${owner.uid}`,
    `--regid=${owner.gid}`,
    '--clear-groups',
    // Both, before exec: an ambient capability survives a uid change between
    // two non-zero uids, and would survive into the shell.
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--no-new-privs',
  ];
}

/**
 * The program and arguments that run `command` as the session's own uid.
 *
 * `cwd` is entered *after* the uid changes (`env -C`): the session's home is
 * `0700` to that uid, which this service cannot enter itself. So the PTY is
 * spawned in `/` and the shell starts where it should.
 */
export function sessionShellCommand(
  owner: SessionOwner,
  maxProcesses: number,
  spec: { command: string; args: string[]; cwd: string },
): { command: string; args: string[]; cwd: string } {
  if (!isValidShellUid(owner.uid) || owner.gid !== owner.uid) {
    throw new ShellIdentityError(`${owner.uid}:${owner.gid} is not a session shell identity`);
  }
  if (!Number.isSafeInteger(maxProcesses) || maxProcesses < 8) {
    throw new ShellIdentityError(`${maxProcesses} is not a usable process ceiling`);
  }
  if (!path.isAbsolute(spec.command) || !path.isAbsolute(spec.cwd)) {
    throw new ShellIdentityError('a session shell is started by absolute path, in an absolute directory');
  }
  return {
    command: PRLIMIT,
    args: [
      `--nproc=${maxProcesses}:${maxProcesses}`,
      '--',
      SETPRIV,
      ...dropTo(owner),
      '--',
      ENV,
      '-C',
      spec.cwd,
      '--',
      spec.command,
      ...spec.args,
    ],
    cwd: '/',
  };
}

/** Run a fixed program as `owner`, holding nothing. Never with student input as argv. */
async function runAs(owner: SessionOwner, program: string, args: string[]): Promise<void> {
  await execFileAsync(SETPRIV, [...dropTo(owner), '--', program, ...args], {
    timeout: 5_000,
    env: { PATH: '/usr/bin:/bin' },
  });
}

/** Pids whose real uid is `uid`. `/proc/<pid>/status` is readable for every process. */
export async function processesOf(uid: number, procRoot = '/proc'): Promise<number[]> {
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = parseProcessStatus(await readFile(path.join(procRoot, entry, 'status'), 'utf8'));
      if (status.uid === uid) pids.push(Number(entry));
    } catch {
      // Gone between readdir and read.
    }
  }
  return pids;
}

/**
 * Kill every process of a session's uid, and prove it.
 *
 * `kill -9 -1` run *as* the uid reaches exactly that uid's processes: a process
 * without capabilities may signal only its own uid's. It is repeated because a
 * process can fork while the signal is being delivered; after a few rounds a
 * uid with processes left is reported, never assumed empty.
 */
export async function killSessionProcesses(owner: SessionOwner, procRoot = '/proc'): Promise<number[]> {
  for (let round = 0; round < 5; round += 1) {
    if ((await processesOf(owner.uid, procRoot)).length === 0) return [];
    await runAs(owner, SH, ['-c', 'kill -9 -1']).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50 * (round + 1)));
  }
  return processesOf(owner.uid, procRoot);
}

/**
 * Give a tree this service created to a session: every entry, and the root.
 *
 * Entries first, root last, so the session can reach none of it until all of
 * it is theirs. `lchown` never follows a link.
 */
export async function handTree(target: string, owner: SessionOwner): Promise<void> {
  const stat = await lstat(target);
  if (stat.isDirectory()) {
    for (const entry of await readdir(target)) await handTree(path.join(target, entry), owner);
  }
  await lchown(target, owner.uid, owner.gid);
}

/**
 * Take a session's tree back, so this service can read, rewrite or delete it.
 *
 * The root first: once a directory is the service's, the session can no longer
 * add to it, so what `readdir` lists is everything there will be. Each
 * directory is made `0700` for its new owner, since the session may have left
 * it `000`.
 */
export async function reclaimTree(target: string, service: SessionOwner): Promise<void> {
  const stat = await lstat(target);
  await lchown(target, service.uid, service.gid);
  if (!stat.isDirectory()) return;
  await chmod(target, 0o700);
  for (const entry of await readdir(target)) await reclaimTree(path.join(target, entry), service);
}

/** Remove a tree whoever owns it now. Never follows a link out of it. */
export async function removeTree(target: string, service: SessionOwner | null): Promise<void> {
  if (service) {
    try {
      await reclaimTree(target, service);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
  await rm(target, { recursive: true, force: true });
}
