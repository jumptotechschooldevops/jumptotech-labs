/**
 * How the application tier reaches `sandboxd` — BETA-P0-011.
 *
 * Every broker request carries a capability secret in `x-internal-secret`. On a
 * single-host compose stack that header crosses one Docker bridge and never a
 * wire. Once `sandboxd` moves to its own runtime host, it crosses a network,
 * and a plaintext `http://` URL would hand the attach, runtime and Docker
 * capabilities to anything on the path. Changing `SANDBOX_BROKER_URL` must not
 * be enough to do that, so this module decides — once, at startup — whether a
 * configured transport is acceptable, and refuses to start when it is not.
 *
 * ```text
 *   application tier                              runtime tier
 *   api ─────── https + CA-verified TLS ───────►  sandboxd (SANDBOXD_TLS_*)
 *   terminal ── wss + CA-verified TLS ─────────►
 * ```
 *
 * ## Production rules (`NODE_ENV=production`)
 *
 * A client URL (api, terminal) is accepted only as:
 *
 *   · `https://…` — certificate and hostname verification always on;
 *   · `http://` to a loopback IP literal (`127.0.0.0/8`, `[::1]`) — the bytes
 *     never leave the kernel, which is also how a local TLS proxy is fronted;
 *   · `http://<single-label name>` with `SANDBOX_BROKER_SAME_HOST_PLAINTEXT=true`
 *     — the compose stack, where caller and broker share one host's private
 *     bridge. An explicit declaration, not an inference from the host name; the
 *     name check only stops the declaration covering an FQDN or an IP.
 *
 * Everything else is refused. The broker applies the same rule to itself: TLS,
 * a loopback bind, or the same declaration.
 *
 * ## Everywhere
 *
 * The URL may carry no userinfo, query, fragment or path, so no credential can
 * ride in it. A CA file paired with `http://` is refused, because it means TLS
 * was intended and plaintext would be the silent result. Certificate
 * verification is never optional: there is no switch here that turns it off.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createSecureContext } from 'node:tls';
import { isProductionEnv } from '@jumptotech/observability';

export const BROKER_URL_ENV = 'SANDBOX_BROKER_URL';
/** PEM bundle trusted for broker connections only — never process-wide. */
export const BROKER_CA_FILE_ENV = 'SANDBOX_BROKER_CA_FILE';
/** The explicit single-host plaintext declaration. `true` or unset. */
export const BROKER_SAME_HOST_PLAINTEXT_ENV = 'SANDBOX_BROKER_SAME_HOST_PLAINTEXT';
export const BROKER_TLS_CERT_FILE_ENV = 'SANDBOXD_TLS_CERT_FILE';
export const BROKER_TLS_KEY_FILE_ENV = 'SANDBOXD_TLS_KEY_FILE';
export const BROKER_TLS_MIN_VERSION = 'TLSv1.2' as const;

/**
 * Why a transport was accepted.
 *
 *   tls                   encrypted, certificate verified
 *   loopback-plaintext    never leaves the host's network namespace
 *   same-host-plaintext   declared single-host private bridge (compose)
 *   development-plaintext NODE_ENV is not production
 */
export type BrokerTransportMode =
  | 'tls'
  | 'loopback-plaintext'
  | 'same-host-plaintext'
  | 'development-plaintext';

/** A refused transport. Names variables and rules, never a URL's credentials. */
export class BrokerTransportError extends Error {
  readonly code = 'BROKER_TRANSPORT_REFUSED';
}

export interface BrokerClientTransport {
  /** `scheme://host:port`, with nothing after it. */
  url: string;
  protocol: 'https:' | 'http:';
  mode: BrokerTransportMode;
  /** Trust anchors for this connection only. Absent ⇒ the system store. */
  ca?: string;
}

export interface BrokerServerTransport {
  mode: BrokerTransportMode;
  /** Present exactly when `mode` is `tls`. */
  tls: { cert: string; key: string } | null;
}

/** Options every TLS connection to the broker is made with. */
export interface BrokerClientTlsOptions {
  ca?: string;
  rejectUnauthorized: true;
  minVersion: typeof BROKER_TLS_MIN_VERSION;
}

function refuse(message: string): never {
  throw new BrokerTransportError(message);
}

/** `127.0.0.0/8` or `::1`, as literals. A name is never trusted to be local. */
export function isLoopbackAddress(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  const family = isIP(bare);
  if (family === 4) return bare.split('.')[0] === '127';
  if (family === 6) {
    // Normalised by URL, so every spelling of ::1 compares equal.
    return new URL(`http://[${bare}]`).hostname === '[::1]';
  }
  return false;
}

/** A Compose service name: one DNS label, not an IP. */
function isSingleLabelHost(hostname: string): boolean {
  return isIP(hostname.replace(/^\[(.*)\]$/, '$1')) === 0 && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname);
}

function sameHostDeclared(env: NodeJS.ProcessEnv): boolean {
  const raw = env[BROKER_SAME_HOST_PLAINTEXT_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  return refuse(`${BROKER_SAME_HOST_PLAINTEXT_ENV} must be 'true' or unset.`);
}

function readFileOrRefuse(file: string, variable: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return refuse(`${variable} names a file that could not be read.`);
  }
}

