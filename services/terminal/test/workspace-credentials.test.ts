/**
 * PLATFORM-CICD-001 — the terminal service and file-backed sessions.
 *
 * The terminal now serves two kinds of sandbox, and the only thing that tells
 * them apart is the `kind` discriminator on the credentials the API returns.
 * These tests cover the gate that runs before a PTY is spawned: what is
 * accepted, what is refused, and the fact that a workspace session is handed
 * no cluster credential of any kind.
 *
 * (`buildShellSetup` itself lives in `server.ts`, which imports `node-pty`;
 * the PTY-spawning path is covered by `terminal-integration.test.ts`, which
 * runs inside the terminal container.)
 */
import { describe, expect, it } from 'vitest';
import {
  CredentialsUnavailableError,
  assertUsableCredentials,
  fetchStudentCredentials,
  type StudentCredentialsResponse,
} from '../src/credentials.js';

const NAMESPACE = 'lab-0000000000aa';

function workspaceCredentials(
  overrides: Partial<Extract<StudentCredentialsResponse, { kind: 'workspace' }>> = {},
): StudentCredentialsResponse {
  return {
    kind: 'workspace',
    namespace: NAMESPACE,
    workspacePath: `/var/lib/jumptotech/workspaces/${NAMESPACE}`,
    environment: { CI: 'true', JTT_LAB_ID: 'CICD-002' },
    expiresAt: new Date().toISOString(),
    ...overrides,
  } as StudentCredentialsResponse;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('workspace credentials', () => {
  it('accepts a well-formed workspace response', () => {
    const credentials = assertUsableCredentials(workspaceCredentials());
    expect(credentials.kind).toBe('workspace');
    // Nothing cluster-shaped is present at all — there is no token to leak.
    expect(JSON.stringify(credentials)).not.toMatch(/kubeconfig|serviceAccount|token/i);
  });

  it('refuses a relative workspace path', () => {
    expect(() => assertUsableCredentials(workspaceCredentials({ workspacePath: 'workspaces/lab-0000000000aa' }))).toThrow(
      /no workspace path/,
    );
  });

  it('refuses a path containing a parent reference', () => {
    expect(() =>
      assertUsableCredentials(workspaceCredentials({ workspacePath: `/var/lib/../etc/${NAMESPACE}` })),
    ).toThrow(/parent reference/);
  });

  it("refuses a path that does not end in this session's own sandbox name", () => {
    expect(() =>
      assertUsableCredentials(
        workspaceCredentials({ workspacePath: '/var/lib/jumptotech/workspaces/lab-ffffffffffff' }),
      ),
    ).toThrow(/does not belong to this session/);
  });

  it('refuses credentials of an unknown kind rather than spawning a shell with nothing', () => {
    expect(() =>
      assertUsableCredentials({ kind: 'magic', namespace: NAMESPACE } as unknown as StudentCredentialsResponse),
    ).toThrow(CredentialsUnavailableError);
  });

  it('travels the whole internal fetch path intact', async () => {
    const credentials = await fetchStudentCredentials({
      apiInternalUrl: 'http://api:4000',
      secret: 'internal',
      sessionId: 'sess-000000000000000a',
      fetchImpl: (async () => jsonResponse({ ok: true, data: workspaceCredentials() })) as unknown as typeof fetch,
    });

    expect(credentials.kind).toBe('workspace');
    if (credentials.kind !== 'workspace') throw new Error('unreachable');
    expect(credentials.workspacePath).toBe(`/var/lib/jumptotech/workspaces/${NAMESPACE}`);
    expect(credentials.environment.CI).toBe('true');
  });
});
