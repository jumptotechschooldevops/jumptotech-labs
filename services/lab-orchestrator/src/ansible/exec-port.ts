/**
 * The narrow slice of a container runtime that Ansible verification needs.
 *
 * Deliberately two methods rather than the whole runtime. Verification reads:
 * it execs allow-listed commands inside containers that already exist and asks
 * whether the control node is up. It never creates, removes, or relabels
 * anything, and a port that cannot express those operations is the simplest
 * way to keep it that way.
 *
 * `DockerRuntimeExecPort` below adapts the platform's own
 * `ContainerRuntimePort` to this shape, so Ansible reads go through exactly
 * the same validated `docker exec` path as every other provider's reads.
 */
import type { ContainerRuntimePort } from '../providers/container/runtime.js';

export interface AnsibleExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the runtime killed the command at its deadline. */
  timedOut: boolean;
}

export interface AnsibleExecSpec {
  container: string;
  argv: string[];
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface AnsibleExecPort {
  exec(spec: AnsibleExecSpec): Promise<AnsibleExecResult>;
  /** `null` when the container does not exist; `{ running }` when it does. */
  inspectContainer(name: string): Promise<{ running: boolean } | null>;
}

/** Adapts the platform's container runtime to the read-only shape above. */
export class DockerRuntimeExecPort implements AnsibleExecPort {
  readonly #runtime: ContainerRuntimePort;

  constructor(runtime: ContainerRuntimePort) {
    this.#runtime = runtime;
  }

  async exec(spec: AnsibleExecSpec): Promise<AnsibleExecResult> {
    const result = await this.#runtime.exec(spec.container, {
      argv: spec.argv,
      ...(spec.user ? { user: spec.user } : {}),
      ...(spec.workdir ? { workdir: spec.workdir } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  async inspectContainer(name: string): Promise<{ running: boolean } | null> {
    const info = await this.#runtime.inspect(name);
    if (!info) return null;
    return { running: info.state === 'running' };
  }
}
