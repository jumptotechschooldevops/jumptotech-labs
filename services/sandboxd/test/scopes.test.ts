/**
 * The internal authorization boundary.
 *
 * Every test here is a way one internal service could exercise a capability it
 * has no business holding. The case that matters most is the third block: the
 * terminal is the one process a student types into, and before scoped
 * credentials it could authenticate to `/v1/docker` and drive the container
 * runtime — not because anything let it, but because nothing stopped it. It
 * held the same shared secret every other caller did.
 *
 * These run against a real `sandboxd` over real HTTP and real WebSockets, so
 * what is proved is what the server does, not what a helper claims it does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import {
  COMPONENT_LABEL,
  CONTAINER_SANDBOX_PREFIX,
  MANAGED_LABEL,
  PROVIDER_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  deriveSandboxRef,
  type ContainerRuntimePort,
  type DockerEngineFactory,
  type DockerEnginePort,
  type DockerSandboxPolicy,
} from '@jumptotech/lab-orchestrator';
import { SCOPE_ENV, loadScopeSecrets, type SandboxdConfig } from '../src/config.js';
import { DockerOps, SANDBOX_COMPONENT } from '../src/docker-ops.js';
import { authorizeScope, scopeForEndpoint, SANDBOXD_SCOPES } from '../src/scopes.js';
import { createSandboxd } from '../src/server.js';

/*
 * Three distinct credentials, one per capability — which is the whole point.
 * Named for their holder rather than their scope, because "what the terminal
 * has" is the thing under test.
 */
const TERMINAL_CRED = 'terminal-attach-credential-0000000';
const API_RUNTIME_CRED = 'api-runtime-credential-00000000000';
const API_DOCKER_CRED = 'api-docker-credential-000000000000';
const NOT_A_CREDENTIAL = 'not-a-credential-at-all-0000000000';

const DERIVATION = 'derivation-secret-for-scope-tests';
const SESSION = 'sess-aaaaaaaaaaaaaaaa';
const refFor = (s: string): string =>
  deriveSandboxRef({ sessionId: s, secret: DERIVATION, prefix: CONTAINER_SANDBOX_PREFIX });

const POLICY: DockerSandboxPolicy = {
  image: 'docker:27-dind',
  privileged: true,
  memory: '2g',
  cpus: '2',
  pidsLimit: 512,
  maxContainers: 10,
  network: 'jumptotech-sandboxes',
  daemonPort: 2376,
  readyTimeoutSeconds: 180,
  restartAttempts: 5,
};

const config: SandboxdConfig = {
  port: 0,
  bindAddress: '127.0.0.1',
  scopeSecrets: { attach: TERMINAL_CRED, runtime: API_RUNTIME_CRED, docker: API_DOCKER_CRED },
  derivationSecret: DERIVATION,
  runtimeOwner: 'jumptotech',
  containerBinary: 'docker',
  shell: '/bin/bash',
  docker: POLICY,
  sandboxUser: 'student',
  sandboxHome: '/home/student',
  maxSessions: 4,
  idleTimeoutMs: 60_000,
  maxSessionMs: 120_000,
};

const servers: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) s.close();
});

/** A sandbox that satisfies every ownership gate, so only scope is under test. */
const snapshot = {
  id: 'id',
  name: refFor(SESSION),
  image: 'docker:27-dind',
  imageId: 'sha256:abc',
  state: 'running',
  running: true,
  exitCode: 0,
  oomKilled: false,
  labels: {
    [MANAGED_LABEL]: 'true',
    [RUNTIME_OWNER_LABEL]: 'jumptotech',
    [COMPONENT_LABEL]: SANDBOX_COMPONENT,
    [PROVIDER_LABEL]: 'docker',
    [SESSION_LABEL]: SESSION,
  },
};

const runtime = {
  name: 'fake',
  ping: async () => '27.0.0',
  list: async () => [],
  inspect: async () => null,
} as unknown as ContainerRuntimePort;

const engines: DockerEngineFactory = {
  host: {
    version: async () => ({ serverVersion: '27.0.0' }),
    inspectContainer: async () => snapshot,
  } as unknown as DockerEnginePort,
  session: () => ({ version: async () => ({ serverVersion: '27.0.0' }) }) as unknown as DockerEnginePort,
};

