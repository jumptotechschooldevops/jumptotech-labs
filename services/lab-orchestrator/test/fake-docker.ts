/**
 * Shared in-memory Docker fake.
 *
 * Implements the whole `DockerPort`, so provider lifecycle, sandbox reads, and
 * verifier handlers can be exercised without a Docker daemon.
 *
 * What it models faithfully: container and network existence, ownership
 * labels, published ports, and a small per-container filesystem so the
 * workspace-seeding and file-reading paths are genuinely exercised rather than
 * stubbed out.
 *
 * What it deliberately does NOT model: Ansible. `ansible`, `ansible-playbook`,
 * and `ansible-inventory` return whatever a test scripted for them. Faking
 * Ansible's own behaviour would let a test "prove" that a playbook is
 * idempotent against a mock, which would prove nothing at all — that property
 * is tested against real containers in `ansible-integration.test.ts`.
 */
import type {
  DockerContainerInfo,
  DockerExecResult,
  DockerExecSpec,
  DockerNetworkInfo,
  DockerPort,
  DockerPortBinding,
  DockerRunSpec,
} from '../src/index.js';
import { DockerUnavailableError } from '../src/index.js';

interface FakeContainer {
  name: string;
  id: string;
  state: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  network: string;
  aliases: string[];
  publish: string[];
  /** Absolute path → contents. Directories are recorded with a null value. */
  files: Map<string, string | null>;
  processes: Set<string>;
  cpus: number;
  memory: string;
  pidsLimit: number;
  capAdd: string[];
}

interface FakeNetwork {
  name: string;
  id: string;
  labels: Record<string, string>;
}

/** A scripted reply for one command, matched on the joined argv. */
export interface ScriptedCommand {
  /** Matched against the argv joined by spaces. */
  match: RegExp;
  result: Partial<DockerExecResult> & { exitCode: number };
  /** Called before the result is returned, so a script can mutate the fake. */
  effect?: (container: string, argv: string[], fake: FakeDocker) => void;
}

export interface FakeDockerOptions {
  /** When set, every call rejects with this message. */
  unavailable?: string;
  images?: string[];
  version?: string;
  /** Host port handed out for the first published binding. Incremented after. */
  firstHostPort?: number;
}

export class FakeDocker implements DockerPort {
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, FakeNetwork>();
  /** Every exec this fake was asked to run, in order. Useful for assertions. */
  readonly execLog: Array<{ container: string; argv: string[]; user?: string }> = [];
  scripts: ScriptedCommand[] = [];

  #unavailable: string | undefined;
  #images: Set<string>;
  #version: string;
  #nextPort: number;
  #counter = 0;

  constructor(options: FakeDockerOptions = {}) {
    this.#unavailable = options.unavailable;
    this.#images = new Set(options.images ?? ['jumptotech/ansible-lab:local']);
    this.#version = options.version ?? '27.0.0';
    this.#nextPort = options.firstHostPort ?? 33001;
  }

  /** Make every subsequent call fail, as a stopped daemon would. */
  goDown(message = 'Cannot connect to the Docker daemon'): void {
    this.#unavailable = message;
  }

  comeBack(): void {
    this.#unavailable = undefined;
  }

  script(...commands: ScriptedCommand[]): void {
    this.scripts.push(...commands);
  }

  #assertUp(): void {
    if (this.#unavailable) throw new DockerUnavailableError(this.#unavailable);
  }

