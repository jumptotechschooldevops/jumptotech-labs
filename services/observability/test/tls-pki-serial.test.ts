/**
 * The throwaway CA in test-support/tls-pki.ts must emit DER that OpenSSL 3
 * accepts, whatever serial `randomBytes` happens to return.
 *
 * A random 8-byte serial begins with 0x00 about once in 256. Encoded without
 * stripping that byte it is a non-minimal DER INTEGER, which OpenSSL 3 refuses
 * with ERR_OSSL_ASN1_ILLEGAL_PADDING; every certificate or TLS server built on
 * it then fails. That made tls-certificate-health.test.ts (and
 * apps/api operations-metrics.test.ts) fail at random in CI. Here the serial is
 * pinned to the exact byte patterns instead of waiting to be unlucky.
 */
import { X509Certificate } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const serial = vi.hoisted(() => ({ next: null as Buffer | null }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: ((size: number) =>
      serial.next ? Buffer.from(serial.next) : actual.randomBytes(size)) as typeof actual.randomBytes,
  };
});

const { createSelfSignedServer, createTestCa } = await import('@jumptotech/test-support/tls-pki');

afterEach(() => {
  serial.next = null;
});

/** The serial number's hex exactly as OpenSSL reads it back. */
const serialOf = (pem: string): string => new X509Certificate(pem).serialNumber.toLowerCase();

describe('tls-pki — certificate serials are minimal DER integers', () => {
  it.each([
    ['one leading zero, then a byte without its high bit', '0079766843118d09', '79766843118d09'],
    ['several leading zeros', '000000124f8e0a31', '124f8e0a31'],
    ['a leading zero before a byte with its high bit set', '00b2c3d4e5f60718', 'b2c3d4e5f60718'],
    ['no leading zero', '5a0b0c0d0e0f1011', '5a0b0c0d0e0f1011'],
  ])('parses a certificate whose random serial has %s', (_label, random, expected) => {
    serial.next = Buffer.from(random, 'hex');
    const ca = createTestCa('jtt serial CA');
    const leaf = ca.issue({ dns: ['labs.jtt.test'] });
    const self = createSelfSignedServer({ dns: ['labs.jtt.test'] });

    for (const pem of [ca.cert, leaf.cert, self.cert]) {
      expect(serialOf(pem)).toBe(expected);
    }
    expect(new X509Certificate(leaf.cert).verify(new X509Certificate(ca.cert).publicKey)).toBe(true);
  });

  it('never emits a negative serial', () => {
    serial.next = Buffer.from('ff01020304050607', 'hex');
    expect(serialOf(createTestCa('jtt negative CA').cert)).toBe('7f01020304050607');
  });
});
