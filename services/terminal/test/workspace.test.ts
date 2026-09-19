/**
 * PLATFORM-DOCKER — the session workspace.
 *
 * A Docker lab sometimes asks a student to *write* a file — a Dockerfile, a
 * compose file — and then build from it. That file lives in this container,
 * because this is where their shell runs and where `docker build` reads its
 * context from.
 *
 * Every student shell here runs as the same OS user, so file permissions alone
 * cannot separate them. Two things are done instead, and both are tested below:
 *
 *   - the directory name is an HMAC of the session id keyed by a server-side
 *     secret, so it cannot be derived from anything a student can see;
 *   - the root is `0711` — traversable but not listable — so a shell cannot
 *     enumerate the sessions it does not belong to.
 *
 * That is containment by unguessability, not by kernel enforcement, and it is
 * recorded as such in README → Known limitations. The isolation that matters for
 * this track — containers, images, volumes, networks — is enforced by separate
 * Docker daemons, not by this file.
 *
 * Separately, the verifier reads workspace files back over an authenticated
 * internal endpoint, so path handling here is a security boundary: a relative
 * path arriving from another service must not be able to name a file outside the
 * session it was asked about.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_WORKSPACE_FILE_BYTES,
  SessionWorkspaces,
  WorkspacePathError,
  resolveWorkspaceFile,
  workspaceDirFor,
} from '../src/workspace.js';

const SECRET = 'a-long-enough-workspace-secret';
const SESSION_A = 'sess-000000000000000a';
const SESSION_B = 'sess-000000000000000b';

const dirs: string[] = [];

/**
 * A workspace root that does not exist yet.
 *
 * Deliberately a path rather than a created directory: in production
 * `TERMINAL_WORKSPACE_ROOT` points at somewhere the service creates itself, and
 * the mode it creates it with is one of the things under test here.
 */
async function scratch(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'jtt-workspace-'));
  dirs.push(parent);
  return path.join(parent, 'workspaces');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ------------------------------------------------------------ directory name

describe('workspace directory names', () => {
  it('are keyed, so a session id alone does not reveal one', () => {
    const withSecret = workspaceDirFor('/w', SESSION_A, SECRET);
    const withAnother = workspaceDirFor('/w', SESSION_A, 'a-different-secret');

    expect(withSecret).not.toBe(withAnother);
    // The session id itself never appears in the path.
    expect(withSecret).not.toContain(SESSION_A);
    expect(path.basename(withSecret)).toMatch(/^ws-[0-9a-f]{16}$/);
  });

  it('are stable for one session and distinct between two', () => {
    expect(workspaceDirFor('/w', SESSION_A, SECRET)).toBe(workspaceDirFor('/w', SESSION_A, SECRET));
    expect(workspaceDirFor('/w', SESSION_A, SECRET)).not.toBe(
      workspaceDirFor('/w', SESSION_B, SECRET),
    );
  });

  it('refuse a session id with nothing usable in it', () => {
    expect(() => workspaceDirFor('/w', '///', SECRET)).toThrow(WorkspacePathError);
  });
});

// -------------------------------------------------------------- path safety

describe('workspace paths cannot leave the session that owns them', () => {
  const rejected = [
    ['an absolute path', '/etc/passwd'],
    ['parent traversal', '../../etc/passwd'],
    ['traversal in the middle', 'sub/../../escape'],
    ['a backslash separator', 'sub\\file'],
    ['an empty path', ''],
    ['a null byte', 'Docker\0file'],
  ] as const;

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => resolveWorkspaceFile('/w/ws-abc', value)).toThrow(WorkspacePathError);
    });
  }

  it('accepts an ordinary relative path, including a nested one', () => {
    expect(resolveWorkspaceFile('/w/ws-abc', 'Dockerfile')).toBe('/w/ws-abc/Dockerfile');
    expect(resolveWorkspaceFile('/w/ws-abc', 'app/Dockerfile')).toBe('/w/ws-abc/app/Dockerfile');
  });

  it('rejects a path that only resolves outside after normalisation', () => {
    // Belt and braces: rejected before resolving *and* re-checked after.
    expect(() => resolveWorkspaceFile('/w/ws-abc', './sub/./../../out')).toThrow(WorkspacePathError);
  });

  it('is string arithmetic, and says so: a symlinked name still resolves', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const dir = await workspaces.seed(SESSION_A, []);

    await writeFile(path.join(root, 'outside.txt'), 'not the student\'s\n');
    await symlink(path.join(root, 'outside.txt'), path.join(dir, 'link.txt'));

    // This function touches no filesystem, so it cannot see the link — which is
    // why `read` and `seed` resolve the path themselves. The two suites below
    // are what prove the boundary; this one pins the division of labour.
    expect(() => resolveWorkspaceFile(dir, 'link.txt')).not.toThrow();
    expect(() => resolveWorkspaceFile(dir, '../outside.txt')).toThrow(WorkspacePathError);
  });
});

