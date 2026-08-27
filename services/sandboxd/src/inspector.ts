/**
 * `docker inspect` for one candidate sandbox.
 *
 * Kept to a single method on purpose. `sandboxd` needs exactly one fact about
 * the runtime — "is there a container by this derived name, and whose is it" —
 * and giving this module any more reach would make it a general daemon proxy,
 * which is the thing the service exists to avoid being.
 *
 * The name is shape-checked before it reaches an argv, `shell: false` means no
 * string is ever parsed as a command line, and the environment handed to the
 * child carries `DOCKER_HOST` only so an operator can point this service at a
 * dedicated runtime node rather than a local socket.
 */
import { execFile } from 'node:child_process';
import { assertValidContainerSandboxRef } from '@jumptotech/lab-orchestrator';
import type { SandboxInspectorPort, SandboxSnapshot } from './attach.js';

const FORMAT = '{{.State.Status}}\t{{.Config.User}}\t{{.Config.WorkingDir}}\t{{json .Config.Labels}}';

export interface DockerInspectorOptions {
  binary?: string;
  timeoutMs?: number;
}

export class DockerSandboxInspector implements SandboxInspectorPort {
  readonly #binary: string;
  readonly #timeoutMs: number;

  constructor(options: DockerInspectorOptions = {}) {
    this.#binary = options.binary ?? 'docker';
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Resolves to the daemon's version, or throws. Used by `/health`. */
  async ping(): Promise<string> {
    const { code, stdout, stderr } = await this.#run([
      'version',
      '--format',
      '{{.Server.Version}}',
    ]);
    if (code !== 0) throw new Error(stderr.trim() || 'the container runtime did not respond');
    return stdout.trim();
  }

  async inspect(ref: string): Promise<SandboxSnapshot | null> {
    assertValidContainerSandboxRef(ref);
    const { code, stdout } = await this.#run([
      'inspect',
      '--type',
      'container',
      '--format',
      FORMAT,
      ref,
    ]);
    // "No such container" is a null, not an error: an expired session asking
    // for its sandbox is ordinary, and the caller renders it as a refusal.
    if (code !== 0) return null;

    const [state, user, workdir, labelsJson] = stdout.trim().split('\t');
    if (state === undefined) return null;
    return {
      state: state || 'unknown',
      user: user ?? '',
      workdir: workdir ?? '',
      labels: parseLabels(labelsJson),
    };
  }

  #run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        this.#binary,
        argv,
        {
          timeout: this.#timeoutMs,
          maxBuffer: 1024 * 1024,
          shell: false,
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: process.env.HOME ?? '/tmp',
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
            ...(process.env.DOCKER_CERT_PATH
              ? { DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH }
              : {}),
            ...(process.env.DOCKER_TLS_VERIFY
              ? { DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY }
              : {}),
          },
        },
        (error, stdout, stderr) => {
          let code = 0;
          if (error) {
            const raw = (error as { code?: unknown }).code;
            code = typeof raw === 'number' ? raw : 1;
          }
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }
}

function parseLabels(raw: string | undefined): Record<string, string> {
  if (!raw || raw === 'null') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') labels[key] = value;
    }
    return labels;
  } catch {
    return {};
  }
}
