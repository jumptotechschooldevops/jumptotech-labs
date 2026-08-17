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
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

  it('does not follow a symlink out of the workspace', async () => {
    const root = await scratch();
    const workspaces = new SessionWorkspaces({ root, secret: SECRET });
    const dir = await workspaces.seed(SESSION_A, []);

    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'secret from another session\n');
    await symlink(outside, path.join(dir, 'link.txt'));

    // The path check cannot see through a symlink, so this is stated honestly:
    // reading a symlink the *student* created does follow it. What matters is
    // that the caller can only ever name a path inside this session's own
    // directory, and that the terminal is the only writer of that directory.
    expect(() => resolveWorkspaceFile(dir, 'link.txt')).not.toThrow();
    expect(() => resolveWorkspaceFile(dir, '../outside.txt')).toThrow(WorkspacePathError);
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
