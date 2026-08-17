/**
 * Where a student's shell lands.
 *
 * The Ansible track hands the terminal an `ssh.workdir` alongside the session
 * key — the lab project directory on that session's control node. This module
 * turns it into the remote command that opens a shell there.
 *
 * **What this is and is not.** It makes the landing directory a property of the
 * credential the API issued rather than only of the image's shell rc files, so
 * the terminal still opens in the project if `.profile` ever changes or is
 * dropped from the sandbox image. It is not a control over the student: the
 * login shell runs their `.profile` *after* this `cd`, so a student who edits
 * their own rc files moves their own shell. That crosses no boundary — it is
 * their sandbox — and the two agree on the shipped image.
 *
 * It lives apart from `server.ts` so it can be tested without loading node-pty,
 * which needs a real PTY and is unavailable on some hosts.
 */

/**
 * An absolute path with no shell-significant character in it.
 *
 * The workdir is platform-authored — the provider supplies a constant, and no
 * lab definition or browser frame contributes to it — so this pattern is a
 * backstop rather than the primary control. It is here because the workdir is
 * the one part of the ssh argv that becomes *remote shell syntax*, and a
 * backstop on that is cheap.
 */
const SAFE_WORKDIR = /^\/[A-Za-z0-9._\-/]{0,255}$/;

export function isSafeWorkdir(workdir: string): boolean {
  return SAFE_WORKDIR.test(workdir) && !workdir.includes('..');
}

/**
 * The remote command that opens the student's shell in the lab directory.
 *
 * Returns no command at all when there is no usable workdir, which leaves ssh
 * to open a plain login shell — the behaviour before this existed. A shell in
 * the home directory is a worse experience than one in the project, but it is a
 * working shell; refusing to connect over it would be the wrong trade.
 *
 * `${SHELL:-/bin/sh}` rather than a hardcoded shell: sshd exports the account's
 * own login shell, and the fallback keeps this working on an image where it
 * does not. `-l` so the student still gets their profile, aliases, and exports.
 */
export function remoteLoginCommand(workdir: string | undefined): string[] {
  if (!workdir || !isSafeWorkdir(workdir)) return [];
  return [`cd ${workdir} && exec "\${SHELL:-/bin/sh}" -l`];
}