/**
 * The CA bundle, as public certificates and nothing else.
 *
 * A private key in the file is refused rather than ignored: it means the wrong
 * file was distributed to the application tier, which is worth stopping for.
 */
function readCaBundle(file: string): string {
  const pem = readFileOrRefuse(file, BROKER_CA_FILE_ENV);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    refuse(`${BROKER_CA_FILE_ENV} contains a private key. A CA bundle holds public certificates only.`);
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) {
    refuse(`${BROKER_CA_FILE_ENV} contains no PEM certificate.`);
  }
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      refuse(`${BROKER_CA_FILE_ENV} contains a certificate that does not parse.`);
    }
  }
  return `${blocks.join('\n')}\n`;
}

/**
 * Refuse a process-wide certificate-verification bypass.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` switches verification off for every TLS
 * connection a Node process makes. The broker clients pass
 * `rejectUnauthorized: true` explicitly and so are unaffected, but the same
 * process also talks to the identity provider. Production refuses to start.
 */
export function assertTlsVerificationEnabled(env: NodeJS.ProcessEnv, service: string): void {
  if (!isProductionEnv(env)) return;
  const raw = env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() ?? '';
  if (raw !== '' && raw !== '1') {
    refuse(
      `NODE_TLS_REJECT_UNAUTHORIZED is set, which can disable certificate verification for every ` +
        `TLS connection. ${service} refuses to start with it under NODE_ENV=production; unset it.`,
    );
  }
}

export interface ResolveBrokerClientOptions {
  /** Named in refusals. */
  service: string;
  /** The URL as the service read it. */
  url: string;
}

