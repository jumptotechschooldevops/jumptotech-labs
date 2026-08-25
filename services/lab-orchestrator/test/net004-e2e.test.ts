/**
 * NET-004 against a real Docker daemon.
 *
 * Everything else about this lab is exercised against fakes. This suite exists
 * for the claims a fake cannot make: that `--internal` really has no route off
 * it, that a real kernel really produces REACHABLE / FAILED / no-entry for the
 * three cases the lab teaches, that a student really cannot forge a neighbour
 * entry without CAP_NET_ADMIN, and that two concurrent sessions really cannot
 * see each other's segment.
 *
 * It drives the production provider and the production verifier — the same
 * `LinuxLabProvider`, the same `sandboxPort` shape the API builds, the same
 * `verifyLab` — so a pass here is evidence about the platform rather than about
 * this file.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1 and the image exists, because it needs
 * a daemon and takes real time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  DockerCliRuntime,
  LinuxLabProvider,
  loadLabDefinition,
  networkRefForSandbox,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { verifyLab } from '@jumptotech/verifier';
import { LABS_DIR, sessionContext } from './helpers.js';

const IMAGE = process.env.NET004_E2E_IMAGE ?? 'jumptotech/lab-linux:net004-e2e';
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

const SANDBOX_A = 'jtt-lab-00000000e2e1';
const SANDBOX_B = 'jtt-lab-00000000e2e2';
const NETWORK_A = networkRefForSandbox(SANDBOX_A);
const NETWORK_B = networkRefForSandbox(SANDBOX_B);

const runtime = new DockerCliRuntime();
const provider = new LinuxLabProvider({ runtime, image: IMAGE });

let lab: LoadedLabDefinition;

function contextFor(sessionId: string, sandboxRef: string): LabSessionContext {
  return sessionContext(lab, { sessionId, sandboxRef });
}

/** The SandboxPort the API hands the verifier, built the same way. */
function sandboxPort(context: LabSessionContext) {
  return {
    read: (relativePath: string, options?: { maxBytes?: number }) =>
      provider.readSandboxPath(context, relativePath, options),
    inspect: (command: string, args: readonly string[], options?: { asRoot?: boolean }) =>
      provider.inspectSandbox(context, command, args, options),
  };
}

async function check(context: LabSessionContext) {
  return verifyLab({
    lab,
    namespace: context.sandboxRef ?? context.namespace,
    sandbox: sandboxPort(context),
  });
}

/** Run a command in the student's sandbox as the student. */
async function student(sandboxRef: string, argv: string[]) {
  return runtime.exec(sandboxRef, { argv, user: 'student', timeoutMs: 30_000 });
}

/** Read this session's own addressing off the machine, as a student would. */
async function segmentOf(sandboxRef: string) {
  const routes = await student(sandboxRef, ['ip', '-json', 'route', 'show']);
  const parsed = JSON.parse(routes.stdout) as Array<{ dst?: string; prefsrc?: string; dev?: string }>;
  const connected = parsed.find((r) => r.dst?.includes('/') && r.prefsrc);
  if (!connected?.prefsrc || !connected.dst) throw new Error('no connected route found');

  const [network] = connected.dst.split('/');
  const octets = String(network).split('.');
  // The gateway of a Docker bridge is the first usable address of the prefix.
  const gateway = [octets[0], octets[1], octets[2], '1'].join('.');
  // An address on the same prefix that nothing is using.
  const unused = [octets[0], octets[1], octets[2], '77'].join('.');
  return { gateway, unused, own: connected.prefsrc, dev: connected.dev ?? 'eth0' };
}

