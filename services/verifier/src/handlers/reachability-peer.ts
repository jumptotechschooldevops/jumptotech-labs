/**
 * The peer-request check.
 *
 * "This service is reachable from another machine" is the one claim a lab
 * cannot settle from inside the machine in question. A student can show that
 * `curl localhost` works and be entirely wrong about what anyone else sees, and
 * that gap is the whole lesson of a bind-address incident — so the platform
 * measures it from somewhere else instead of taking evidence for it.
 *
 * The request is issued by this session's peer container: a second host on the
 * session's own private segment, created and owned by the platform, with no
 * capabilities and no shell attached. A student controls neither end of the
 * measurement, so there is nothing to forge — no file, no transcript and no
 * command history can make this check pass.
 *
 * The target is not configurable. A lab supplies a port, a path and an expected
 * status; the host is always this session's own sandbox, resolved by the
 * segment's embedded DNS. A `host` field would have turned a grading check into
 * a way of making the platform issue requests to addresses of a lab author's
 * choosing, which is not a thing this check should be able to do.
 */
import type { SandboxVerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';

export const httpRequest: SandboxVerifierHandler<'http_request'> = {
  type: 'http_request',
  label: (r) =>
    `Another host on this segment gets HTTP ${r.expected_status} from port ${r.port}${r.path}`,

  async run(requirement, reader) {
    if (!reader.canRequestFromPeer) {
      // The platform could not look. That is not the same as having looked and
      // found the service reachable, so it is a failure rather than a pass.
      return fail('This lab environment has no peer host, so reachability could not be measured');
    }

    const result = await reader.httpFromPeer({
      port: requirement.port,
      path: requirement.path,
      timeoutSeconds: requirement.timeout_seconds,
    });

    if (!result.reached) {
      return fail(
        `Another host on this segment could not reach port ${requirement.port}${requirement.path}`,
      );
    }
    if (result.status !== requirement.expected_status) {
      return fail(
        `Another host on this segment got HTTP ${result.status} from port ${requirement.port}${requirement.path}, expected ${requirement.expected_status}`,
      );
    }
    return pass();
  },
};