async function start(): Promise<string> {
  const server = createSandboxd({
    config,
    inspector: {
      inspect: async () => ({
        state: 'running',
        user: 'student',
        workdir: '/home/student',
        labels: { [MANAGED_LABEL]: 'true', [RUNTIME_OWNER_LABEL]: 'jumptotech', [SESSION_LABEL]: SESSION },
      }),
    },
    runtime,
    docker: new DockerOps({
      engines,
      derivationSecret: DERIVATION,
      runtimeOwner: 'jumptotech',
      policy: POLICY,
    }),
    spawn: () =>
      ({
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
        onData: () => undefined,
        onExit: () => undefined,
      }) as never,
    log: () => undefined,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** POST an operation with a given credential; resolve with `[status, code]`. */
async function post(
  base: string,
  path: '/v1/runtime' | '/v1/docker',
  credential: string | null,
  body: Record<string, unknown>,
): Promise<[number, string]> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential === null ? {} : { 'x-internal-secret': credential }),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok?: boolean; error?: { code?: string } };
  return [res.status, json.error?.code ?? 'ok'];
}

/** Try the attach WebSocket with a given credential. */
function attach(base: string, credential: string | null): Promise<'attached' | string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/attach`, {
      headers: credential === null ? {} : { 'x-internal-secret': credential },
    });
    sockets.push(ws);
    const done = setTimeout(() => resolve('timeout'), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'attach', sessionId: SESSION }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { type?: string; code?: string };
      if (m.type === 'attached') {
        clearTimeout(done);
        resolve('attached');
      } else if (m.type === 'error') {
        clearTimeout(done);
        resolve(m.code ?? 'error');
      }
    });
    ws.on('error', (e: Error) => {
      clearTimeout(done);
      resolve(`upgrade-refused: ${e.message}`);
    });
  });
}

describe('the terminal holds attach, and only attach', () => {
  it('can open the endpoint it needs', async () => {
    const base = await start();
    expect(await attach(base, TERMINAL_CRED)).toBe('attached');
  });

  it('is rejected from the Docker control plane', async () => {
    const base = await start();
    expect(await post(base, '/v1/docker', TERMINAL_CRED, { op: 'hostVersion' })).toEqual([
      403,
      'SCOPE_DENIED',
    ]);
  });

  it('is rejected from runtime management it does not need', async () => {
    const base = await start();
    expect(await post(base, '/v1/runtime', TERMINAL_CRED, { op: 'ping' })).toEqual([
      403,
      'SCOPE_DENIED',
    ]);
  });

  it('cannot reach a destructive runtime operation either', async () => {
    // The one that would matter most: removing another session's sandbox.
    const base = await start();
    expect(
      await post(base, '/v1/runtime', TERMINAL_CRED, { op: 'remove', name: 'jtt-lab-aabbccddeeff' }),
    ).toEqual([403, 'SCOPE_DENIED']);
  });
});

describe('the API holds runtime and docker, and not attach', () => {
  it('can perform runtime operations with the runtime credential', async () => {
    const base = await start();
    expect(await post(base, '/v1/runtime', API_RUNTIME_CRED, { op: 'ping' })).toEqual([200, 'ok']);
  });

  it('can perform Docker operations with the Docker credential', async () => {
    const base = await start();
    expect(await post(base, '/v1/docker', API_DOCKER_CRED, { op: 'hostVersion' })).toEqual([
      200,
      'ok',
    ]);
  });

  it('cannot use its runtime credential on the Docker plane, or the reverse', async () => {
    // Two valid credentials of this deployment, each useless on the other's
    // endpoint. Scope is per capability, not per service.
    const base = await start();
    expect(await post(base, '/v1/docker', API_RUNTIME_CRED, { op: 'hostVersion' })).toEqual([
      403,
      'SCOPE_DENIED',
    ]);
    expect(await post(base, '/v1/runtime', API_DOCKER_CRED, { op: 'ping' })).toEqual([
      403,
      'SCOPE_DENIED',
    ]);
  });

  it('cannot open a student shell with either of its credentials', async () => {
    const base = await start();
    for (const cred of [API_RUNTIME_CRED, API_DOCKER_CRED]) {
      expect(await attach(base, cred)).toMatch(/upgrade-refused/);
    }
  });
});

describe('missing and invalid credentials', () => {
  it('rejects a request with no credential at all', async () => {
    const base = await start();
    expect(await post(base, '/v1/runtime', null, { op: 'ping' })).toEqual([403, 'SCOPE_DENIED']);
    expect(await post(base, '/v1/docker', null, { op: 'hostVersion' })).toEqual([403, 'SCOPE_DENIED']);
    expect(await attach(base, null)).toMatch(/upgrade-refused/);
  });

  it('rejects a credential this deployment has never issued', async () => {
    const base = await start();
    expect(await post(base, '/v1/runtime', NOT_A_CREDENTIAL, { op: 'ping' })).toEqual([
      403,
      'SCOPE_DENIED',
    ]);
    expect(await attach(base, NOT_A_CREDENTIAL)).toMatch(/upgrade-refused/);
  });

  it('still refuses anything a browser sent, whatever the credential', async () => {
    // The Origin gate runs first and is not replaced by scoping.
    const base = await start();
    const res = await fetch(`${base}/v1/runtime`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': API_RUNTIME_CRED,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ op: 'ping' }),
    });
    expect(res.status).toBe(401);
  });

  it('does not tell a caller that its credential is valid somewhere else', async () => {
    /*
     * A wrong-scope refusal and an unrecognised-credential refusal must look
     * the same, or the error becomes a hint about which endpoint to try next.
     */
    const base = await start();
    const wrongScope = await fetch(`${base}/v1/docker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': API_RUNTIME_CRED },
      body: JSON.stringify({ op: 'hostVersion' }),
    }).then((r) => r.json());
    const unknown = await fetch(`${base}/v1/docker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': NOT_A_CREDENTIAL },
      body: JSON.stringify({ op: 'hostVersion' }),
    }).then((r) => r.json());
    expect(wrongScope).toEqual(unknown);
  });
});

describe('the endpoint-to-scope table is the only authority', () => {
  it('maps each endpoint to exactly one scope', () => {
    expect(scopeForEndpoint('/v1/attach')).toBe('attach');
    expect(scopeForEndpoint('/v1/runtime')).toBe('runtime');
    expect(scopeForEndpoint('/v1/docker')).toBe('docker');
  });

  it('gives an unlisted path no scope, so it cannot be authorized', () => {
    for (const path of ['/v1/exec', '/v1/docker/', '/v1/dockerX', '/', '/health', undefined]) {
      expect(scopeForEndpoint(path)).toBeNull();
    }
  });

  it('denies every scope that is not configured', () => {
    const none = { attach: '', runtime: '', docker: '' };
    for (const scope of SANDBOXD_SCOPES) {
      expect(authorizeScope('anything', scope, none)).toMatchObject({
        ok: false,
        denial: 'scope-not-configured',
      });
    }
  });
});

describe('configuration cannot quietly collapse the boundary', () => {
  const base = {
    [SCOPE_ENV.attach]: TERMINAL_CRED,
    [SCOPE_ENV.runtime]: API_RUNTIME_CRED,
    [SCOPE_ENV.docker]: API_DOCKER_CRED,
  } as NodeJS.ProcessEnv;

  it('accepts three distinct secrets', () => {
    expect(loadScopeSecrets(base)).toEqual({
      attach: TERMINAL_CRED,
      runtime: API_RUNTIME_CRED,
      docker: API_DOCKER_CRED,
    });
  });

  it('refuses two scopes sharing a value', () => {
    /*
     * The failure this check exists for: equal secrets re-create the single
     * shared credential exactly, and every test above would still pass because
     * every request would still be authorized. It has to fail at startup or it
     * cannot be observed at all.
     */
    expect(() =>
      loadScopeSecrets({ ...base, [SCOPE_ENV.docker]: TERMINAL_CRED } as NodeJS.ProcessEnv),
    ).toThrow(/same value/);
  });

  it('refuses a secret too short to be one', () => {
    expect(() =>
      loadScopeSecrets({ ...base, [SCOPE_ENV.runtime]: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/at least 16 characters/);
  });

  it('refuses a broker with no capability configured at all', () => {
    expect(() => loadScopeSecrets({} as NodeJS.ProcessEnv)).toThrow(/No sandboxd capability/);
  });

  it('allows a capability to be switched off on its own', () => {
    // A deployment without the Docker track configures no docker secret, and
    // that endpoint then refuses everything rather than accepting anything.
    const secrets = loadScopeSecrets({ ...base, [SCOPE_ENV.docker]: '' } as NodeJS.ProcessEnv);
    expect(secrets.docker).toBe('');
    expect(authorizeScope(API_DOCKER_CRED, 'docker', secrets)).toMatchObject({ ok: false });
    expect(authorizeScope(TERMINAL_CRED, 'attach', secrets)).toMatchObject({ ok: true });
  });
});
