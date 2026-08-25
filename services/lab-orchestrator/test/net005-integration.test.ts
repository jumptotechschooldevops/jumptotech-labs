/**
 * NET-005 against a real Docker daemon.
 *
 * The claim this suite exists to test is the one a fake cannot make: that the
 * *fixture itself* cannot produce the network state the lab grades. The seeded
 * poller runs every few seconds against an endpoint on a network no route
 * covers, so it fails at the routing decision and never attempts address
 * resolution. If that reasoning were wrong — if the poller's own traffic left a
 * resolved neighbour behind — the lab would pass itself, and section 2 below
 * would catch it against a real kernel rather than against an assumption.
 *
 * It drives the production provider and the production verifier, so a pass here
 * is evidence about the platform rather than about this file.
 *
 * Tier: E2E (PLATFORM-006). Gated on RUN_INTEGRATION_TESTS=1, so `npm test`
 * stays hermetic.
 *
 * What it mutates on the shared daemon, and nothing else:
 *   · two sandbox containers, named from this run's id
 *   · the two `jtt-net-*` lab networks the provider derives from those names
 *
 * Names are derived from `testRunId()` so concurrent worktrees cannot collide.
 * The run id cannot appear literally in either name — `jtt-lab-<hex>` and
 * `sess-<hex>` are hex-only by platform rule — so teardown proves ownership the
 * stronger way: it re-reads the container's own session label from the daemon
 * and refuses anything that is not this run's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CONTAINER_SESSION_LABEL,
  DockerCliRuntime,
  LinuxLabProvider,
  loadLabDefinition,
  networkRefForSandbox,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { verifyLab } from '@jumptotech/verifier';
import { testRunId } from '@jumptotech/test-support/run-id';
import { LABS_DIR, sessionContext } from './helpers.js';

const IMAGE = process.env.NET005_E2E_IMAGE ?? 'jumptotech/lab-linux:net004-e2e';
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

const RUN_HEX = createHash('sha256').update(testRunId()).digest('hex').slice(0, 12);
const SANDBOX_A = `jtt-lab-${RUN_HEX}c1`;
const SANDBOX_B = `jtt-lab-${RUN_HEX}c2`;
const SESSION_A = `sess-${RUN_HEX}c1`;
const SESSION_B = `sess-${RUN_HEX}c2`;
const NETWORK_A = networkRefForSandbox(SANDBOX_A);
const NETWORK_B = networkRefForSandbox(SANDBOX_B);

const CONF = '/etc/ledger/settlement.conf';
const BAD = '10.80.4.10';

const runtime = new DockerCliRuntime();
const provider = new LinuxLabProvider({ runtime, image: IMAGE });

let lab: LoadedLabDefinition;

function contextFor(sessionId: string, sandboxRef: string): LabSessionContext {
  return sessionContext(lab, { sessionId, sandboxRef });
}

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

async function student(sandboxRef: string, argv: string[]) {
  return runtime.exec(sandboxRef, { argv, user: 'student', timeoutMs: 30_000 });
}

async function root(sandboxRef: string, argv: string[], stdin?: string) {
  return runtime.exec(sandboxRef, {
    argv,
    user: 'root',
    timeoutMs: 30_000,
    ...(stdin !== undefined ? { stdin } : {}),
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the segment off the machine, exactly as the brief asks a student to. */
async function segmentOf(sandboxRef: string) {
  const routes = await student(sandboxRef, ['ip', '-json', 'route', 'show']);
  const parsed = JSON.parse(routes.stdout) as Array<{ dst?: string; prefsrc?: string }>;
  const connected = parsed.find((r) => r.dst?.includes('/') && r.prefsrc);
  if (!connected?.prefsrc || !connected.dst) throw new Error('no connected route found');
  const octets = String(connected.dst.split('/')[0]).split('.');
  return {
    own: connected.prefsrc,
    // The first usable address of the prefix — the arithmetic NET-002 taught.
    firstUsable: [octets[0], octets[1], octets[2], '1'].join('.'),
  };
}

