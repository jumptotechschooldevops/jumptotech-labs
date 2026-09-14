/**
 * How the application reaches PostgreSQL — BETA-P0-012.
 *
 * The connection carries the database password and every student's history.
 * On the compose stack it crosses one host's private Docker bridge; against a
 * database on another host it crosses a network. This module decides, once and
 * before any connection is opened, whether a configured transport is acceptable.
 *
 * ## Certificate verification is not optional
 *
 * `DATABASE_SSL=true` means verified TLS: the server's chain is checked against
 * `DATABASE_SSL_CA_FILE` (or the system store when unset), its name is checked
 * against the host dialled, and TLS ≥ 1.2. The pool was previously built with
 * `rejectUnauthorized: false`, which encrypted the password to whoever answered.
 * There is no variable that turns verification off.
 *
 * `pg` has two side doors that could still do it, and both are closed:
 *
 *   · the connection string. Query parameters (`sslmode=no-verify`, `ssl=…`,
 *     `sslrootcert=…`, `uselibpqcompat=true`) are merged *over* the `ssl`
 *     option this module builds, so a URL could silently downgrade it. Any TLS
 *     parameter in `DATABASE_URL` is refused, in every environment.
 *   · `PGSSLMODE`, which `pg` reads whenever `ssl` is left undefined. The pool
 *     always passes `ssl` explicitly, so it is never consulted, and production
 *     refuses it being set at all rather than let an operator believe it works.
 *
 * ## Production rules (`NODE_ENV=production`)
 *
 * A database is accepted only as:
 *
 *   · `DATABASE_SSL=true` — verified TLS, to any host;
 *   · a Unix socket or a loopback IP literal — the bytes never leave the host;
 *   · a single-label host (a Compose service name) with
 *     `DATABASE_SAME_HOST_PLAINTEXT=true` — the compose stack, where the api and
 *     PostgreSQL share one host's private bridge. An explicit declaration, not
 *     an inference from the name, in the same shape as BETA-P0-011's
 *     `SANDBOX_BROKER_SAME_HOST_PLAINTEXT`.
 *
 * Everything else — plaintext to `db.internal`, to `10.0.0.5`, or to an
 * undeclared `postgres` — is a refusal to start. Outside production, plaintext
 * is accepted and reported as `development-plaintext`.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export const DATABASE_SSL_ENV = 'DATABASE_SSL';
/** PEM bundle trusted for the database connection only — never process-wide. */
export const DATABASE_SSL_CA_FILE_ENV = 'DATABASE_SSL_CA_FILE';
/** The explicit single-host plaintext declaration. `true` or unset. */
export const DATABASE_SAME_HOST_PLAINTEXT_ENV = 'DATABASE_SAME_HOST_PLAINTEXT';
export const DATABASE_TLS_MIN_VERSION = 'TLSv1.2' as const;

/**
 * Why a transport was accepted.
 *
 *   tls                    encrypted, certificate and host name verified
 *   local-socket           a Unix domain socket
 *   loopback-plaintext     never leaves the host's network namespace
 *   same-host-plaintext    declared single-host private bridge (compose)
 *   development-plaintext  NODE_ENV is not production
 */
export type DatabaseTransportMode =
  | 'tls'
  | 'local-socket'
  | 'loopback-plaintext'
  | 'same-host-plaintext'
  | 'development-plaintext';

/** A refused database transport. Names variables and rules, never a credential. */
export class DatabaseTransportError extends Error {
  readonly code = 'DATABASE_TRANSPORT_REFUSED';
}

/** The `ssl` option every TLS connection to PostgreSQL is made with. */
export interface DatabaseTlsOptions {
  rejectUnauthorized: true;
  minVersion: typeof DATABASE_TLS_MIN_VERSION;
  ca?: string;
}

function refuse(message: string): never {
  throw new DatabaseTransportError(message);
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? '').trim() === 'production';
}

/**
 * `DATABASE_SSL`, strictly.
 *
 * The previous reader treated anything it did not recognise as `false`, so a
 * typo such as `DATABASE_SSL=verify` quietly meant plaintext.
 */
export function readDatabaseSsl(env: NodeJS.ProcessEnv): boolean {
  const raw = env[DATABASE_SSL_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '' || ['0', 'false', 'no', 'off'].includes(raw)) return false;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  return refuse(`${DATABASE_SSL_ENV} must be true or false.`);
}

function sameHostDeclared(env: NodeJS.ProcessEnv): boolean {
  const raw = env[DATABASE_SAME_HOST_PLAINTEXT_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  return refuse(`${DATABASE_SAME_HOST_PLAINTEXT_ENV} must be 'true' or unset.`);
}

/**
 * The CA bundle, as public certificates and nothing else.
 *
 * A private key in the file is refused rather than ignored: it means the wrong
 * file was distributed to the application tier.
 */
export function readDatabaseCaBundle(file: string): string {
  let pem: string;
  try {
    pem = readFileSync(file, 'utf8');
  } catch {
    return refuse(`${DATABASE_SSL_CA_FILE_ENV} names a file that could not be read.`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    refuse(`${DATABASE_SSL_CA_FILE_ENV} contains a private key. A CA bundle holds public certificates only.`);
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) {
    refuse(`${DATABASE_SSL_CA_FILE_ENV} contains no PEM certificate.`);
  }
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      refuse(`${DATABASE_SSL_CA_FILE_ENV} contains a certificate that does not parse.`);
    }
  }
  return `${blocks.join('\n')}\n`;
}

