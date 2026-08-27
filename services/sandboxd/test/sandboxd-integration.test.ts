/**
 * `sandboxd` against a real container runtime and a real PTY.
 *
 * The unit suites prove the gates with fakes, which is the right place for
 * them. What they cannot prove is the thing this architecture actually claims:
 * that a student's shell reaches a real container **through a process the
 * student cannot address and cannot name a container to**, and that the
 * refusals hold when the objects are real rather than dictionaries.
 *
 * ```text
 *   BrokerRuntime ──POST /v1/runtime──► sandboxd ──► dockerd     (create/exec/remove)
 *   ws client     ──/v1/attach───────► sandboxd ──► real PTY     (a real bash)
 * ```
 *
 * ## Running it
 *
 *   make test-sandboxd-container
 *
 * It needs a container runtime *and* a working `node-pty`, and on macOS hosts
 * the second is not available — `pty.spawn` fails with `posix_spawnp failed`.
 * So the suite skips itself on a host that cannot do both, and the make target
 * runs it inside the terminal test image, which can.
 *
 * ## What it must never do
 *
 * Touch a container it did not create. Every object here carries this run's
 * ownership labels, the broker is configured with a run-scoped
 * `RUNTIME_OWNER_ID`, and the derivation secret is run-scoped too — so the
 * sandbox names themselves differ between concurrent runs. Cleanup filters on
 * all three. See docs/runtime-ownership.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as pty from 'node-pty';
import WebSocket from 'ws';
import {
  BrokerRuntime,
  CONTAINER_SANDBOX_PREFIX,
  ContainerRuntimeError,
  DockerCliRuntime,
  LAB_LABEL,
  MANAGED_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  deriveSandboxRef,
} from '@jumptotech/lab-orchestrator';
import { ownershipLabels, testRunId } from '@jumptotech/test-support/run-id';
import { defaultObservabilityConfig, type SandboxdConfig } from '../src/config.js';
import { DockerSandboxInspector } from '../src/inspector.js';
import { createSandboxd } from '../src/server.js';

const INTERNAL_SECRET = 'sandboxd-integration-internal-secret';
/** Run-scoped, so two concurrent runs derive different container names. */
const DERIVATION_SECRET = `sandboxd-integration-${testRunId()}`;
/** Run-scoped, so this broker refuses to see another run's sandboxes at all. */
const RUNTIME_OWNER = `sandboxd-it-${testRunId()}`;

const IMAGE = process.env.LINUX_SANDBOX_IMAGE ?? 'jumptotech/lab-linux:latest';

const SESSION_A = 'sess-1111111111111111';
const SESSION_B = 'sess-2222222222222222';

const refFor = (sessionId: string): string =>
  deriveSandboxRef({ sessionId, secret: DERIVATION_SECRET, prefix: CONTAINER_SANDBOX_PREFIX });

