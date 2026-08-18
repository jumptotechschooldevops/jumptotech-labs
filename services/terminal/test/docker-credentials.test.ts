/**
 * PLATFORM-DOCKER — the terminal's half of Docker isolation.
 *
 * The Kubernetes headline was: a student shell is given a namespace-scoped
 * kubeconfig fetched for its own session, and nothing else. The Docker headline
 * is the same sentence with one noun changed — a shell is given a client
 * certificate for *its own sandbox's* daemon, and nothing else. This service
 * holds no ambient Docker credential of any kind: there is no `DOCKER_HOST` in
 * its configuration and no socket mounted into its container.
 *
 * Two things are therefore tested here:
 *
 *   - the credential payload is narrowed by explicit field checks, not by a
 *     cast, because it arrives over the network;
 *   - the material lands in private files that are removed with the shell.
 *
 * The session workspace — where a Docker student authors a Dockerfile — is
 * covered in `workspace.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CredentialsUnavailableError,
  fetchStudentCredentials,
  fetchTerminalContext,
  removeSessionDockerCerts,
  writeSessionDockerCerts,
} from '../src/credentials.js';
import { loadTerminalConfig } from '../src/config.js';

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jtt-docker-creds-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const DOCKER_CREDENTIALS = {
  kind: 'docker-daemon',
  dockerHost: 'tcp://lab-0000000000aa:2376',
  ca: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n',
  clientCert: '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n',
  clientKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
  sandboxRef: 'lab-0000000000aa',
  workspaceFiles: [{ path: 'Dockerfile', content: 'FROM alpine:3.20\n' }],
  expiresAt: new Date(3_000_000_000_000).toISOString(),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchReturning(data: unknown): typeof fetch {
  return (async () => jsonResponse({ ok: true, data })) as unknown as typeof fetch;
}

describe('fetchTerminalContext — Docker payloads', () => {
  it('accepts a Docker credential and keeps it distinguishable from a kubeconfig', async () => {
    const credentials = await fetchTerminalContext({
      apiInternalUrl: 'http://api:4000',
      secret: 'service-secret',
      sessionId: 'sess-000000000000000a',
      fetchImpl: fetchReturning(DOCKER_CREDENTIALS),
    });

    expect(credentials.kind).toBe('docker-daemon');
    // The discriminant is what lets the server build a Docker shell rather than
    // reading a kubeconfig field that was never there.
    if (credentials.kind !== 'docker-daemon') throw new Error('expected Docker credentials');
    expect(credentials.dockerHost).toBe('tcp://lab-0000000000aa:2376');
    expect(credentials.sandboxRef).toBe('lab-0000000000aa');
    expect(credentials.workspaceFiles).toEqual([
      { path: 'Dockerfile', content: 'FROM alpine:3.20\n' },
    ]);
  });

  it('refuses to hand a Docker session a kubeconfig it does not have', async () => {
    // `fetchStudentCredentials` is the Kubernetes-only narrowing. A Docker
    // session has no kubeconfig, and saying so beats returning a half-empty one.
    await expect(
      fetchStudentCredentials({
        apiInternalUrl: 'http://api:4000',
        secret: 'service-secret',
        sessionId: 'sess-000000000000000a',
        fetchImpl: fetchReturning(DOCKER_CREDENTIALS),
      }),
    ).rejects.toThrow(/not backed by a Kubernetes namespace/);
  });

  it('still recognises a kubeconfig payload that predates the discriminator', async () => {
    const credentials = await fetchTerminalContext({
      apiInternalUrl: 'http://api:4000',
      secret: 's',
      sessionId: 'sess-000000000000000a',
      fetchImpl: fetchReturning({
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        namespace: 'lab-0000000000aa',
        serviceAccountName: 'student',
        expiresAt: '',
      }),
    });

    expect(credentials.kind).toBe('kubernetes');
  });

  it('refuses a Docker credential missing any part of its TLS material', async () => {
    for (const field of ['dockerHost', 'ca', 'clientCert', 'clientKey'] as const) {
      await expect(
        fetchTerminalContext({
          apiInternalUrl: 'http://api:4000',
          secret: 's',
          sessionId: 'sess-000000000000000a',
          fetchImpl: fetchReturning({ ...DOCKER_CREDENTIALS, [field]: '' }),
        }),
        `missing ${field}`,
      ).rejects.toThrow(new RegExp(`no ${field}`));
    }
  });

  it('refuses a credential of an unknown kind rather than guessing', async () => {
    await expect(
      fetchTerminalContext({
        apiInternalUrl: 'http://api:4000',
        secret: 's',
        sessionId: 'sess-000000000000000a',
        fetchImpl: fetchReturning({ kind: 'firecracker', sandboxRef: 'lab-0000000000aa' }),
      }),
    ).rejects.toThrow(/unknown kind/);
  });

  it('fails closed when the API is unreachable', async () => {
    await expect(
      fetchTerminalContext({
        apiInternalUrl: 'http://api:4000',
        secret: 's',
        sessionId: 'sess-000000000000000a',
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(CredentialsUnavailableError);
  });
});

describe('writeSessionDockerCerts', () => {
  it('writes the three files DOCKER_CERT_PATH expects, private to the owner', async () => {
    const dir = await scratch();

    const certDir = await writeSessionDockerCerts(dir, 'sess-000000000000000a', DOCKER_CREDENTIALS);

    expect((await readdir(certDir)).sort()).toEqual(['ca.pem', 'cert.pem', 'key.pem']);
    expect(await readFile(path.join(certDir, 'ca.pem'), 'utf8')).toBe(DOCKER_CREDENTIALS.ca);
    expect(await readFile(path.join(certDir, 'key.pem'), 'utf8')).toBe(DOCKER_CREDENTIALS.clientKey);

    // 0700 on the directory, 0600 on each file: a private key for a live daemon
    // gets exactly the treatment the kubeconfig gets.
    expect((await stat(certDir)).mode & 0o777).toBe(0o700);
    for (const file of ['ca.pem', 'cert.pem', 'key.pem']) {
      expect((await stat(path.join(certDir, file))).mode & 0o777, file).toBe(0o600);
    }
  });

  it('sanitises the session id so it cannot escape the directory', async () => {
    const dir = await scratch();

    const certDir = await writeSessionDockerCerts(dir, '../../etc/passwd', DOCKER_CREDENTIALS);

    expect(path.dirname(certDir)).toBe(dir);
    expect(path.basename(certDir)).toBe('etcpasswd.docker');
  });

  it('refuses a session id with nothing usable in it', async () => {
    const dir = await scratch();

    await expect(writeSessionDockerCerts(dir, '///', DOCKER_CREDENTIALS)).rejects.toThrow(
      /unnamed session/,
    );
  });

  it('gives two sessions separate directories with different material', async () => {
    const dir = await scratch();

    const a = await writeSessionDockerCerts(dir, 'sess-000000000000000a', DOCKER_CREDENTIALS);
    const b = await writeSessionDockerCerts(dir, 'sess-000000000000000b', {
      ...DOCKER_CREDENTIALS,
      ca: '-----BEGIN CERTIFICATE-----\nca-b\n-----END CERTIFICATE-----\n',
    });

    expect(a).not.toBe(b);
    expect(await readFile(path.join(a, 'ca.pem'), 'utf8')).not.toBe(
      await readFile(path.join(b, 'ca.pem'), 'utf8'),
    );
  });

  it('removes the certificate directory, and tolerates removing it twice', async () => {
    const dir = await scratch();
    const certDir = await writeSessionDockerCerts(dir, 'sess-000000000000000a', DOCKER_CREDENTIALS);

    await removeSessionDockerCerts(certDir);
    await removeSessionDockerCerts(certDir);

    await expect(stat(certDir)).rejects.toThrow();
  });
});

describe('terminal configuration — Docker track', () => {
  it('holds no ambient Docker credential', () => {
    // The service that runs student shells must not be able to reach the host
    // daemon at all; per-session certificates are the only Docker access it has.
    const config = loadTerminalConfig({
      TERMINAL_SESSION_SECRET: 'a-long-enough-secret',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      DOCKER_CERT_PATH: '/root/.docker',
    } as NodeJS.ProcessEnv);

    expect(Object.keys(config)).not.toContain('dockerHost');
    expect(JSON.stringify(config)).not.toContain('docker.sock');
    expect(JSON.stringify(config)).not.toContain('/root/.docker');
  });

  it('has a workspace root for the files a Docker student authors', () => {
    const config = loadTerminalConfig({
      TERMINAL_SESSION_SECRET: 'a-long-enough-secret',
      TERMINAL_WORKSPACE_ROOT: '/home/student/workspaces',
    } as NodeJS.ProcessEnv);

    expect(config.workspaceRoot).toBe('/home/student/workspaces');
  });
});