/** Decide whether a caller may send capability secrets to this URL. */
export function resolveBrokerClientTransport(
  env: NodeJS.ProcessEnv,
  options: ResolveBrokerClientOptions,
): BrokerClientTransport {
  const production = isProductionEnv(env);

  let parsed: URL;
  try {
    parsed = new URL(options.url.trim());
  } catch {
    return refuse(`${BROKER_URL_ENV} for ${options.service} is not an absolute URL.`);
  }

  // Credentials first, so no later message can be built from a URL holding one.
  if (parsed.username || parsed.password) {
    refuse(
      `${BROKER_URL_ENV} for ${options.service} carries credentials. Capability secrets travel only ` +
        'in the x-internal-secret header; remove them from the URL and rotate them.',
    );
  }
  if (parsed.search || parsed.hash || options.url.includes('?') || options.url.includes('#')) {
    refuse(`${BROKER_URL_ENV} for ${options.service} may not carry a query string or fragment.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    refuse(`${BROKER_URL_ENV} for ${options.service} must be an https:// URL.`);
  }
  if (parsed.pathname !== '/') {
    refuse(`${BROKER_URL_ENV} for ${options.service} must name the broker's origin only, with no path.`);
  }

  const caFile = env[BROKER_CA_FILE_ENV]?.trim() ?? '';
  const sameHost = sameHostDeclared(env);
  const url = parsed.origin;

  if (parsed.protocol === 'https:') {
    if (production && sameHost) {
      refuse(
        `${BROKER_SAME_HOST_PLAINTEXT_ENV}=true is set for ${options.service}, but ${BROKER_URL_ENV} is ` +
          'https://. The declaration exists only for plaintext; remove it.',
      );
    }
    const ca = caFile ? readCaBundle(caFile) : undefined;
    return { url, protocol: 'https:', mode: 'tls', ...(ca ? { ca } : {}) };
  }

  if (caFile) {
    refuse(
      `${BROKER_CA_FILE_ENV} is set for ${options.service}, but ${BROKER_URL_ENV} is http://. A CA file ` +
        'means TLS was intended; refusing rather than sending capability secrets in plaintext.',
    );
  }
  if (isLoopbackAddress(parsed.hostname)) {
    return { url, protocol: 'http:', mode: 'loopback-plaintext' };
  }
  if (!production) {
    return { url, protocol: 'http:', mode: 'development-plaintext' };
  }
  if (sameHost) {
    if (isSingleLabelHost(parsed.hostname)) {
      return { url, protocol: 'http:', mode: 'same-host-plaintext' };
    }
    refuse(
      `${BROKER_SAME_HOST_PLAINTEXT_ENV}=true covers a Compose service name on one host's private ` +
        `bridge, but ${options.service}'s ${BROKER_URL_ENV} names '${parsed.hostname}'. Use https://.`,
    );
  }
  return refuse(
    `${options.service} refuses to send sandboxd capability secrets over plaintext http:// to ` +
      `'${parsed.hostname}' under NODE_ENV=production. Use https:// (with ${BROKER_CA_FILE_ENV} for a ` +
      `private CA), or, only where caller and broker share one host's private bridge, set ` +
      `${BROKER_SAME_HOST_PLAINTEXT_ENV}=true. See docs/runtime-architecture.md.`,
  );
}

export interface ResolveBrokerServerOptions {
  /** `SANDBOXD_BIND`, as resolved. */
  bindAddress: string;
}

/** Decide how `sandboxd` serves its capability endpoints. */
export function resolveBrokerServerTransport(
  env: NodeJS.ProcessEnv,
  options: ResolveBrokerServerOptions,
): BrokerServerTransport {
  const production = isProductionEnv(env);
  const certFile = env[BROKER_TLS_CERT_FILE_ENV]?.trim() ?? '';
  const keyFile = env[BROKER_TLS_KEY_FILE_ENV]?.trim() ?? '';
  const sameHost = sameHostDeclared(env);

  if (Boolean(certFile) !== Boolean(keyFile)) {
    refuse(`${BROKER_TLS_CERT_FILE_ENV} and ${BROKER_TLS_KEY_FILE_ENV} must be set together.`);
  }

  if (certFile) {
    if (production && sameHost) {
      refuse(
        `${BROKER_SAME_HOST_PLAINTEXT_ENV}=true is set, but sandboxd is configured for TLS. The ` +
          'declaration exists only for plaintext; remove it.',
      );
    }
    const cert = readFileOrRefuse(certFile, BROKER_TLS_CERT_FILE_ENV);
    const key = readFileOrRefuse(keyFile, BROKER_TLS_KEY_FILE_ENV);
    try {
      // Loads both and checks they belong together. Nothing from either is echoed.
      createSecureContext({ cert, key, minVersion: BROKER_TLS_MIN_VERSION });
    } catch {
      refuse(
        `${BROKER_TLS_CERT_FILE_ENV} and ${BROKER_TLS_KEY_FILE_ENV} could not be loaded as a ` +
          'certificate and its matching private key.',
      );
    }
    return { mode: 'tls', tls: { cert, key } };
  }

  if (isLoopbackAddress(options.bindAddress)) {
    return { mode: 'loopback-plaintext', tls: null };
  }
  if (!production) {
    return { mode: 'development-plaintext', tls: null };
  }
  if (sameHost) {
    return { mode: 'same-host-plaintext', tls: null };
  }
  return refuse(
    `sandboxd refuses to serve capability endpoints in plaintext on SANDBOXD_BIND=${options.bindAddress} ` +
      `under NODE_ENV=production. Set ${BROKER_TLS_CERT_FILE_ENV} and ${BROKER_TLS_KEY_FILE_ENV}, bind ` +
      `to loopback behind a TLS proxy, or, only on a single-host private bridge, set ` +
      `${BROKER_SAME_HOST_PLAINTEXT_ENV}=true. See docs/runtime-architecture.md.`,
  );
}

/** The options every TLS connection to the broker uses. Verification is not a parameter. */
export function brokerTlsOptions(target: { ca?: string }): BrokerClientTlsOptions {
  return {
    rejectUnauthorized: true,
    minVersion: BROKER_TLS_MIN_VERSION,
    ...(target.ca ? { ca: target.ca } : {}),
  };
}

/**
 * A `fetch` for one broker.
 *
 * Plain `http://` uses the global `fetch`. `https://` goes through
 * `node:https` instead, because the global `fetch` accepts neither a
 * per-connection CA nor an explicit `rejectUnauthorized` — so it would need
 * either a process-wide CA (not narrowly scoped) or would inherit
 * `NODE_TLS_REJECT_UNAUTHORIZED`. Only the slice of `fetch` the broker clients
 * use is implemented: a string body, headers, a signal, and a JSON reply.
 */
export function brokerFetch(target: { url: string; ca?: string }): typeof fetch {
  if (!target.url.startsWith('https:')) return fetch;
  const tls = brokerTlsOptions(target);

  const tlsFetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      if (typeof input !== 'string' && !(input instanceof URL)) {
        reject(new TypeError('the broker transport takes a URL, not a Request'));
        return;
      }
      const url = new URL(String(input));
      if (url.protocol !== 'https:') {
        reject(new TypeError('the TLS broker transport refuses a non-https URL'));
        return;
      }
      if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
        reject(new TypeError('the broker transport sends string bodies only'));
        return;
      }
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }

      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const body = typeof init.body === 'string' ? init.body : undefined;
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

      const req = httpsRequest(
        url,
        { method: init.method ?? 'GET', headers, ...tls },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', fail);
          res.on('end', () => {
            signal?.removeEventListener('abort', onAbort);
            try {
              const status = res.statusCode ?? 502;
              const nullBody = [101, 204, 205, 304].includes(status);
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(res.headers)) {
                if (typeof value === 'string') responseHeaders.set(name, value);
              }
              resolve(
                new Response(nullBody ? null : Buffer.concat(chunks), {
                  status,
                  headers: responseHeaders,
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );

      function fail(error: Error): void {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
      function onAbort(): void {
        const reason = signal?.reason instanceof Error ? signal.reason : new Error('aborted');
        req.destroy(reason);
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', fail);
      if (body !== undefined) req.write(body);
      req.end();
    });

  return tlsFetch as typeof fetch;
}
