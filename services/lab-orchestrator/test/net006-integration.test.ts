/**
 * NET-006 against a real Docker daemon.
 *
 * Two claims here need a real kernel rather than a fake. First, that `ss`
 * inside the sandbox really reports the bind address the way the verifier
 * parses it — including the `*` Linux prints for an IPv6 wildcard, which is not
 * the `[::]` one might expect. Second, and more important: that two students
 * running this lab *on the same port at the same time* are graded from their
 * own socket tables and never from a port number looked up somewhere global.
 * That second one is the failure mode a port-based check invites, so it is
 * tested rather than reasoned about.
 *
 * Drives the production provider and the production verifier.
 *
 * Tier: E2E (PLATFORM-006). Gated on RUN_INTEGRATION_TESTS=1.
 *
 * What it mutates on the shared daemon, and nothing else:
 *   · two sandbox containers, named from this run's id
 *   · the two `jtt-net-*` lab networks the provider derives from those names
 *
 * Names derive from `testRunId()`. The run id cannot appear literally in either
 * — `jtt-lab-<hex>` and `sess-<hex>` are hex-only by platform rule — so teardown
 * proves ownership by re-reading the container's own session label.
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

const IMAGE = process.env.NET006_E2E_IMAGE ?? 'jumptotech/lab-linux:net004-e2e';
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

const RUN_HEX = createHash('sha256').update(testRunId()).digest('hex').slice(0, 12);
const SANDBOX_A = `jtt-lab-${RUN_HEX}d1`;
const SANDBOX_B = `jtt-lab-${RUN_HEX}d2`;
const SESSION_A = `sess-${RUN_HEX}d1`;
const SESSION_B = `sess-${RUN_HEX}d2`;
const NETWORK_A = networkRefForSandbox(SANDBOX_A);
const NETWORK_B = networkRefForSandbox(SANDBOX_B);

const CONF = '/etc/payments/api.conf';

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

/** The bind address of the TCP listener on a port, as the kernel reports it. */
async function bindAddressOf(sandboxRef: string, port: number): Promise<string | undefined> {
  const result = await student(sandboxRef, ['ss', '-H', '-l', '-t', '-n']);
  for (const line of result.stdout.split('\n')) {
    const columns = line.trim().split(/\s+/);
    const local = columns[3] ?? '';
    const separator = local.lastIndexOf(':');
    if (separator < 0) continue;
    if (Number(local.slice(separator + 1)) === port) return local.slice(0, separator);
  }
  return undefined;
}

/**
 * Set the bind address and restart the service, as the brief describes.
 *
 * Waits for the *expected* address rather than for any listener: for a moment
 * after the restart the previous socket is still bound, and accepting that
 * would race the check that follows.
 */
