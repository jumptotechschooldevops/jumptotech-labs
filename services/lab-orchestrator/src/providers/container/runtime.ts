/**
 * The container runtime seam.
 *
 * `ContainerRuntimePort` is to the container providers what `KubernetesPort` is
 * to the Kubernetes provider: a narrow, testable interface so provider logic
 * can be exercised against an in-memory fake, while production talks to a real
 * daemon. Anything that depends on the daemon actually *enforcing* something —
 * pids limits, memory ceilings, `--network none` — is asserted against a real
 * Docker in the integration suite, never against the fake.
 *
 * `DockerCliRuntime` is the one implementation today. Two properties it must
 * keep:
 *
 *   - **Every invocation is an argv array with `shell: false`.** No string is
 *     ever interpolated into a command line, so a path or an image name can
 *     never become syntax.
 *   - **Nothing here takes an identifier from a browser.** Container names are
 *     derived server-side from the session id, validated against
 *     `CONTAINER_SANDBOX_PATTERN`, and re-checked against ownership labels
 *     before anything destructive.
 *
 * Honest limitation, stated once here and again in the README: this drives the
 * *host's* Docker daemon. Container isolation is not VM-grade tenant isolation,
 * and the orchestrator process holding daemon access is a development-only
 * arrangement — production would put a rootless, per-tenant daemon behind a
 * dedicated broker service.
 */
import { execFile } from 'node:child_process';
import { assertValidContainerSandboxRef } from '../../session/identifiers.js';

export const MANAGED_CONTAINER_LABEL = 'jumptotech.io/managed';
export const CONTAINER_SESSION_LABEL = 'jumptotech.io/session-id';
export const CONTAINER_LAB_LABEL = 'jumptotech.io/lab-id';
export const CONTAINER_EXPIRES_LABEL = 'jumptotech.io/expires-at';
export const CONTAINER_PROVIDER_LABEL = 'jumptotech.io/provider';

export const MANAGED_CONTAINER_SELECTOR = `${MANAGED_CONTAINER_LABEL}=true`;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap on anything read out of a sandbox, so a huge file cannot exhaust the API. */
export const MAX_SANDBOX_READ_BYTES = 64 * 1024;

export interface ContainerSpec {
  /** Container name — the session's sandbox reference. */
  name: string;
  image: string;
  labels: Record<string, string>;
  user: string;
  workdir: string;
  /** `--cpus`. */
  cpus: string;
  /** `--memory`. */
  memory: string;
  pidsLimit: number;
  /** `--network`; `none` unless a lab genuinely needs egress. */
  network: string;
  hostname: string;
  env?: Record<string, string>;
  /** Long-running foreground process that keeps the sandbox alive. */
  command: string[];
}

export interface ContainerInfo {
  name: string;
  /** Full container id. Never leaves the orchestrator. */
  id: string;
  /** `running` | `exited` | `created` | … */
  state: string;
  image: string;
  labels: Record<string, string>;
}

export interface ContainerExecRequest {
  argv: string[];
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Written to the process' stdin, for `tee`-style file seeding. */
  stdin?: string;
  maxBufferBytes?: number;
}

export interface ContainerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class ContainerRuntimeError extends Error {
  readonly code = 'CONTAINER_RUNTIME_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ContainerRuntimeError';
  }
}

export interface ContainerRuntimePort {
  readonly name: string;
  /** Throws when the daemon cannot be reached. Resolves to its version. */
  ping(): Promise<string>;
  imageExists(image: string): Promise<boolean>;
  create(spec: ContainerSpec): Promise<ContainerInfo>;
  inspect(name: string): Promise<ContainerInfo | null>;
  /** Every container carrying a label selector, e.g. the platform's own. */
  list(labelSelector: string): Promise<ContainerInfo[]>;
  remove(name: string): Promise<void>;
  exec(name: string, request: ContainerExecRequest): Promise<ContainerExecResult>;
}

// ---------------------------------------------------------------------------

export interface DockerCliOptions {
  /** Path to the CLI. Not configurable from any request. */
  binary?: string;
  timeoutMs?: number;
  /** Injected in tests. */
  run?: (argv: string[], options: { timeoutMs: number; stdin?: string; maxBufferBytes?: number }) => Promise<ContainerExecResult>;
}

export class DockerCliRuntime implements ContainerRuntimePort {
  readonly name = 'docker';
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #run: NonNullable<DockerCliOptions['run']>;

  constructor(options: DockerCliOptions = {}) {
    this.#binary = options.binary ?? 'docker';
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#run = options.run ?? ((argv, opts) => runProcess(this.#binary, argv, opts));
  }

