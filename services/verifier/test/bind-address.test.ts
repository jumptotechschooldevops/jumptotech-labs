/**
 * `port_listening` / `port_not_listening` — the bind-address extension.
 *
 * The single most common real networking bug is a service bound to
 * `127.0.0.1` that everyone assumes is bound to `0.0.0.0`, and until now the
 * platform could not tell the two apart: the check took a port and a protocol
 * and nothing else. This is that gap closed, as an optional field on the
 * primitive that already exists rather than a second one beside it.
 *
 * Semantics settled here, and asserted rather than described:
 *
 *   · **Omitted `address` means what it always meant.** Something is listening
 *     on the port, wherever it is bound. Every lab that shipped before this
 *     field existed is unaffected, which section 1 pins.
 *   · **The check grades the socket, not the process.** Any process binding the
 *     required address and port satisfies it. A lab that cares which program is
 *     running has `process_running` for that, and conflating the two would make
 *     this check fail correct work.
 *   · **`0.0.0.0` and `::` are different bindings.** With
 *     `net.ipv6.bindv6only=0` — the Linux default — an IPv6 wildcard socket
 *     also serves IPv4, so in *effect* they often coincide. This check grades
 *     what a socket is bound to, not what it happens to be reachable over, so a
 *     lab that accepts either says so by naming both.
 *   · **Spelling is not identity.** `[::1]` and `::1` are the same address, and
 *     `*` is how `ss` prints the IPv6 any-address socket on Linux — all three
 *     normalise before comparison.
 *
 * The observed values here are the forms a real `ss -H -lntu` printed inside
 * the sandbox image, including the `*` for an IPv6 wildcard, which is not the
 * `[::]` one might expect.
 */
import { describe, expect, it } from 'vitest';
import {
  LabDefinitionError,
  parseLabDefinition,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { normaliseBindAddress } from '../src/sandbox-reader.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

type Socket = NonNullable<FakeWorld['listening']>[number];

function labWith(requirement: string): LoadedLabDefinition {
  const yaml = `
id: NET-903
slug: net-903-probe
title: Bind probe
track: networking
topic: sockets
difficulty: beginner
duration_minutes: 10
environment:
  provider: linux
task:
  summary: s
  description: d
requirements:
${requirement}
references:
  - title: RFC 1122
    url: https://www.rfc-editor.org/rfc/rfc1122.html
skills:
  - net.l4.ports
`;
  return {
    ...parseLabDefinition(yaml),
    directory: '/labs/net-903',
    sourcePath: '/labs/net-903/lab.yaml',
  };
}

function box(listening: Socket[], files: FakeWorld['files'] = {}): FakeSandbox {
  return new FakeSandbox({ listening, files });
}

async function verify(requirement: string, listening: Socket[], files?: FakeWorld['files']) {
  return verifyLab({
    lab: labWith(requirement),
    sandbox: box(listening, files),
    namespace: 'jtt-lab-000000000001',
  });
}

const passed = (r: { passed: boolean }) => r.passed;
const detailOf = (r: { checks: Array<{ status: string; detail?: string }> }) =>
  r.checks.find((c) => c.status !== 'pass')?.detail;

const LOOPBACK = `  - type: port_listening
    port: 8080
    address: 127.0.0.1
    label: The service is bound to loopback
`;
const ALL_INTERFACES = `  - type: port_listening
    port: 8080
    address: [0.0.0.0, "::"]
    label: The service is reachable off this host
`;
const ANY_BINDING = `  - type: port_listening
    port: 8080
    label: Something is listening on 8080
`;

// ------------------------------------------------ 1. the default is unchanged

describe('a check that names no address behaves exactly as before', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['the IPv4 wildcard', '0.0.0.0'],
    ['a specific interface address', '10.90.0.10'],
    ['the IPv6 wildcard as ss prints it', '*'],
    ['IPv6 loopback', '[::1]'],
  ])('passes for a listener on %s', async (_name, address) => {
    const result = await verify(ANY_BINDING, [{ protocol: 'tcp', port: 8080, address }]);
    expect(passed(result)).toBe(true);
  });

  it('still fails when nothing is listening at all', async () => {
    const result = await verify(ANY_BINDING, []);
    expect(passed(result)).toBe(false);
    expect(detailOf(result)).toBe('Nothing is listening on tcp port 8080');
  });
});