// ------------------------------------------------- symlinks a student planted
//
// A student owns their workspace and can put a symlink in it. Two things must
// not follow one:
//
//   read   the verifier reads these files through this service, which runs as
//          uid 1001 with its own /proc closed to the shells it hosts. A read
//          that followed `Dockerfile -> /proc/self/environ` would hand the
//          verifier this service's environment — TERMINAL_SESSION_SECRET,
//          INTERNAL_SERVICE_SECRET, SANDBOXD_ATTACH_SECRET — through a file the
//          student chose.
//   seed   a lab reset restores the baseline. Writing *through* a planted link
//          would put student-chosen content at a student-chosen path outside
//          the session, with this service's identity.

describe('a symlink planted in a workspace', () => {
  it('does not redirect a read out of the session workspace', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const dir = await workspaces.seed(SESSION_A, []);

    const serviceOnly = path.join(root, 'service-only.txt');
    await writeFile(serviceOnly, 'TERMINAL_SESSION_SECRET=would-be-leaked\n');
    await symlink(serviceOnly, path.join(dir, 'Dockerfile'));

    await expect(workspaces.read(SESSION_A, 'Dockerfile')).rejects.toThrow(WorkspacePathError);
  });

  it('does not redirect a read into another session workspace', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const mine = await workspaces.seed(SESSION_A, []);
    const theirs = await workspaces.seed(SESSION_B, [{ path: 'Dockerfile', content: 'FROM theirs\n' }]);

    await symlink(path.join(theirs, 'Dockerfile'), path.join(mine, 'Dockerfile'));

    await expect(workspaces.read(SESSION_A, 'Dockerfile')).rejects.toThrow(WorkspacePathError);
  });

  it('still reads a symlink that stays inside the session workspace', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const dir = await workspaces.seed(SESSION_A, [{ path: 'app/Dockerfile', content: 'FROM alpine\n' }]);

    await symlink(path.join(dir, 'app', 'Dockerfile'), path.join(dir, 'Dockerfile'));

    expect(await workspaces.read(SESSION_A, 'Dockerfile')).toBe('FROM alpine\n');
  });

  it('does not write a baseline file through a link out of the workspace', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const dir = await workspaces.seed(SESSION_A, []);

    const outside = path.join(root, 'someone-elses.txt');
    await writeFile(outside, 'original\n');
    await symlink(outside, path.join(dir, 'Dockerfile'));

    await workspaces.seed(SESSION_A, [{ path: 'Dockerfile', content: 'FROM attacker\n' }]);

    // The link was replaced by the baseline; what it pointed at is untouched.
    expect(await readFile(outside, 'utf8')).toBe('original\n');
    expect(await readFile(path.join(dir, 'Dockerfile'), 'utf8')).toBe('FROM attacker\n');
    expect((await lstat(path.join(dir, 'Dockerfile'))).isSymbolicLink()).toBe(false);
  });

  it('does not write a baseline file through a linked parent directory', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const dir = await workspaces.seed(SESSION_A, []);

    const outsideDir = path.join(root, 'elsewhere');
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(dir, 'app'));

    await expect(
      workspaces.seed(SESSION_A, [{ path: 'app/Dockerfile', content: 'FROM attacker\n' }]),
    ).rejects.toThrow(WorkspacePathError);

    await expect(readFile(path.join(outsideDir, 'Dockerfile'), 'utf8')).rejects.toThrow();
  });
});

// ------------------------------------------------------------ seed and read

