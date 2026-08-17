/**
 * `DockerPort` backed by the `docker` CLI.
 *
 * The CLI rather than a client library, for the same reason the Kubernetes
 * provider shells out to `kubectl` for its health check: `execFile` with an
 * argv array and `shell: false` is a surface small enough to audit in one
 * sitting, and it adds no dependency that could reach the daemon on its own.
 *
 * Every invocation in this file is built from a literal argv array. Values that
 * vary — container names, labels, images — are pushed in as separate array
 * elements, never interpolated into a string, so there is no construction here
 * that could turn a value into an option or a second command.
 */
import { execFile } from 'node:child_process';
import {
  DockerOperationError,
  DockerUnavailableError,
  type DockerContainerInfo,
  type DockerExecResult,
  type DockerExecSpec,
  type DockerNetworkInfo,
  type DockerPort,
  type DockerPortBinding,
  type DockerRunSpec,
} from './docker-port.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface DockerCliOptions {
  /** Path to the docker binary. Configurable; never taken from a request. */
  binary?: string;
  /** `DOCKER_HOST` for a non-default daemon endpoint. */
  dockerHost?: string;
  defaultTimeoutMs?: number;
}

interface RawResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class DockerCli implements DockerPort {
  readonly #binary: string;
  readonly #dockerHost: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: DockerCliOptions = {}) {
    this.#binary = options.binary ?? 'docker';
    this.#dockerHost = options.dockerHost;
    this.#timeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ------------------------------------------------------------------ daemon

