/**
 * Per-session credential handling in the terminal service.
 *
 * The property under test is the PLATFORM-002 headline: a student shell is
 * given a namespace-scoped kubeconfig fetched for its own session, and nothing
 * else — never an ambient cluster credential.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CredentialsUnavailableError,
  credentialMode,
  fetchStudentCredentials,
  removeSessionKubeconfig,
  removeSessionPrivateKey,
  writeSessionKubeconfig,
  writeSessionPrivateKey,
} from '../src/credentials.js';
import { loadTerminalConfig } from '../src/config.js';

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jtt-creds-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const KUBECONFIG = 'apiVersion: v1\nkind: Config\n';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchStudentCredentials', () => {
  it('asks the API for exactly the session it was given', async () => {
    const calls: Array<{ url: string; secret: string | null }> = [];

    const credentials = await fetchStudentCredentials({
      apiInternalUrl: 'http://api:4000',
      secret: 'service-secret',
      sessionId: 'sess-000000000000000a',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          secret: (init.headers as Record<string, string>)['x-internal-secret'] ?? null,
        });
        return jsonResponse({
          ok: true,
          data: {
            kubeconfig: KUBECONFIG,
            namespace: 'lab-0000000000aa',
            serviceAccountName: 'student',
            expiresAt: new Date().toISOString(),
          },
        });
      }) as unknown as typeof fetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'http://api:4000/internal/sessions/sess-000000000000000a/credentials',
    );
    expect(calls[0]?.secret).toBe('service-secret');
    expect(credentials.namespace).toBe('lab-0000000000aa');
  });

  it('url-encodes the session id so it cannot shape the request path', async () => {
    let requested = '';
    await fetchStudentCredentials({
      apiInternalUrl: 'http://api:4000',
      secret: 's',
      sessionId: '../../internal/admin',
      fetchImpl: (async (url: string) => {
        requested = String(url);
        return jsonResponse({
          ok: true,
          data: { kubeconfig: KUBECONFIG, namespace: 'x', serviceAccountName: 'student', expiresAt: '' },
        });
      }) as unknown as typeof fetch,
    });

    expect(requested).toContain('%2F..%2Finternal%2Fadmin');
    expect(requested).not.toContain('/../');
  });

  it('surfaces the API’s structured error', async () => {
    await expect(
      fetchStudentCredentials({
        apiInternalUrl: 'http://api:4000',
        secret: 's',
        sessionId: 'sess-000000000000000a',
        fetchImpl: (async () =>
          jsonResponse(
            { ok: false, error: { code: 'SESSION_NOT_ACTIVE', message: 'This lab session is ENDED.' } },
            409,
          )) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
  });

  it('fails closed when the API is unreachable', async () => {
    await expect(
      fetchStudentCredentials({
        apiInternalUrl: 'http://api:4000',
        secret: 's',
        sessionId: 'sess-000000000000000a',
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(CredentialsUnavailableError);
  });

  it('refuses an empty kubeconfig rather than spawning an unscoped shell', async () => {
    await expect(
      fetchStudentCredentials({
        apiInternalUrl: 'http://api:4000',
        secret: 's',
        sessionId: 'sess-000000000000000a',
        fetchImpl: (async () =>
          jsonResponse({
            ok: true,
            data: { kubeconfig: '', namespace: 'x', serviceAccountName: 'student', expiresAt: '' },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/empty kubeconfig/);
  });
});

describe('writeSessionKubeconfig', () => {
  it('writes the file private to the owner', async () => {
    const dir = await scratch();

    const file = await writeSessionKubeconfig(dir, 'sess-000000000000000a', KUBECONFIG);

    expect(await readFile(file, 'utf8')).toBe(KUBECONFIG);
    // 0600: no group or other access to a live cluster credential.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('sanitises the session id so it cannot escape the directory', async () => {
    const dir = await scratch();

    const file = await writeSessionKubeconfig(dir, '../../etc/passwd', KUBECONFIG);

    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toBe('etcpasswd.kubeconfig');
  });

  it('refuses a session id with nothing usable in it', async () => {
    const dir = await scratch();

    await expect(writeSessionKubeconfig(dir, '///', KUBECONFIG)).rejects.toThrow(
      /unnamed session/,
    );
  });

  it('removes the credential file, and tolerates removing it twice', async () => {
    const dir = await scratch();
    const file = await writeSessionKubeconfig(dir, 'sess-000000000000000a', KUBECONFIG);

    await removeSessionKubeconfig(file);
    await removeSessionKubeconfig(file);

    await expect(stat(file)).rejects.toThrow();
  });
});

describe('SSH credentials (Ansible track)', () => {
  const SSH = {
    host: '127.0.0.1',
    port: 33001,
    user: 'student',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMII…\n-----END RSA PRIVATE KEY-----',
    workdir: '/home/student/lab',
  };

  function sshEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      data: {
        kubeconfig: '',
        namespace: 'lab-0000000000aa',
        serviceAccountName: 'student',
        expiresAt: '2099-01-01T00:00:00.000Z',
        shell: 'ssh',
        ssh: SSH,
        ...overrides,
      },
    };
  }

  it('accepts an SSH credential with no kubeconfig at all', async () => {
    const credentials = await fetchStudentCredentials({
      apiInternalUrl: 'http://api:4000',
      secret: 's',
      sessionId: 'sess-000000000000000a',
      fetchImpl: async () => jsonResponse(sshEnvelope()),
    });

    expect(credentialMode(credentials)).toBe('ssh');
    expect(credentials.ssh?.port).toBe(33001);
    expect(credentials.kubeconfig).toBe('');
  });

  it('refuses an SSH credential that is missing its key', async () => {
    await expect(
      fetchStudentCredentials({
        apiInternalUrl: 'http://api:4000',
        secret: 's',
        sessionId: 'sess-000000000000000a',
        fetchImpl: async () => jsonResponse(sshEnvelope({ ssh: { ...SSH, privateKey: '' } })),
      }),
    ).rejects.toThrow(/incomplete SSH credentials/);
  });

  it('refuses an SSH credential with a nonsensical port', async () => {
    await expect(
      fetchStudentCredentials({
        apiInternalUrl: 'http://api:4000',
        secret: 's',
        sessionId: 'sess-000000000000000a',
        fetchImpl: async () => jsonResponse(sshEnvelope({ ssh: { ...SSH, port: 'the usual one' } })),
      }),
    ).rejects.toThrow(/incomplete SSH credentials/);
  });

  it('still requires a kubeconfig when the credential is a local one', async () => {
    await expect(
      fetchStudentCredentials({
        apiInternalUrl: 'http://api:4000',
        secret: 's',
        sessionId: 'sess-000000000000000a',
        fetchImpl: async () => jsonResponse(sshEnvelope({ shell: 'local', ssh: undefined })),
      }),
    ).rejects.toThrow(/empty kubeconfig/);
  });

  it('defaults to a local shell when the response says nothing', async () => {
    const credentials = await fetchStudentCredentials({
      apiInternalUrl: 'http://api:4000',
      secret: 's',
      sessionId: 'sess-000000000000000a',
      fetchImpl: async () =>
        jsonResponse({
          ok: true,
          data: {
            kubeconfig: KUBECONFIG,
            namespace: 'lab-0000000000aa',
            serviceAccountName: 'student',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        }),
    });

    expect(credentialMode(credentials)).toBe('local');
  });

  it('writes the private key 0600 — OpenSSH refuses anything looser', async () => {
    const dir = await scratch();

    const file = await writeSessionPrivateKey(dir, 'sess-000000000000000a', SSH.privateKey);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe(`${SSH.privateKey}\n`);
  });

  it('sanitises the session id for the key file too', async () => {
    const dir = await scratch();

    const file = await writeSessionPrivateKey(dir, '../../root/.ssh/id_rsa', SSH.privateKey);

    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toBe('rootsshid_rsa.key');
  });

  it('removes the key, and tolerates removing it twice', async () => {
    const dir = await scratch();
    const file = await writeSessionPrivateKey(dir, 'sess-000000000000000a', SSH.privateKey);

    await removeSessionPrivateKey(file);
    await removeSessionPrivateKey(file);

    await expect(stat(file)).rejects.toThrow();
  });
});

describe('terminal configuration', () => {
  it('holds no ambient cluster credential', () => {
    // The old shape read KUBECONFIG from the environment and handed it to every
    // PTY. There is deliberately no such field any more.
    const config = loadTerminalConfig({
      TERMINAL_SESSION_SECRET: 'a-long-enough-secret',
      KUBECONFIG: '/etc/kubernetes/admin.conf',
    } as NodeJS.ProcessEnv);

    expect(Object.keys(config)).not.toContain('kubeconfigPath');
    expect(JSON.stringify(config)).not.toContain('admin.conf');
  });

  it('requires a session secret', () => {
    expect(() => loadTerminalConfig({} as NodeJS.ProcessEnv)).toThrow(/TERMINAL_SESSION_SECRET/);
  });

  it('names an SSH client but no sandbox to point it at', () => {
    // The binary is operator configuration. Every value that varies per session
    // — host, port, user, key — comes from the API's credential response, so
    // there is deliberately no sandbox address anywhere in this config.
    const config = loadTerminalConfig({
      TERMINAL_SESSION_SECRET: 'a-long-enough-secret',
    } as NodeJS.ProcessEnv);

    expect(config.sshBinary).toBe('/usr/bin/ssh');
    expect(JSON.stringify(config)).not.toMatch(/lab-[0-9a-f]/);
  });
});
