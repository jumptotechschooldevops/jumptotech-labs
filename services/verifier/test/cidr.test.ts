/**
 * IPv4 CIDR arithmetic.
 *
 * The properties here are the ones lab grading rests on: a plan is judged by
 * the ranges it allocates, so parsing has to reject anything that only looks
 * like a CIDR, and containment/overlap have to be exact at the boundaries.
 */
import { describe, expect, it } from 'vitest';
import {
  AWS_RESERVED_ADDRESSES_PER_SUBNET,
  cidrContains,
  cidrsOverlap,
  freeAddresses,
  isRfc1918,
  parseIpv4Cidr,
  usableAddresses,
} from '../src/cidr.js';

const cidr = (text: string) => {
  const parsed = parseIpv4Cidr(text);
  if (!parsed) throw new Error(`expected ${text} to parse`);
  return parsed;
};

describe('parseIpv4Cidr', () => {
  it('parses a block and reports its boundaries', () => {
    const parsed = cidr('10.0.0.0/16');
    expect(parsed.text).toBe('10.0.0.0/16');
    expect(parsed.prefixLength).toBe(16);
    expect(parsed.addressCount).toBe(65_536);
    expect(parsed.network).toBe(0x0a000000);
    expect(parsed.broadcast).toBe(0x0a00ffff);
    expect(parsed.normalised).toBe(false);
  });

  it('clears host bits the way AWS does, and says that it did', () => {
    // The VPC User Guide's own example: 100.68.0.18/18 becomes 100.68.0.0/18.
    const parsed = cidr('100.68.0.18/18');
    expect(parsed.text).toBe('100.68.0.0/18');
    expect(parsed.normalised).toBe(true);
  });

  it('handles the extremes of the address space', () => {
    expect(cidr('0.0.0.0/0').addressCount).toBe(4_294_967_296);
    expect(cidr('0.0.0.0/0').broadcast).toBe(0xffffffff);
    expect(cidr('255.255.255.255/32').addressCount).toBe(1);
    expect(cidr('255.255.255.255/32').network).toBe(0xffffffff);
  });

  it.each([
    ['10.0.0.0', 'no prefix'],
    ['10.0.0.0/', 'empty prefix'],
    ['10.0.0.0/33', 'prefix out of range'],
    ['10.0.0.0/016', 'padded prefix'],
    ['10.0.0.256/16', 'octet out of range'],
    ['10.0.0/16', 'three octets'],
    ['10.0.0.0.0/16', 'five octets'],
    ['010.0.0.0/16', 'leading zero'],
    ['10.0.0.-1/16', 'negative octet'],
    ['10.0.0.0/16/24', 'two prefixes'],
    ['10.0.0.0 /16', 'inner whitespace'],
    ['ten.0.0.0/16', 'not numeric'],
    ['2001:db8::/32', 'IPv6'],
    ['', 'empty'],
  ])('rejects %s (%s)', (input) => {
    expect(parseIpv4Cidr(input)).toBeNull();
  });

  it('rejects anything that is not a string', () => {
    for (const input of [undefined, null, 16, {}, [], { Ref: 'VpcCidr' }]) {
      expect(parseIpv4Cidr(input)).toBeNull();
    }
  });
});

describe('containment and overlap', () => {
  it('contains a block inside it, including itself', () => {
    expect(cidrContains(cidr('10.0.0.0/16'), cidr('10.0.1.0/24'))).toBe(true);
    expect(cidrContains(cidr('10.0.0.0/16'), cidr('10.0.0.0/16'))).toBe(true);
  });

  it('is exact at both boundaries', () => {
    const vpc = cidr('10.0.0.0/16');
    expect(cidrContains(vpc, cidr('10.0.0.0/24'))).toBe(true);
    expect(cidrContains(vpc, cidr('10.0.255.0/24'))).toBe(true);
    // One address past each end.
    expect(cidrContains(vpc, cidr('9.255.255.255/32'))).toBe(false);
    expect(cidrContains(vpc, cidr('10.1.0.0/32'))).toBe(false);
  });

  it('does not contain a block wider than itself', () => {
    expect(cidrContains(cidr('10.0.0.0/24'), cidr('10.0.0.0/16'))).toBe(false);
  });

  it('detects overlap, including partial and nested', () => {
    expect(cidrsOverlap(cidr('10.0.0.0/24'), cidr('10.0.0.128/25'))).toBe(true);
    expect(cidrsOverlap(cidr('10.0.0.0/16'), cidr('10.0.5.0/24'))).toBe(true);
    expect(cidrsOverlap(cidr('10.0.0.0/24'), cidr('10.0.0.0/24'))).toBe(true);
  });

  it('calls adjacent blocks disjoint', () => {
    // The split from the VPC guide: /25 and /25 fill a /24 without overlapping.
    expect(cidrsOverlap(cidr('10.0.0.0/25'), cidr('10.0.0.128/25'))).toBe(false);
    expect(cidrsOverlap(cidr('10.0.0.0/24'), cidr('10.0.1.0/24'))).toBe(false);
  });

  it('is symmetric', () => {
    const a = cidr('172.16.0.0/20');
    const b = cidr('172.16.8.0/24');
    expect(cidrsOverlap(a, b)).toBe(cidrsOverlap(b, a));
  });
});

describe('capacity', () => {
  it('subtracts the five addresses AWS reserves in every subnet', () => {
    expect(AWS_RESERVED_ADDRESSES_PER_SUBNET).toBe(5);
    // The guide's example: a /24 holds 256, of which five are reserved.
    expect(usableAddresses(cidr('10.0.0.0/24'))).toBe(251);
    expect(usableAddresses(cidr('10.0.0.0/20'))).toBe(4_091);
    // The smallest subnet AWS allows holds 16 addresses.
    expect(usableAddresses(cidr('10.0.0.0/28'))).toBe(11);
  });

  it('never reports a negative count for a block smaller than the reservation', () => {
    expect(usableAddresses(cidr('10.0.0.0/32'))).toBe(0);
    expect(usableAddresses(cidr('10.0.0.0/30'))).toBe(0);
  });

  it('measures what a plan leaves unallocated', () => {
    const vpc = cidr('10.0.0.0/16');
    const subnets = ['10.0.0.0/20', '10.0.16.0/20'].map(cidr);
    expect(freeAddresses(vpc, subnets)).toBe(65_536 - 8_192);
  });

  it('ignores ranges that fall outside the parent rather than going negative', () => {
    const vpc = cidr('10.0.0.0/24');
    expect(freeAddresses(vpc, [cidr('192.168.0.0/16')])).toBe(256);
  });
});

describe('RFC 1918', () => {
  it.each(['10.0.0.0/16', '10.255.255.0/24', '172.16.0.0/16', '172.31.0.0/16', '192.168.0.0/20'])(
    'accepts %s',
    (text) => {
      expect(isRfc1918(cidr(text))).toBe(true);
    },
  );

  it.each(['11.0.0.0/16', '172.15.0.0/16', '172.32.0.0/16', '192.169.0.0/16', '100.64.0.0/16'])(
    'rejects %s',
    (text) => {
      expect(isRfc1918(cidr(text))).toBe(false);
    },
  );

  it('rejects a block that only partly overlaps a private range', () => {
    // Straddles the top of 172.16.0.0/12, so not wholly private.
    expect(isRfc1918(cidr('172.16.0.0/11'))).toBe(false);
  });
});
