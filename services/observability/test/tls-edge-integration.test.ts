/**
 * BETA-P0-017 — the production TLS edge in the real web image, against real
 * TLS clients.
 *
 * Tier: INTEGRATION (PLATFORM-006). Gated on RUN_INTEGRATION_TESTS=1.
 *
 *   RUN_INTEGRATION_TESTS=1 npx vitest run test/tls-edge-integration.test.ts --root services/observability
 *   make test-tls-edge
 *
 * The edge runs exactly as docker-compose.production.yml defines the web
 * service: its environment, mounts, published container ports and health check
 * are read from `docker compose config` for the production stack, not retyped
 * here. Only the sources of three mounts differ: the certificate directory, the
 * ACME webroot, and a stub page in place of the Vite bundle (the image is the
 * Dockerfile's `edge` stage, which is the shipped image without the bundle).
 *
 * What it creates on the Docker daemon, all named from this run's id and all
 * removed afterwards:
 *   · the image tag jumptotech/web-edge:tls-<run>, from web.Dockerfile --target edge
 *   · the bridge network jtt-tls-<run>
 *   · an upstream stub (node:22-bookworm-slim) answering as `api` and `terminal`
 *   · edge containers jtt-tls-<run>-*, and openssl client/control containers
 *   · a temporary directory of certificates
 *
 * TEST-ONLY CERTIFICATES. They come from an in-memory CA
 * (test-support/tls-pki.ts), are valid for days, and name labs.jtt.test, under
 * the reserved `.test` TLD. They prove the edge's behaviour. They are not, and
 * do not stand in for, a publicly issued certificate: this suite issues nothing
 * and contacts no CA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes, createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { scopedTmpPrefix, testRunId } from '@jumptotech/test-support/run-id';
import { createSelfSignedServer, createTestCa, type TestCa, type TestIdentity } from '@jumptotech/test-support/tls-pki';

const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';
const run = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST = 'labs.jtt.test';
const RUN = testRunId().toLowerCase().replace(/[^a-z0-9]/g, '');
const IMAGE = `jumptotech/web-edge:tls-${RUN}`;
const NETWORK = `jtt-tls-${RUN}`;
const LABEL = `jumptotech.io/tls-edge-test=${RUN}`;
const DAY = 86_400_000;
const at = (days: number): Date => new Date(Date.now() + days * DAY);

interface ComposeVolume {
  type: string;
  source: string;
  target: string;
  read_only?: boolean;
}
interface ComposeWeb {
  environment: Record<string, string>;
  volumes: ComposeVolume[];
  ports: Array<{ target: number; published: string }>;
  healthcheck: { test: string[] };
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function sh(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run(file, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout ?? 120_000,
      ...(options.env ? { env: options.env } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error) };
  }
}

async function docker(...args: string[]): Promise<Result> {
  return sh('docker', args);
}

async function mustDocker(...args: string[]): Promise<string> {
  const result = await docker(...args);
  if (result.code !== 0) throw new Error(`docker ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  return result.stdout;
}

// --- fixtures ---------------------------------------------------------------

let work: string;
let web: ComposeWeb;
let root: TestCa;
let intermediate: TestCa;
let acmeDir: string;
let htmlDir: string;
let rootFile: string;
const identities: Record<string, TestIdentity> = {};
const containers = new Set<string>();

const chain = (identity: TestIdentity): string => identity.cert + intermediate.cert;

function pairDir(name: string, certificatePem: string | null, keyPem: string | null, keyMode = 0o600): string {
  const dir = path.join(work, 'pairs', name);
  mkdirSync(dir, { recursive: true });
  if (certificatePem !== null) writeFileSync(path.join(dir, 'fullchain.pem'), certificatePem, { mode: 0o644 });
  if (keyPem !== null) {
    writeFileSync(path.join(dir, 'privkey.pem'), keyPem, { mode: keyMode });
    chmodSync(path.join(dir, 'privkey.pem'), keyMode);
  }
  return dir;
}

function fingerprint(certificatePem: string): string {
  return new X509Certificate(certificatePem).fingerprint256;
}

function keyFragments(pem: string): string[] {
  return pem
    .split('\n')
    .filter((line) => line && !line.startsWith('-----'))
    .map((line) => line.slice(0, 40))
    .filter((line) => line.length >= 40);
}

function expectNoKeyMaterial(text: string, ...keys: string[]): void {
  expect(text).not.toContain('PRIVATE KEY');
  for (const key of keys) for (const fragment of keyFragments(key)) expect(text).not.toContain(fragment);
}

/** The web service exactly as the production stack resolves it, with sentinel values for every secret. */
async function productionWebService(): Promise<ComposeWeb> {
  const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, 'infrastructure/secret-distribution.json'), 'utf8')) as {
    secrets: string[];
    stacks: { production: { files: string[] } };
  };
  const envFile = path.join(work, 'sentinel.env');
  const values: Record<string, string> = {
    RUNTIME_OWNER_ID: `tls-edge-${RUN}`,
    PUBLIC_ORIGIN: `https://${HOST}`,
    ...Object.fromEntries(contract.secrets.map((name) => [name, `p0017sentinel${randomBytes(8).toString('hex')}`])),
  };
  writeFileSync(envFile, `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
  const scrubbed = Object.fromEntries(
    ['PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'TMPDIR']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]!]),
  );
  const files = contract.stacks.production.files.flatMap((file) => ['-f', path.join(REPO_ROOT, file)]);
  const result = await sh('docker', ['compose', '--project-directory', REPO_ROOT, '--env-file', envFile, ...files, 'config', '--format', 'json'], {
    env: scrubbed,
  });
  if (result.code !== 0) throw new Error(`docker compose config failed: ${result.stderr}`);
  return (JSON.parse(result.stdout) as { services: { web: ComposeWeb } }).services.web;
}

const UPSTREAM_STUB = `
const http = require('node:http');
const crypto = require('node:crypto');
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ upstream: 'api', url: req.url, proto: req.headers['x-forwarded-proto'], host: req.headers.host }));
}).listen(4000);
const terminal = http.createServer((req, res) => res.writeHead(426).end());
terminal.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept +
    '\\r\\nX-Upstream-Proto: ' + (req.headers['x-forwarded-proto'] || '') + '\\r\\n\\r\\n');
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 6) {
      const length = buffer[1] & 0x7f;
      if (buffer.length < 6 + length) return;
      const mask = buffer.subarray(2, 6);
      const payload = Buffer.from(buffer.subarray(6, 6 + length)).map((byte, i) => byte ^ mask[i % 4]);
      buffer = buffer.subarray(6 + length);
      const reply = Buffer.concat([Buffer.from('echo:'), payload]);
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    }
  });
  socket.on('error', () => {});
}).listen(4001);
`;

// --- running an edge ----------------------------------------------------------

interface EdgeOptions {
  certDir: string;
  env?: Record<string, string | null>;
  mountTls?: boolean;
}

function edgeArgs(name: string, options: EdgeOptions): string[] {
  const args = ['--name', name, '--label', LABEL, '--network', NETWORK];
  const env = { ...web.environment, ...(options.env ?? {}) };
  for (const [key, value] of Object.entries(env)) if (value !== null) args.push('-e', `${key}=${value}`);
  for (const volume of web.volumes) {
    if (volume.type !== 'bind') continue;
    if (volume.target === '/etc/nginx/tls' && options.mountTls === false) continue;
    const source =
      volume.target === '/etc/nginx/tls' ? options.certDir : volume.target === '/var/www/acme' ? acmeDir : volume.source;
    args.push('--mount', `type=bind,source=${source},target=${volume.target}${volume.read_only ? ',readonly' : ''}`);
  }
  args.push('--mount', `type=bind,source=${htmlDir},target=/usr/share/nginx/html,readonly`);
  for (const port of web.ports) args.push('-p', `127.0.0.1::${port.target}`);
  return args;
}

interface Edge {
  name: string;
  httpsPort: number;
  httpPort: number;
}

async function hostPort(name: string, target: number): Promise<number> {
  const out = await mustDocker('port', name, `${target}/tcp`);
  const port = /:(\d+)\s*$/m.exec(out.split('\n')[0] ?? '')?.[1];
  if (!port) throw new Error(`no host port for ${name}:${target}: ${out}`);
  return Number(port);
}

async function startEdge(suffix: string, options: EdgeOptions): Promise<Edge> {
  const name = `jtt-tls-${RUN}-${suffix}`;
  containers.add(name);
  await docker('rm', '-f', name);
  await mustDocker('run', '-d', ...edgeArgs(name, options), IMAGE);
  const edge = { name, httpsPort: await hostPort(name, 8443), httpPort: await hostPort(name, 8080) };
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = (await docker('inspect', '-f', '{{.State.Running}}', name)).stdout.trim();
    if (state !== 'true') throw new Error(`edge ${name} exited:\n${(await docker('logs', name)).stderr}`);
    if ((await docker('exec', name, ...web.healthcheck.test.slice(1))).code === 0) return edge;
    if (Date.now() > deadline) throw new Error(`edge ${name} never became healthy:\n${(await docker('logs', name)).stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Runs an edge that must refuse to start. Returns its exit code and everything it logged. */
async function refusedEdge(suffix: string, options: EdgeOptions): Promise<{ code: number; logs: string }> {
  const name = `jtt-tls-${RUN}-${suffix}`;
  containers.add(name);
  await docker('rm', '-f', name);
  const result = await sh('docker', ['run', ...edgeArgs(name, options), IMAGE], { timeout: 60_000 });
  const exit = Number((await docker('inspect', '-f', '{{.State.ExitCode}}', name)).stdout.trim());
  const logs = `${result.stdout}\n${result.stderr}`;
  await docker('rm', '-f', name);
  return { code: exit, logs };
}

// --- clients ------------------------------------------------------------------

interface HttpsResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  protocol: string | null;
  cipher: string;
  fingerprint: string;
}

