/**
 * N9 — `docker_exec_probe`, from the verifier's side.
 *
 * `container-probes.test.ts` in the orchestrator proves the vocabulary cannot
 * be turned into a command. This file proves the *check* built on it reaches
 * the right verdict, and — the part that matters more — that every way of not
 * getting an answer is a failure rather than a pass.
 *
 * The sections are the failure modes, because those are the ones a lab depends
 * on being right: a missing container, a stopped container, a timeout, a
 * refused probe, and a daemon that is not there at all.
 */
import { describe, expect, it } from 'vitest';
import {
  DockerUnreachableError,
  InMemoryWorkspace,
  requirementSchema,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerDaemon, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { DockerVerifyReader, verifyRequirement } from '../src/index.js';

const SANDBOX = 'lab-00000000000a';
const SESSION = 'sess-000000000000000a';

/** Parse through the real schema, so a test can never assert on a shape a lab could not write. */
function requirement(raw: Record<string, unknown>): Requirement {
  return requirementSchema.parse({ label: 'probe', ...raw }) as Requirement;
}

function check(docker: FakeDockerDaemon, raw: Record<string, unknown>) {
  return verifyRequirement(
    requirement(raw),
    new DockerVerifyReader(docker, SANDBOX, {
      port: new InMemoryWorkspace(),
      sessionId: SESSION,
    }),
  );
}

/**
 * A daemon holding the probing container and the container being probed.
 *
 * Both are needed: a probe's target must itself be a container in this
 * session's daemon (VERIFIER-CONTRACTS §3.3), so a fixture with only the
 * prober would fail the ownership gate before any probe ran.
 */
function daemon(
  probes: Record<string, { exitCode?: number; stdout?: string; timedOut?: boolean }> = {},
  options: { state?: string; withTarget?: boolean } = {},
): FakeDockerDaemon {
  const docker = new FakeDockerDaemon();
  docker.addContainer(
    containerSpec({ name: 'ledger-worker', image: 'alpine:3.20' }),
    options.state ?? 'running',
  );
  if (options.withTarget !== false) {
    docker.addContainer(containerSpec({ name: 'ledger-api', image: 'nginx:1.27-alpine' }));
  }
  Object.assign(docker.probes, probes);
  return docker;
}

const DNS = { type: 'docker_exec_probe', container: 'ledger-worker', probe: 'dns_lookup', host: 'ledger-api' };
const TCP = {
  type: 'docker_exec_probe',
  container: 'ledger-worker',
  probe: 'tcp_connect',
  host: 'ledger-api',
  port: 8081,
  timeout_seconds: 3,
};

// ------------------------------------------------------- 1. the two verdicts

describe('a probe grades the exit code, and nothing else', () => {
  it('passes when the probe succeeds and the lab expected success', async () => {
    const docker = daemon({ 'ledger-worker: nslookup ledger-api': { exitCode: 0 } });
    expect((await check(docker, DNS)).status).toBe('pass');
  });

  it('fails when the probe fails and the lab expected success', async () => {
    const docker = daemon({ 'ledger-worker: nslookup ledger-api': { exitCode: 1 } });
    const result = await check(docker, DNS);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ledger-worker');
  });

  it('passes when the probe fails and the lab expected failure', async () => {
    // The shape a firewall lab needs: this connection must still be refused.
    const docker = daemon({ 'ledger-worker: nc -z -w 3 ledger-api 8081': { exitCode: 1 } });
    expect((await check(docker, { ...TCP, expect: 'failure' })).status).toBe('pass');
  });

  it('fails when the probe succeeds and the lab expected failure', async () => {
    const docker = daemon({ 'ledger-worker: nc -z -w 3 ledger-api 8081': { exitCode: 0 } });
    const result = await check(docker, { ...TCP, expect: 'failure' });

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('still');
  });

  it('runs the command the probe vocabulary builds, and only that', async () => {
    const docker = daemon({ 'ledger-worker: nc -z -w 3 ledger-api 8081': { exitCode: 0 } });
    await check(docker, TCP);

    expect(docker.probeRuns).toEqual(['ledger-worker: nc -z -w 3 ledger-api 8081']);
    // Nothing reached the arbitrary-exec path at any point.
    expect(docker.execs).toEqual([]);
  });
});

// ------------------------------------------- 1b. what a probe may be aimed at

describe('a probe may only be aimed at a container in this session', () => {
  it('refuses a target that is not a container here, before running anything', async () => {
    // The ownership gate from VERIFIER-CONTRACTS §3.3. A syntactic check on
    // `host` would accept every one of these; requiring the name to resolve to
    // a container the session-scoped reader can see makes them unnameable.
    for (const host of ['169.254.169.254', 'metadata', 'evil', 'localhost']) {
      const docker = daemon({}, { withTarget: false });
      const result = await check(docker, { ...DNS, host });

      expect(result.status, host).toBe('fail');
      expect(result.detail, host).toContain('is nothing to probe for');
      // Nothing was executed on the way to that verdict.
      expect(docker.probeRuns, host).toEqual([]);
    }
  });

  it('refuses an absent target even when the lab expected the probe to fail', async () => {
    // Otherwise "this must not be reachable" would be satisfied by naming
    // something that was never there — including an Internet host.
    const docker = daemon({}, { withTarget: false });
    const result = await check(docker, { ...TCP, expect: 'failure' });

    expect(result.status).toBe('fail');
    expect(docker.probeRuns).toEqual([]);
  });

  it('still probes when the target exists but shares no network with the prober', async () => {
    // Deliberately NOT short-circuited on a shared-network check: proving that
    // an isolated namespace cannot reach a running container is the observation
    // NET-021 is built on, and inspecting the daemon's view instead would
    // assume the answer.
    const docker = daemon({ 'ledger-worker: nc -z -w 3 ledger-api 8081': { exitCode: 1 } });
    const result = await check(docker, { ...TCP, expect: 'failure' });

    expect(result.status).toBe('pass');
    expect(docker.probeRuns).toEqual(['ledger-worker: nc -z -w 3 ledger-api 8081']);
  });

  it('needs no target for a probe that names none', async () => {
    const docker = daemon(
      { 'ledger-worker: ip -o link show': { exitCode: 0, stdout: '1: lo: <UP>' } },
      { withTarget: false },
    );
    const result = await check(docker, {
      type: 'docker_exec_probe',
      container: 'ledger-worker',
      probe: 'interface_exists',
      interface: 'lo',
    });

    expect(result.status).toBe('pass');
  });
});

// ------------------------------------------------------ 2. failing closed

describe('every way of not getting an answer is a failure', () => {
  it('fails when the container does not exist, and says so', async () => {
    const docker = daemon();
    const result = await check(docker, { ...DNS, container: 'not-a-container' });

    expect(result.status).toBe('fail');
    // "Your container is gone" and "your fix did not work" are different
    // problems, and a student should be told which one they have.
    expect(result.detail).toContain('No container named');
    // The probe was never attempted.
    expect(docker.probeRuns).toEqual([]);
  });

  it('fails when the container exists but is not running', async () => {
    const docker = daemon({}, { state: 'exited' });
    const result = await check(docker, DNS);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not running');
    expect(docker.probeRuns).toEqual([]);
  });

  it('fails a missing container even when the lab expected the probe to fail', async () => {
    // The trap in `expect: failure`: deleting the container must not be a way
    // to satisfy "this connection must be refused".
    const docker = daemon();
    const result = await check(docker, {
      ...TCP,
      container: 'not-a-container',
      expect: 'failure',
    });
    expect(result.status).toBe('fail');
  });

  it('fails a stopped container even when the lab expected the probe to fail', async () => {
    const docker = daemon({}, { state: 'exited' });
    expect((await check(docker, { ...TCP, expect: 'failure' })).status).toBe('fail');
  });

  it('fails a timeout under BOTH expectations', async () => {
    // A timeout is the absence of an answer, not evidence of one. A lab
    // grading "must still be refused" must not be satisfied by a probe the
    // platform never got a result from — that is how a dropped packet and a
    // broken environment would become indistinguishable.
    const timedOut = { 'ledger-worker: nc -z -w 3 ledger-api 8081': { exitCode: 1, timedOut: true } };

    const expectingSuccess = await check(daemon(timedOut), TCP);
    expect(expectingSuccess.status).toBe('fail');
    expect(expectingSuccess.detail).toContain('did not finish');

    const expectingFailure = await check(daemon(timedOut), { ...TCP, expect: 'failure' });
    expect(expectingFailure.status).toBe('fail');
    expect(expectingFailure.detail).toContain('did not finish');
  });

  it('fails, rather than passing, when the probe itself is refused', async () => {
    const docker = daemon();
    docker.failOn = { probeContainer: 'probe refused' };

    const result = await check(docker, DNS);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Could not probe');
  });

  it('propagates an unreachable daemon, so checks are skipped and not failed', async () => {
    const docker = daemon();
    docker.unreachable = 'session daemon is not responding';

    // A student whose environment broke has not made a mistake. `verifyLab`
    // turns this into ENVIRONMENT_UNREACHABLE with every check skipped.
    await expect(check(docker, DNS)).rejects.toBeInstanceOf(DockerUnreachableError);
  });
});

// -------------------------------------------- 3. the interface probe parses

describe('interface_exists reads the listing rather than an exit code alone', () => {
  const LISTING = [
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN',
    '14: eth0@if15: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP',
  ].join('\n');

  const probe = (name: string, expectation = 'success') => ({
    type: 'docker_exec_probe',
    container: 'ledger-worker',
    probe: 'interface_exists',
    interface: name,
    expect: expectation,
  });

  it('passes when the interface is in the listing', async () => {
    const docker = daemon({ 'ledger-worker: ip -o link show': { exitCode: 0, stdout: LISTING } });
    expect((await check(docker, probe('eth0'))).status).toBe('pass');
  });

  it('fails when it is not, even though `ip` itself exited 0', async () => {
    // The distinction that makes this probe worth having: `ip -o link show`
    // succeeds whether or not the interface the lab asked about is there.
    const docker = daemon({ 'ledger-worker: ip -o link show': { exitCode: 0, stdout: LISTING } });
    expect((await check(docker, probe('eth1'))).status).toBe('fail');
  });

  it('passes an expected absence, which is what a --network none container is', async () => {
    const onlyLoopback = '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN';
    const docker = daemon({
      'ledger-worker: ip -o link show': { exitCode: 0, stdout: onlyLoopback },
    });

    expect((await check(docker, probe('eth0', 'failure'))).status).toBe('pass');
    expect((await check(docker, probe('lo', 'failure'))).status).toBe('fail');
  });

  it('fails when `ip` could not run, rather than reading an empty listing as an absence', async () => {
    const docker = daemon({ 'ledger-worker: ip -o link show': { exitCode: 127, stdout: '' } });

    // `expect: failure` is the dangerous direction: an image with no `ip` at
    // all would otherwise "prove" the interface is missing.
    expect((await check(docker, probe('eth0', 'failure'))).status).toBe('fail');
    expect((await check(docker, probe('eth0'))).status).toBe('fail');
  });
});

// ------------------------------------------------------ 4. non-disclosure

describe('a probe never hands back what it saw', () => {
  it('quotes no output, on success or failure', async () => {
    const secret = 'INTERNAL-ONLY-VALUE-must-never-be-shown';
    const docker = daemon({
      'ledger-worker: ip -o link show': { exitCode: 0, stdout: `1: lo: <UP> ${secret}` },
    });

    const result = await check(docker, {
      type: 'docker_exec_probe',
      container: 'ledger-worker',
      probe: 'interface_exists',
      interface: 'eth0',
    });

    expect(result.status).toBe('fail');
    // The output came from a process in a container the student controls; the
    // verifier reads it and does not repeat it. Same rule as
    // `docker_container_file_content`.
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('describes the question in its detail, which is the task restated', async () => {
    const docker = daemon({ 'ledger-worker: nslookup ledger-api': { exitCode: 1 } });
    const result = await check(docker, DNS);

    // A failure detail names what was asked and of which container. That is the
    // task restated, not the answer: it tells a student where to look without
    // telling them what they would have found.
    expect(result.detail).toContain('ledger-worker');
    expect(result.detail).toContain('resolve ledger-api');
  });
});

// ------------------------------------------------ 5. session isolation

describe('a probe cannot address another session', () => {
  it('reaches only the daemon its reader was constructed with', async () => {
    const mine = daemon();
    const theirs = daemon({ 'ledger-worker: nslookup ledger-api': { exitCode: 0 } });

    // Session B has a container that would answer. Session A is graded against
    // its own daemon, which is a different object store — not a filtered view.
    const result = await check(mine, DNS);
    expect(result.status).toBe('fail');
    expect(theirs.probeRuns).toEqual([]);
  });

  it('offers no field that could name a daemon, a sandbox or a session', () => {
    const parsed = requirement(DNS) as Record<string, unknown>;
    for (const key of ['namespace', 'sandbox', 'session', 'sessionId', 'dockerHost', 'daemon']) {
      expect(Object.keys(parsed)).not.toContain(key);
    }
    // Isolation here is structural: the reader holds one engine and no handler
    // can choose another.
  });
});
