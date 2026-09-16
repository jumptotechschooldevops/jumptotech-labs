/**
 * The internal workspace endpoints, over HTTP.
 *
 * `workspace.test.ts` proves `SessionWorkspaces` in isolation. This proves the
 * three routes that are the only way into it from another process:
 *
 * ```text
 *   api (verifier) ──sid + relative path + x-internal-secret──► terminal
 *                  ◄──────────── file contents, size-capped ───
 * ```
 *
 * They deserve their own suite because they are a trust boundary that nothing
 * else covered: the shared-secret gate, the mapping from a `WorkspacePathError`
 * to a 400 rather than a 500, and the fact that a session id is the *only*
 * thing that selects a directory — there is no root, no prefix and no absolute
 * path a caller can name.
 *
 * The server is built with nothing else wired up. These routes need no API, no
 * broker and no PTY, and giving them one would only mean a suite that fails for
 * reasons that are not about them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadTerminalConfig } from '../src/config.js';
import { createTerminalServer } from '../src/server.js';
import { workspaceDirFor } from '../src/workspace.js';

const TERMINAL_SECRET = 'workspace-endpoints-session-secret';
const INTERNAL_SECRET = 'workspace-endpoints-internal-secret';
const SESSION_A = 'sess-000000000000000a';
const SESSION_B = 'sess-000000000000000b';

const started: Server[] = [];
const scratches: string[] = [];

afterEach(async () => {
  await Promise.all(
    started.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function terminal(): Promise<{ url: string; root: string; dirFor: (id: string) => string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'jtt-ws-endpoints-'));
  scratches.push(root);

  const config = loadTerminalConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    TERMINAL_WORKSPACE_ROOT: root,
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const server = createTerminalServer(config);
  started.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    root,
    dirFor: (id) => workspaceDirFor(root, id, config.sessionSecret),
  };
}

interface Reply {
  status: number;
  body: { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } };
}

async function post(url: string, route: string, body: unknown, secret = INTERNAL_SECRET): Promise<Reply> {
  const response = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-internal-secret': secret }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Reply['body'] };
}

// ------------------------------------------------------------------- the gate

describe('the workspace endpoints are for the API and nobody else', () => {
  it('refuses every route without the shared service secret', async () => {
    const { url } = await terminal();

    for (const route of ['/internal/workspace/read', '/internal/workspace/seed', '/internal/workspace/destroy']) {
      const refused = await post(url, route, { sessionId: SESSION_A, path: 'Dockerfile', files: [] }, 'wrong');
      expect(refused.status, route).toBe(401);
      expect(refused.body.error?.code, route).toBe('UNAUTHORIZED');
    }
  });

  it('refuses a request with no secret at all', async () => {
    const { url } = await terminal();
    const response = await fetch(`${url}/internal/workspace/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_A, path: 'Dockerfile' }),
    });
    expect(response.status).toBe(401);
  });

  it('answers 404 on a route that does not exist, rather than falling through', async () => {
    const { url } = await terminal();
    const response = await fetch(`${url}/internal/workspace`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

// ------------------------------------------------------------ the round trip

describe('seed, read, destroy', () => {
  it('writes what the lab declares and reads it back', async () => {
    const { url, dirFor } = await terminal();

    const seeded = await post(url, '/internal/workspace/seed', {
      sessionId: SESSION_A,
      files: [
        { path: 'Dockerfile', content: 'FROM alpine:3.20\n' },
        { path: 'app/run.sh', content: '#!/bin/sh\necho hi\n' },
      ],
    });
    expect(seeded.status).toBe(200);
    expect(seeded.body.data).toEqual({ seeded: 2 });

    const read = await post(url, '/internal/workspace/read', { sessionId: SESSION_A, path: 'Dockerfile' });
    expect(read.body.data).toEqual({ exists: true, content: 'FROM alpine:3.20\n' });

    const nested = await post(url, '/internal/workspace/read', { sessionId: SESSION_A, path: 'app/run.sh' });
    expect(nested.body.data).toEqual({ exists: true, content: '#!/bin/sh\necho hi\n' });

    // On disk, in this session's directory and no other.
    expect(await readFile(path.join(dirFor(SESSION_A), 'Dockerfile'), 'utf8')).toBe('FROM alpine:3.20\n');
  });

  it('reports a file nobody wrote as absent rather than as an error', async () => {
    const { url } = await terminal();
    await post(url, '/internal/workspace/seed', { sessionId: SESSION_A, files: [] });

    const read = await post(url, '/internal/workspace/read', { sessionId: SESSION_A, path: 'Dockerfile' });
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual({ exists: false, content: null });
  });

  it('reports a session that never had a workspace as absent, not as a failure', async () => {
    const { url } = await terminal();
    const read = await post(url, '/internal/workspace/read', { sessionId: SESSION_B, path: 'Dockerfile' });
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual({ exists: false, content: null });
  });

  it('destroys one session workspace and leaves the other alone', async () => {
    const { url } = await terminal();
    for (const sessionId of [SESSION_A, SESSION_B]) {
      await post(url, '/internal/workspace/seed', {
        sessionId,
        files: [{ path: 'Dockerfile', content: `FROM ${sessionId}\n` }],
      });
    }

    expect((await post(url, '/internal/workspace/destroy', { sessionId: SESSION_A })).body.data).toEqual({
      destroyed: true,
    });

    expect((await post(url, '/internal/workspace/read', { sessionId: SESSION_A, path: 'Dockerfile' })).body.data)
      .toEqual({ exists: false, content: null });
    expect((await post(url, '/internal/workspace/read', { sessionId: SESSION_B, path: 'Dockerfile' })).body.data)
      .toEqual({ exists: true, content: `FROM ${SESSION_B}\n` });
  });

  it('destroying twice is not an error', async () => {
    const { url } = await terminal();
    await post(url, '/internal/workspace/seed', { sessionId: SESSION_A, files: [] });
    expect((await post(url, '/internal/workspace/destroy', { sessionId: SESSION_A })).status).toBe(200);
    expect((await post(url, '/internal/workspace/destroy', { sessionId: SESSION_A })).status).toBe(200);
  });
});

// ------------------------------------------------------------- what it refuses

describe('a session id is the only thing that selects a directory', () => {
  it('refuses an absolute path, a traversal and a backslash — as 400, not 500', async () => {
    const { url } = await terminal();
    await post(url, '/internal/workspace/seed', { sessionId: SESSION_A, files: [] });

    for (const bad of ['/etc/passwd', '../../etc/passwd', 'sub/../../out', 'a\\b']) {
      const refused = await post(url, '/internal/workspace/read', { sessionId: SESSION_A, path: bad });
      expect(refused.status, bad).toBe(400);
      expect(refused.body.error?.code, bad).toBe('INVALID_WORKSPACE_PATH');
    }
  });

  it('refuses a malformed body without touching the filesystem', async () => {
    const { url } = await terminal();

    for (const body of [{}, { sessionId: SESSION_A }, { path: 'Dockerfile' }, { sessionId: 7, path: 'x' }]) {
      expect((await post(url, '/internal/workspace/read', body)).status).toBe(400);
    }
    expect((await post(url, '/internal/workspace/seed', { sessionId: SESSION_A })).status).toBe(400);
    expect((await post(url, '/internal/workspace/destroy', {})).status).toBe(400);
  });

  it('cannot be pointed at another session, even by naming its directory', async () => {
    const { url, dirFor } = await terminal();
    await post(url, '/internal/workspace/seed', {
      sessionId: SESSION_B,
      files: [{ path: 'Dockerfile', content: 'FROM theirs\n' }],
    });
    await post(url, '/internal/workspace/seed', { sessionId: SESSION_A, files: [] });

    // The directory name is an HMAC, so it is not derivable — but even handed
    // it outright, the path is relative to the caller's own session.
    const theirDirName = path.basename(dirFor(SESSION_B));
    const attempt = await post(url, '/internal/workspace/read', {
      sessionId: SESSION_A,
      path: `../${theirDirName}/Dockerfile`,
    });

    expect(attempt.status).toBe(400);
    expect(attempt.body.error?.code).toBe('INVALID_WORKSPACE_PATH');
  });

  /*
   * The same refusal a student can reach without a crafted path at all.
   *
   * They cannot send a request to this endpoint, but they own the directory it
   * reads from, so a symlink is their way of choosing the file. Proven here
   * over HTTP as well as in `workspace.test.ts` because this is the boundary the
   * verifier actually crosses, and a 400 is what keeps the answer out of a
   * check result.
   */
  it('refuses to follow a symlink a student planted, as 400', async () => {
    const { url, root, dirFor } = await terminal();
    await post(url, '/internal/workspace/seed', { sessionId: SESSION_A, files: [] });

    const outside = path.join(root, 'service-only.txt');
    await writeFile(outside, 'TERMINAL_SESSION_SECRET=would-be-leaked\n');
    await symlink(outside, path.join(dirFor(SESSION_A), 'Dockerfile'));

    const refused = await post(url, '/internal/workspace/read', { sessionId: SESSION_A, path: 'Dockerfile' });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe('INVALID_WORKSPACE_PATH');
    expect(JSON.stringify(refused.body)).not.toContain('would-be-leaked');
  });

  it('caps the request body rather than reading an unbounded seed', async () => {
    const { url } = await terminal();

    const huge = 'x'.repeat(300 * 1024);
    await expect(
      post(url, '/internal/workspace/seed', {
        sessionId: SESSION_A,
        files: [{ path: 'Dockerfile', content: huge }],
      }),
    ).rejects.toThrow();

    // Nothing was written: the read reports absence, not a truncated file.
    const read = await post(url, '/internal/workspace/read', { sessionId: SESSION_A, path: 'Dockerfile' });
    expect(read.body.data).toEqual({ exists: false, content: null });
  });
});
