/**
 * BETA-P0-011 — the application tier reaches sandboxd safely, and cannot expose
 * it.
 *
 *   1. `loadConfig` refuses, under NODE_ENV=production, a broker URL that would
 *      carry the runtime and Docker capabilities in plaintext across a network,
 *      and a process-wide TLS verification bypass. The P0-008 owner gate and the
 *      P0-010 secret gate keep their precedence.
 *   2. The composition root hands the validated CA to both broker clients: a
 *      real TLS round trip through `buildContainerRuntime` and
 *      `buildDockerEngines` carries each capability in its own header.
 *   3. Nothing shipped routes to sandboxd: the compose runtime overlay is the one
 *      declared single-host arrangement, the web proxy has no route to the
 *      broker or a metrics port, no browser code names a broker variable, and no
 *      API route touches the broker configuration.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BrokerDockerEngines,
  BrokerRuntime,
  resolveBrokerClientTransport,
  resolveBrokerServerTransport,
} from '@jumptotech/lab-orchestrator';
import { createTestCa } from '@jumptotech/test-support/tls-pki';
import { loadConfig } from '../src/config.js';
import { buildContainerRuntime, buildDockerEngines } from '../src/providers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

const PRODUCTION = {
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://issuer.example.com',
  OIDC_CLIENT_ID: 'jumptotech-labs',
  OIDC_AUDIENCE: 'jumptotech-labs',
  PUBLIC_ORIGIN: 'https://labs.example.com',
  ALLOWED_ORIGINS: 'https://labs.example.com',
  TERMINAL_SESSION_SECRET: hex('terminal-session'),
  INTERNAL_SERVICE_SECRET: hex('internal-service'),
  NAMESPACE_DERIVATION_SECRET: hex('namespace-derivation'),
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape-token'),
  SANDBOXD_RUNTIME_SECRET: hex('runtime').slice(0, 48),
  SANDBOXD_DOCKER_SECRET: hex('docker').slice(0, 48),
  RUNTIME_OWNER_ID: 'labs-prod',
} as NodeJS.ProcessEnv;

const ca = createTestCa();
const work = mkdtempSync(path.join(tmpdir(), 'jtt-api-transport-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const caFile = path.join(work, 'ca.pem');
writeFileSync(caFile, ca.cert, { mode: 0o600 });

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadConfig to refuse');
}

describe('the api broker transport under NODE_ENV=production', () => {
  it('refuses plaintext to a remote runtime host', () => {
    for (const url of ['http://sandboxd.runtime.example:4002', 'http://10.40.0.9:4002', 'http://sandboxd:4002']) {
      expect(refusal({ ...PRODUCTION, SANDBOX_BROKER_URL: url }), url).toMatch(/api refuses to send sandboxd/);
    }
  });

  it('accepts https to a runtime host, with the CA carried for the broker only', () => {
    const config = loadConfig({
      ...PRODUCTION,
      SANDBOX_BROKER_URL: 'https://sandboxd.runtime.example:4002',
      SANDBOX_BROKER_CA_FILE: caFile,
    });
    expect(config.sandbox.runtimeBrokerTransport).toMatchObject({
      url: 'https://sandboxd.runtime.example:4002',
      mode: 'tls',
    });
    expect(config.sandbox.runtimeBrokerTransport?.ca).toContain('BEGIN CERTIFICATE');
  });

  it('accepts the compose arrangement as declared', () => {
    const config = loadConfig({
      ...PRODUCTION,
      SANDBOX_BROKER_URL: 'http://sandboxd:4002',
      SANDBOX_BROKER_SAME_HOST_PLAINTEXT: 'true',
    });
    expect(config.sandbox.runtimeBrokerTransport?.mode).toBe('same-host-plaintext');
  });

  it('resolves no transport without a broker', () => {
    expect(loadConfig(PRODUCTION).sandbox.runtimeBrokerTransport).toBeNull();
  });

  it('refuses NODE_TLS_REJECT_UNAUTHORIZED even without a broker', () => {
    expect(refusal({ ...PRODUCTION, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('keeps the owner gate and the secret gate ahead of the transport gate', () => {
    const unsafe = { ...PRODUCTION, SANDBOX_BROKER_URL: 'http://sandboxd.runtime.example:4002' };
    expect(refusal({ ...unsafe, RUNTIME_OWNER_ID: undefined })).toMatch(/RUNTIME_OWNER_ID must be set/);
    expect(refusal({ ...unsafe, SANDBOXD_RUNTIME_SECRET: undefined })).toContain('SANDBOXD_RUNTIME_SECRET is not set');
  });

  it('leaves runtime-owner wiring unchanged over TLS', () => {
    const config = loadConfig({ ...PRODUCTION, SANDBOX_BROKER_URL: 'https://sandboxd.runtime.example:4002' });
    expect(config.sandbox.runtimeOwner).toBe('labs-prod');
    expect(config.sandbox.runtimeOwnerSource).not.toBe('development-default');
    expect(buildContainerRuntime(config)).toBeInstanceOf(BrokerRuntime);
    expect(buildDockerEngines(config)).toBeInstanceOf(BrokerDockerEngines);
  });

  it('keeps development plaintext working', () => {
    const DEV = { TERMINAL_SESSION_SECRET: 'terminal-session-secret-for-tests' };
    for (const [url, mode] of [
      ['http://127.0.0.1:4002', 'loopback-plaintext'],
      ['http://sandboxd:4002', 'development-plaintext'],
    ] as const) {
      const config = loadConfig({ ...DEV, SANDBOX_BROKER_URL: url } as NodeJS.ProcessEnv);
      expect(config.sandbox.runtimeBrokerTransport?.mode, url).toBe(mode);
    }
  });
});

describe('the composition root over a real TLS broker', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('carries each capability in its own header, verified against the configured CA', async () => {
    const seen: Array<{ url?: string; secret?: string }> = [];
    const server = createServer(ca.issue({ ips: ['127.0.0.1'] }), (req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ url: req.url, secret: req.headers['x-internal-secret'] as string });
        const data = req.url === '/v1/runtime' ? { version: '27.0.0' } : { version: { version: '27.3.1' } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    const config = loadConfig({
      ...PRODUCTION,
      SANDBOX_BROKER_URL: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      SANDBOX_BROKER_CA_FILE: caFile,
    });
    await expect(buildContainerRuntime(config).ping()).resolves.toBe('27.0.0');
    await expect(buildDockerEngines(config).host.version()).resolves.toEqual({ version: '27.3.1' });

    expect(seen).toEqual([
      { url: '/v1/runtime', secret: PRODUCTION.SANDBOXD_RUNTIME_SECRET },
      { url: '/v1/docker', secret: PRODUCTION.SANDBOXD_DOCKER_SECRET },
    ]);
  });
});

/** One service's `environment:` entries from a compose file, comments ignored. */
function composeEnvironment(file: string, service: string): Record<string, string> {
  const env: Record<string, string> = {};
  let inServices = false;
  let current: string | null = null;
  for (const line of read(file).split('\n')) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = null;
      continue;
    }
    if (!inServices || /^\s*#/.test(line)) continue;
    const name = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (name) {
      current = name[1]!;
      continue;
    }
    if (current !== service) continue;
    const entry = /^ {6}([A-Z][A-Z0-9_]*):\s*"?([^"#]*?)"?\s*$/.exec(line);
    if (entry) env[entry[1]!] = entry[2]!;
  }
  return env;
}