/** Produce the three outcomes the lab asks for, exactly as its brief says. */
async function solve(sandboxRef: string) {
  const segment = await segmentOf(sandboxRef);

  // A TCP connection attempt: it fails, and the kernel resolves first anyway.
  await student(sandboxRef, ['nc', '-w', '2', segment.gateway, '9']);
  await student(sandboxRef, ['nc', '-w', '3', segment.unused, '9']);
  await student(sandboxRef, ['nc', '-w', '2', '10.99.99.99', '9']);

  const table = await student(sandboxRef, ['ip', 'neigh', 'show']);
  await runtime.exec(sandboxRef, {
    argv: ['tee', '/home/student/l2/findings.txt'],
    user: 'student',
    stdin: table.stdout,
    timeoutMs: 15_000,
  });
  await runtime.exec(sandboxRef, {
    argv: ['tee', '/home/student/l2/answers.txt'],
    user: 'student',
    stdin: [
      '  arp_request_destination = broadcast',
      '  off_subnet_frame_goes_to = the gateway',
      '',
    ].join('\n'),
    timeoutMs: 15_000,
  });
  return segment;
}

describe.skipIf(!ENABLED)('NET-004 end to end, against a real daemon', () => {
  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'networking', 'net-004-arp-neighbours', 'lab.yaml'),
    );
    if (!(await runtime.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not built — run: docker build -t ${IMAGE} -f infrastructure/docker/sandbox-linux.Dockerfile .`);
    }
  }, 120_000);

  afterAll(async () => {
    for (const ref of [SANDBOX_A, SANDBOX_B]) {
      await provider.destroySandbox(ref).catch(() => undefined);
    }
  }, 120_000);

  it('runs the whole student journey: start, fail, solve, pass, break, fail, reset, fail, solve, pass', async () => {
    const context = contextFor('sess-00000000000e2e01', SANDBOX_A);

    // --- start ------------------------------------------------------------
    const created = await provider.create(context);
    expect(created.ok, JSON.stringify(created.steps)).toBe(true);

    // The session really is on its own internal bridge.
    const network = await runtime.networkInspect(NETWORK_A);
    expect(network?.labels['jumptotech.io/session-id']).toBe(context.sessionId);
    const info = await runtime.inspect(SANDBOX_A);
    expect(info?.state).toBe('running');

    // --- the initial state is real ---------------------------------------
    const segment = await segmentOf(SANDBOX_A);
    expect(segment.own).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // `--internal` means no route off the segment: the off-subnet address is
    // unreachable at the routing layer, which is the third outcome the lab
    // grades and the reason no neighbour entry is ever created for it.
    const offSegment = await student(SANDBOX_A, ['nc', '-w', '2', '10.99.99.99', '9']);
    expect(offSegment.exitCode).not.toBe(0);

    // --- check before solving --------------------------------------------
    const before = await check(context);
    expect(before.passed).toBe(false);

    // --- solve -------------------------------------------------------------
    await solve(SANDBOX_A);

    const after = await check(context);
    expect(after.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(after.passed).toBe(true);

    // --- break one piece of required state ---------------------------------
    await runtime.exec(SANDBOX_A, {
      argv: ['rm', '-f', '/home/student/l2/findings.txt'],
      user: 'student',
      timeoutMs: 15_000,
    });
    const broken = await check(context);
    expect(broken.passed).toBe(false);

    // --- reset -------------------------------------------------------------
    const reset = await provider.reset(context);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    // The topology is restored: same private network, fresh container on it.
    expect(await runtime.networkInspect(NETWORK_A)).not.toBeNull();
    const restored = await segmentOf(SANDBOX_A);
    expect(restored.own).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // A previous pass cannot survive: the new container's network namespace
    // has an empty neighbour table and the seeded answer sheet is blank again.
    const afterReset = await check(context);
    expect(afterReset.passed).toBe(false);

    // --- solve again -------------------------------------------------------
    await solve(SANDBOX_A);
    const solvedAgain = await check(context);
    expect(solvedAgain.passed).toBe(true);
  }, 600_000);

  it('produces the three neighbour outcomes a real kernel reports', async () => {
    const context = contextFor('sess-00000000000e2e01', SANDBOX_A);
    if (!(await runtime.inspect(SANDBOX_A))) {
      const created = await provider.create(context);
      expect(created.ok).toBe(true);
      await solve(SANDBOX_A);
    }

    const segment = await segmentOf(SANDBOX_A);
    const table = await student(SANDBOX_A, ['ip', '-json', 'neigh', 'show']);
    const rows = JSON.parse(table.stdout) as Array<{
      dst: string;
      dev: string;
      lladdr?: string;
      state: string[];
    }>;

    const gateway = rows.find((r) => r.dst === segment.gateway);
    expect(gateway?.lladdr, 'the gateway resolves to a hardware address').toMatch(
      /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/,
    );
    expect(['REACHABLE', 'STALE', 'DELAY', 'PROBE']).toContain(gateway?.state[0]);

    const unused = rows.find((r) => r.dst === segment.unused);
    expect(['INCOMPLETE', 'FAILED']).toContain(unused?.state[0]);
    expect(unused?.lladdr).toBeUndefined();

    // No route means the kernel never gets as far as asking.
    expect(rows.find((r) => r.dst === '10.99.99.99')).toBeUndefined();
  }, 300_000);

  it('will not let a student forge neighbour state', async () => {
    const context = contextFor('sess-00000000000e2e01', SANDBOX_A);
    if (!(await runtime.inspect(SANDBOX_A))) {
      await provider.create(context);
    }

    const forge = await student(SANDBOX_A, [
      'ip', 'neigh', 'add', '10.90.0.250', 'lladdr', 'de:ad:be:ef:00:01', 'dev', 'eth0',
    ]);
    expect(forge.exitCode).not.toBe(0);
    expect(`${forge.stderr}${forge.stdout}`).toMatch(/not permitted/i);

    // Even with sudo, the capability is not in the container to begin with.
    const withSudo = await student(SANDBOX_A, [
      'sudo', 'ip', 'neigh', 'add', '10.90.0.251', 'lladdr', 'de:ad:be:ef:00:02', 'dev', 'eth0',
    ]);
    expect(withSudo.exitCode).not.toBe(0);
  }, 300_000);

  it('keeps two concurrent sessions on separate segments', async () => {
    const a = contextFor('sess-00000000000e2e01', SANDBOX_A);
    const b = contextFor('sess-00000000000e2e02', SANDBOX_B);
    if (!(await runtime.inspect(SANDBOX_A))) await provider.create(a);
    const createdB = await provider.create(b);
    expect(createdB.ok, JSON.stringify(createdB.steps)).toBe(true);

    // Different networks, and neither container is attached to the other's.
    expect(NETWORK_A).not.toBe(NETWORK_B);
    const netA = await runtime.networkInspect(NETWORK_A);
    const netB = await runtime.networkInspect(NETWORK_B);
    expect(netA?.id).not.toBe(netB?.id);

    // Solve only in B.
    await solve(SANDBOX_B);
    expect((await check(b)).passed).toBe(true);

    // A is untouched by that. Its own table is what decides its verdict.
    await runtime.exec(SANDBOX_A, {
      argv: ['rm', '-f', '/home/student/l2/findings.txt', '/home/student/l2/answers.txt'],
      user: 'student',
      timeoutMs: 15_000,
    });
    expect((await check(a)).passed).toBe(false);

    // A cannot reach B's sandbox either: separate bridges, no route between.
    const segmentB = await segmentOf(SANDBOX_B);
    const reach = await student(SANDBOX_A, ['nc', '-w', '2', segmentB.own, '9']);
    expect(reach.exitCode).not.toBe(0);

    // Ending A leaves B entirely alone.
    await provider.destroySandbox(SANDBOX_A, a.sessionId);
    expect(await runtime.networkInspect(NETWORK_A)).toBeNull();
    expect(await runtime.networkInspect(NETWORK_B)).not.toBeNull();
    expect((await runtime.inspect(SANDBOX_B))?.state).toBe('running');
    expect((await check(b)).passed).toBe(true);
  }, 600_000);

  it('leaves no orphan network behind after teardown', async () => {
    for (const ref of [SANDBOX_A, SANDBOX_B]) {
      await provider.destroySandbox(ref).catch(() => undefined);
    }

    expect(await runtime.networkInspect(NETWORK_A)).toBeNull();
    expect(await runtime.networkInspect(NETWORK_B)).toBeNull();
    // And destroying again is safe.
    const again = await provider.destroySandbox(SANDBOX_A);
    expect(again.ok).toBe(true);
  }, 300_000);
});