  async ping(): Promise<void> {
    const result = await this.#run(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new DockerUnavailableError(
        `Docker is not reachable: ${firstLine(result.stderr) || 'docker version failed'}`,
      );
    }
  }

  async version(): Promise<string> {
    const result = await this.#run(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new DockerUnavailableError(`Docker is not reachable: ${firstLine(result.stderr)}`);
    }
    return result.stdout.trim();
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await this.#run(['image', 'inspect', image, '--format', '{{.Id}}'], {
      timeoutMs: 15_000,
    });
    return result.exitCode === 0;
  }

  // ----------------------------------------------------------------- network

  async createNetwork(name: string, labels: Record<string, string>): Promise<void> {
    const argv = ['network', 'create', '--driver', 'bridge'];
    for (const [key, value] of Object.entries(labels)) argv.push('--label', `${key}=${value}`);
    argv.push(name);

    const result = await this.#run(argv);
    if (result.exitCode !== 0) {
      // Re-creating an existing sandbox must initialise it, not fail — the
      // provider contract requires create() to be idempotent.
      if (/already exists/i.test(result.stderr)) return;
      throw new DockerOperationError(`could not create network ${name}: ${firstLine(result.stderr)}`);
    }
  }

  async removeNetwork(name: string): Promise<void> {
    const result = await this.#run(['network', 'rm', name]);
    if (result.exitCode === 0) return;
    if (/no such network|not found/i.test(result.stderr)) return;
    throw new DockerOperationError(`could not remove network ${name}: ${firstLine(result.stderr)}`);
  }

  async networkExists(name: string): Promise<boolean> {
    const result = await this.#run(['network', 'inspect', name, '--format', '{{.Id}}'], {
      timeoutMs: 15_000,
    });
    return result.exitCode === 0;
  }

  async listNetworks(labelSelector: string): Promise<DockerNetworkInfo[]> {
    const result = await this.#run([
      'network',
      'ls',
      '--filter',
      `label=${labelSelector}`,
      '--format',
      '{{.Name}}\t{{.ID}}',
    ]);
    if (result.exitCode !== 0) {
      throw new DockerUnavailableError(`could not list networks: ${firstLine(result.stderr)}`);
    }

    const networks: DockerNetworkInfo[] = [];
    for (const line of nonEmptyLines(result.stdout)) {
      const [name = '', id = ''] = line.split('\t');
      networks.push({ name, id, labels: await this.#networkLabels(name) });
    }
    return networks;
  }

  async #networkLabels(name: string): Promise<Record<string, string>> {
    const result = await this.#run([
      'network',
      'inspect',
      name,
      '--format',
      '{{json .Labels}}',
    ]);
    return result.exitCode === 0 ? parseLabels(result.stdout) : {};
  }

  // --------------------------------------------------------------- container

  async runContainer(spec: DockerRunSpec): Promise<void> {
    const argv = [
      'run',
      '--detach',
      '--name',
      spec.name,
      '--hostname',
      spec.hostname,
      '--network',
      spec.network,
      '--restart',
      'no',
      // Cost + blast-radius ceilings. Every one of these is configurable
      // policy, not a literal buried in provider code.
      '--cpus',
      String(spec.cpus),
      '--memory',
      spec.memory,
      '--memory-swap',
      spec.memory,
      '--pids-limit',
      String(spec.pidsLimit),
      // Nothing in a sandbox ever needs to gain privileges.
      '--security-opt',
      'no-new-privileges:true',
      '--cap-drop',
      'ALL',
    ];

    for (const capability of spec.capAdd ?? []) argv.push('--cap-add', capability);
    for (const alias of spec.aliases) argv.push('--network-alias', alias);
    for (const [key, value] of Object.entries(spec.labels)) argv.push('--label', `${key}=${value}`);
    for (const [key, value] of Object.entries(spec.env)) argv.push('--env', `${key}=${value}`);
    for (const mapping of spec.publish ?? []) argv.push('--publish', mapping);
    for (const mount of spec.tmpfs ?? []) argv.push('--tmpfs', mount);
    if (spec.readOnlyRootfs) argv.push('--read-only');

    argv.push(spec.image);

    const result = await this.#run(argv, { timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new DockerOperationError(
        `could not start container ${spec.name}: ${firstLine(result.stderr)}`,
      );
    }
  }

  async removeContainer(name: string): Promise<void> {
    const result = await this.#run(['rm', '--force', '--volumes', name], { timeoutMs: 60_000 });
    if (result.exitCode === 0) return;
    if (/no such container|not found/i.test(result.stderr)) return;
    throw new DockerOperationError(`could not remove container ${name}: ${firstLine(result.stderr)}`);
  }

  async inspectContainer(name: string): Promise<DockerContainerInfo | null> {
    const result = await this.#run([
      'container',
      'inspect',
      name,
      '--format',
      '{{.Id}}\t{{.State.Status}}\t{{json .Config.Labels}}',
    ]);
    if (result.exitCode !== 0) return null;

    const [id = '', state = '', labelsJson = '{}'] = result.stdout.trim().split('\t');
    return { name, id, state, labels: parseLabels(labelsJson) };
  }

  async listContainers(labelSelector: string): Promise<DockerContainerInfo[]> {
    const result = await this.#run([
      'ps',
      '--all',
      '--filter',
      `label=${labelSelector}`,
      '--format',
      '{{.Names}}',
    ]);
    if (result.exitCode !== 0) {
      throw new DockerUnavailableError(`could not list containers: ${firstLine(result.stderr)}`);
    }

    const containers: DockerContainerInfo[] = [];
    for (const name of nonEmptyLines(result.stdout)) {
      const info = await this.inspectContainer(name);
      if (info) containers.push(info);
    }
    return containers;
  }

  async publishedPorts(name: string, containerPort: number): Promise<DockerPortBinding[]> {
    const result = await this.#run([
      'container',
      'inspect',
      name,
      '--format',
      '{{json .NetworkSettings.Ports}}',
    ]);
    if (result.exitCode !== 0) return [];

    let parsed: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
    try {
      parsed = JSON.parse(result.stdout.trim()) as typeof parsed;
    } catch {
      return [];
    }

    const bindings = parsed[`${containerPort}/tcp`] ?? [];
    return bindings
      .map((binding) => ({
        hostIp: binding.HostIp && binding.HostIp !== '0.0.0.0' ? binding.HostIp : '127.0.0.1',
        hostPort: Number.parseInt(binding.HostPort ?? '', 10),
        containerPort,
      }))
      .filter((binding) => Number.isInteger(binding.hostPort) && binding.hostPort > 0);
  }

  // -------------------------------------------------------------------- exec

  /**
   * Run one argv inside a container.
   *
   * Docker's own options all precede the container name, and everything after
   * it is the command — so no separator is needed, and `docker exec` does not
   * accept one (`--` would be taken as the executable). The command itself is
   * always a platform-authored binary name; only its arguments ever carry a
   * validated lab-supplied value, and those are separate argv elements that no
   * shell ever sees.
   */
  async exec(spec: DockerExecSpec): Promise<DockerExecResult> {
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) {
      throw new DockerOperationError('exec requires a non-empty argv array');
    }
    if (spec.argv.some((arg) => typeof arg !== 'string')) {
      throw new DockerOperationError('exec argv must contain only strings');
    }

    const argv = ['exec'];
    if (spec.input !== undefined) argv.push('--interactive');
    if (spec.user) argv.push('--user', spec.user);
    if (spec.workdir) argv.push('--workdir', spec.workdir);
    for (const [key, value] of Object.entries(spec.env ?? {})) argv.push('--env', `${key}=${value}`);
    argv.push(spec.container, ...spec.argv);

    const result = await this.#run(argv, {
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.input !== undefined ? { input: spec.input } : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  // ----------------------------------------------------------------- private

  #run(argv: string[], options: { timeoutMs?: number; input?: string } = {}): Promise<RawResult> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
    };
    if (this.#dockerHost) env.DOCKER_HOST = this.#dockerHost;

    return new Promise<RawResult>((resolve) => {
      const child = execFile(
        this.#binary,
        argv,
        {
          timeout: options.timeoutMs ?? this.#timeoutMs,
          env,
          maxBuffer: MAX_BUFFER_BYTES,
          shell: false,
        },
        (error, stdout, stderr) => {
          const timedOut = Boolean(
            error && ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed),
          );
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

      if (options.input !== undefined && child.stdin) {
        /*
         * A child that exits before reading its stdin — `docker exec` failing
         * because the container is already gone, or the inner command dying
         * early — makes this write fail with EPIPE. Without a listener that is
         * an *uncaught* exception on the stream, which would take the whole
         * orchestrator process down over one student's teardown race.
         *
         * The write failing is not itself the error worth reporting: the exec
         * callback below still resolves with docker's real exit code and
         * stderr, which is what the caller acts on. So the pipe error is
         * absorbed here and the outcome is read from the process, not the pipe.
         */
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.input);
      }
    });
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseLabels(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json.trim()) as Record<string, string> | null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