describe('SessionWorkspaces', () => {
  it('creates a listable-proof root and a private session directory', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });

    const dir = await workspaces.seed(SESSION_A, []);

    // 0711: enter your own workspace by name, but do not enumerate the root.
    expect((await stat(root)).mode & 0o777).toBe(0o711);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('writes the baseline files a lab declares', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });

    const dir = await workspaces.seed(SESSION_A, [
      { path: 'Dockerfile', content: 'FROM alpine:3.20\n' },
      { path: 'app/run.sh', content: '#!/bin/sh\necho hi\n' },
    ]);

    expect(await readFile(path.join(dir, 'Dockerfile'), 'utf8')).toBe('FROM alpine:3.20\n');
    expect(await readFile(path.join(dir, 'app', 'run.sh'), 'utf8')).toContain('echo hi');
  });

  it('is idempotent, because it runs at shell start and on every reset', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const files = [{ path: 'Dockerfile', content: 'FROM alpine:3.20\n' }];

    await workspaces.seed(SESSION_A, files);
    await workspaces.read(SESSION_A, 'Dockerfile');
    // A reset re-seeds; a student's edits are discarded, which is the point.
    await writeFile(path.join(workspaces.dirFor(SESSION_A), 'Dockerfile'), 'FROM broken\n');
    await workspaces.seed(SESSION_A, files);

    expect(await workspaces.read(SESSION_A, 'Dockerfile')).toBe('FROM alpine:3.20\n');
  });

  it('reads a file back, and reports a missing one as absent rather than failing', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    await workspaces.seed(SESSION_A, [{ path: 'Dockerfile', content: 'FROM alpine:3.20\n' }]);

    expect(await workspaces.read(SESSION_A, 'Dockerfile')).toBe('FROM alpine:3.20\n');
    expect(await workspaces.read(SESSION_A, 'nope.txt')).toBeNull();
    // A directory is not a file, and asking for one is not an error either.
    await mkdir(path.join(workspaces.dirFor(SESSION_A), 'app'), { recursive: true });
    expect(await workspaces.read(SESSION_A, 'app')).toBeNull();
  });

  it('never returns another session\'s file', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    await workspaces.seed(SESSION_A, [{ path: 'Dockerfile', content: 'session A\n' }]);
    await workspaces.seed(SESSION_B, [{ path: 'Dockerfile', content: 'session B\n' }]);

    expect(await workspaces.read(SESSION_A, 'Dockerfile')).toBe('session A\n');
    expect(await workspaces.read(SESSION_B, 'Dockerfile')).toBe('session B\n');
    // There is no parameter that could redirect a read at the other session:
    // the directory is derived from the session id, not supplied alongside it.
    expect(() => resolveWorkspaceFile(workspaces.dirFor(SESSION_A), '../ws-anything/Dockerfile')).toThrow(
      WorkspacePathError,
    );
  });

  it('caps what it will return, rather than reading an unbounded file', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const dir = await workspaces.seed(SESSION_A, []);
    await writeFile(path.join(dir, 'huge.txt'), 'x'.repeat(MAX_WORKSPACE_FILE_BYTES + 5_000));

    const content = await workspaces.read(SESSION_A, 'huge.txt');

    // Truncated rather than refused: a student who created a huge file by
    // accident should still get a useful answer about its first lines.
    expect(content).toHaveLength(MAX_WORKSPACE_FILE_BYTES);
  });

  it('reads only the cap from a file larger than any string this process could build', async () => {
    // The student's shell writes this directory and this process serves every
    // student's terminal. A whole-file read of this (sparse, so it costs no
    // disk) either fails outright or holds the whole file in memory before
    // cutting it to the cap; a bounded read answers from its first 256 KiB.
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const dir = await workspaces.seed(SESSION_A, []);
    await writeFile(path.join(dir, 'image.tar'), 'layer\n');
    await truncate(path.join(dir, 'image.tar'), 600 * 1024 * 1024);

    const content = await workspaces.read(SESSION_A, 'image.tar');

    expect(content).toHaveLength(MAX_WORKSPACE_FILE_BYTES);
    expect(content!.startsWith('layer\n')).toBe(true);
  });

  it('destroys a workspace, and tolerates destroying it twice', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    await workspaces.seed(SESSION_A, [{ path: 'Dockerfile', content: 'FROM alpine:3.20\n' }]);
    await workspaces.seed(SESSION_B, [{ path: 'Dockerfile', content: 'FROM alpine:3.20\n' }]);

    await workspaces.destroy(SESSION_A);
    await workspaces.destroy(SESSION_A);

    expect(await workspaces.read(SESSION_A, 'Dockerfile')).toBeNull();
    // Tearing one session down leaves the other's work exactly where it was.
    expect(await workspaces.read(SESSION_B, 'Dockerfile')).toBe('FROM alpine:3.20\n');
  });
});
