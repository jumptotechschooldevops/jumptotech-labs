/**
 * IPv4 CIDR arithmetic.
 *
 * Pure numbers. This module knows nothing about labs, CloudFormation, or the
 * sandbox — it exists so that a network *design* can be graded on what it
 * means rather than on how it was typed. Two plans that allocate different but
 * equally valid ranges must both pass, and that is only possible if the
 * verifier can actually do the subnet maths.
 *
 * The AWS-specific rules it encodes are documented ones, cited where used:
 *
 *   · a VPC IPv4 block is between a /16 and a /28 netmask;
 *   · a subnet IPv4 block is between a /28 and a /16 netmask;
 *   · the first four addresses and the last address of every subnet are
 *     reserved by AWS and cannot be assigned — five in total;
 *   · a CIDR given with host bits set is accepted and stored in canonical
 *     form (AWS does this itself: `100.68.0.18/18` becomes `100.68.0.0/18`),
 *     so host bits are *normalised*, never treated as an error.
 *
 * — Amazon VPC User Guide, "VPC CIDR blocks" and "Subnet CIDR blocks".
 */

/** Addresses AWS reserves in every subnet: the first four and the last. */
export const AWS_RESERVED_ADDRESSES_PER_SUBNET = 5;

/** Narrowest and widest IPv4 netmask AWS accepts for a VPC or a subnet. */
export const AWS_MIN_PREFIX_LENGTH = 16;
export const AWS_MAX_PREFIX_LENGTH = 28;

/** RFC 1918 private ranges, which the VPC guide recommends for a VPC. */
export const RFC_1918_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] as const;

/**
 * A parsed IPv4 CIDR block, normalised to its canonical network address.
 *
 * `network` and `broadcast` are unsigned 32-bit integers so containment and
 * overlap are integer comparisons rather than string work.
 */
export interface Ipv4Cidr {
  /** Canonical `a.b.c.d/p`, with host bits cleared. */
  readonly text: string;
  /** First address in the block, as an unsigned 32-bit integer. */
  readonly network: number;
  /** Last address in the block, as an unsigned 32-bit integer. */
  readonly broadcast: number;
  readonly prefixLength: number;
  /** Total addresses in the block, reserved ones included. */
  readonly addressCount: number;
  /** True when the input carried host bits that had to be cleared. */
  readonly normalised: boolean;
}

function toInt(octets: readonly number[]): number {
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0) >>> 0;
}

function toDotted(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

/** Mask for a prefix length. Written to avoid the `<< 32` identity shift. */
function maskFor(prefixLength: number): number {
  if (prefixLength === 0) return 0;
  return (0xffffffff << (32 - prefixLength)) >>> 0;
}

/**
 * Parse an IPv4 CIDR block, or return `null` if it is not one.
 *
 * Deliberately strict about the *syntax* — no leading zeros, no missing
 * prefix, no whitespace, no IPv6 — and deliberately forgiving about host
 * bits, which are cleared exactly as AWS clears them.
 */
export function parseIpv4Cidr(input: unknown): Ipv4Cidr | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text !== input.trim() || text.length === 0 || text.length > 18) return null;

  const slash = text.indexOf('/');
  if (slash === -1 || text.indexOf('/', slash + 1) !== -1) return null;

  const address = text.slice(0, slash);
  const prefix = text.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefix)) return null;
  const prefixLength = Number(prefix);
  if (prefixLength > 32) return null;

  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // `01` and `1_0` are not octets; a bare `\d+` check would accept the first.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }

  const raw = toInt(octets);
  const mask = maskFor(prefixLength);
  const network = (raw & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  return {
    text: `${toDotted(network)}/${prefixLength}`,
    network,
    broadcast,
    prefixLength,
    addressCount: 2 ** (32 - prefixLength),
    normalised: network !== raw,
  };
}

/** Does `outer` wholly contain `inner`? A block contains itself. */
export function cidrContains(outer: Ipv4Cidr, inner: Ipv4Cidr): boolean {
  return inner.network >= outer.network && inner.broadcast <= outer.broadcast;
}

/** Do these two blocks share any address at all? */
export function cidrsOverlap(a: Ipv4Cidr, b: Ipv4Cidr): boolean {
  return a.network <= b.broadcast && b.network <= a.broadcast;
}

/**
 * Addresses actually assignable in a subnet of this size.
 *
 * Five fewer than the block holds, per the VPC User Guide. A block smaller
 * than the five reserved addresses yields zero rather than a negative count.
 */
export function usableAddresses(cidr: Ipv4Cidr): number {
  return Math.max(0, cidr.addressCount - AWS_RESERVED_ADDRESSES_PER_SUBNET);
}

/** Is this block inside one of the RFC 1918 private ranges? */
export function isRfc1918(cidr: Ipv4Cidr): boolean {
  return RFC_1918_RANGES.some((range) => {
    const parsed = parseIpv4Cidr(range);
    return parsed !== null && cidrContains(parsed, cidr);
  });
}

/**
 * Addresses of `parent` that no block in `children` covers.
 *
 * Children are expected to be inside the parent and disjoint from each other;
 * both are checked separately, and anything outside the parent contributes
 * nothing here rather than making the total negative.
 */
export function freeAddresses(parent: Ipv4Cidr, children: readonly Ipv4Cidr[]): number {
  let used = 0;
  for (const child of children) {
    if (cidrContains(parent, child)) used += child.addressCount;
  }
  return Math.max(0, parent.addressCount - used);
}

/** The first pair of blocks that overlap, for a failure message that names them. */
export function firstOverlappingPair<T extends { cidr: Ipv4Cidr }>(
  entries: readonly T[],
): [T, T] | null {
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (cidrsOverlap(entries[i]!.cidr, entries[j]!.cidr)) return [entries[i]!, entries[j]!];
    }
  }
  return null;
}
