/**
 * Container probes — capability **N9**, and the one place their argv is built.
 *
 * ## The problem this solves, and the boundary it must not cross
 *
 * Several Networking labs can only be graded by *observing behaviour from
 * inside a container*: whether a name resolves, whether a port accepts a
 * connection, whether a published path answers, whether an interface exists at
 * all. Reading a file out of the container (`docker_container_file_content`)
 * cannot answer any of those, because none of them is a file.
 *
 * The obvious implementation — let a lab name a command and run it with
 * `docker exec` — is exactly the capability this platform has deliberately
 * refused. `BrokerSessionEngine.execInContainer` is *not brokered*, and its
 * comment says why: "each is the shape of a capability worth not having.
 * `execInContainer` is arbitrary execution." Re-opening that would undo a
 * decision, not extend one.
 *
 * So a probe is not a command. It is a **closed vocabulary of questions**, and
 * this module is the only place that turns one into an argv:
 *
 * ```text
 *   lab.yaml            a probe kind + typed operands, schema-validated
 *        ↓
 *   probeArgv()         THIS FILE — trusted code owns the executable and every
 *                       argument's position; the lab contributes only operands
 *        ↓
 *   docker exec         argv array, execve, no shell anywhere
 * ```
 *
 * A lab cannot name an executable, cannot add a flag, cannot reorder an
 * argument and cannot supply a string that reaches a shell — because there is
 * no field in the schema that carries any of those, and no shell in the path.
 * This is the `VERIFIER_INTERNAL_COMMANDS` arrangement (`requirements.ts`),
 * where "trusted verifier code owns both the executable and the whole argv, and
 * a lab contributes only strictly validated operands that the handler places
 * itself" — applied to a container instead of to the sandbox.
 *
 * The argv is never sent over the broker. `sessionProbeContainer` carries the
 * *probe*, and `sandboxd` calls this same function to build the argv on its own
 * side. Two callers, one builder, so the validated shape and the executed shape
 * cannot drift apart.
 *
 * ## What a probe observes, and what that is worth
 *
 * A probe runs inside a container the **student controls**: they chose its
 * image and can write to its filesystem. A student who deliberately builds a
 * container whose `nslookup` always exits 0 can make a probe say what they
 * want. That is worth stating plainly, because it bounds the claim:
 *
 *   - a probe is strictly better than a worksheet, which asks the student to
 *     *report* the result — the platform runs it and reads the exit code;
 *   - a probe is **not** tamper-proof against a student who sets out to forge
 *     one, and a lab that cares should pin the container with
 *     `docker_container_image` beside it, which every lab using a probe does.
 *
 * Nothing a probe can do exceeds what the student can already do in their own
 * sandbox with their own shell. It opens no new network path, reaches no other
 * session, and touches nothing on the host.
 */

/** The questions a lab may ask from inside a container. A closed set. */
export const CONTAINER_PROBES = [
  /** Does this name resolve, using whatever resolver the container was given? */
  'dns_lookup',
  /** Does a TCP connection to this host and port complete? */
  'tcp_connect',
  /** Does an HTTP GET of this path return a success status? */
  'http_get',
  /** Does the container's own network namespace hold this interface? */
  'interface_exists',
] as const;

export type ContainerProbeKind = (typeof CONTAINER_PROBES)[number];

/** Bounds on how long any probe may run. Both ends matter. */
export const MIN_PROBE_TIMEOUT_SECONDS = 1;
export const MAX_PROBE_TIMEOUT_SECONDS = 30;
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 5;

/**
 * Bytes of probe output the platform will read.
 *
 * Only `interface_exists` reads output at all, and a link listing is a few
 * hundred bytes. The cap exists because the process on the other end is inside
 * a student's container and can print for as long as it is allowed to: without
 * it, `yes | head -c ...` in a crafted image is a memory-exhaustion primitive
 * aimed at the verifier.
 */
export const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

/**
 * A hostname or IP literal a probe may be pointed at.
 *
 * Deliberately narrower than DNS allows: no leading dash (so an operand can
 * never be read as a flag by the binary it is passed to), no slash, no colon,
 * no percent, nothing that could terminate an authority or introduce a scope
 * id. Container names, service names and IPv4 literals all satisfy it.
 *
 * IPv6 literals are *not* accepted. They would need brackets inside a URL and
 * bare form elsewhere, which is two shapes and a bracket-stripping step for no
 * lab that needs one; a lab probing IPv6 should be designed when there is one.
 */
const PROBE_HOST = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;

/**
 * The path component of an `http_get`.
 *
 * Must begin with `/`. No query, no fragment, no userinfo, no `..`, and no
 * empty segment — so it cannot re-point the request at another authority or
 * climb anywhere. The request is a URL for a binary, not a filesystem path, but
 * the same rule is the cheapest way to keep it uninteresting.
 */
const PROBE_PATH = /^\/[A-Za-z0-9._~\-/]*$/;

/** An interface name, as the kernel allows one. */
const PROBE_INTERFACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/;

export function isProbeHost(value: string): boolean {
  return PROBE_HOST.test(value);
}

export function isProbePath(value: string): boolean {
  return PROBE_PATH.test(value) && !value.includes('..') && !value.includes('//');
}

export function isProbeInterface(value: string): boolean {
  return PROBE_INTERFACE.test(value);
}

export function isProbePort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A validated probe, ready to be turned into an argv. */
export type ContainerProbe =
  | { kind: 'dns_lookup'; host: string }
  | { kind: 'tcp_connect'; host: string; port: number; timeoutSeconds: number }
  | { kind: 'http_get'; host: string; port: number; path: string; timeoutSeconds: number }
  | { kind: 'interface_exists'; interface: string };