// ------------------------------------------------------- 2. the distinction

describe('a check that names an address grades the binding', () => {
  it('passes on the exact binding required', async () => {
    const result = await verify(LOOPBACK, [{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }]);
    expect(passed(result)).toBe(true);
  });

  it('fails a wildcard listener when loopback was required', async () => {
    const result = await verify(LOOPBACK, [{ protocol: 'tcp', port: 8080, address: '0.0.0.0' }]);
    expect(passed(result)).toBe(false);
    expect(detailOf(result)).toBe('TCP port 8080 is not listening on 127.0.0.1');
  });

  it('fails a loopback listener when all interfaces were required', async () => {
    const result = await verify(ALL_INTERFACES, [
      { protocol: 'tcp', port: 8080, address: '127.0.0.1' },
    ]);
    expect(passed(result)).toBe(false);
    expect(detailOf(result)).toBe('TCP port 8080 is not listening on 0.0.0.0 or ::');
  });

  it('fails when the right address is bound on the wrong port', async () => {
    const result = await verify(LOOPBACK, [{ protocol: 'tcp', port: 9090, address: '127.0.0.1' }]);
    expect(passed(result)).toBe(false);
    expect(detailOf(result)).toBe('Nothing is listening on tcp port 8080');
  });

  it('fails when nothing is listening on the port at all', async () => {
    const result = await verify(LOOPBACK, []);
    expect(passed(result)).toBe(false);
  });

  it('does not confuse a UDP socket with a TCP one on the same port', async () => {
    const result = await verify(LOOPBACK, [{ protocol: 'udp', port: 8080, address: '127.0.0.1' }]);
    expect(passed(result)).toBe(false);
  });

  it('accepts a specific interface address when that is what the lab named', async () => {
    const onInterface = `  - type: port_listening
    port: 8080
    address: 10.90.0.10
    label: bound to the segment address
`;
    expect(
      passed(await verify(onInterface, [{ protocol: 'tcp', port: 8080, address: '10.90.0.10' }])),
    ).toBe(true);
    expect(
      passed(await verify(onInterface, [{ protocol: 'tcp', port: 8080, address: '0.0.0.0' }])),
    ).toBe(false);
  });
});

// ------------------------------------------------------------- 3. IPv6

describe('IPv6 bindings follow the documented rules', () => {
  it('treats `*` as the IPv6 wildcard, because that is how ss prints it', () => {
    expect(normaliseBindAddress('*')).toBe('::');
  });

  it('treats brackets as presentation, not identity', () => {
    expect(normaliseBindAddress('[::1]')).toBe('::1');
    expect(normaliseBindAddress('[::]')).toBe('::');
    expect(normaliseBindAddress('::1')).toBe('::1');
  });

  it('accepts an IPv6 wildcard listener for a check that names either wildcard', async () => {
    const result = await verify(ALL_INTERFACES, [{ protocol: 'tcp', port: 8080, address: '*' }]);
    expect(passed(result)).toBe(true);
  });

  it('does not let an IPv6 wildcard satisfy a check that named only the IPv4 one', async () => {
    // Deliberate. With bindv6only=0 that socket does serve IPv4, but it is not
    // bound to 0.0.0.0, and this check grades the binding.
    const ipv4Only = `  - type: port_listening
    port: 8080
    address: 0.0.0.0
    label: bound to the IPv4 wildcard
`;
    const result = await verify(ipv4Only, [{ protocol: 'tcp', port: 8080, address: '*' }]);
    expect(passed(result)).toBe(false);
  });

  it('matches IPv6 loopback however the lab spells it', async () => {
    for (const spelling of ['::1', '[::1]']) {
      const requirement = `  - type: port_listening
    port: 8080
    address: "${spelling}"
    label: bound to IPv6 loopback
`;
      const result = await verify(requirement, [
        { protocol: 'tcp', port: 8080, address: '[::1]' },
      ]);
      expect(passed(result), `spelling ${spelling}`).toBe(true);
    }
  });

  it('does not confuse IPv6 loopback with IPv4 loopback', async () => {
    const result = await verify(LOOPBACK, [{ protocol: 'tcp', port: 8080, address: '[::1]' }]);
    expect(passed(result)).toBe(false);
  });
});