describe('the shipped configuration', () => {
  const RUNTIME = 'docker-compose.runtime.yml';

  it('is the declared single-host arrangement, and passes the production rules as such', () => {
    for (const service of ['api', 'terminal']) {
      const env = composeEnvironment(RUNTIME, service);
      expect(env.SANDBOX_BROKER_SAME_HOST_PLAINTEXT, service).toBe('true');
      expect(
        resolveBrokerClientTransport(
          { NODE_ENV: 'production', SANDBOX_BROKER_SAME_HOST_PLAINTEXT: env.SANDBOX_BROKER_SAME_HOST_PLAINTEXT },
          { service, url: env.SANDBOX_BROKER_URL! },
        ).mode,
      ).toBe('same-host-plaintext');
    }
    const sandboxd = composeEnvironment(RUNTIME, 'sandboxd');
    expect(sandboxd.NODE_ENV).toBe('production');
    expect(
      resolveBrokerServerTransport(
        { NODE_ENV: 'production', SANDBOX_BROKER_SAME_HOST_PLAINTEXT: sandboxd.SANDBOX_BROKER_SAME_HOST_PLAINTEXT },
        { bindAddress: sandboxd.SANDBOXD_BIND! },
      ).mode,
    ).toBe('same-host-plaintext');
  });

  it('makes that declaration in the single-host runtime overlay and nowhere else', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.observability.yml']) {
      const code = read(file)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line));
      expect(code.filter((line) => line.includes('SANDBOX_BROKER_SAME_HOST_PLAINTEXT')), file).toEqual([]);
    }
  });

  it('gives the web proxy no route to sandboxd or to any metrics port', () => {
    const conf = read('infrastructure/docker/nginx/web.conf');
    const code = conf
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const targets = [...code.matchAll(/proxy_pass\s+([^;]+);/g)].map((match) => match[1]!.trim());
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(['http://api:4000', 'http://terminal:4001']).toContain(target);
    expect(code).not.toMatch(/sandboxd|:4002|:940[0-2]/);
  });

  it('names no broker URL, broker credential or capability header in browser code', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === 'node_modules' || name === 'dist') continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?|html|css)$/.test(name)) files.push(full);
      }
    };
    walk(path.join(REPO_ROOT, 'apps/web/src'));
    files.push(path.join(REPO_ROOT, 'apps/web/index.html'));
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((file) =>
      /SANDBOX_BROKER|SANDBOXD_|x-internal-secret|:4002\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the broker configuration out of every API route', () => {
    const src = path.join(REPO_ROOT, 'apps/api/src');
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/runtimeBroker|SANDBOX_BROKER|\/v1\/(runtime|docker|attach)/.test(readFileSync(full, 'utf8'))) {
          readers.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    // Configuration, the composition root that builds the clients, the startup
    // log line that reports the transport mode, and the redaction self-test
    // that registers the credentials. No route, and not the app.
    expect(readers.sort()).toEqual(['config.ts', 'index.ts', 'observability.ts', 'providers.ts']);
  });
});