function httpsGet(
  port: number,
  requestPath: string,
  options: { servername?: string; host?: string; maxVersion?: 'TLSv1.2' | 'TLSv1.3' } = {},
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        servername: options.servername ?? HOST,
        headers: { host: options.host ?? HOST },
        ca: root.cert,
        agent: false,
        rejectUnauthorized: true,
        ...(options.maxVersion ? { maxVersion: options.maxVersion } : {}),
        timeout: 10_000,
      },
      (res) => {
        const socket = res.socket as TLSSocket;
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher().standardName;
        const peer = socket.getPeerX509Certificate();
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, protocol, cipher, fingerprint: peer?.fingerprint256 ?? '' }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function httpGet(port: number, requestPath: string, host = HOST): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: requestPath, headers: { host }, agent: false, timeout: 10_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ...(res.headers.location ? { location: res.headers.location } : {}), body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function tlsHandshake(port: number, servername: string | undefined): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ...(servername ? { servername } : {}), ca: root.cert, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    socket.setTimeout(10_000, () => socket.destroy(new Error('timeout')));
    socket.once('secureConnect', () => {
      socket.end();
      resolve({ ok: true });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, error: error.code ?? error.message }));
  });
}

/** A browser terminal's WebSocket through the edge: TLS, the upgrade, framed messages. */
class TerminalSocket {
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private constructor(
    private readonly socket: TLSSocket,
    readonly upgradeResponse: string,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  static open(port: number): Promise<TerminalSocket> {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const socket = tlsConnect({ host: '127.0.0.1', port, servername: HOST, ca: root.cert, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      socket.setTimeout(15_000, () => socket.destroy(new Error('timeout')));
      socket.once('error', reject);
      socket.once('secureConnect', () => {
        socket.write(
          `GET /terminal?session=p0017 HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://${HOST}\r\n\r\n`,
        );
        let head = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf('\r\n\r\n');
          if (end === -1) return;
          socket.off('data', onData);
          const response = head.subarray(0, end).toString('latin1');
          const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
          if (!response.startsWith('HTTP/1.1 101') || !response.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)) {
            reject(new Error(`no upgrade: ${response}`));
            return;
          }
          const terminal = new TerminalSocket(socket, response);
          terminal.buffer = head.subarray(end + 4);
          resolve(terminal);
        };
        socket.on('data', onData);
      });
    });
  }

  async send(text: string): Promise<string> {
    const payload = Buffer.from(text);
    const mask = randomBytes(4);
    const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
    this.socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
    const deadline = Date.now() + 10_000;
    while (this.buffer.length < 2 || this.buffer.length < 2 + (this.buffer[1]! & 0x7f)) {
      if (Date.now() > deadline) throw new Error('no WebSocket frame came back');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
    const length = this.buffer[1]! & 0x7f;
    const frame = this.buffer.subarray(2, 2 + length).toString();
    this.buffer = this.buffer.subarray(2 + length);
    return frame;
  }

  close(): void {
    this.socket.destroy();
  }
}