/** Whether anything on the segment is currently resolved. */
async function resolvedNeighbours(sandboxRef: string) {
  const table = await student(sandboxRef, ['ip', '-json', 'neigh', 'show']);
  const rows = JSON.parse(table.stdout || '[]') as Array<{
    dst: string;
    lladdr?: string;
    state: string[];
  }>;
  return rows.filter((r) => r.lladdr && !r.state.includes('FAILED'));
}

async function teardown() {
  for (const [ref, sessionId] of [
    [SANDBOX_A, SESSION_A],
    [SANDBOX_B, SESSION_B],
  ] as const) {
    const info = await runtime.inspect(ref).catch(() => null);
    if (info && info.labels[CONTAINER_SESSION_LABEL] !== sessionId) continue;
    await provider.destroySandbox(ref, sessionId).catch(() => undefined);
  }
}

/** Repoint the poller, as a student would, and let it pick the change up. */
async function solve(sandboxRef: string) {
  const segment = await segmentOf(sandboxRef);
  const conf = await root(sandboxRef, ['cat', CONF]);
  const fixed = conf.stdout.replace(
    /settlement_endpoint\s*=.*/,
    `settlement_endpoint = ${segment.firstUsable}:9200`,
  );
  await root(sandboxRef, ['tee', CONF], fixed);

  // The poller re-reads its configuration every cycle, so the change lands on
  // its own. Wait for the evidence rather than for a fixed number of seconds:
  // the first cycle after the edit can still see resolution in progress, and a
  // loaded machine stretches every cycle. Bounded, so a lab that genuinely
  // never reaches its endpoint fails here instead of hanging.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const log = await root(sandboxRef, ['cat', '/var/log/jumptotech/settlement.log']);
    if (log.stdout.includes('status=routable neighbour=resolved')) return segment;
    await sleep(3_000);
  }
  throw new Error('the poller never recorded a routable, resolved endpoint');
}