// -------------------------------------------- 4. the socket, not the process

describe('the check grades the socket rather than the process', () => {
  it('passes whichever program bound the address', async () => {
    // Documented decision: the requirement is about reachability, and a lab
    // that cares which program is running says so with `process_running`.
    // Tying this check to a process would fail a student who reimplemented the
    // service correctly, which is not the thing being graded.
    const result = await verify(LOOPBACK, [{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }]);
    expect(passed(result)).toBe(true);
  });

  it('passes when several sockets share the port and one matches', async () => {
    // A dual-stack service is two rows in the table; one of them matching is
    // the binding the lab asked for.
    const result = await verify(LOOPBACK, [
      { protocol: 'tcp', port: 8080, address: '[::1]' },
      { protocol: 'tcp', port: 8080, address: '127.0.0.1' },
    ]);
    expect(passed(result)).toBe(true);
  });
});

// ------------------------------------------------------ 5. absence, narrowed

describe('port_not_listening can be narrowed to one binding', () => {
  const notLoopback = `  - type: port_not_listening
    port: 8080
    address: 127.0.0.1
    label: nothing is bound to loopback
`;

  it('passes when the service has moved off loopback', async () => {
    const result = await verify(notLoopback, [
      { protocol: 'tcp', port: 8080, address: '0.0.0.0' },
    ]);
    expect(passed(result)).toBe(true);
  });

  it('fails while the service is still on loopback', async () => {
    const result = await verify(notLoopback, [
      { protocol: 'tcp', port: 8080, address: '127.0.0.1' },
    ]);
    expect(passed(result)).toBe(false);
    expect(detailOf(result)).toBe('TCP port 8080 is still listening on 127.0.0.1');
  });

  it('without an address, still means nothing at all is listening', async () => {
    const nothing = `  - type: port_not_listening
    port: 8080
    label: nothing at all
`;
    expect(passed(await verify(nothing, []))).toBe(true);
    expect(
      passed(await verify(nothing, [{ protocol: 'tcp', port: 8080, address: '0.0.0.0' }])),
    ).toBe(false);
  });
});

// ------------------------------------------------------- 6. cannot be faked

describe('the check reads the socket table and nothing else', () => {
  it('ignores a file the student wrote that says the port is bound', async () => {
    const sandbox = box([], {
      '/home/student/evidence.txt': {
        type: 'file',
        content: 'LISTEN 0 128 127.0.0.1:8080 0.0.0.0:*\n',
      },
      '/home/student/ss-output.txt': {
        type: 'file',
        content: 'tcp LISTEN 0 5 127.0.0.1:8080\n',
      },
      '/home/student/.bash_history': { type: 'file', content: 'ss -ltn\n' },
    });

    const result = await verifyLab({
      lab: labWith(LOOPBACK),
      sandbox,
      namespace: 'jtt-lab-000000000001',
    });

    expect(passed(result)).toBe(false);
    // The graded read never touched the student's files.
    expect(sandbox.reads).toEqual([]);
    expect(sandbox.inspections).toEqual(['ss -H -lntu']);
  });

  it('cannot be redirected: the argv belongs to the verifier', async () => {
    const sandbox = box([{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }]);
    await verifyLab({ lab: labWith(LOOPBACK), sandbox, namespace: 'jtt-lab-000000000001' });

    // One fixed inspection, with no lab operand anywhere in it.
    expect(sandbox.inspections).toEqual(['ss -H -lntu']);
  });

  it('reports only the property the lab asked about', async () => {
    // A failure must not become a listing of everything else on the host.
    const result = await verify(LOOPBACK, [
      { protocol: 'tcp', port: 8080, address: '0.0.0.0' },
      { protocol: 'tcp', port: 22, address: '0.0.0.0' },
      { protocol: 'udp', port: 53, address: '127.0.0.11' },
    ]);

    const detail = detailOf(result) ?? '';
    expect(detail).toBe('TCP port 8080 is not listening on 127.0.0.1');
    expect(detail).not.toContain('22');
    expect(detail).not.toContain('53');
    expect(detail).not.toContain('127.0.0.11');
  });
});

// ------------------------------------------------------------ 7. isolation