export class ProbeError extends Error {
  readonly code = 'INVALID_CONTAINER_PROBE';
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

/**
 * Re-validate a probe that arrived from somewhere else, and refuse anything
 * else.
 *
 * Called on both sides of the broker. The schema in `requirements.ts` has
 * already checked a lab definition, but `sandboxd` is a separate process
 * reached over HTTP, and a component that trusts its input because "the other
 * side validated it" is one deployment mistake away from not being validated at
 * all. Fails closed: an unknown kind, a missing operand or one that does not
 * match its grammar throws rather than being defaulted or coerced.
 */
export function assertContainerProbe(value: unknown): ContainerProbe {
  if (typeof value !== 'object' || value === null) {
    throw new ProbeError('a probe must be an object');
  }
  const probe = value as Record<string, unknown>;
  const kind = probe.kind;
  if (typeof kind !== 'string' || !(CONTAINER_PROBES as readonly string[]).includes(kind)) {
    throw new ProbeError(`'${String(kind)}' is not a probe this platform performs`);
  }

  const host = (): string => {
    const found = probe.host;
    if (typeof found !== 'string' || !isProbeHost(found)) {
      throw new ProbeError(`'${String(found)}' is not a valid probe host`);
    }
    return found;
  };
  const port = (): number => {
    const found = probe.port;
    if (typeof found !== 'number' || !isProbePort(found)) {
      throw new ProbeError(`'${String(found)}' is not a valid port`);
    }
    return found;
  };
  const timeout = (): number => {
    const found = probe.timeoutSeconds;
    if (
      typeof found !== 'number' ||
      !Number.isInteger(found) ||
      found < MIN_PROBE_TIMEOUT_SECONDS ||
      found > MAX_PROBE_TIMEOUT_SECONDS
    ) {
      throw new ProbeError(`'${String(found)}' is not a probe timeout in seconds`);
    }
    return found;
  };

  switch (kind) {
    case 'dns_lookup':
      return { kind, host: host() };
    case 'tcp_connect':
      return { kind, host: host(), port: port(), timeoutSeconds: timeout() };
    case 'http_get': {
      const path = probe.path;
      if (typeof path !== 'string' || !isProbePath(path)) {
        throw new ProbeError(`'${String(path)}' is not a valid probe path`);
      }
      return { kind, host: host(), port: port(), path, timeoutSeconds: timeout() };
    }
    case 'interface_exists': {
      const name = probe.interface;
      if (typeof name !== 'string' || !isProbeInterface(name)) {
        throw new ProbeError(`'${String(name)}' is not a valid interface name`);
      }
      return { kind, interface: name };
    }
    /* c8 ignore next 2 -- unreachable: `kind` was checked against the closed set above. */
    default:
      throw new ProbeError(`'${kind}' is not a probe this platform performs`);
  }
}

/**
 * The argv one probe runs, built entirely here.
 *
 * Every executable and every flag is a literal in this function. The only
 * values that come from a lab are the operands, each already matched against
 * its own grammar, and each placed in a position this code chooses. There is no
 * concatenation into a command line and no shell: the array goes to `docker
 * exec`, which passes it to `execve`.
 *
 * The binaries are BusyBox applets, present in `alpine` and every image the
 * Docker track ships. A probe against an image that lacks one fails — which is
 * the correct answer to "did this probe succeed", and never a pass.
 */
export function probeArgv(probe: ContainerProbe): string[] {
  switch (probe.kind) {
    case 'dns_lookup':
      // Resolver comes from the container's own /etc/resolv.conf, which is the
      // thing a DNS lab is about. No server operand: a lab asks whether the
      // container can resolve a name, not whether some other server can.
      return ['nslookup', probe.host];

    case 'tcp_connect':
      // `-z` connects and closes without transferring data; `-w` bounds the
      // connect and is what makes "dropped" report differently from "refused".
      return ['nc', '-z', '-w', String(probe.timeoutSeconds), probe.host, String(probe.port)];

    case 'http_get':
      // Output is discarded: the exit code is the whole signal, and a response
      // body from a student-controlled server is not something to carry around.
      return [
        'wget',
        '-q',
        '-O',
        '/dev/null',
        '-T',
        String(probe.timeoutSeconds),
        `http://${probe.host}:${probe.port}${probe.path}`,
      ];

    case 'interface_exists':
      // The listing is parsed by the caller; the interface name is *not* passed
      // to `ip`, so no operand reaches the binary at all for this probe.
      return ['ip', '-o', 'link', 'show'];
  }
}

/** How long a probe's exec may take, including process startup. */
export function probeTimeoutMs(probe: ContainerProbe): number {
  const seconds = 'timeoutSeconds' in probe ? probe.timeoutSeconds : DEFAULT_PROBE_TIMEOUT_SECONDS;
  // A margin over the binary's own timeout, so a probe that is doing its job
  // reports its own verdict instead of being killed and reported as a timeout.
  return (seconds + 2) * 1000;
}

/**
 * Does this link listing hold the named interface?
 *
 * `ip -o link show` prints one interface per line as `<index>: <name>: <...>`,
 * and a veth carries `@if<peer>` after its name. Matched on the name field
 * only, anchored, so `eth0` does not match `eth01` and a name appearing later
 * in the line — inside `master eth0`, say — is not a hit.
 */
export function linkListingHasInterface(listing: string, name: string): boolean {
  for (const line of listing.split('\n')) {
    const match = /^\s*\d+:\s*([A-Za-z0-9._-]+)(?:@[A-Za-z0-9._-]+)?:/.exec(line);
    if (match && match[1] === name) return true;
  }
  return false;
}