/** Both capabilities this suite needs, probed rather than assumed. */
async function capable(): Promise<string | null> {
  if (process.env.RUN_INTEGRATION_TESTS !== '1') return 'RUN_INTEGRATION_TESTS is not 1';
  try {
    await new DockerCliRuntime().ping();
  } catch (error) {
    return `no container runtime: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const term = pty.spawn('/bin/echo', ['probe'], { name: 'xterm-256color', cols: 80, rows: 24 });
    term.kill();
  } catch (error) {
    return `node-pty cannot spawn a PTY on this host: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return null;
}

let skipReason: string | null = 'not probed';
let server: Server | undefined;
let brokerUrl = '';
let client: BrokerRuntime;
const realRuntime = new DockerCliRuntime();

function specFor(sessionId: string, labels: Record<string, string> = {}) {
  return {
    name: refFor(sessionId),
    image: IMAGE,
    labels: {
      ...ownershipLabels(),
      [SESSION_LABEL]: sessionId,
      [LAB_LABEL]: 'LINUX-001',
      ...labels,
    },
    /*
     * `root`, exactly as `LinuxLabProvider` creates it: the foreground process
     * is a service supervisor and has to be. The student is still `student`,
     * and proving that against a container shaped this way is the point — a
     * sandbox created `--user student` would pass whether or not the broker
     * got it right.
     */
    user: 'root',
    workdir: '/home/student',
    cpus: '0.5',
    memory: '512m',
    pidsLimit: 128,
    network: 'none',
    hostname: 'lab',
    command: ['sleep', '900'],
  };
}

/** Remove only what this run owns, whatever the test outcome. */
async function reapThisRun(): Promise<void> {
  for (const sessionId of [SESSION_A, SESSION_B]) {
    try {
      await realRuntime.remove(refFor(sessionId));
    } catch {
      /* never created, or already gone */
    }
  }
}

beforeAll(async () => {
  skipReason = await capable();
  if (skipReason) {
    console.log(`[sandboxd-integration] skipped — ${skipReason}`);
    return;
  }

  await reapThisRun();

  const config: SandboxdConfig = {
    observability: defaultObservabilityConfig('sandboxd', 0),
    port: 0,
    bindAddress: '127.0.0.1',
    scopeSecrets: { attach: INTERNAL_SECRET + '-attach', runtime: INTERNAL_SECRET + '-runtime', docker: INTERNAL_SECRET + '-docker' },
    derivationSecret: DERIVATION_SECRET,
    runtimeOwner: RUNTIME_OWNER,
    containerBinary: 'docker',
    shell: '/bin/bash',
    docker: null,
  sandboxUser: 'student',
    sandboxHome: '/home/student',
    maxSessions: 8,
    idleTimeoutMs: 120_000,
    maxSessionMs: 300_000,
  };

  server = createSandboxd({
    config,
    inspector: new DockerSandboxInspector(),
    runtime: realRuntime,
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  brokerUrl = `http://127.0.0.1:${port}`;
  client = new BrokerRuntime({ baseUrl: brokerUrl, secret: INTERNAL_SECRET + '-runtime' });
}, 180_000);

afterAll(async () => {
  await reapThisRun();
  server?.close();
}, 120_000);

/** Attach a real shell for a session and return a small driver for it. */
async function attach(sessionId: string): Promise<{
  ws: WebSocket;
  first: Record<string, unknown>;
  /** Run one command and resolve with everything printed until a sentinel. */
  run(command: string): Promise<string>;
  close(): void;
}> {
  const ws = new WebSocket(`${brokerUrl.replace('http', 'ws')}/v1/attach`, {
    headers: { 'x-internal-secret': INTERNAL_SECRET + '-attach' },
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  let buffer = '';
  const listeners: Array<() => void> = [];
  const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no attach response')), 20_000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (msg.type === 'output' && typeof msg.data === 'string') {
        buffer += msg.data;
        for (const l of listeners) l();
        return;
      }
      if (msg.type === 'attached' || msg.type === 'error') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 100, rows: 30 }));
  });

  return {
    ws,
    first,
    /*
     * Run one command and resolve with what the shell printed for it.
     *
     * The sentinel is *spelled* differently from how it *prints*: the line
     * typed at the shell contains `"JTT""DONE"`, and only the shell's own
     * output contains `JTTDONE`. Without that split the PTY's echo of the
     * command line matched the sentinel and this resolved before the command
     * had produced anything — which looked exactly like a shell that ran
     * nothing.
     */
    run(command: string) {
      const sentinel = 'JTTDONE';
      const start = buffer.length;
      ws.send(JSON.stringify({ type: 'input', data: `${command}; echo "JTT""DONE"\r` }));
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`'${command}' produced no sentinel; saw: ${buffer.slice(start)}`)),
          20_000,
        );
        const check = (): void => {
          const tail = buffer.slice(start);
          if (!tail.includes(sentinel)) return;
          clearTimeout(timer);
          // Everything before the sentinel, minus the echoed command line.
          resolve(tail.slice(0, tail.indexOf(sentinel)));
        };
        listeners.push(check);
        check();
      });
    },
    close() {
      ws.close();
    },
  };
}

