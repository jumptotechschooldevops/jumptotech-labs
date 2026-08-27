/**
 * PLATFORM-006 — the host-execution guard, and the seam it protects.
 *
 * These tests exist because the defect they cover was invisible: three suites
 * constructed `KindLabProvider` with a `FakeKubernetes`, looked hermetic, and
 * quietly ran the host's real `kubectl` as part of the provider's readiness
 * step. They passed on a quiet laptop and failed whenever another worktree was
 * running its own E2E — eight failures during the PLATFORM-006 audit, with six
 * foreign sandboxes alive at the time.
 *
 * So the property under test is not "the guard has a nice error message". It is
 * **a unit test cannot reach host infrastructure, and cannot be made to reach it
 * by a fixture**.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  HostExecutionDenied,
  guardChildProcess,
  guardNodePty,
  hostExecutionAllowed,
  patchLoadedChildProcess,
} from '@jumptotech/test-support/host-execution';
import {
  ownedByThisRun,
  ownershipFilters,
  scopedName,
  scopedTmpPrefix,
  testRunId,
  TEST_RUN_LABEL,
} from '@jumptotech/test-support/run-id';
import { KindLabProvider } from '../src/index.js';
import { FakeKubernetes, fakeExec } from './fakes.js';
import { loadK8s001, sessionContext } from './helpers.js';

// ------------------------------------------------- the guard is actually on

describe('the host-execution guard is installed for this suite', () => {
  it('denies a real child process, naming the binary and argv', () => {
    // This is the exact call `KindLabProvider` used to make.
    expect(() =>
      (execFile as unknown as (c: string, a: string[]) => void)('kubectl', ['version']),
    ).toThrow(HostExecutionDenied);

    try {
      (execFile as unknown as (c: string, a: string[]) => void)('kubectl', ['version']);
    } catch (error) {
      const denied = error as HostExecutionDenied;
      expect(denied.code).toBe('HOST_EXECUTION_DENIED');
      expect(denied.command).toBe('kubectl');
      expect(denied.args).toEqual(['version']);
      // The diagnostic has to say what to do, or it just moves the confusion.
      expect(denied.message).toContain('KindProviderOptions.exec');
      expect(denied.message).toContain('RUN_INTEGRATION_TESTS=1');
    }
  });

  it('denies every process-starting entry point, not just the one we found', () => {
    // Fail closed: a future escape hatch is caught by this, not by someone
    // noticing a slow suite six months from now.
    const guarded = guardChildProcess(
      Object.fromEntries(
        ['execFile', 'exec', 'spawn', 'fork', 'execFileSync', 'execSync', 'spawnSync'].map((k) => [
          k,
          () => 'real',
        ]),
      ),
      {},
    );
    for (const api of Object.keys(guarded)) {
      expect(() => (guarded[api] as () => void)(), api).toThrow(HostExecutionDenied);
    }
  });
});

// ------------------------------------------------------------- the opt-in

describe('an integration run opts in explicitly', () => {
  it('is denied by default and allowed only by a known flag', () => {
    expect(hostExecutionAllowed({})).toBe(false);
    expect(hostExecutionAllowed({ RUN_INTEGRATION_TESTS: '1' })).toBe(true);
    expect(hostExecutionAllowed({ RUN_DOCKER_INTEGRATION_TESTS: '1' })).toBe(true);
    expect(hostExecutionAllowed({ RUN_DB_TESTS: '1' })).toBe(true);
    expect(hostExecutionAllowed({ JTT_ALLOW_HOST_EXECUTION: '1' })).toBe(true);
    // Truthy-but-not-'1' does not count: a stray `RUN_INTEGRATION_TESTS=false`
    // must not silently unlock the host.
    expect(hostExecutionAllowed({ RUN_INTEGRATION_TESTS: 'false' })).toBe(false);
    expect(hostExecutionAllowed({ RUN_INTEGRATION_TESTS: '' })).toBe(false);
  });

  it('hands back the real module untouched when allowed', () => {
    const actual = { execFile: () => 'real', spawn: () => 'real' };
    expect(guardChildProcess(actual, { RUN_INTEGRATION_TESTS: '1' })).toBe(actual);
  });
});

// ------------------------------------- the two surfaces child_process missed

describe('node-pty is guarded too, because it is not a child_process wrapper', () => {
  // `pty.spawn` is a native binding. Every call went straight past
  // `guardChildProcess`, and `services/terminal/src/shell.ts` calls it with no
  // injection seam — so the hole was reachable, not theoretical.
  it('denies every process-starting entry point node-pty offers', () => {
    const guarded = guardNodePty(
      Object.fromEntries(
        ['spawn', 'fork', 'open', 'createTerminal'].map((k) => [k, () => 'real']),
      ),
      {},
    );
    for (const api of Object.keys(guarded)) {
      expect(() => (guarded[api] as () => void)(), api).toThrow(HostExecutionDenied);
    }
  });

  it('names the surface in the diagnostic, so the fix is obvious', () => {
    const guarded = guardNodePty({ spawn: () => 'real' }, {});
    try {
      (guarded.spawn as (c: string) => void)('/bin/sh');
      expect.unreachable('node-pty spawn resolved instead of being denied');
    } catch (error) {
      expect((error as HostExecutionDenied).api).toBe('node-pty.spawn');
    }
  });

  it('hands back the real module untouched when allowed', () => {
    const actual = { spawn: () => 'real' };
    expect(guardNodePty(actual, { RUN_INTEGRATION_TESTS: '1' })).toBe(actual);
  });
});

describe('the loaded builtin is patched, for the environment mocking cannot reach', () => {
  // Under `environment: 'jsdom'` a *named* import binds to the real builtin and
  // never sees `vi.mock`, which is why `apps/web` ran unguarded. Patching the
  // module object is what closes that, so it has to keep working.
  it('replaces every entry point on the object it is handed', () => {
    const moduleExports: Record<string, unknown> = {
      execFile: () => 'real',
      spawn: () => 'real',
      execSync: () => 'real',
    };
    expect(patchLoadedChildProcess(moduleExports, {})).toBe(3);
    for (const api of Object.keys(moduleExports)) {
      expect(() => (moduleExports[api] as () => void)(), api).toThrow(HostExecutionDenied);
    }
  });

  it('leaves the module alone when an integration run has opted in', () => {
    const original = () => 'real';
    const moduleExports: Record<string, unknown> = { execFile: original };
    expect(patchLoadedChildProcess(moduleExports, { RUN_INTEGRATION_TESTS: '1' })).toBe(0);
    expect(moduleExports.execFile).toBe(original);
  });
});

// ------------------------------------------- the provider seam that leaked

describe('KindLabProvider never reaches the host on its own', () => {
  async function provision(exec = fakeExec()) {
    const provider = new KindLabProvider({
      k8s: new FakeKubernetes(),
      clusterName: 'jumptotech-labs',
      exec,
      sleep: async () => undefined,
    });
    const lab = await loadK8s001();
    return { result: await provider.create(sessionContext(lab)), exec };
  }

  it('provisions through the injected runner, and starts no process', async () => {
    const { result, exec } = await provision();

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    // The readiness step ran — against the fake, which is the whole point.
    expect(exec.calls.map((c) => c.command)).toContain('kubectl');
  });

  it('appends the namespace itself, so a runner can never choose one', async () => {
    const { exec } = await provision();
    const call = exec.calls.find((c) => c.command === 'kubectl');

    // The session's namespace is applied by the provider after the caller's
    // args. A fixture that tried to smuggle `--namespace kube-system` would be
    // followed by the real one, and cannot displace it.
    expect(call?.args.slice(-2)[0]).toBe('--namespace');
    expect(call?.args.at(-1)).toMatch(/^lab-[0-9a-f]{12}$/);
  });

  it('still refuses a binary that is not allow-listed, before any runner runs', async () => {
    const exec = fakeExec();
    const provider = new KindLabProvider({
      k8s: new FakeKubernetes(),
      clusterName: 'jumptotech-labs',
      exec,
    });
    const lab = await loadK8s001();

    await expect(
      provider.execute(sessionContext(lab), { command: 'sh', args: ['-c', 'id'] }),
    ).rejects.toThrow(/not allow-listed/);
    // The allow-list is checked first: nothing reached the runner at all.
    expect(exec.calls).toEqual([]);
  });
});

// ------------------------------------------------- run-scoped resource names

describe('integration resources are named per run, so cleanup cannot cross runs', () => {
  it('produces a stable id within a process', () => {
    expect(testRunId()).toBe(testRunId());
    expect(testRunId()).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('produces names that are Docker- and Kubernetes-legal', () => {
    const name = scopedName('lab', 'foreign');
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toContain(testRunId());
  });

  it('recognises only its own resources', () => {
    // The property that makes concurrent runs safe: a run cannot even name
    // another run's container, so its cleanup cannot delete one.
    expect(ownedByThisRun(scopedName('lab'))).toBe(true);
    expect(ownedByThisRun('jtt-lab-someoneelsesrun')).toBe(false);
    expect(ownedByThisRun(undefined)).toBe(false);
  });

  it('filters and prefixes carry the run id', () => {
    expect(ownershipFilters()).toEqual(['--filter', `label=${TEST_RUN_LABEL}=${testRunId()}`]);
    expect(scopedTmpPrefix('it')).toContain(testRunId());
  });
});
