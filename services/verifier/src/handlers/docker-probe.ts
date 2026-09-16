/**
 * N9 — the one Docker check that observes *behaviour* rather than state.
 *
 * Every other check in the Docker family reads `docker inspect` or the archive
 * endpoint. Neither can answer the questions the Networking container labs are
 * about, because none of them is a fact about an object: whether a name
 * resolves, whether a port accepts a connection, whether a published path
 * answers, whether a container's namespace holds an interface at all.
 *
 * ## How this stays away from `docker exec`
 *
 * A lab never names a command. It names a **probe** — one of a closed set — and
 * typed operands. `docker/probes.ts` owns every executable and every argument's
 * position and builds the argv, on both sides of the broker, so nothing a lab
 * writes reaches an argv slot it did not choose and nothing reaches a shell.
 * The session engine's `execInContainer` stays refused; this is a different
 * capability with a different shape.
 *
 * ## Fail closed, everywhere
 *
 * The verdict is `expect`, compared against one bit: did the probe's binary
 * exit 0. Everything that is not a clean answer is a **failure**, never a pass:
 *
 *   - the container does not exist, or is not running → fail, and say which,
 *     because "your container is gone" and "your fix did not work" are
 *     different problems for a student;
 *   - the probe timed out → fail with `expect: success`, and — deliberately —
 *     **also** fail with `expect: failure`. A timeout is not evidence that a
 *     connection was refused; it is the absence of an answer, and a lab that
 *     grades "must still be refused" must not be satisfied by a probe the
 *     platform never got a result from;
 *   - the daemon is unreachable → the error propagates, so `verifyLab` reports
 *     ENVIRONMENT_UNREACHABLE and every check is skipped rather than failed.
 *
 * ## Non-disclosure
 *
 * A probe's stdout is a student-controlled process's output and is never quoted
 * back — the same rule `docker_container_file_content` holds. Only
 * `interface_exists` reads output at all, and it is parsed, not echoed. Details
 * carry the question and the verdict, never the bytes.
 */
import {
  DockerUnreachableError,
  linkListingHasInterface,
  type ContainerProbe,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import type { DockerVerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';

type ProbeRequirement = Extract<Requirement, { type: 'docker_exec_probe' }>;

/** What the lab is asking, in words a student can act on. */
function describe(r: ProbeRequirement): string {
  switch (r.probe) {
    case 'dns_lookup':
      return `resolve ${r.host}`;
    case 'tcp_connect':
      return `open a TCP connection to ${r.host}:${r.port}`;
    case 'http_get':
      return `fetch http://${r.host}:${r.port}${r.path}`;
    case 'interface_exists':
      return `find the ${r.interface} interface`;
  }
}

/**
 * The requirement as the probe vocabulary understands it.
 *
 * The schema has already checked that exactly the operands this probe kind
 * takes are present, and `assertContainerProbe` checks again on the way to the
 * daemon. This is a translation, not a validation.
 */
function toProbe(r: ProbeRequirement): ContainerProbe {
  switch (r.probe) {
    case 'dns_lookup':
      return { kind: 'dns_lookup', host: r.host as string };
    case 'tcp_connect':
      return {
        kind: 'tcp_connect',
        host: r.host as string,
        port: r.port as number,
        timeoutSeconds: r.timeout_seconds,
      };
    case 'http_get':
      return {
        kind: 'http_get',
        host: r.host as string,
        port: r.port as number,
        path: r.path as string,
        timeoutSeconds: r.timeout_seconds,
      };
    case 'interface_exists':
      return { kind: 'interface_exists', interface: r.interface as string };
  }
}

export const dockerExecProbe: DockerVerifierHandler<'docker_exec_probe'> = {
  type: 'docker_exec_probe',
  label: (r) =>
    r.expect === 'success'
      ? `Container ${r.container} can ${describe(r)}`
      : `Container ${r.container} cannot ${describe(r)}`,
  async run(r, reader) {
    // Resolved first, so "there is no such container" is never reported as
    // "your fix did not work".
    const container = await reader.container(r.container);
    if (!container) {
      return fail(`No container named '${r.container}' exists in your Docker environment`);
    }
    if (!container.running) {
      return fail(`Container '${r.container}' is not running, so nothing can be observed inside it`);
    }

    /*
     * The target must be a container in this session's own daemon.
     *
     * This is the ownership gate `docs/docker/VERIFIER-CONTRACTS.md` §3.3
     * specifies, and it is the reason a probe cannot be pointed anywhere
     * interesting. `host` passes a syntactic check in the schema, but a
     * syntactic check would still accept `169.254.169.254`, `host.docker
     * .internal`, the platform's own API or any Internet host. Requiring the
     * name to resolve to a container the session-scoped reader can see makes
     * all of those unnameable by construction rather than by blocklist — the
     * reader holds one daemon and takes no daemon parameter, so a container in
     * another session is not merely forbidden, it is unaddressable.
     *
     * A student may of course type any address they like in their own shell.
     * This is about what a *lab definition* can make the platform do.
     *
     * The one gate from §3.3 deliberately not adopted is "from and to must
     * share a network". That short-circuits the negative case by inspecting the
     * daemon's view, and the negative case is exactly what NET-021 needs to
     * *observe*: a namespace with no route out must be shown not to reach a
     * container, not assumed not to.
     */
    if (r.host !== undefined) {
      const target = await reader.container(r.host);
      if (!target) {
        return fail(
          `No container named '${r.host}' exists in your Docker environment, so there is nothing to probe for`,
        );
      }
    }

    let result: Awaited<ReturnType<typeof reader.probe>>;
    try {
      result = await reader.probe(r.container, toProbe(r));
    } catch (error) {
      // An environment that cannot be reached is never a wrong answer.
      if (error instanceof DockerUnreachableError) throw error;
      // Anything else — a refused probe, a malformed one that got this far — is
      // a failed check with a structural reason, never a silent pass.
      const reason = error instanceof Error ? error.message : 'the probe could not be run';
      return fail(`Could not probe '${r.container}': ${reason}`);
    }

    if (result.timedOut) {
      // Fails under *either* expectation. See the header: a timeout is the
      // absence of an answer, not evidence of one.
      return fail(
        `The probe did not finish within ${r.timeout_seconds}s, so whether '${r.container}' can ${describe(r)} is unknown`,
      );
    }

    /*
     * `interface_exists` is the one probe whose verdict is not the exit code,
     * and that makes it the one that can be fooled in the dangerous direction.
     *
     * `ip -o link show` exits 0 whether or not the interface the lab asked
     * about is present, so the listing has to be parsed. But the converse
     * matters more: a non-zero exit means there is **no listing** — the image
     * has no `ip`, or the binary died — and an empty listing trivially does not
     * contain the interface. Reading that as "the interface is absent" would
     * let `expect: failure` be satisfied by a container that cannot answer the
     * question at all, which is the same mistake as treating a timeout as a
     * refused connection. So it fails under either expectation, exactly as a
     * timeout does.
     */
    if (r.probe === 'interface_exists' && result.exitCode !== 0) {
      return fail(
        `Could not list the interfaces inside '${r.container}', so whether it has ${r.interface} is unknown`,
      );
    }

    const succeeded =
      r.probe === 'interface_exists'
        ? linkListingHasInterface(result.stdout, r.interface as string)
        : result.exitCode === 0;

    if (succeeded === (r.expect === 'success')) return pass();

    return fail(
      r.expect === 'success'
        ? `Container '${r.container}' could not ${describe(r)}`
        : `Container '${r.container}' can still ${describe(r)}, and this lab requires that it cannot`,
    );
  },
};
