/**
 * IPv4 CIDR arithmetic for NetworkPolicy `ipBlock` rules.
 *
 * Why this exists rather than `ipBlock.except`: an egress rule of
 * `0.0.0.0/0 except <ranges>` is the obvious way to say "the internet, but not
 * these", and its enforcement is exactly the part of NetworkPolicy that CNIs
 * have historically disagreed about. A plain `cidr` allow is the one form every
 * enforcing implementation handles, so the platform computes the complement
 * itself and emits only plain entries. A unit test pins that no `except` is
 * ever generated.
 *
 * IPv4 only. The policies allow no IPv6 destination at all, which on a
 * dual-stack cluster means IPv6 egress stays denied — the safe direction.
 */

const IPV4_SPACE = 2 ** 32;

export class CidrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CidrError';
  }
}

/** Inclusive range of addresses as unsigned integers. */
export interface Ipv4Range {
  start: number;
  end: number;
}

/**
 * IPv4 space that is not globally reachable (IANA special-purpose registry).
 *
 * "External egress" means the public internet. Everything here is either a
 * private network — where the platform's own infrastructure lives: the node
 * network, the application tier, a cloud VPC — or link-local (instance
 * metadata), loopback, multicast, documentation or reserved space. None of it
 * is something a lab reaches "on the internet".
 */
export const NON_PUBLIC_IPV4_CIDRS: readonly string[] = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // RFC 1918
  '100.64.0.0/10', // carrier-grade NAT (RFC 6598)
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, including 169.254.169.254 instance metadata
  '172.16.0.0/12', // RFC 1918
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast (deprecated)
  '192.168.0.0/16', // RFC 1918
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, including 255.255.255.255
];

export function parseIpv4Address(text: string): number {
  const parts = text.split('.');
  if (parts.length !== 4) throw new CidrError(`'${text}' is not an IPv4 address`);
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) {
      throw new CidrError(`'${text}' is not an IPv4 address`);
    }
    value = value * 256 + Number(part);
  }
  return value;
}

export function formatIpv4Address(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

/**
 * Parse `a.b.c.d/n`. Host bits must be zero: `10.244.1.7/16` is refused rather
 * than silently widened, because a mistyped range in a security policy should
 * fail at startup, not quietly mean something else.
 */
export function parseIpv4Cidr(cidr: string): Ipv4Range {
  const match = /^([^/]+)\/(\d{1,2})$/.exec(cidr.trim());
  if (!match) throw new CidrError(`'${cidr}' is not an IPv4 CIDR (expected a.b.c.d/n)`);
  const prefix = Number(match[2]);
  if (prefix > 32) throw new CidrError(`'${cidr}' has a prefix longer than /32`);
  const address = parseIpv4Address(match[1]!);
  const size = 2 ** (32 - prefix);
  if (address % size !== 0) {
    throw new CidrError(
      `'${cidr}' has host bits set; did you mean ${formatIpv4Address(address - (address % size))}/${prefix}?`,
    );
  }
  return { start: address, end: address + size - 1 };
}

/** Sort and merge overlapping or adjacent ranges. */
function mergeRanges(ranges: readonly Ipv4Range[]): Ipv4Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Ipv4Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** The fewest CIDR blocks covering exactly `[start, end]`. */
export function rangeToCidrs(range: Ipv4Range): string[] {
  const cidrs: string[] = [];
  let start = range.start;
  while (start <= range.end) {
    // Largest block aligned at `start` that does not run past `end`.
    let size = start === 0 ? IPV4_SPACE : 2 ** Math.min(32, trailingZeroBits(start));
    while (start + size - 1 > range.end) size /= 2;
    cidrs.push(`${formatIpv4Address(start)}/${32 - Math.log2(size)}`);
    start += size;
  }
  return cidrs;
}

function trailingZeroBits(value: number): number {
  let bits = 0;
  while (bits < 32 && value % 2 ** (bits + 1) === 0) bits += 1;
  return bits;
}

/**
 * Every IPv4 address *not* in `denied`, as plain CIDR blocks.
 *
 * The result never overlaps a denied range, and together with `denied` it
 * covers the whole space — both properties are asserted in the unit tests.
 */
export function ipv4Complement(denied: readonly string[]): string[] {
  const merged = mergeRanges(denied.map(parseIpv4Cidr));
  const allowed: string[] = [];
  let next = 0;
  for (const range of merged) {
    if (range.start > next) allowed.push(...rangeToCidrs({ start: next, end: range.start - 1 }));
    next = range.end + 1;
  }
  if (next <= IPV4_SPACE - 1) allowed.push(...rangeToCidrs({ start: next, end: IPV4_SPACE - 1 }));
  return allowed;
}

export function ipv4CidrContains(cidr: string, address: string): boolean {
  const range = parseIpv4Cidr(cidr);
  const value = parseIpv4Address(address);
  return value >= range.start && value <= range.end;
}
