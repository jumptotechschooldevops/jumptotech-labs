/**
 * The attach gate.
 *
 * These are the tests that matter most in the service: every one of them is a
 * way a shell could be opened on a container that does not belong to the
 * session asking for it. The happy path is one test; the refusals are the rest.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_SANDBOX_PREFIX,
  LAB_LABEL,
  MANAGED_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  deriveSandboxRef,
} from '@jumptotech/lab-orchestrator';
import {
  AttachDeniedError,
  attachArgv,
  resolveAttachTarget,
  type SandboxSnapshot,
} from '../src/attach.js';

const SECRET = 'derivation-secret-for-tests';
const OWNER = 'jumptotech';
const SESSION_A = 'sess-aaaaaaaaaaaaaaaa';
const SESSION_B = 'sess-bbbbbbbbbbbbbbbb';

const refFor = (sessionId: string): string =>
  deriveSandboxRef({ sessionId, secret: SECRET, prefix: CONTAINER_SANDBOX_PREFIX });

function sandbox(overrides: Partial<SandboxSnapshot> & { sessionId?: string } = {}): SandboxSnapshot {
  const { sessionId = SESSION_A, ...rest } = overrides;
  return {
    state: 'running',
    user: 'student',
    workdir: '/home/student',
    labels: {
      [MANAGED_LABEL]: 'true',
      [RUNTIME_OWNER_LABEL]: OWNER,
      [SESSION_LABEL]: sessionId,
      [LAB_LABEL]: 'LINUX-001',
    },
    ...rest,
  };
}

/** An inspector holding a fixed set of containers, keyed by name. */
function inspectorOf(containers: Record<string, SandboxSnapshot>) {
  const seen: string[] = [];
  return {
    seen,
    inspect: async (ref: string) => {
      seen.push(ref);
      return containers[ref] ?? null;
    },
  };
}

const resolve = (sessionId: unknown, inspector: { inspect: (r: string) => Promise<SandboxSnapshot | null> }) =>
  resolveAttachTarget({
    sessionId,
    inspector,
    derivationSecret: SECRET,
    runtimeOwner: OWNER,
    sandboxUser: 'student',
    sandboxHome: '/home/student',
  });

