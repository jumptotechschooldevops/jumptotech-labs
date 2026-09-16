/**
 * N9 — the probe vocabulary, and the boundary it exists to hold.
 *
 * `docker_exec_probe` is the only Docker check that runs anything, so the
 * question this file answers is not "does it work" but "can it be turned into
 * `docker exec`". It cannot, and the reason is structural rather than
 * defensive: a lab has no field that carries an executable, a flag, or an argv
 * position. It names a probe kind from a closed set and supplies operands that
 * trusted code places itself.
 *
 * These tests are written as attempts to break that.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_PROBES,
  MAX_PROBE_TIMEOUT_SECONDS,
  MIN_PROBE_TIMEOUT_SECONDS,
  ProbeError,
  assertContainerProbe,
  linkListingHasInterface,
  probeArgv,
  addressesForInterface,
  interfaceAddressInRange,
  probeTimeoutMs,
  requirementSchema,
  type ContainerProbe,
} from '../src/index.js';

const dns: ContainerProbe = { kind: 'dns_lookup', host: 'ledger-api' };
const tcp: ContainerProbe = { kind: 'tcp_connect', host: '10.0.0.5', port: 8080, timeoutSeconds: 3 };
const http: ContainerProbe = {
  kind: 'http_get',
  host: 'ledger-api',
  port: 80,
  path: '/health',
  timeoutSeconds: 5,
};
const iface: ContainerProbe = { kind: 'interface_exists', interface: 'eth0' };
const addr: ContainerProbe = { kind: 'address_in_range', interface: 'eth0', cidr: '10.77.0.128/26' };

// ------------------------------------------------------- 1. the vocabulary

describe('the probe vocabulary is closed', () => {
  it('names exactly the questions the platform performs', () => {
    // Stated as a literal on purpose. Adding a probe kind means adding an
    // executable a lab can cause to run inside a container, which is a security
    // review, not a refactor — so it should require editing this line.
    expect([...CONTAINER_PROBES]).toEqual([
      'dns_lookup',
      'tcp_connect',
      'http_get',
      'interface_exists',
      'address_in_range',
    ]);
  });

  it('refuses a kind it does not know, rather than defaulting to one', () => {
    for (const kind of ['exec', 'shell', 'sh', 'bash', 'docker', '', 'DNS_LOOKUP', 'dns_lookup ']) {
      expect(() => assertContainerProbe({ kind, host: 'x' }), kind).toThrow(ProbeError);
    }
  });

  it('refuses a probe that is not an object at all', () => {
    for (const value of [null, undefined, 'dns_lookup', 42, [], true]) {
      expect(() => assertContainerProbe(value)).toThrow(ProbeError);
    }
  });
});

// ----------------------------------------------------------- 2. the argv

describe('the argv is built here, never supplied', () => {
  it('produces the command each probe means', () => {
    expect(probeArgv(dns)).toEqual(['nslookup', 'ledger-api']);
    expect(probeArgv(tcp)).toEqual(['nc', '-z', '-w', '3', '10.0.0.5', '8080']);
    expect(probeArgv(http)).toEqual([
      'wget',
      '-q',
      '-O',
      '/dev/null',
      '-T',
      '5',
      'http://ledger-api:80/health',
    ]);
    // The interface name is parsed out of the listing, never passed to `ip`.
    expect(probeArgv(iface)).toEqual(['ip', '-o', 'link', 'show']);
    expect(probeArgv(iface)).not.toContain('eth0');
    // Same for the address probe: neither operand reaches the binary.
    expect(probeArgv(addr)).toEqual(['ip', '-o', 'addr', 'show']);
    expect(probeArgv(addr)).not.toContain('eth0');
    expect(probeArgv(addr)).not.toContain('10.77.0.128/26');
  });

  it('draws every executable from a set a lab cannot influence', () => {
    const executables = new Set(
      ([dns, tcp, http, iface, addr] as ContainerProbe[]).map((p) => probeArgv(p)[0]),
    );
    expect([...executables].sort()).toEqual(['ip', 'nc', 'nslookup', 'wget']);
    // None of them is a shell, and none of them is the Docker CLI.
    for (const executable of executables) {
      expect(['sh', 'bash', 'ash', 'zsh', 'docker', 'env', 'busybox']).not.toContain(executable);
    }
  });

  it('never emits an argv element that a shell would treat as syntax', () => {
    // There is no shell in the path — `docker exec` passes the array to
    // `execve` — but an argv that *could* be a command line is a latent bug for
    // whoever logs or re-executes it, so the property is asserted directly.
    const probes: ContainerProbe[] = [
      dns,
      tcp,
      http,
      iface,
      { kind: 'dns_lookup', host: 'a-b.c_d' },
      { kind: 'http_get', host: '10.0.0.1', port: 65535, path: '/a/b~c-d._e', timeoutSeconds: 1 },
    ];
    for (const probe of probes) {
      for (const argument of probeArgv(probe)) {
        expect(argument, argument).not.toMatch(/[;&|`$(){}<>*?\\'"\s\n]/);
      }
    }
  });

  it("bounds the exec beyond the binary's own timeout, so a verdict is not lost to a kill", () => {
    expect(probeTimeoutMs(tcp)).toBe(5_000);
    expect(probeTimeoutMs(http)).toBe(7_000);
    // Probes with no timeout operand still get a bounded exec.
    expect(probeTimeoutMs(dns)).toBeGreaterThan(0);
    expect(probeTimeoutMs(iface)).toBeGreaterThan(0);
    expect(
      probeTimeoutMs({ ...tcp, timeoutSeconds: MAX_PROBE_TIMEOUT_SECONDS }),
    ).toBeLessThanOrEqual((MAX_PROBE_TIMEOUT_SECONDS + 2) * 1000);
  });
});

// ------------------------------------------------- 3. hostile operand values

describe('a hostile operand cannot become a flag, a path or an authority', () => {
  it.each([
    ['a leading dash, which a binary would read as a flag', '-e'],
    ['a long option', '--output-document=/etc/passwd'],
    ['a slash, which would re-point a URL', 'evil.com/x'],
    ['a colon, which would change the port', 'host:1234'],
    ['an at sign, which would become userinfo', 'user@evil.com'],
    ['a space', 'host name'],
    ['command chaining', 'host;id'],
    ['command substitution', '$(id)'],
    ['backticks', '`id`'],
    ['a pipe', 'host|id'],
    ['a newline', 'host\nid'],
    ['a NUL byte', `host${String.fromCharCode(0)}id`],
    ['a percent, which is an IPv6 scope', 'fe80::1%eth0'],
    ['a query string', 'host?a=b'],
    ['an empty value', ''],
  ])('refuses %s as a host', (_name, host) => {
    expect(() => assertContainerProbe({ kind: 'dns_lookup', host })).toThrow(ProbeError);
  });

  it.each([
    ['no leading slash', 'health'],
    ['parent traversal', '/../../etc/passwd'],
    ['a protocol-relative path, which changes the authority', '//evil.com/'],
    ['a query string', '/health?x=1'],
    ['a fragment', '/health#x'],
    ['an at sign', '/health@evil.com'],
    ['a space', '/health x'],
    ['command substitution', '/$(id)'],
  ])('refuses %s as an http_get path', (_name, path) => {
    expect(() =>
      assertContainerProbe({ kind: 'http_get', host: 'h', port: 80, path, timeoutSeconds: 1 }),
    ).toThrow(ProbeError);
  });

  it.each([
    ['a leading dash', '-j'],
    ['a space', 'eth 0'],
    ['a slash', 'eth0/x'],
    ['over-long', 'a'.repeat(16)],
    ['command substitution', '$(id)'],
  ])('refuses %s as an interface name', (_name, name) => {
    expect(() => assertContainerProbe({ kind: 'interface_exists', interface: name })).toThrow(
      ProbeError,
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['above the port range', 65_536],
    ['fractional', 8080.5],
    ['not a number', '8080'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s as a port', (_name, port) => {
    expect(() =>
      assertContainerProbe({ kind: 'tcp_connect', host: 'h', port, timeoutSeconds: 1 }),
    ).toThrow(ProbeError);
  });

  it.each([
    ['zero, which would mean no bound at all', 0],
    ['negative', -5],
    ['beyond the ceiling', MAX_PROBE_TIMEOUT_SECONDS + 1],
    ['fractional', 1.5],
    ['not a number', '5'],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s as a timeout', (_name, timeoutSeconds) => {
    expect(() =>
      assertContainerProbe({ kind: 'tcp_connect', host: 'h', port: 80, timeoutSeconds }),
    ).toThrow(ProbeError);
  });

  it('accepts the bounds themselves', () => {
    for (const timeoutSeconds of [MIN_PROBE_TIMEOUT_SECONDS, MAX_PROBE_TIMEOUT_SECONDS]) {
      expect(() =>
        assertContainerProbe({ kind: 'tcp_connect', host: 'h', port: 80, timeoutSeconds }),
      ).not.toThrow();
    }
  });

  it('returns a fresh object, so a hostile key cannot ride along', () => {
    // `JSON.parse` makes `__proto__` an inert own property rather than
    // polluting anything, but the property that matters here is stronger and
    // is the reason `assertContainerProbe` rebuilds instead of casting: what it
    // returns carries only the keys it validated, so nothing else reaches
    // `probeArgv` or the broker even in principle.
    const hostile = JSON.parse(
      '{"kind":"dns_lookup","host":"a","__proto__":{"kind":"exec","host":"pwned"}}',
    );
    const probe = assertContainerProbe(hostile);

    expect(Object.keys(probe)).toEqual(['kind', 'host']);
    expect(probeArgv(probe)).toEqual(['nslookup', 'a']);
    // And nothing was polluted on the way through.
    expect((Object.prototype as Record<string, unknown>).kind).toBeUndefined();
    expect(({} as Record<string, unknown>).kind).toBeUndefined();
  });

  it('ignores operands a probe does not take, rather than smuggling them into the argv', () => {
    // The requirement schema refuses a stray operand outright. This is the
    // second line: even if one reached here, it contributes nothing, because
    // `probeArgv` reads only the fields its own branch names.
    const smuggled = assertContainerProbe({
      kind: 'dns_lookup',
      host: 'ledger-api',
      path: '/etc/passwd',
      port: 22,
      interface: 'eth0',
      argv: ['sh', '-c', 'id'],
      command: 'id',
    } as unknown);

    expect(probeArgv(smuggled)).toEqual(['nslookup', 'ledger-api']);
  });
});

// --------------------------------------------------- 4. parsing a link listing

describe('an interface is matched on the name field, not anywhere in the line', () => {
  // Real `ip -o link show` output, from alpine on a user-defined bridge.
  const listing = [
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN \\    link/loopback 00:00:00:00:00:00',
    '2: tunl0@NONE: <NOARP> mtu 1480 qdisc noop state DOWN \\    link/ipip 0.0.0.0',
    '14: eth0@if15: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP \\    link/ether 02:42:ac:13:00:02',
  ].join('\n');

  it('finds an interface that is there, including a veth with a peer suffix', () => {
    expect(linkListingHasInterface(listing, 'lo')).toBe(true);
    expect(linkListingHasInterface(listing, 'eth0')).toBe(true);
    expect(linkListingHasInterface(listing, 'tunl0')).toBe(true);
  });

  it('does not report one that is absent', () => {
    expect(linkListingHasInterface(listing, 'eth1')).toBe(false);
    // Not a prefix match: `eth0` must not answer for `eth`, nor `eth` for `eth0`.
    expect(linkListingHasInterface(listing, 'eth')).toBe(false);
    expect(linkListingHasInterface('', 'eth0')).toBe(false);
  });

  it('does not match a name that only appears elsewhere in the line', () => {
    // A veth's `master br-x` names another interface; a bridge member's line
    // mentions its master. Matching anywhere in the line would report a bridge
    // as present inside a container that merely names it.
    const member =
      '15: veth7ed@if14: <BROADCAST,UP> mtu 1500 master br-6c30 state UP \\    link/ether fa:b7:a6:65:0a:12';
    expect(linkListingHasInterface(member, 'veth7ed')).toBe(true);
    expect(linkListingHasInterface(member, 'br-6c30')).toBe(false);
  });

  it('is not fooled by a line a student could print themselves', () => {
    // The listing comes from a process in a container the student controls, so
    // the parser must at least require the shape `ip -o` produces rather than
    // accepting any line that contains the name.
    expect(linkListingHasInterface('eth0', 'eth0')).toBe(false);
    expect(linkListingHasInterface('eth0: up', 'eth0')).toBe(false);
    expect(linkListingHasInterface('totally eth0: <UP>', 'eth0')).toBe(false);
  });
});

// ------------------------------------------- 5. the requirement schema

describe('a lab definition cannot ask for a probe it did not fully specify', () => {
  const base = { type: 'docker_exec_probe', container: 'ledger-worker', label: 'l' };
  const parse = (raw: Record<string, unknown>) => () => requirementSchema.parse({ ...base, ...raw });

  it('accepts each probe with exactly its own operands', () => {
    expect(parse({ probe: 'dns_lookup', host: 'ledger-api' })).not.toThrow();
    expect(parse({ probe: 'tcp_connect', host: 'ledger-api', port: 8080 })).not.toThrow();
    expect(parse({ probe: 'http_get', host: 'h', port: 80, path: '/health' })).not.toThrow();
    expect(parse({ probe: 'interface_exists', interface: 'eth0' })).not.toThrow();
  });

  it('defaults the expectation to success and the timeout to a bounded value', () => {
    const parsed = requirementSchema.parse({
      ...base,
      probe: 'dns_lookup',
      host: 'ledger-api',
    }) as { expect: string; timeout_seconds: number };

    expect(parsed.expect).toBe('success');
    expect(parsed.timeout_seconds).toBeGreaterThanOrEqual(MIN_PROBE_TIMEOUT_SECONDS);
    expect(parsed.timeout_seconds).toBeLessThanOrEqual(MAX_PROBE_TIMEOUT_SECONDS);
  });

  it.each([
    ['dns_lookup with no host', { probe: 'dns_lookup' }],
    ['tcp_connect with no port', { probe: 'tcp_connect', host: 'h' }],
    ['tcp_connect with no host', { probe: 'tcp_connect', port: 80 }],
    ['http_get with no path', { probe: 'http_get', host: 'h', port: 80 }],
    ['interface_exists with no interface', { probe: 'interface_exists' }],
  ])('refuses %s', (_name, raw) => {
    expect(parse(raw)).toThrow();
  });

  it.each([
    ['a path on a tcp_connect', { probe: 'tcp_connect', host: 'h', port: 80, path: '/x' }],
    ['a port on a dns_lookup', { probe: 'dns_lookup', host: 'h', port: 80 }],
    ['an interface on an http_get', { probe: 'http_get', host: 'h', port: 80, path: '/', interface: 'eth0' }],
    ['a host on an interface_exists', { probe: 'interface_exists', interface: 'eth0', host: 'h' }],
  ])('refuses %s, so a lab cannot believe it grades something it does not', (_name, raw) => {
    expect(parse(raw)).toThrow();
  });

  it('refuses an unknown probe kind', () => {
    expect(parse({ probe: 'exec', host: 'h' })).toThrow();
    expect(parse({ probe: 'shell', host: 'h' })).toThrow();
  });

  it('offers no field that could carry a command, an argv or a shell', () => {
    for (const smuggled of [
      { command: 'sh' },
      { argv: ['sh', '-c', 'id'] },
      { args: ['-c', 'id'] },
      { shell: 'id' },
      { entrypoint: 'sh' },
      { user: 'root' },
      { exec: 'id' },
    ]) {
      // `.strict()` refuses an unknown key outright, which is what stops a lab
      // smuggling an executable in beside a probe that looks innocuous.
      expect(parse({ probe: 'dns_lookup', host: 'h', ...smuggled }), JSON.stringify(smuggled)).toThrow();
    }
  });

  it('refuses a container name that is not a Docker object name', () => {
    for (const container of ['-rm', 'a b', 'a;id', '$(id)', '../etc', 'a|b', '']) {
      expect(
        () => requirementSchema.parse({ ...base, container, probe: 'dns_lookup', host: 'h' }),
        container,
      ).toThrow();
    }
  });

  it('refuses a timeout outside the platform bounds', () => {
    expect(parse({ probe: 'dns_lookup', host: 'h', timeout_seconds: 0 })).toThrow();
    expect(
      parse({ probe: 'dns_lookup', host: 'h', timeout_seconds: MAX_PROBE_TIMEOUT_SECONDS + 1 }),
    ).toThrow();
  });
});

// ------------------------------------------- 6. the address probe

describe('address_in_range compares, and never executes, its range', () => {
  // Real `ip -o addr show` output, from BusyBox on a user-defined network.
  const LISTING = [
    '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
    '22: eth0    inet 10.77.0.137/24 brd 10.77.0.255 scope global eth0\\       valid_lft forever',
  ].join('\n');

  it('reads the addresses of the interface it was asked about', () => {
    expect(addressesForInterface(LISTING, 'eth0')).toEqual(['10.77.0.137']);
    expect(addressesForInterface(LISTING, 'lo')).toEqual(['127.0.0.1']);
    expect(addressesForInterface(LISTING, 'eth1')).toEqual([]);
  });

  it('does not let one interface answer for another', () => {
    // `eth0` appears twice on its own line; a loose match would report it for
    // any query that happened to be a substring.
    expect(addressesForInterface(LISTING, 'eth')).toEqual([]);
    expect(addressesForInterface(LISTING, 'th0')).toEqual([]);
  });

  it('ignores inet6, which is a family this probe does not claim', () => {
    const v6 = '22: eth0    inet6 fe80::42:acff:fe13:3/64 scope link\\       valid_lft forever';
    expect(addressesForInterface(v6, 'eth0')).toEqual([]);
  });

  it('decides containment from the range, not from a prefix string match', () => {
    expect(interfaceAddressInRange(LISTING, 'eth0', '10.77.0.128/26')).toBe(true);
    // .137 is in .128/26 (.128-.191) and not in .64/26 (.64-.127), which a
    // string comparison on "10.77.0.1" would get wrong.
    expect(interfaceAddressInRange(LISTING, 'eth0', '10.77.0.64/26')).toBe(false);
    expect(interfaceAddressInRange(LISTING, 'eth0', '10.77.0.0/24')).toBe(true);
    expect(interfaceAddressInRange(LISTING, 'eth0', '10.78.0.0/16')).toBe(false);
  });

  it('is false when the interface has no address at all', () => {
    expect(interfaceAddressInRange('1: lo    inet 127.0.0.1/8 scope host lo', 'eth0', '10.0.0.0/8')).toBe(
      false,
    );
    expect(interfaceAddressInRange('', 'eth0', '10.0.0.0/8')).toBe(false);
  });

  it.each([
    ['no prefix', '10.77.0.128'],
    ['a prefix above 32', '10.77.0.128/33'],
    ['an octet above 255', '10.77.0.300/24'],
    ['a leading-zero octet', '10.77.0.01/24'],
    ['an IPv6 range', 'fe80::/64'],
    ['a hostname', 'ledger-api/24'],
    ['command substitution', '$(id)/24'],
    ['a space', '10.77.0.128 /26'],
    ['two slashes', '10.77.0.128//26'],
  ])('refuses %s as a range', (_name, cidr) => {
    expect(() =>
      assertContainerProbe({ kind: 'address_in_range', interface: 'eth0', cidr }),
    ).toThrow(ProbeError);
  });

  it('is refused by the schema without both of its operands', () => {
    const base = { type: 'docker_exec_probe', container: 'c', label: 'l', probe: 'address_in_range' };
    expect(() => requirementSchema.parse({ ...base, interface: 'eth0' })).toThrow();
    expect(() => requirementSchema.parse({ ...base, cidr: '10.0.0.0/8' })).toThrow();
    expect(() =>
      requirementSchema.parse({ ...base, interface: 'eth0', cidr: '10.0.0.0/8' }),
    ).not.toThrow();
    // And a `cidr` on a probe that does not take one is refused, so a lab
    // cannot believe it grades a range when it grades presence.
    expect(() =>
      requirementSchema.parse({
        type: 'docker_exec_probe',
        container: 'c',
        label: 'l',
        probe: 'interface_exists',
        interface: 'eth0',
        cidr: '10.0.0.0/8',
      }),
    ).toThrow();
  });
});
