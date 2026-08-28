/**
 * "Not reached" and "not measured" are different answers.
 *
 * `requestFromPeer` is how NET-007 is graded: the peer is asked whether it can
 * reach this session's service, and a student controls neither end of that
 * measurement. Which makes the failure mode expensive — a measurement that
 * never produced a verdict used to be reported as "another host could not reach
 * the service", so a correct repair could be graded as a failure.
 *
 * That is not hypothetical. On a loaded host one budget covers the exec, the
 * request and the fork of the shell script that answers it, and a NET-007 run
 * was observed failing that check while the service was bound to `0.0.0.0`,
 * `curl` on the box returned 200, and the same peer answered 200 three times a
 * moment later.
 *
 * The tests below hold both halves down: a real negative is still a negative
 * and is still reported on the first attempt, and an inconclusive measurement
 * is retried rather than turned into a grade.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  LinuxLabProvider,
  loadLabDefinition,
  peerRefForSandbox,
  type ContainerExecRequest,
  type ContainerExecResult,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { LABS_DIR, sessionContext } from './helpers.js';

const SANDBOX = 'jtt-lab-0000000000a7';
const PEER = peerRefForSandbox(SANDBOX);
const NET_007 = path.join(LABS_DIR, 'networking', 'net-007-bind-address-incident', 'lab.yaml');

let lab: LoadedLabDefinition;

/**
 * A runtime that answers the peer's `curl` from a script and records how often
 * it was asked. Everything else falls through to the shared fake, so the peer
 * still has to exist and still has to be this session's.
 */
class ScriptedPeerRuntime extends FakeContainerRuntime {
  readonly curls: string[] = [];

  constructor(private readonly answers: ContainerExecResult[]) {
    super();
  }

  override async exec(name: string, request: ContainerExecRequest): Promise<ContainerExecResult> {
    if (request.argv[0] !== 'curl') return super.exec(name, request);
    this.curls.push(name);
    const index = Math.min(this.curls.length - 1, this.answers.length - 1);
    return this.answers[index]!;
  }
}

const answered = (status: string): ContainerExecResult => ({
  exitCode: 0,
  stdout: status,
  stderr: '',
  timedOut: false,
});

/** What curl reports when it connected and was refused: `000`, exit 7. */
const refused: ContainerExecResult = {
  exitCode: 7,
  stdout: '000',
  stderr: 'curl: (7) Failed to connect',
  timedOut: false,
};

/** What the runtime returns when the exec itself never finished. */
const execTimedOut: ContainerExecResult = {
  exitCode: 1,
  stdout: '',
  stderr: '',
  timedOut: true,
};

async function ask(runtime: FakeContainerRuntime) {
  const provider = new LinuxLabProvider({ runtime, image: 'jumptotech/lab-linux:test' });
  const context = sessionContext(lab, { sandboxRef: SANDBOX });
  await provider.create(context);
  return provider.requestFromPeer(context, { port: 8080, path: '/health' });
}

describe('the peer reachability measurement', () => {
  it('loads NET-007, the lab this measurement grades', async () => {
    lab = await loadLabDefinition(NET_007);
    expect(lab.environment.peer).toBe(true);
  });

  it('reports the status the peer actually received', async () => {
    const runtime = new ScriptedPeerRuntime([answered('200')]);
    expect(await ask(runtime)).toEqual({ reached: true, status: 200 });
    expect(runtime.curls).toEqual([PEER]);
  });

  it('reports a refusal as unreachable, and asks only once', async () => {
    // The failing state every unrepaired NET-007 is in. It is instantaneous and
    // identical every time, so retrying it would only make grading slower.
    const runtime = new ScriptedPeerRuntime([refused]);
    expect(await ask(runtime)).toMatchObject({ reached: false });
    expect(runtime.curls).toHaveLength(1);
  });

  it('measures again when the measurement itself did not complete', async () => {
    const runtime = new ScriptedPeerRuntime([execTimedOut, answered('200')]);
    expect(await ask(runtime)).toEqual({ reached: true, status: 200 });
    expect(runtime.curls.length).toBeGreaterThan(1);
  });

  it('gives up after a bounded number of inconclusive attempts', async () => {
    const runtime = new ScriptedPeerRuntime([execTimedOut]);
    const result = await ask(runtime);
    expect(result.reached).toBe(false);
    // And says which of the two things happened, rather than blaming the student.
    expect(result.detail).toMatch(/could not be measured/);
    expect(runtime.curls.length).toBeGreaterThan(1);
    expect(runtime.curls.length).toBeLessThanOrEqual(5);
  });

  it('does not retry a curl that reported it could not resolve the target', async () => {
    const runtime = new ScriptedPeerRuntime([
      { exitCode: 6, stdout: '000', stderr: 'curl: (6) Could not resolve host', timedOut: false },
    ]);
    expect(await ask(runtime)).toMatchObject({ reached: false });
    expect(runtime.curls).toHaveLength(1);
  });
});