describe('resolveAttachTarget', () => {
  it('attaches a session to the container derived from its own id', async () => {
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({ [ref]: sandbox() });

    const target = await resolve(SESSION_A, inspector);

    expect(target.ref).toBe(ref);
    expect(target.user).toBe('student');
    expect(target.workdir).toBe('/home/student');
    expect(target.labId).toBe('LINUX-001');
  });

  it('never asks the runtime about a container it was not asked for', async () => {
    // The point of the whole design: the only name that reaches the runtime is
    // the one derived here. A caller has no way to put a different one there.
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({ [ref]: sandbox() });

    await resolve(SESSION_A, inspector);

    expect(inspector.seen).toEqual([ref]);
  });

  it('refuses a session id that is not shaped like one', async () => {
    const inspector = inspectorOf({});
    for (const bad of ['jtt-lab-abc123', '../../etc/passwd', '', 'sess-ZZZZ', null, 42, {}]) {
      await expect(resolve(bad, inspector)).rejects.toBeInstanceOf(AttachDeniedError);
    }
    // Not one of them reached the runtime.
    expect(inspector.seen).toEqual([]);
  });

  it("refuses when the session's sandbox does not exist", async () => {
    await expect(resolve(SESSION_A, inspectorOf({}))).rejects.toMatchObject({
      code: 'SANDBOX_NOT_FOUND',
    });
  });

  it('refuses a container the platform did not create', async () => {
    const ref = refFor(SESSION_A);
    const labels = { ...sandbox().labels };
    delete labels[MANAGED_LABEL];
    const inspector = inspectorOf({ [ref]: sandbox({ labels }) });

    await expect(resolve(SESSION_A, inspector)).rejects.toMatchObject({
      code: 'SANDBOX_NOT_MANAGED',
    });
  });

  it('refuses a container belonging to a different runtime owner', async () => {
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({
      [ref]: sandbox({
        labels: { ...sandbox().labels, [RUNTIME_OWNER_LABEL]: 'someone-elses-worktree' },
      }),
    });

    await expect(resolve(SESSION_A, inspector)).rejects.toMatchObject({
      code: 'SANDBOX_NOT_OWNED',
    });
  });

  it("refuses a container carrying another session's id", async () => {
    /*
     * The derived name and the stored label disagreeing means the container at
     * that name is not this session's, whatever produced it. Cheap to check and
     * the last line between two students.
     */
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({ [ref]: sandbox({ sessionId: SESSION_B }) });

    await expect(resolve(SESSION_A, inspector)).rejects.toMatchObject({
      code: 'SANDBOX_SESSION_MISMATCH',
    });
  });

  it('gives two sessions two different containers', async () => {
    expect(refFor(SESSION_A)).not.toBe(refFor(SESSION_B));

    const inspector = inspectorOf({
      [refFor(SESSION_A)]: sandbox({ sessionId: SESSION_A }),
      [refFor(SESSION_B)]: sandbox({ sessionId: SESSION_B }),
    });

    const a = await resolve(SESSION_A, inspector);
    const b = await resolve(SESSION_B, inspector);
    expect(a.ref).not.toBe(b.ref);
  });

  it('refuses a sandbox that is not running', async () => {
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({ [ref]: sandbox({ state: 'exited' }) });

    await expect(resolve(SESSION_A, inspector)).rejects.toMatchObject({
      code: 'SANDBOX_NOT_RUNNING',
    });
  });

  it("attaches as the policy user even when the container's init process is root", async () => {
    /*
     * The regression this file exists for as much as any refusal above.
     *
     * A Linux sandbox's foreground process is a real service supervisor and is
     * deliberately created `--user root`. The student is never that account —
     * the terminal service has always attached with `--user student`. Reading
     * `Config.User` back and using it handed every Linux, CS, Networking and
     * AWS student a root shell, and nothing failed: the lab started, the
     * terminal opened, and the prompt said `root@lab`.
     */
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({ [ref]: sandbox({ user: 'root' }) });

    const target = await resolve(SESSION_A, inspector);

    expect(target.user).toBe('student');
    expect(attachArgv(target, { shell: '/bin/bash' })).not.toContain('root');
  });

  it('refuses to open a student shell as root, however it is configured', async () => {
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({ [ref]: sandbox() });

    await expect(
      resolveAttachTarget({
        sessionId: SESSION_A,
        inspector,
        derivationSecret: SECRET,
        runtimeOwner: OWNER,
        sandboxUser: 'root',
        sandboxHome: '/root',
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_USER_INVALID' });
  });

  it('refuses a configured user or home that could reach an argv', async () => {
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({ [ref]: sandbox() });
    const attempt = (sandboxUser: string, sandboxHome: string) =>
      resolveAttachTarget({
        sessionId: SESSION_A,
        inspector,
        derivationSecret: SECRET,
        runtimeOwner: OWNER,
        sandboxUser,
        sandboxHome,
      });

    await expect(attempt('student --privileged', '/home/student')).rejects.toMatchObject({
      code: 'SANDBOX_USER_INVALID',
    });
    await expect(attempt('student', 'home/student')).rejects.toMatchObject({
      code: 'SANDBOX_WORKDIR_INVALID',
    });
  });

  it('drops a lab id that is not shaped like one rather than passing it through', async () => {
    const ref = refFor(SESSION_A);
    const inspector = inspectorOf({
      [ref]: sandbox({ labels: { ...sandbox().labels, [LAB_LABEL]: 'a\nb --privileged' } }),
    });

    const target = await resolve(SESSION_A, inspector);
    expect(target.labId).toBe('');
  });

  it('fails closed when the derivation secret does not match the API', async () => {
    // A broker keyed differently derives a name that simply is not there.
    const inspector = inspectorOf({ [refFor(SESSION_A)]: sandbox() });

    await expect(
      resolveAttachTarget({
        sessionId: SESSION_A,
        inspector,
        derivationSecret: 'a-completely-different-secret',
        runtimeOwner: OWNER,
        sandboxUser: 'student',
        sandboxHome: '/home/student',
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
  });
});

describe('attachArgv', () => {
  const target = { ref: refFor(SESSION_A), user: 'student', workdir: '/home/student', labId: 'LINUX-001' };

  it('execs the derived container as its own user, and adds no privilege', () => {
    const argv = attachArgv(target, { shell: '/bin/bash' });

    expect(argv.slice(0, 3)).toEqual(['exec', '--interactive', '--tty']);
    expect(argv).toContain(target.ref);
    expect(argv[argv.indexOf('--user') + 1]).toBe('student');
    expect(argv[argv.indexOf('--workdir') + 1]).toBe('/home/student');

    for (const forbidden of [
      '--privileged',
      '--cap-add',
      '--volume',
      '-v',
      '--mount',
      '--network',
      '--security-opt',
      '--pid',
      '--device',
    ]) {
      expect(argv).not.toContain(forbidden);
    }
  });

  it('omits JTT_LAB_ID entirely when the label was not usable', () => {
    const argv = attachArgv({ ...target, labId: '' }, { shell: '/bin/bash' });
    expect(argv.join(' ')).not.toContain('JTT_LAB_ID');
  });

  it('puts the shell last and passes no login files', () => {
    const argv = attachArgv(target, { shell: '/bin/bash' });
    expect(argv.slice(-3)).toEqual(['/bin/bash', '--norc', '--noprofile']);
  });
});