async function setBindAddress(sandboxRef: string, address: string, expected = address) {
  const conf = await root(sandboxRef, ['cat', CONF]);
  await root(
    sandboxRef,
    ['tee', CONF],
    conf.stdout.replace(/bind_address\s*=.*/, `bind_address = ${address}`),
  );
  await root(sandboxRef, ['sv', 'restart', 'payments-api']);

  const deadline = Date.now() + 60_000;
  let observed: string | undefined;
  while (Date.now() < deadline) {
    observed = await bindAddressOf(sandboxRef, 9106);
    if (observed === expected) return;
    await sleep(2_000);
  }
  throw new Error(
    `payments-api never rebound to ${expected} (last observed: ${observed ?? 'nothing'})`,
  );
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

describe.skipIf(!ENABLED)('NET-006 end to end, against a real daemon', () => {
  beforeAll(async () => {
    lab = await loadLabDefinition(
      path.join(LABS_DIR, 'networking', 'net-006-listening-sockets', 'lab.yaml'),
    );
    if (!(await runtime.imageExists(IMAGE))) throw new Error(`${IMAGE} is not built`);
  }, 120_000);

  afterAll(async () => {
    await teardown();
  }, 120_000);

  it('start, fail, repair, pass, misbind, fail, restore, pass, reset, fail, repair, pass', async () => {
    const context = contextFor(SESSION_A, SANDBOX_A);

    const created = await provider.create(context);
    expect(created.ok, JSON.stringify(created.steps)).toBe(true);

    // --- the initial state is the fault, in the socket table ---------------
    expect(await bindAddressOf(SANDBOX_A, 9106)).toBe('127.0.0.1');
    expect(await bindAddressOf(SANDBOX_A, 9105)).toBe('0.0.0.0');

    const before = await check(context);
    expect(before.passed).toBe(false);

    // --- the student's repair ---------------------------------------------
    await setBindAddress(SANDBOX_A, '0.0.0.0');
    expect(await bindAddressOf(SANDBOX_A, 9106)).toBe('0.0.0.0');

    const after = await check(context);
    expect(after.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(after.passed).toBe(true);

    // --- bind it somewhere wrong again ------------------------------------
    await setBindAddress(SANDBOX_A, '127.0.0.1');
    expect((await check(context)).passed).toBe(false);

    // --- and back ----------------------------------------------------------
    await setBindAddress(SANDBOX_A, '0.0.0.0');
    expect((await check(context)).passed).toBe(true);

    // --- reset restores the fault -----------------------------------------
    const reset = await provider.reset(context);
    expect(reset.ok, JSON.stringify(reset.steps)).toBe(true);

    const restoredConf = await root(SANDBOX_A, ['cat', CONF]);
    expect(restoredConf.stdout).toContain('127.0.0.1');
    expect(await bindAddressOf(SANDBOX_A, 9106)).toBe('127.0.0.1');
    expect((await check(context)).passed).toBe(false);

    // --- and it can be solved again ---------------------------------------
    await setBindAddress(SANDBOX_A, '0.0.0.0');
    expect((await check(context)).passed).toBe(true);
  }, 900_000);

  it('accepts an IPv6 wildcard binding, which Linux reports as `*`', async () => {
    const context = contextFor(SESSION_A, SANDBOX_A);
    if (!(await runtime.inspect(SANDBOX_A))) {
      expect((await provider.create(context)).ok).toBe(true);
    }

    // A student who binds the IPv6 any-address has also made the service
    // reachable off this host, and the lab accepts either wildcard.
    await setBindAddress(SANDBOX_A, '[::]', '*');

    const observed = await bindAddressOf(SANDBOX_A, 9106);
    // The claim the verifier's normaliser rests on, checked against a real ss.
    expect(observed).toBe('*');
    expect((await check(context)).passed).toBe(true);
  }, 600_000);

  it('fails when a healthy service is taken down to make the fix', async () => {
    const context = contextFor(SESSION_A, SANDBOX_A);
    await setBindAddress(SANDBOX_A, '0.0.0.0');
    expect((await check(context)).passed).toBe(true);

    await root(SANDBOX_A, ['sv', 'stop', 'ledger-api']);
    await sleep(2_000);

    const result = await check(context);
    expect(result.passed).toBe(false);
    expect(result.checks.filter((c) => c.status !== 'pass').map((c) => c.label)).toEqual([
      'The ledger API was left alone',
    ]);

    await root(SANDBOX_A, ['sv', 'start', 'ledger-api']);
    await sleep(3_000);
    expect((await check(context)).passed).toBe(true);
  }, 600_000);

  it('grades two students on the same port from their own socket tables', async () => {
    const a = contextFor(SESSION_A, SANDBOX_A);
    const b = contextFor(SESSION_B, SANDBOX_B);
    if (!(await runtime.inspect(SANDBOX_A))) expect((await provider.create(a)).ok).toBe(true);
    expect((await provider.create(b)).ok, 'session B').toBe(true);

    expect(NETWORK_A).not.toBe(NETWORK_B);
    expect((await runtime.networkInspect(NETWORK_A))?.id).not.toBe(
      (await runtime.networkInspect(NETWORK_B))?.id,
    );

    // Both sessions use port 9106 — the same number, by design. Solve A only,
    // and put B firmly back to its broken baseline.
    await setBindAddress(SANDBOX_A, '0.0.0.0');
    await setBindAddress(SANDBOX_B, '127.0.0.1');

    expect((await check(a)).passed).toBe(true);
    expect((await check(b)).passed).toBe(false);

    // And the other way round, so neither direction leaks.
    await setBindAddress(SANDBOX_B, '0.0.0.0');
    await setBindAddress(SANDBOX_A, '127.0.0.1');

    expect((await check(b)).passed).toBe(true);
    expect((await check(a)).passed).toBe(false);

    // Ending A leaves B untouched and still passing.
    await provider.destroySandbox(SANDBOX_A, SESSION_A);
    expect(await runtime.networkInspect(NETWORK_A)).toBeNull();
    expect((await check(b)).passed).toBe(true);
  }, 900_000);

  it('leaves no orphan container or network behind', async () => {
    await teardown();

    expect(await runtime.networkInspect(NETWORK_A)).toBeNull();
    expect(await runtime.networkInspect(NETWORK_B)).toBeNull();
    expect(await runtime.inspect(SANDBOX_A)).toBeNull();
    expect(await runtime.inspect(SANDBOX_B)).toBeNull();
  }, 300_000);
});