  async ping(): Promise<string> {
    const result = await this.#docker(['version', '--format', '{{.Server.Version}}']);
    if (result.exitCode !== 0) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || 'the Docker daemon did not respond',
      );
    }
    return result.stdout.trim();
  }

  async imageExists(image: string): Promise<boolean> {
    assertImageReference(image);
    const result = await this.#docker(['image', 'inspect', image, '--format', '{{.Id}}']);
    return result.exitCode === 0;
  }

  async create(spec: ContainerSpec): Promise<ContainerInfo> {
    assertValidContainerSandboxRef(spec.name);
    assertImageReference(spec.image);

    const argv = [
      'run',
      '--detach',
      '--name',
      spec.name,
      '--hostname',
      spec.hostname,
      // Isolation and blast radius. Every one of these is deliberate:
      //  · no host filesystem is mounted, and no bind mount is ever added;
      //  · the Docker socket is never passed in — a student cannot reach the daemon;
      //  · no capabilities, and no way to regain any through setuid binaries;
      //  · the sandbox runs as an unprivileged user, never root.
      '--network',
      spec.network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--user',
      spec.user,
      '--workdir',
      spec.workdir,
      // Resource bounds (PLATFORM-004 §18). `--memory-swap` equal to `--memory`
      // disables swap growth, so the ceiling is a real ceiling.
      '--cpus',
      spec.cpus,
      '--memory',
      spec.memory,
      '--memory-swap',
      spec.memory,
      '--pids-limit',
      String(spec.pidsLimit),
      '--restart',
      'no',
    ];

    for (const [key, value] of Object.entries(spec.labels)) {
      argv.push('--label', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      assertEnvName(key);
      argv.push('--env', `${key}=${value}`);
    }
    argv.push(spec.image, ...spec.command);

    const result = await this.#docker(argv, { timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || `docker run exited with code ${result.exitCode}`,
      );
    }

    const info = await this.inspect(spec.name);
    if (!info) {
      throw new ContainerRuntimeError(`container ${spec.name} did not appear after creation`);
    }
    return info;
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    assertValidContainerSandboxRef(name);
    const result = await this.#docker([
      'inspect',
      '--type',
      'container',
      '--format',
      '{{.Id}}\t{{.State.Status}}\t{{.Config.Image}}\t{{json .Config.Labels}}',
      name,
    ]);
    if (result.exitCode !== 0) return null;

    const [id, state, image, labelsJson] = result.stdout.trim().split('\t');
    if (!id) return null;
    return {
      name,
      id,
      state: state ?? 'unknown',
      image: image ?? '',
      labels: parseLabelsJson(labelsJson),
    };
  }

  async list(labelSelector: string): Promise<ContainerInfo[]> {
    const result = await this.#docker([
      'ps',
      '--all',
      '--filter',
      `label=${labelSelector}`,
      '--format',
      '{{.Names}}',
    ]);
    if (result.exitCode !== 0) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || 'could not list containers',
      );
    }

    const names = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const found: ContainerInfo[] = [];
    for (const name of names) {
      // Name-shape gate first: a container someone else labelled by hand never
      // enters the cleanup work list.
      try {
        assertValidContainerSandboxRef(name);
      } catch {
        continue;
      }
      const info = await this.inspect(name);
      if (info) found.push(info);
    }
    return found;
  }

  async remove(name: string): Promise<void> {
    assertValidContainerSandboxRef(name);
    const result = await this.#docker(['rm', '--force', '--volumes', name], {
      timeoutMs: 60_000,
    });
    // "No such container" is success: teardown is re-entrant by design.
    if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
      throw new ContainerRuntimeError(
        result.stderr.trim() || `docker rm exited with code ${result.exitCode}`,
      );
    }
  }

  async exec(name: string, request: ContainerExecRequest): Promise<ContainerExecResult> {
    assertValidContainerSandboxRef(name);
    if (!Array.isArray(request.argv) || request.argv.length === 0) {
      throw new ContainerRuntimeError('exec requires a non-empty argv array');
    }
    if (request.argv.some((arg) => typeof arg !== 'string')) {
      throw new ContainerRuntimeError('exec argv must contain only strings');
    }

    const argv = ['exec'];
    if (request.stdin !== undefined) argv.push('--interactive');
    if (request.user) {
      assertUserName(request.user);
      argv.push('--user', request.user);
    }
    if (request.workdir) argv.push('--workdir', request.workdir);
    for (const [key, value] of Object.entries(request.env ?? {})) {
      assertEnvName(key);
      argv.push('--env', `${key}=${value}`);
    }
    argv.push(name, ...request.argv);

    return this.#docker(argv, {
      timeoutMs: request.timeoutMs ?? this.#timeoutMs,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.maxBufferBytes !== undefined ? { maxBufferBytes: request.maxBufferBytes } : {}),
    });
  }

  #docker(
    argv: string[],
    options: { timeoutMs?: number; stdin?: string; maxBufferBytes?: number } = {},
  ): Promise<ContainerExecResult> {
    return this.#run(argv, {
      timeoutMs: options.timeoutMs ?? this.#timeoutMs,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.maxBufferBytes !== undefined ? { maxBufferBytes: options.maxBufferBytes } : {}),
    });
  }
}

// --- helpers ---------------------------------------------------------------

function runProcess(
  binary: string,
  argv: string[],
  options: { timeoutMs: number; stdin?: string; maxBufferBytes?: number },
): Promise<ContainerExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      argv,
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes ?? 4 * 1024 * 1024,
        shell: false,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? '/tmp',
          ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
        },
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
        let exitCode = 0;
        if (error) {
          const code = (error as { code?: unknown }).code;
          exitCode = typeof code === 'number' ? code : 1;
        }
        resolve({
          exitCode,
          stdout: String(stdout),
          stderr: String(stderr) || (error && exitCode !== 0 ? error.message : ''),
          timedOut,
        });
      },
    );

    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.stdin);
    }
  });
}

function parseLabelsJson(raw: string | undefined): Record<string, string> {
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

const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\-/]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

export function assertImageReference(image: unknown): string {
  if (typeof image !== 'string' || !IMAGE_PATTERN.test(image)) {
    throw new ContainerRuntimeError(`'${String(image)}' is not a valid container image reference`);
  }
  return image;
}

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export function assertUserName(user: unknown): string {
  if (typeof user !== 'string' || !USER_PATTERN.test(user)) {
    throw new ContainerRuntimeError(`'${String(user)}' is not a valid sandbox user name`);
  }
  return user;
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function assertEnvName(name: unknown): string {
  if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name)) {
    throw new ContainerRuntimeError(`'${String(name)}' is not a valid environment variable name`);
  }
  return name;
}