describe.skipIf(!ENABLED)('NET-005 end to end, against a real daemon', () => {
  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'networking', 'net-005-routing-reachability', 'lab.yaml'),
    );
    if (!(await runtime.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not built`);
    }
  }, 120_000);

  afterAll(async () => {
    await teardown();
  }, 120_000);

  // ---------------------------------------------------- 1. the whole journey

  it('start, fail, diagnose, repair, pass, break, fail, reset, fail, repair, pass', async () => {
    const context = contextFor(SESSION_A, SANDBOX_A);

    const created = await provider.create(context);
    expect(created.ok, JSON.stringify(created.steps)).toBe(true);

    // The seeded fault is real: the endpoint is outside every route this host
    // holds, and the routing table has one connected prefix and no default.
    const routes = await student(SANDBOX_A, ['ip', 'route', 'show']);
    expect(routes.stdout).not.toMatch(/default/);
    // `-v` matters: without it nc is silent, and the reason would be lost.
    const reach = await student(SANDBOX_A, ['nc', '-w', '2', '-v', BAD, '9200']);
    expect(reach.exitCode).not.toBe(0);
    expect(`${reach.stderr}${reach.stdout}`).toMatch(/unreachable/i);

    const before = await check(context);
    expect(before.passed).toBe(false);

    // The student's repair, at the layer the fault was introduced.
    await solve(SANDBOX_A);

    const after = await check(context);
    expect(after.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(after.passed).toBe(true);

    // Put the fault back: the lab must fail again immediately.
    const conf = await root(SANDBOX_A, ['cat', CONF]);
    await root(
      SANDBOX_A,
      ['tee', CONF],
      conf.stdout.replace(/settlement_endpoint\s*=.*/, `settlement_endpoint = ${BAD}:9200`),
    );
    const broken = await check(context);
    expect(broken.passed).toBe(false);

    // Reset restores the fixture — and with it, a failing lab.
    const reset = await provider.reset(context);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);
    const restoredConf = await root(SANDBOX_A, ['cat', CONF]);
    expect(restoredConf.stdout).toContain(BAD);

    const afterReset = await check(context);
    expect(afterReset.passed).toBe(false);

    // And it can be solved again from the restored baseline.
    await solve(SANDBOX_A);
    expect((await check(context)).passed).toBe(true);
  }, 900_000);

  // ------------------------------------------- 2. the fixture cannot self-pass

  it('leaves no resolved neighbour however long the seeded poller runs', async () => {
    const context = contextFor(SESSION_B, SANDBOX_B);
    const created = await provider.create(context);
    expect(created.ok, JSON.stringify(created.steps)).toBe(true);

    // Let the seeded poller complete several cycles against the unreachable
    // endpoint. This is the anti-false-positive claim, tested rather than
    // reasoned about: a destination with no route never reaches resolution.
    await sleep(16_000);

    const log = await root(SANDBOX_B, ['cat', '/var/log/jumptotech/settlement.log']);
    expect(log.stdout).toMatch(/status=unreachable neighbour=none/);
    expect(log.stdout).not.toMatch(/status=routable/);

    expect(await resolvedNeighbours(SANDBOX_B)).toEqual([]);
    expect((await check(context)).passed).toBe(false);

    // Restarting the poller changes nothing: it re-reads the same bad endpoint.
    await root(SANDBOX_B, ['sv', 'restart', 'settlement-poller']).catch(() => undefined);
    await sleep(12_000);

    expect(await resolvedNeighbours(SANDBOX_B)).toEqual([]);
    expect((await check(context)).passed).toBe(false);
  }, 600_000);

  // --------------------------------------------------------- 3. isolation

  it('keeps two students on separate segments, and one cannot satisfy the other', async () => {
    const a = contextFor(SESSION_A, SANDBOX_A);
    const b = contextFor(SESSION_B, SANDBOX_B);
    if (!(await runtime.inspect(SANDBOX_A))) await provider.create(a);
    if (!(await runtime.inspect(SANDBOX_B))) await provider.create(b);

    expect(NETWORK_A).not.toBe(NETWORK_B);
    const netA = await runtime.networkInspect(NETWORK_A);
    const netB = await runtime.networkInspect(NETWORK_B);
    expect(netA?.id).not.toBe(netB?.id);

    // Solve only in B, and put A firmly back to its broken baseline.
    await solve(SANDBOX_B);
    const confA = await root(SANDBOX_A, ['cat', CONF]);
    await root(
      SANDBOX_A,
      ['tee', CONF],
      confA.stdout.replace(/settlement_endpoint\s*=.*/, `settlement_endpoint = ${BAD}:9200`),
    );

    expect((await check(b)).passed).toBe(true);
    expect((await check(a)).passed).toBe(false);

    // A cannot reach B's host either: separate bridges, no route between them.
    const segmentB = await segmentOf(SANDBOX_B);
    const reach = await student(SANDBOX_A, ['nc', '-w', '2', '-v', segmentB.own, '9120']);
    expect(reach.exitCode).not.toBe(0);

    // Ending A leaves B untouched and still passing.
    await provider.destroySandbox(SANDBOX_A, SESSION_A);
    expect(await runtime.networkInspect(NETWORK_A)).toBeNull();
    expect(await runtime.networkInspect(NETWORK_B)).not.toBeNull();
    expect((await check(b)).passed).toBe(true);
  }, 900_000);

  // ------------------------------------------------------------ 4. cleanup

  it('leaves no orphan container or network behind', async () => {
    await teardown();

    expect(await runtime.networkInspect(NETWORK_A)).toBeNull();
    expect(await runtime.networkInspect(NETWORK_B)).toBeNull();
    expect(await runtime.inspect(SANDBOX_A)).toBeNull();
    expect(await runtime.inspect(SANDBOX_B)).toBeNull();
  }, 300_000);
});