describe('one session cannot satisfy another', () => {
  it('reads each session through its own sandbox', async () => {
    const solved = box([{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }]);
    const untouched = box([]);

    const b = await verifyLab({ lab: labWith(LOOPBACK), sandbox: solved, namespace: 'jtt-lab-000000000002' });
    const a = await verifyLab({ lab: labWith(LOOPBACK), sandbox: untouched, namespace: 'jtt-lab-000000000001' });

    expect(passed(b)).toBe(true);
    expect(passed(a)).toBe(false);
  });

  it('cannot inherit a pass from a previous session on the same port', async () => {
    // Two sessions of the same lab use the same port by design. The verdict
    // comes from the socket table of the sandbox handed in, never from a port
    // number looked up somewhere global.
    const before = await verify(LOOPBACK, [{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }]);
    expect(passed(before)).toBe(true);

    const fresh = await verify(LOOPBACK, []);
    expect(passed(fresh)).toBe(false);
  });
});

// ------------------------------------------------------------- 8. the schema

describe('the address a lab may name', () => {
  it.each([
    ['a shell fragment', '127.0.0.1; id'],
    ['a hostname', 'localhost'],
    ['a CIDR block', '127.0.0.0/8'],
    ['an address with a port', '127.0.0.1:8080'],
    ['an empty string', '""'],
  ])('refuses %s', (_name, address) => {
    const requirement = `  - type: port_listening
    port: 8080
    address: "${address}"
    label: l
`;
    expect(() => labWith(requirement)).toThrow(LabDefinitionError);
  });

  it('refuses an empty list', () => {
    expect(() =>
      labWith(`  - type: port_listening
    port: 8080
    address: []
    label: l
`),
    ).toThrow(LabDefinitionError);
  });
});

// ------------------------------------------- 9. unreadable state fails safely

describe('a socket table the sandbox cannot produce never becomes a pass', () => {
  it('raises a broken environment rather than passing when ss fails', async () => {
    // The platform's convention: a sandbox that cannot answer is an
    // environment fault, reported as such, and never dressed up as a student
    // who failed. What matters here is that it cannot become a pass.
    const sandbox = new FakeSandbox({
      commands: { 'ss -H -lntu': { exitCode: 1, stderr: 'ss: command failed' } },
    });

    await expect(
      verifyLab({ lab: labWith(LOOPBACK), sandbox, namespace: 'jtt-lab-000000000001' }),
    ).rejects.toThrow(/command failed/i);
  });

  it('does not pass when the sandbox cannot be inspected at all', async () => {
    // A reader with no `inspect` is what a provider offering no inspection
    // commands hands over.
    const noInspect = {
      async read() {
        return null;
      },
    };

    const result = await verifyLab({
      lab: labWith(LOOPBACK),
      sandbox: noInspect,
      namespace: 'jtt-lab-000000000001',
    });

    expect(passed(result)).toBe(false);
  });

  it.each([
    ['empty output', ''],
    ['a header with no rows', 'Netid State Recv-Q Send-Q Local Address:Port\n'],
    ['rows with too few columns', 'tcp LISTEN\n'],
    ['a local address with no port separator', 'tcp LISTEN 0 5 garbage 0.0.0.0:*\n'],
    ['a non-numeric port', 'tcp LISTEN 0 5 127.0.0.1:abc 0.0.0.0:*\n'],
    ['an out-of-range port', 'tcp LISTEN 0 5 127.0.0.1:99999 0.0.0.0:*\n'],
  ])('fails rather than throwing on %s', async (_name, stdout) => {
    const sandbox = new FakeSandbox({ commands: { 'ss -H -lntu': { stdout } } });

    const result = await verifyLab({
      lab: labWith(LOOPBACK),
      sandbox,
      namespace: 'jtt-lab-000000000001',
    });

    expect(passed(result)).toBe(false);
  });

  it('fails the next check once the listener has stopped', async () => {
    // A pass is never cached: the verdict comes from the table as it is now.
    const before = await verify(LOOPBACK, [{ protocol: 'tcp', port: 8080, address: '127.0.0.1' }]);
    expect(passed(before)).toBe(true);

    const after = await verify(LOOPBACK, []);
    expect(passed(after)).toBe(false);
    expect(detailOf(after)).toBe('Nothing is listening on tcp port 8080');
  });
});