/**
 * Refuse TLS settings carried in a connection string.
 *
 * `pg` merges the URL's query parameters over the options it is given, so
 * `?sslmode=no-verify` would replace verified TLS with unverified TLS and
 * `?sslmode=disable` would replace it with none. TLS is configured with
 * `DATABASE_SSL` and `DATABASE_SSL_CA_FILE`, and only there. The refusal names
 * parameters, never the URL, which holds the password.
 */
export function assertNoConnectionStringTls(url: string): void {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0]! : '';
  const names = query
    .split('&')
    .map((pair) => {
      try {
        return decodeURIComponent(pair.split('=')[0]!.replace(/\+/g, ' ')).trim().toLowerCase();
      } catch {
        return pair.split('=')[0]!.trim().toLowerCase();
      }
    })
    .filter((name) => name.startsWith('ssl') || name === 'uselibpqcompat');
  if (names.length > 0) {
    refuse(
      `DATABASE_URL carries TLS parameters (${[...new Set(names)].sort().join(', ')}), which would override ` +
        `the verified TLS settings. Remove them and set ${DATABASE_SSL_ENV}=true (with ${DATABASE_SSL_CA_FILE_ENV} ` +
        'for a private CA).',
    );
  }
}

/** The `ssl` option for `pg`. Always explicit, so `PGSSLMODE` is never consulted. */
export function databaseTlsOptions(config: { ssl: boolean; sslCa?: string }): false | DatabaseTlsOptions {
  if (!config.ssl) return false;
  return {
    rejectUnauthorized: true,
    minVersion: DATABASE_TLS_MIN_VERSION,
    ...(config.sslCa ? { ca: config.sslCa } : {}),
  };
}

/** The host `pg` will dial, from either configuration form. */
function databaseHost(config: { url?: string; host?: string }): string | null {
  if (!config.url) return config.host ?? null;
  if (config.url.startsWith('/')) return config.url.split(' ')[0]!;
  // `?host=` wins over the authority in `pg`, so it wins here too. Read by hand:
  // a socket URL (`postgresql://u:p@/db?host=/run/postgresql`) has no authority
  // host, which `URL` refuses to parse.
  const hostParam = /[?&]host=([^&#]*)/.exec(config.url)?.[1];
  if (hostParam) {
    try {
      return decodeURIComponent(hostParam);
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(new URL(config.url).hostname) || null;
  } catch {
    return null;
  }
}

function isLoopbackLiteral(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  const family = isIP(bare);
  if (family === 4) return bare.split('.')[0] === '127';
  if (family === 6) return new URL(`http://[${bare}]`).hostname === '[::1]';
  return false;
}

/** A Compose service name: one DNS label, not an IP. */
function isSingleLabelHost(host: string): boolean {
  return isIP(host.replace(/^\[(.*)\]$/, '$1')) === 0 && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
}

/** Decide whether this process may send the database credential over this transport. */
export function resolveDatabaseTransport(
  config: { url?: string; host?: string; ssl: boolean; sslCa?: string },
  env: NodeJS.ProcessEnv,
  service: string,
): { mode: DatabaseTransportMode } {
  const production = isProduction(env);
  const sameHost = sameHostDeclared(env);
  if (config.url) assertNoConnectionStringTls(config.url);

  if (production && (env.PGSSLMODE?.trim() ?? '') !== '') {
    refuse(
      `PGSSLMODE is set, but ${service} configures database TLS with ${DATABASE_SSL_ENV} and never reads it. ` +
        'Refusing under NODE_ENV=production rather than leave a TLS setting that does nothing; unset it.',
    );
  }

  if (config.ssl) {
    if (production && sameHost) {
      refuse(
        `${DATABASE_SAME_HOST_PLAINTEXT_ENV}=true is set for ${service}, but ${DATABASE_SSL_ENV}=true. The ` +
          'declaration exists only for plaintext; remove it.',
      );
    }
    return { mode: 'tls' };
  }

  const host = databaseHost(config);
  if (host?.startsWith('/')) return { mode: 'local-socket' };
  if (host && isLoopbackLiteral(host)) return { mode: 'loopback-plaintext' };
  if (!production) return { mode: 'development-plaintext' };
  if (sameHost) {
    if (host && isSingleLabelHost(host)) return { mode: 'same-host-plaintext' };
    refuse(
      `${DATABASE_SAME_HOST_PLAINTEXT_ENV}=true covers a Compose service name on one host's private bridge, ` +
        `but ${service}'s database host is ${host ? `'${host}'` : 'not a host name'}. Set ${DATABASE_SSL_ENV}=true.`,
    );
  }
  return refuse(
    `${service} refuses to send the database password over plaintext to ${host ? `'${host}'` : 'the configured host'} ` +
      `under NODE_ENV=production. Set ${DATABASE_SSL_ENV}=true (with ${DATABASE_SSL_CA_FILE_ENV} for a private CA), ` +
      `or, only where the service and PostgreSQL share one host's private bridge, set ` +
      `${DATABASE_SAME_HOST_PLAINTEXT_ENV}=true. See docs/runtime-architecture.md §11.`,
  );
}
