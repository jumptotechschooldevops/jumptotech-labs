/**
 * PLATFORM-004 — what the terminal service is allowed to spawn
 * (story test requirements 29–30).
 *
 * This is the security boundary of the generic terminal binding. The API says
 * *which sandbox* a session has; it never says what to run. Everything
 * executable is decided here, from a closed set of shapes, after re-validating
 * every field.
 *
 * The duplication is the point: the orchestrator already validates these values
 * when it mints them, and this service validates them again because it is a
 * different process. These tests assert the second check holds on its own — so
 * even a compromised API cannot talk the terminal into `exec`ing an arbitrary
 * container or running an arbitrary command.
 */
import { describe, expect, it } from 'vitest';
import {
  containerSpawnPlan,
  kubernetesSpawnPlan,
  TerminalContextError,
  type SpawnPlanOptions,
} from '../src/spawn-plan.js';

const OPTIONS: SpawnPlanOptions = {
  shell: '/bin/bash',
  containerBinary: 'docker',
  workDir: '/home/student',
  promptUser: 'student',
  promptHost: 'lab',
  labId: 'LINUX-001',
};

const CONTAINER = {
  runtime: 'docker' as const,
  containerRef: 'jtt-lab-3f9c1a7b2d40',
  user: 'student',
  workdir: '/home/student',
};

describe('the Kubernetes plan', () => {
  it('spawns a local shell pointed at this session"s kubeconfig', () => {
    const plan = kubernetesSpawnPlan(
      { namespace: 'lab-3f9c1a7b2d40' },
      '/run/jumptotech/sess-abc.kubeconfig',
      OPTIONS,
    );

    expect(plan.command).toBe('/bin/bash');
    expect(plan.args).toEqual(['--norc', '--noprofile']);
    expect(plan.env.KUBECONFIG).toBe('/run/jumptotech/sess-abc.kubeconfig');
    expect(plan.env.JTT_NAMESPACE).toBe('lab-3f9c1a7b2d40');
    expect(plan.sandboxKind).toBe('namespace');
    expect(plan.sandboxRef).toBe('lab-3f9c1a7b2d40');
  });

  it('gives the shell a minimal environment with nothing inherited', () => {
    const plan = kubernetesSpawnPlan({ namespace: 'lab-000000000001' }, '/tmp/kc', OPTIONS);

    expect(Object.keys(plan.env).sort()).toEqual([
      'HOME',
      'HOSTNAME',
      'JTT_LAB_ID',
      'JTT_NAMESPACE',
      'KUBECONFIG',
      'LANG',
      'PATH',
      'PS1',
      'SHELL',
      'TERM',
      'USER',
    ]);
  });
});

describe('the container plan', () => {
  it('builds a docker exec argv, and never a shell string', () => {
    const plan = containerSpawnPlan(CONTAINER, OPTIONS);

    expect(plan.command).toBe('docker');
    expect(plan.args.slice(0, 7)).toEqual([
      'exec',
      '--interactive',
      '--tty',
      '--user',
      'student',
      '--workdir',
      '/home/student',
    ]);
    // The container is the second-to-last argument, followed by the shell.
    expect(plan.args.slice(-4)).toEqual(['jtt-lab-3f9c1a7b2d40', '/bin/bash', '--norc', '--noprofile']);
    expect(plan.sandboxKind).toBe('container');
    expect(plan.sandboxRef).toBe('jtt-lab-3f9c1a7b2d40');
  });

  it('asks for nothing that would widen the sandbox', () => {
    const argv = containerSpawnPlan(CONTAINER, OPTIONS).args.join(' ');

    for (const forbidden of [
      '--privileged',
      '--volume',
      '-v ',
      '--mount',
      '--network',
      '--cap-add',
      '--security-opt',
      'docker.sock',
    ]) {
      expect(argv, `docker exec argv must not contain '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it('carries no credential to the exec client', () => {
    const plan = containerSpawnPlan(CONTAINER, OPTIONS);
    expect(plan.env.KUBECONFIG).toBeUndefined();
    expect(JSON.stringify(plan.env)).not.toMatch(/token|secret|kubeconfig/i);
  });

  it('refuses a container reference that is not a JumpToTech sandbox name', () => {
    for (const bad of [
      'postgres',
      'lab-3f9c1a7b2d40',
      'jtt-lab-',
      'jtt-lab-XYZ',
      'jtt-lab-3f9c1a7b2d40; rm -rf /',
      'jtt-lab-3f9c1a7b2d40 --privileged',
      '../../etc/passwd',
      '',
    ]) {
      expect(
        () => containerSpawnPlan({ ...CONTAINER, containerRef: bad }, OPTIONS),
        `expected '${bad}' to be refused`,
      ).toThrow(TerminalContextError);
    }
  });

  it('refuses a user, working directory or runtime it does not recognise', () => {
    expect(() => containerSpawnPlan({ ...CONTAINER, user: 'root; id' }, OPTIONS)).toThrow(
      /not a valid sandbox user name/,
    );
    expect(() => containerSpawnPlan({ ...CONTAINER, user: '0' }, OPTIONS)).toThrow(
      /not a valid sandbox user name/,
    );
    expect(() => containerSpawnPlan({ ...CONTAINER, workdir: 'home/student' }, OPTIONS)).toThrow(
      /not a valid sandbox working directory/,
    );
    expect(() =>
      containerSpawnPlan({ ...CONTAINER, workdir: '/home/student; cat /etc/shadow' }, OPTIONS),
    ).toThrow(/not a valid sandbox working directory/);
    expect(() =>
      containerSpawnPlan({ ...CONTAINER, runtime: 'podman' as 'docker' }, OPTIONS),
    ).toThrow(/is not supported by this terminal service/);
  });

  it('refuses environment names and values that are not ordinary', () => {
    expect(() =>
      containerSpawnPlan({ ...CONTAINER, env: { 'BAD NAME': 'x' } }, OPTIONS),
    ).toThrow(/not a valid environment variable name/);
    expect(() =>
      containerSpawnPlan({ ...CONTAINER, env: { lowercase: 'x' } }, OPTIONS),
    ).toThrow(/not a valid environment variable name/);
    // A newline could split one --env into two arguments if anything ever
    // joined these, so it is refused rather than escaped.
    expect(() =>
      containerSpawnPlan({ ...CONTAINER, env: { OK: 'value\n--privileged' } }, OPTIONS),
    ).toThrow(/not a valid environment value/);
  });

  it('passes through a valid extra environment variable', () => {
    const plan = containerSpawnPlan({ ...CONTAINER, env: { JTT_LAB_ID: 'TF-001' } }, OPTIONS);
    expect(plan.args).toContain('JTT_LAB_ID=TF-001');
  });

  it('uses the configured container binary, never one from the context', () => {
    const plan = containerSpawnPlan(CONTAINER, { ...OPTIONS, containerBinary: '/usr/bin/docker' });
    expect(plan.command).toBe('/usr/bin/docker');
    // There is no field in the context that could have supplied this.
    expect(Object.keys(CONTAINER)).not.toContain('binary');
  });
});