  #id(): string {
    this.#counter += 1;
    return `fake${String(this.#counter).padStart(12, '0')}`;
  }

  // ------------------------------------------------------------------ daemon

  async ping(): Promise<void> {
    this.#assertUp();
  }

  async version(): Promise<string> {
    this.#assertUp();
    return this.#version;
  }

  async imageExists(image: string): Promise<boolean> {
    this.#assertUp();
    return this.#images.has(image);
  }

  // ----------------------------------------------------------------- network

  async createNetwork(name: string, labels: Record<string, string>): Promise<void> {
    this.#assertUp();
    if (this.networks.has(name)) return;
    this.networks.set(name, { name, id: this.#id(), labels: { ...labels } });
  }

  async removeNetwork(name: string): Promise<void> {
    this.#assertUp();
    this.networks.delete(name);
  }

  async networkExists(name: string): Promise<boolean> {
    this.#assertUp();
    return this.networks.has(name);
  }

  async listNetworks(labelSelector: string): Promise<DockerNetworkInfo[]> {
    this.#assertUp();
    const [key, value] = splitSelector(labelSelector);
    return [...this.networks.values()]
      .filter((network) => (value === undefined ? key in network.labels : network.labels[key] === value))
      .map((network) => ({ ...network, labels: { ...network.labels } }));
  }

  // --------------------------------------------------------------- container

  async runContainer(spec: DockerRunSpec): Promise<void> {
    this.#assertUp();
    if (this.containers.has(spec.name)) {
      throw new Error(`container ${spec.name} already exists`);
    }
    this.containers.set(spec.name, {
      name: spec.name,
      id: this.#id(),
      state: 'running',
      labels: { ...spec.labels },
      env: { ...spec.env },
      network: spec.network,
      aliases: [...spec.aliases],
      publish: [...(spec.publish ?? [])],
      // Every sandbox node boots with sshd up; that is what the image does.
      processes: new Set(['sshd']),
      files: new Map<string, string | null>([['/home/student', null]]),
      cpus: spec.cpus,
      memory: spec.memory,
      pidsLimit: spec.pidsLimit,
      capAdd: [...(spec.capAdd ?? [])],
    });
  }

  async removeContainer(name: string): Promise<void> {
    this.#assertUp();
    this.containers.delete(name);
  }

  async inspectContainer(name: string): Promise<DockerContainerInfo | null> {
    this.#assertUp();
    const container = this.containers.get(name);
    if (!container) return null;
    return { name, id: container.id, state: container.state, labels: { ...container.labels } };
  }

  async listContainers(labelSelector: string): Promise<DockerContainerInfo[]> {
    this.#assertUp();
    const [key, value] = splitSelector(labelSelector);
    return [...this.containers.values()]
      .filter((container) =>
        value === undefined ? key in container.labels : container.labels[key] === value,
      )
      .map((container) => ({
        name: container.name,
        id: container.id,
        state: container.state,
        labels: { ...container.labels },
      }));
  }

  async publishedPorts(name: string, containerPort: number): Promise<DockerPortBinding[]> {
    this.#assertUp();
    const container = this.containers.get(name);
    if (!container) return [];
    return container.publish
      .filter((mapping) => mapping.endsWith(`:${containerPort}`))
      .map((mapping) => {
        const hostIp = mapping.split(':')[0] ?? '127.0.0.1';
        this.#nextPort += 1;
        return { hostIp, hostPort: this.#nextPort, containerPort };
      });
  }

  // -------------------------------------------------------------------- exec

  /**
   * Interpret one argv against the container's in-memory filesystem.
   *
   * Only the commands the platform actually issues are implemented, and each
   * behaves as the real one does for the cases we rely on. Anything else falls
   * through to the scripted replies, then to "command not found".
   */
  async exec(spec: DockerExecSpec): Promise<DockerExecResult> {
    this.#assertUp();
    this.execLog.push({
      container: spec.container,
      argv: [...spec.argv],
      ...(spec.user ? { user: spec.user } : {}),
    });

    const container = this.containers.get(spec.container);
    if (!container) {
      return { exitCode: 1, stdout: '', stderr: `No such container: ${spec.container}`, timedOut: false };
    }

    const joined = spec.argv.join(' ');
    for (const script of this.scripts) {
      if (!script.match.test(joined)) continue;
      script.effect?.(spec.container, spec.argv, this);
      return {
        exitCode: script.result.exitCode,
        stdout: script.result.stdout ?? '',
        stderr: script.result.stderr ?? '',
        timedOut: script.result.timedOut ?? false,
      };
    }

    return this.#builtin(container, spec);
  }

  #builtin(container: FakeContainer, spec: DockerExecSpec): DockerExecResult {
    const [command = '', ...rest] = spec.argv;
    const ok = (stdout = ''): DockerExecResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
    const err = (stderr: string, code = 1): DockerExecResult => ({
      exitCode: code,
      stdout: '',
      stderr,
      timedOut: false,
    });

    switch (command) {
      case 'pgrep': {
        const name = rest[rest.length - 1] ?? '';
        return container.processes.has(name) ? ok('1\n') : err('', 1);
      }
      case 'mkdir': {
        const target = rest[rest.length - 1] ?? '';
        for (const ancestor of ancestors(target)) container.files.set(ancestor, null);
        container.files.set(target, null);
        return ok();
      }
      case 'tee': {
        const target = rest[rest.length - 1] ?? '';
        const parent = target.slice(0, target.lastIndexOf('/'));
        if (parent && !container.files.has(parent)) {
          return err(`tee: ${target}: No such file or directory`);
        }
        container.files.set(target, spec.input ?? '');
        return ok(spec.input ?? '');
      }
      case 'chmod':
        return ok();
      case 'rm': {
        const target = rest[rest.length - 1] ?? '';
        for (const key of [...container.files.keys()]) {
          if (key === target || key.startsWith(`${target}/`)) container.files.delete(key);
        }
        return ok();
      }
      case 'head': {
        const target = rest[rest.length - 1] ?? '';
        const content = container.files.get(target);
        if (content === undefined) return err(`head: ${target}: No such file or directory`);
        if (content === null) return err(`head: error reading '${target}': Is a directory`, 1);
        return ok(content);
      }
      case 'stat': {
        const target = rest[rest.length - 1] ?? '';
        const entry = container.files.get(target);
        if (entry === undefined) return err(`stat: cannot statx '${target}': No such file or directory`);
        const kind = entry === null ? 'directory' : 'regular file';
        const mode = entry === null ? '755' : '644';
        const size = entry === null ? 4096 : Buffer.byteLength(entry);
        return ok(`${kind}|${mode}|root|root|${size}\n`);
      }
      case 'ls': {
        const target = rest[rest.length - 1] ?? '';
        if (container.files.get(target) !== null) {
          return err(`ls: ${target}: No such file or directory`);
        }
        const prefix = `${target}/`;
        const names = new Set<string>();
        for (const key of container.files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const remainder = key.slice(prefix.length);
          const head = remainder.split('/')[0];
          if (head) names.add(head);
        }
        return ok([...names].sort().join('\n'));
      }
      case '/usr/local/bin/jtt-install-key':
        container.files.set('/home/student/.ssh', null);
        container.files.set('/home/student/.ssh/id_lab', spec.input ?? '');
        return ok('installed\n');
      case 'ssh': {
        // "can the control node open a session on this node" — true when the
        // named node exists in the same fake and has sshd up.
        const target = rest.find((arg) => arg.includes('@'))?.split('@')[1] ?? '';
        const peer = [...this.containers.values()].find(
          (candidate) => candidate.network === container.network && candidate.aliases.includes(target),
        );
        return peer && peer.processes.has('sshd') ? ok() : err(`ssh: Could not resolve hostname ${target}`, 255);
      }
      default:
        return err(`${command}: not found`, 127);
    }
  }

  // ------------------------------------------------------------------ helpers

  /** Write a file into a container, as a lab's automation would. */
  writeFile(containerName: string, path: string, content: string): void {
    const container = this.containers.get(containerName);
    if (!container) throw new Error(`no such fake container: ${containerName}`);
    for (const ancestor of ancestors(path)) container.files.set(ancestor, null);
    container.files.set(path, content);
  }

  makeDirectory(containerName: string, path: string): void {
    const container = this.containers.get(containerName);
    if (!container) throw new Error(`no such fake container: ${containerName}`);
    for (const ancestor of ancestors(path)) container.files.set(ancestor, null);
    container.files.set(path, null);
  }

  readFile(containerName: string, path: string): string | null | undefined {
    return this.containers.get(containerName)?.files.get(path);
  }

  startProcess(containerName: string, processName: string): void {
    this.containers.get(containerName)?.processes.add(processName);
  }

  stopProcess(containerName: string, processName: string): void {
    this.containers.get(containerName)?.processes.delete(processName);
  }

  container(name: string): FakeContainer | undefined {
    return this.containers.get(name);
  }

  /** Container names, sorted. Handy for asserting what a sandbox owns. */
  containerNames(): string[] {
    return [...this.containers.keys()].sort();
  }
}

function splitSelector(selector: string): [string, string | undefined] {
  const index = selector.indexOf('=');
  if (index === -1) return [selector, undefined];
  return [selector.slice(0, index), selector.slice(index + 1)];
}

/** Every parent directory of a path, shallowest first. */
function ancestors(path: string): string[] {
  const segments = path.split('/').filter(Boolean).slice(0, -1);
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join('/')}`);
}
