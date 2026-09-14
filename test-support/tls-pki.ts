/**
 * A throwaway certificate authority, built in memory — BETA-P0-011.
 *
 * The transport tests need real X.509 certificates: a CA, a server certificate
 * it signed, a certificate for the wrong host, and an unrelated CA. Committing
 * those would put private keys in the repository and an expiry date in the test
 * suite; `openssl` would be a host process, which the guard (rightly) refuses.
 * So they are minted here with `node:crypto` — ECDSA P-256, valid for one day,
 * never written to disk unless a test writes one to its own temp directory.
 *
 * Test-only. Nothing under `src/` imports this.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const boolTrue = (): Buffer => tlv(0x01, Buffer.from([0xff]));

function integer(bytes: Buffer): Buffer {
  return tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first! + second!];
  for (const part of rest) {
    const encoded = [part & 0x7f];
    for (let v = part >> 7; v > 0; v >>= 7) encoded.unshift((v & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text));
}

const commonName = (cn: string): Buffer => sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ECDSA_WITH_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [boolTrue()] : []), tlv(0x04, value));
}

function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.concat(groups.map((g) => Buffer.from(g.padStart(4, '0'), 'hex')));
}

function pem(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function certificate(options: {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signingKey: KeyObject;
  extensions: Buffer[];
}): string {
  const serial = randomBytes(8);
  serial[0]! &= 0x7f;
  const now = Date.now();
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_WITH_SHA256,
    commonName(options.issuer),
    sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    commonName(options.subject),
    options.publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(...options.extensions)),
  );
  const signature = sign('sha256', tbs, options.signingKey);
  return pem(sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature]))));
}

export interface TestIdentity {
  /** PEM certificate. */
  cert: string;
  /** PEM PKCS#8 private key. */
  key: string;
}

export interface TestCa {
  /** The CA's own certificate — what a client trusts. */
  cert: string;
  /** A server certificate for these names, signed by this CA. */
  issue(names: { dns?: string[]; ips?: string[] }): TestIdentity;
}

export function createTestCa(name = 'jumptotech test CA'): TestCa {
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caCert = certificate({
    subject: name,
    issuer: name,
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    extensions: [
      extension('2.5.29.19', true, sequence(boolTrue())),
      // keyCertSign | cRLSign
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06]))),
    ],
  });

  return {
    cert: caCert,
    issue({ dns = [], ips = [] }) {
      const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const cert = certificate({
        subject: dns[0] ?? ips[0] ?? 'server',
        issuer: name,
        publicKey: leaf.publicKey,
        signingKey: ca.privateKey,
        extensions: [
          extension(
            '2.5.29.17',
            false,
            sequence(
              ...dns.map((d) => tlv(0x82, Buffer.from(d))),
              ...ips.map((ip) => tlv(0x87, ipBytes(ip))),
            ),
          ),
        ],
      });
      return { cert, key: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    },
  };
}