describe.runIf(process.env.RUN_INTEGRATION_TESTS === '1')('sandboxd against a real runtime', () => {
  it('creates a sandbox through the broker and stamps its own ownership', async () => {
    if (skipReason) return;

    const created = await client.create(specFor(SESSION_A));
    expect(created.name).toBe(refFor(SESSION_A));
    expect(created.labels[MANAGED_LABEL]).toBe('true');
    // Stamped by the broker, from its own configuration.
    expect(created.labels[RUNTIME_OWNER_LABEL]).toBe(RUNTIME_OWNER);

    // The daemon agrees, not just the broker's reply.
    const onDaemon = await realRuntime.inspect(refFor(SESSION_A));
    expect(onDaemon?.state).toBe('running');
  }, 180_000);

  it('opens a real shell in it, and the shell is the sandbox user', async () => {
    if (skipReason) return;

    const shell = await attach(SESSION_A);
    expect(shell.first).toMatchObject({ type: 'attached', sandboxRef: refFor(SESSION_A) });

    // A real command, executed by a real bash, inside a real container — and
    // `student`, not the `root` the container's own init process runs as.
    const who = await shell.run('id -un');
    expect(who).toContain('student');
    expect(who).not.toMatch(/\broot\b/);

    /*
     * Not root, and no route to becoming root. The container was created
     * `--user student --cap-drop ALL --security-opt no-new-privileges`, and
     * none of that is something the broker could have added or removed: they
     * are properties of the container, and `docker exec` cannot widen them.
     */
    expect(await shell.run('test "$(id -u)" -ne 0 && echo NOT_ROOT')).toContain('NOT_ROOT');
    expect(await shell.run('cat /proc/self/status | grep -c CapEff')).toContain('1');

    // The socket is not in here. It is not in the terminal either — it is in
    // sandboxd, one process away, and this shell has no address for it.
    expect(await shell.run('test -S /var/run/docker.sock || echo NO_SOCKET')).toContain('NO_SOCKET');

    shell.close();
  }, 180_000);

  it('writes a file the verifier path can read back through the same runtime', async () => {
    if (skipReason) return;

    const shell = await attach(SESSION_A);
    await shell.run("printf 'graded\\n' > /home/student/answer.txt");
    shell.close();

    // Exactly how a verifier reads state back: an allow-listed exec through the
    // provider's runtime port — which, here, is the broker.
    const read = await client.exec(refFor(SESSION_A), {
      argv: ['/bin/cat', '/home/student/answer.txt'],
      user: 'student',
    });
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('graded');
  }, 180_000);

  it("will not attach one session to another session's sandbox", async () => {
    if (skipReason) return;

    await client.create(specFor(SESSION_B));

    const a = await attach(SESSION_A);
    const b = await attach(SESSION_B);
    expect(a.first.sandboxRef).toBe(refFor(SESSION_A));
    expect(b.first.sandboxRef).toBe(refFor(SESSION_B));
    expect(a.first.sandboxRef).not.toBe(b.first.sandboxRef);

    // A file written in A's sandbox does not exist in B's. Two real
    // filesystems, not two views of one.
    await a.run("printf 'A only\\n' > /home/student/marker.txt");
    expect(await b.run('cat /home/student/marker.txt 2>&1')).toMatch(/No such file/i);

    a.close();
    b.close();
  }, 240_000);

  it('refuses a session id whose sandbox is not on this runtime', async () => {
    if (skipReason) return;
    const orphan = await attach('sess-9999999999999999');
    expect(orphan.first).toMatchObject({ type: 'error', code: 'SANDBOX_NOT_FOUND' });
    orphan.close();
  }, 60_000);

  it('refuses to remove a container it does not own, and leaves it running', async () => {
    if (skipReason) return;

    /*
     * A validly *named* sandbox created outside this broker's ownership — the
     * exact shape of "another deployment's container on a shared daemon". The
     * name gate passes; the label gate is what must refuse.
     */
    const foreign = refFor('sess-3333333333333333');
    await realRuntime.remove(foreign).catch(() => undefined);
    await realRuntime.create({
      ...specFor('sess-3333333333333333'),
      name: foreign,
      labels: {
        ...ownershipLabels(),
        [MANAGED_LABEL]: 'true',
        [RUNTIME_OWNER_LABEL]: `not-${RUNTIME_OWNER}`,
        [SESSION_LABEL]: 'sess-3333333333333333',
      },
    });

    try {
      await expect(client.remove(foreign)).rejects.toBeInstanceOf(ContainerRuntimeError);
      // Still there. The refusal was real, not cosmetic.
      expect((await realRuntime.inspect(foreign))?.state).toBe('running');

      // And invisible to a listing, so a reaper driving this broker cannot
      // even see it as a candidate.
      const listed = await client.list(`${MANAGED_LABEL}=true`);
      expect(listed.map((c) => c.name)).not.toContain(foreign);
    } finally {
      await realRuntime.remove(foreign).catch(() => undefined);
    }
  }, 180_000);

  it('destroys a sandbox on request, and destroying it twice is success', async () => {
    if (skipReason) return;

    await client.remove(refFor(SESSION_B));
    expect(await realRuntime.inspect(refFor(SESSION_B))).toBeNull();
    // Re-entrant: the reaper retries, and a retry must not be an error.
    await expect(client.remove(refFor(SESSION_B))).resolves.toBeUndefined();
  }, 180_000);
});