async function tlsInstall(edge: Edge, tlsDir: string, pair: string): Promise<Result> {
  return sh('bash', [path.join(REPO_ROOT, 'scripts/tls-install.sh'), '--cert', path.join(pair, 'fullchain.pem'), '--key', path.join(pair, 'privkey.pem')], {
    env: { ...process.env, WEB_CONTAINER: edge.name, TLS_DIR: tlsDir },
    timeout: 120_000,
  });
}

async function tlsCheck(edge: Edge, extra: string[]): Promise<Result> {
  return sh(
    path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
    [
      path.join(REPO_ROOT, 'scripts/tls-check.ts'),
      '--origin', `https://${HOST}`,
      '--connect', '127.0.0.1',
      '--https-port', String(edge.httpsPort),
      '--http-port', String(edge.httpPort),
      '--ca-file', rootFile,
      ...extra,
    ],
    { timeout: 60_000 },
  );
}

// --- the suite ----------------------------------------------------------------

describe.skipIf(!ENABLED)('the production TLS edge, in the real web image (BETA-P0-017)', () => {
  let edge: Edge;
  let liveDir: string;

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), scopedTmpPrefix('tls-edge')));
    acmeDir = path.join(work, 'acme');
    htmlDir = path.join(work, 'html');
    mkdirSync(path.join(acmeDir, '.well-known/acme-challenge'), { recursive: true });
    mkdirSync(htmlDir);
    writeFileSync(path.join(htmlDir, 'index.html'), '<p>JTT-P0017-EDGE</p>\n');
    writeFileSync(path.join(acmeDir, '.well-known/acme-challenge/p0017-token'), 'p0017-token.key-authorization\n');

    root = createTestCa('jtt p0017 integration root', { notBefore: at(-1), notAfter: at(30) });
    intermediate = root.intermediate('jtt p0017 integration intermediate', { notBefore: at(-1), notAfter: at(30) });
    rootFile = path.join(work, 'root.pem');
    writeFileSync(rootFile, root.cert);
    const stale = root.intermediate('jtt p0017 stale intermediate', { notBefore: at(-10), notAfter: at(-1) });
    Object.assign(identities, {
      live: intermediate.issue({ dns: [HOST], notAfter: at(25) }),
      renewed: intermediate.issue({ dns: [HOST], notAfter: at(28) }),
      drift: intermediate.issue({ dns: [HOST], notAfter: at(27) }),
      expired: intermediate.issue({ dns: [HOST], notBefore: at(-20), notAfter: at(-1) }),
      future: intermediate.issue({ dns: [HOST], notBefore: at(2), notAfter: at(20) }),
      wrongHost: intermediate.issue({ dns: ['other.jtt.test'], notAfter: at(25) }),
      caLeaf: intermediate.issue({ dns: [HOST], isCa: true, notAfter: at(25) }),
      rsa1024: intermediate.issue({ dns: [HOST], keyType: 'rsa', rsaBits: 1024, notAfter: at(25) }),
      selfSigned: createSelfSignedServer({ dns: [HOST], notAfter: at(25) }),
      staleLeaf: stale.issue({ dns: [HOST], notAfter: at(25) }),
      staleCa: { cert: stale.cert, key: '' },
    });

    web = await productionWebService();

    await mustDocker('build', '-q', '--target', 'edge', '-t', IMAGE, '-f', path.join(REPO_ROOT, 'infrastructure/docker/web.Dockerfile'), REPO_ROOT);
    await docker('network', 'rm', NETWORK);
    await mustDocker('network', 'create', '--label', LABEL, NETWORK);
    const stub = `jtt-tls-${RUN}-upstream`;
    containers.add(stub);
    await mustDocker('run', '-d', '--name', stub, '--label', LABEL, '--network', NETWORK, '--network-alias', 'api', '--network-alias', 'terminal',
      'node:22-bookworm-slim', 'node', '-e', UPSTREAM_STUB);

    liveDir = pairDir('live', chain(identities.live!), identities.live!.key);
    edge = await startEdge('live', { certDir: liveDir });
  }, 900_000);

  afterAll(async () => {
    if (!ENABLED) return;
    for (const name of containers) await docker('rm', '-f', name);
    await docker('network', 'rm', NETWORK);
    await docker('rmi', IMAGE);
    if (work) rmSync(work, { recursive: true, force: true });
  }, 120_000);

  describe('as the production stack defines it', () => {
    it('is the web service from docker compose config: gate on, three read-only mounts, 443 and 80, a served-certificate health check', () => {
      expect(web.environment).toEqual({ WEB_TLS: 'required', PUBLIC_ORIGIN: `https://${HOST}` });
      expect(web.volumes.map((v) => `${v.target}:${v.read_only ? 'ro' : 'rw'}`).sort()).toEqual([
        '/etc/nginx/conf.d/default.conf:ro',
        '/etc/nginx/tls:ro',
        '/var/www/acme:ro',
      ]);
      expect(web.ports.map((p) => `${p.published}->${p.target}`).sort()).toEqual(['443->8443', '80->8080']);
      expect(web.healthcheck.test).toEqual(['CMD', 'jtt-tls-preflight', 'served']);
    });
  });

  describe('HTTPS', () => {
    it('serves the application for the public host over a verified chain, with HSTS and no version banner', async () => {
      const response = await httpsGet(edge.httpsPort, '/');
      expect(response.status).toBe(200);
      expect(response.body).toContain('JTT-P0017-EDGE');
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
      expect(response.headers.server).toBe('nginx');
      expect(response.fingerprint).toBe(fingerprint(identities.live!.cert));
    }, 60_000);

    it('proxies the API with X-Forwarded-Proto https and the public host', async () => {
      const response = await httpsGet(edge.httpsPort, '/api/health?probe=p0017');
      expect(JSON.parse(response.body)).toEqual({ upstream: 'api', url: '/api/health?probe=p0017', proto: 'https', host: HOST });
    }, 60_000);

    it('negotiates TLS 1.3, and TLS 1.2 only with a forward-secret AEAD suite', async () => {
      expect((await httpsGet(edge.httpsPort, '/')).protocol).toBe('TLSv1.3');
      const tls12 = await httpsGet(edge.httpsPort, '/', { maxVersion: 'TLSv1.2' });
      expect(tls12.protocol).toBe('TLSv1.2');
      expect(tls12.cipher).toMatch(/^TLS_ECDHE_(ECDSA|RSA)_WITH_(AES_(128|256)_GCM_SHA(256|384)|CHACHA20_POLY1305_SHA256)$/);
    }, 60_000);

    it('refuses TLS 1.1 and a CBC suite that a permissive server accepts from the same client', async () => {
      const edgeHost = edge.name;
      const control = `jtt-tls-${RUN}-control`;
      containers.add(control);
      await docker('rm', '-f', control);
      await mustDocker('run', '-d', '--name', control, '--label', LABEL, '--network', NETWORK,
        '--mount', `type=bind,source=${liveDir},target=/w,readonly`, '--entrypoint', 'openssl', IMAGE,
        // -www: answer every connection without reading stdin. A detached s_server
        // otherwise sees EOF on stdin and exits after its first client.
        's_server', '-www', '-accept', '9443', '-cert', '/w/fullchain.pem', '-key', '/w/privkey.pem', '-cipher', 'ALL:@SECLEVEL=0', '-min_protocol', 'TLSv1');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const client = async (target: string, ...flags: string[]): Promise<boolean> => {
        const result = await docker('run', '--rm', '--network', NETWORK, '--entrypoint', 'sh', IMAGE, '-c',
          `timeout 10 openssl s_client -connect ${target} -servername ${HOST} ${flags.join(' ')} </dev/null 2>&1`);
        return result.code === 0 && !/Cipher is \(NONE\)/.test(result.stdout);
      };
      // Negative controls first: the client can do both, when a server lets it.
      // ECDHE-ECDSA-AES128-SHA is a CBC suite the test's EC certificate can serve.
      expect(await client(`${control}:9443`, '-tls1_1', '-cipher', "'DEFAULT:@SECLEVEL=0'")).toBe(true);
      expect(await client(`${control}:9443`, '-tls1_2', '-cipher', 'ECDHE-ECDSA-AES128-SHA')).toBe(true);
      expect(await client(`${edgeHost}:8443`, '-tls1_1', '-cipher', "'DEFAULT:@SECLEVEL=0'")).toBe(false);
      expect(await client(`${edgeHost}:8443`, '-tls1_2', '-cipher', 'ECDHE-ECDSA-AES128-SHA')).toBe(false);
      expect(await client(`${edgeHost}:8443`, '-tls1_2')).toBe(true);
      await docker('rm', '-f', control);
    }, 180_000);

    it('gives no certificate to a client that does not name the host, and refuses a mismatched Host header', async () => {
      expect(await tlsHandshake(edge.httpsPort, HOST)).toEqual({ ok: true });
      expect((await tlsHandshake(edge.httpsPort, 'other.jtt.test')).ok).toBe(false);
      expect((await tlsHandshake(edge.httpsPort, undefined)).ok).toBe(false);
      expect((await httpsGet(edge.httpsPort, '/', { host: 'other.jtt.test' })).status).toBe(421);
    }, 60_000);

    it('upgrades the terminal WebSocket through TLS, with X-Forwarded-Proto https', async () => {
      const terminal = await TerminalSocket.open(edge.httpsPort);
      expect(terminal.upgradeResponse).toMatch(/X-Upstream-Proto: https/i);
      expect(await terminal.send('ls -la')).toBe('echo:ls -la');
      terminal.close();
    }, 60_000);
  });

  describe('HTTP on port 80', () => {
    it('redirects every request to the same path on the configured host, whatever Host it names', async () => {
      expect(await httpGet(edge.httpPort, '/labs/K8S-001?tab=1')).toMatchObject({ status: 301, location: `https://${HOST}/labs/K8S-001?tab=1` });
      expect(await httpGet(edge.httpPort, '/api/health', 'evil.example')).toMatchObject({ status: 301, location: `https://${HOST}/api/health` });
    }, 60_000);

    it('serves ACME challenge tokens that exist, 404s the rest, and proxies nothing', async () => {
      const token = await httpGet(edge.httpPort, '/.well-known/acme-challenge/p0017-token');
      expect(token).toMatchObject({ status: 200, body: 'p0017-token.key-authorization\n' });
      expect((await httpGet(edge.httpPort, '/.well-known/acme-challenge/absent')).status).toBe(404);
      expect((await httpGet(edge.httpPort, '/.well-known/acme-challenge/../../api/health')).status).toBe(301);
    }, 60_000);
  });

  describe('fails closed: the container exits and nginx never listens', () => {
    const cases: Array<[string, () => EdgeOptions, RegExp]> = [
      ['no certificate or key', () => ({ certDir: pairDir('empty', null, null) }), /fullchain\.pem does not exist/],
      ['no TLS directory mounted at all', () => ({ certDir: '', mountTls: false }), /fullchain\.pem does not exist/],
      ['a key that belongs to another certificate', () => ({ certDir: pairDir('mismatch', chain(identities.live!), identities.renewed!.key) }), /does not belong to the server certificate/],
      ['an expired certificate', () => ({ certDir: pairDir('expired', chain(identities.expired!), identities.expired!.key) }), /expired at/],
      ['a certificate not yet valid', () => ({ certDir: pairDir('future', chain(identities.future!), identities.future!.key) }), /is not valid until/],
      ['a certificate for another host', () => ({ certDir: pairDir('wrong-host', chain(identities.wrongHost!), identities.wrongHost!.key) }), /does not name labs\.jtt\.test/],
      ['a self-signed certificate', () => ({ certDir: pairDir('self-signed', identities.selfSigned!.cert, identities.selfSigned!.key) }), /holds only the server certificate/],
      ['a server certificate without its intermediate', () => ({ certDir: pairDir('no-intermediate', identities.live!.cert, identities.live!.key) }), /holds only the server certificate/],
      ['an unrelated certificate in place of the intermediate', () => ({ certDir: pairDir('unrelated', identities.live!.cert + createTestCa('jtt p0017 unrelated').cert, identities.live!.key) }), /does not verify/],
      ['an expired intermediate', () => ({ certDir: pairDir('stale-intermediate', identities.staleLeaf!.cert + identities.staleCa!.cert, identities.staleLeaf!.key) }), /does not verify/],
      ['a CA certificate as the server certificate', () => ({ certDir: pairDir('ca-leaf', chain(identities.caLeaf!), identities.caLeaf!.key) }), /is a CA certificate/],
      ['a 1024-bit RSA key', () => ({ certDir: pairDir('rsa1024', chain(identities.rsa1024!), identities.rsa1024!.key) }), /1024-bit RSA key/],
      ['a key readable by group or others', () => ({ certDir: pairDir('world-readable', chain(identities.live!), identities.live!.key, 0o644) }), /readable by group or others/],
      ['a private key inside fullchain.pem', () => ({ certDir: pairDir('key-in-chain', chain(identities.live!) + identities.live!.key, identities.live!.key) }), /contains a private key/],
      ['an encrypted private key', () => ({
        certDir: pairDir('encrypted', chain(identities.live!), createPrivateKey(identities.live!.key).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'p0017' }).toString()),
      }), /not a readable, unencrypted private key/],
      ['PUBLIC_ORIGIN unset', () => ({ certDir: liveDir, env: { PUBLIC_ORIGIN: null } }), /PUBLIC_ORIGIN is not set/],
      ['an http:// PUBLIC_ORIGIN', () => ({ certDir: liveDir, env: { PUBLIC_ORIGIN: `http://${HOST}` } }), /must be an https:\/\/ origin/],
      ['a PUBLIC_ORIGIN with a port', () => ({ certDir: liveDir, env: { PUBLIC_ORIGIN: `https://${HOST}:8443` } }), /must be exactly https:\/\/<dns-host-name>/],
      ['a PUBLIC_ORIGIN that is an IP address', () => ({ certDir: liveDir, env: { PUBLIC_ORIGIN: 'https://203.0.113.10' } }), /must be exactly https:\/\/<dns-host-name>/],
      ['WEB_TLS set to anything but required', () => ({ certDir: liveDir, env: { WEB_TLS: 'true' } }), /WEB_TLS must be 'required' or unset/],
      ['the TLS configuration without the gate', () => ({ certDir: liveDir, env: { WEB_TLS: null } }), /runtime\/public-host\.conf" failed/],
    ];

    it.each(cases)('refuses %s', async (_name, options, reason) => {
      const suffix = `refuse-${createHash('sha1').update(_name).digest('hex').slice(0, 8)}`;
      const { code, logs } = await refusedEdge(suffix, options());
      expect(logs).toMatch(reason);
      expect(code).not.toBe(0);
      expect(logs).not.toMatch(/start worker process/);
      expectNoKeyMaterial(logs, ...Object.values(identities).map((identity) => identity.key).filter(Boolean));
    }, 120_000);
  });

  describe('the certificate lifecycle', () => {
    it('reports a healthy edge through the operator check, including the ACME route', async () => {
      const result = await tlsCheck(edge, ['--cert-dir', liveDir, '--expect-acme']);
      expect(result.stdout).toContain(`TLS check for ${HOST}: OK`);
      expect(result.code).toBe(0);
      expectNoKeyMaterial(result.stdout + result.stderr, identities.live!.key);
    }, 120_000);

    it('renews in place: validated, swapped, reloaded, served, without dropping an open terminal', async () => {
      const tlsDir = pairDir('renewal-live', chain(identities.live!), identities.live!.key);
      const renewing = await startEdge('renewal', { certDir: tlsDir });
      const terminal = await TerminalSocket.open(renewing.httpsPort);
      expect(await terminal.send('before')).toBe('echo:before');

      const install = await tlsInstall(renewing, tlsDir, pairDir('renewed', chain(identities.renewed!), identities.renewed!.key));
      expect(install.stdout).toContain('nginx is serving the new certificate');
      expect(install.code).toBe(0);
      expectNoKeyMaterial(install.stdout + install.stderr, identities.live!.key, identities.renewed!.key);

      expect((await httpsGet(renewing.httpsPort, '/')).fingerprint).toBe(fingerprint(identities.renewed!.cert));
      expect(await terminal.send('after')).toBe('echo:after');
      terminal.close();

      expect(readFileSync(path.join(tlsDir, 'fullchain.pem.previous'), 'utf8')).toBe(chain(identities.live!));
      expect(statSync(path.join(tlsDir, 'privkey.pem.previous')).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(tlsDir, 'privkey.pem')).mode & 0o777).toBe(0o600);
      expect(existsSync(path.join(tlsDir, 'privkey.pem.next'))).toBe(false);

      const check = await tlsCheck(renewing, ['--cert-dir', tlsDir]);
      expect(check.code).toBe(0);
      expect(check.stdout).toContain(fingerprint(identities.renewed!.cert));
    }, 300_000);

    it('refuses a bad renewal and keeps serving the certificate it had', async () => {
      const tlsDir = pairDir('refusal-live', chain(identities.live!), identities.live!.key);
      const refusing = await startEdge('refusal', { certDir: tlsDir });
      for (const bad of [
        pairDir('bad-mismatch', chain(identities.renewed!), identities.live!.key),
        pairDir('bad-host', chain(identities.wrongHost!), identities.wrongHost!.key),
        pairDir('bad-expired', chain(identities.expired!), identities.expired!.key),
      ]) {
        const install = await tlsInstall(refusing, tlsDir, bad);
        expect(install.stderr).toContain('nothing was changed');
        expect(install.code).toBe(1);
        expect(readFileSync(path.join(tlsDir, 'fullchain.pem'), 'utf8')).toBe(chain(identities.live!));
        expect(existsSync(path.join(tlsDir, 'fullchain.pem.next'))).toBe(false);
        expect((await httpsGet(refusing.httpsPort, '/')).fingerprint).toBe(fingerprint(identities.live!.cert));
      }
    }, 300_000);

    it('notices a certificate installed without a reload, in the health check and the operator check', async () => {
      const tlsDir = pairDir('drift-live', chain(identities.live!), identities.live!.key);
      const drifting = await startEdge('drift', { certDir: tlsDir });
      const replacement = pairDir('drift-new', chain(identities.drift!), identities.drift!.key);
      copyFileSync(path.join(replacement, 'fullchain.pem'), path.join(tlsDir, 'fullchain.pem'));
      copyFileSync(path.join(replacement, 'privkey.pem'), path.join(tlsDir, 'privkey.pem'));

      const health = await docker('exec', drifting.name, ...web.healthcheck.test.slice(1));
      expect(health.stderr).toContain('the served certificate is not the installed one');
      expect(health.code).not.toBe(0);

      const check = await tlsCheck(drifting, ['--cert-dir', tlsDir]);
      expect(check.code).toBe(2);
      expect(check.stdout + check.stderr).toContain('served_differs_from_installed');

      expect((await docker('exec', drifting.name, 'nginx', '-s', 'reload')).code).toBe(0);
      // `nginx -s reload` only signals the master and returns. The old workers keep
      // accepting, with the old certificate, until the master has re-read the
      // configuration, started new workers and retired them: measured at up to ~2 s
      // on a CPU-limited edge. Wait for the health check itself, as
      // scripts/tls-install.sh does, instead of guessing a delay.
      let reloaded = await docker('exec', drifting.name, ...web.healthcheck.test.slice(1));
      for (const deadline = Date.now() + 20_000; reloaded.code !== 0 && Date.now() < deadline; ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        reloaded = await docker('exec', drifting.name, ...web.healthcheck.test.slice(1));
      }
      expect(reloaded.code, reloaded.stderr).toBe(0);
      expect((await httpsGet(drifting.httpsPort, '/')).fingerprint).toBe(fingerprint(identities.drift!.cert));
      const healed = await tlsCheck(drifting, ['--cert-dir', tlsDir]);
      expect(healed.code, healed.stdout + healed.stderr).toBe(0);
      expect(healed.stdout + healed.stderr).not.toContain('served_differs_from_installed');
    }, 300_000);

    it('warns through the operator check inside the renewal window', async () => {
      const result = await tlsCheck(edge, ['--cert-dir', liveDir, '--warn-days', '60', '--critical-days', '7']);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain('renewal_due');
    }, 120_000);

    it('logged no key material over the whole run', async () => {
      const logs = await docker('logs', edge.name);
      expectNoKeyMaterial(logs.stdout + logs.stderr, ...Object.values(identities).map((identity) => identity.key).filter(Boolean));
    }, 60_000);
  });
});
