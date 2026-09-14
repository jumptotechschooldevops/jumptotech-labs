/**
 * BETA-P0-015 — the CIDR arithmetic behind the external-egress allow-list.
 *
 * The allow-list is a security boundary expressed as numbers, so the properties
 * that matter are checked exhaustively at every range boundary rather than by
 * example: the complement never admits a denied address, and never drops an
 * address that was not denied.
 */
import { describe, expect, it } from 'vitest';
import {
  CidrError,
  NON_PUBLIC_IPV4_CIDRS,
  formatIpv4Address,
  ipv4CidrContains,
  ipv4Complement,
  parseIpv4Address,
  parseIpv4Cidr,
  rangeToCidrs,
} from '../src/k8s/cidr.js';

const inAny = (cidrs: readonly string[], address: string) =>
  cidrs.some((cidr) => ipv4CidrContains(cidr, address));

/** Every range edge, one either side of it, and a spread of public addresses. */
function probeAddresses(cidrs: readonly string[]): string[] {
  const values = new Set<number>([0, 2 ** 32 - 1, 16_843_009, 134_744_072]);
  for (const cidr of cidrs) {
    const { start, end } = parseIpv4Cidr(cidr);
    for (const v of [start - 1, start, start + 1, end - 1, end, end + 1]) {
      if (v >= 0 && v < 2 ** 32) values.add(v);
    }
  }
  return [...values].map(formatIpv4Address);
}

describe('parsing', () => {
  it('round-trips addresses', () => {
    for (const address of ['0.0.0.0', '10.244.0.1', '255.255.255.255', '172.19.0.3']) {
      expect(formatIpv4Address(parseIpv4Address(address))).toBe(address);
    }
  });

  it('refuses malformed input and host bits rather than widening a range', () => {
    for (const bad of ['10.244.0.0', '10.244.0.0/33', '256.0.0.0/8', '10.0.0/8', '010.0.0.0/8', '::/0']) {
      expect(() => parseIpv4Cidr(bad), bad).toThrow(CidrError);
    }
    expect(() => parseIpv4Cidr('10.244.1.7/16')).toThrow(/host bits set; did you mean 10\.244\.0\.0\/16/);
  });

  it('splits an arbitrary range into the fewest aligned blocks', () => {
    expect(rangeToCidrs(parseIpv4Cidr('0.0.0.0/0'))).toEqual(['0.0.0.0/0']);
    expect(rangeToCidrs({ start: parseIpv4Address('10.0.0.1'), end: parseIpv4Address('10.0.0.6') })).toEqual([
      '10.0.0.1/32',
      '10.0.0.2/31',
      '10.0.0.4/31',
      '10.0.0.6/32',
    ]);
  });
});

describe('ipv4Complement', () => {
  it('is the whole space when nothing is denied, and empty when everything is', () => {
    expect(ipv4Complement([])).toEqual(['0.0.0.0/0']);
    expect(ipv4Complement(['0.0.0.0/0'])).toEqual([]);
  });

  it('never admits a denied address and never drops an allowed one', () => {
    const denied = [...NON_PUBLIC_IPV4_CIDRS, '10.244.0.0/16', '10.96.0.0/16', '100.100.0.0/16', '8.8.8.8/32'];
    const allowed = ipv4Complement(denied);

    for (const address of probeAddresses([...denied, ...allowed])) {
      expect(inAny(allowed, address), address).toBe(!inAny(denied, address));
    }
  });

  it('produces non-overlapping blocks', () => {
    const ranges = ipv4Complement(NON_PUBLIC_IPV4_CIDRS)
      .map(parseIpv4Cidr)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]!.start).toBeGreaterThan(ranges[i - 1]!.end);
    }
  });

  it('tolerates overlapping and duplicate denials', () => {
    expect(ipv4Complement(['10.0.0.0/8', '10.244.0.0/16', '10.0.0.0/8'])).toEqual(
      ipv4Complement(['10.0.0.0/8']),
    );
  });
});

describe('NON_PUBLIC_IPV4_CIDRS', () => {
  it('covers the ranges platform infrastructure and instance metadata live in', () => {
    for (const address of [
      '10.0.0.1', // RFC 1918 — cluster, VPC
      '172.19.0.3', // RFC 1918 — the kind Docker network, where the dev api container sits
      '192.168.1.1', // RFC 1918
      '169.254.169.254', // instance metadata
      '100.64.0.1', // CGNAT
      '127.0.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(inAny(NON_PUBLIC_IPV4_CIDRS, address), address).toBe(true);
    }
  });

  it('leaves ordinary public addresses reachable', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '140.82.112.3', '151.101.1.69']) {
      expect(inAny(NON_PUBLIC_IPV4_CIDRS, address), address).toBe(false);
    }
  });
});
