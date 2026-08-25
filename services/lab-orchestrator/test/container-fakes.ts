/**
 * In-memory container runtime, with just enough of a filesystem to exercise
 * provider logic without a daemon.
 *
 * Same rule as `FakeKubernetes`: this fake deliberately does **not** simulate
 * anything the runtime is supposed to *enforce*. It does not implement
 * `--cap-drop`, `--pids-limit`, `--network none`, or user separation, because a
 * fake that "proved" those would prove nothing at all. Those are asserted
 * against a real Docker daemon in `sandbox-integration.test.ts`.
 *
 * What it does model is the shape of the interaction: which flags the provider
 * asks for, which labels it stamps, which argv it runs to read a path back, and
 * what happens when a container is missing, unlabelled, or owned by another
 * session.
 */
import type {
  ContainerExecRequest,
  ContainerExecResult,
  ContainerInfo,
  ContainerRuntimePort,
  ContainerSpec,
  NetworkInfo,
  NetworkSpec,
} from '../src/index.js';
import { assertValidContainerNetworkRef } from '../src/index.js';

interface FakeEntry {
  type: 'file' | 'directory';
  content: string;
  mode: string;
  owner: string;
  group: string;
}

interface FakeContainer {
  info: ContainerInfo;
  spec: ContainerSpec;
  files: Map<string, FakeEntry>;
}

export interface FakeRuntimeOptions {
  /** Images this daemon has. Anything else reports as missing. */
  images?: string[];
  /** When set, `ping()` rejects with this message. */
  unreachable?: string;
  /** Extra entries every new container starts with, keyed by absolute path. */
  seed?: Record<string, Partial<FakeEntry>>;
  /**
   * Processes the fake sandbox reports, as `ps -eo pid=,user=,args=` lines.
   *
   * The fake does not *run* anything, and deliberately does not pretend to: a
   * seed script that would have started a daemon does not start one here. Tests
   * that need a process table state it, so no assertion can accidentally read
   * as "the fake proved a real daemon came up".
   */
  processes?: string[];
  /** Listening sockets, as `ss -H -lntu` lines. */
  sockets?: string[];
  /**
   * Raw `/proc/<pid>/environ` bytes per pid, for `process_environ`.
   *
   * NUL-separated `NAME=value`, exactly as the kernel exposes it, so a test
   * exercises the same parsing the real reader performs.
   */
  environs?: Record<number, string>;
  /** `getent <db> <key>` answers, keyed `db:key`. */
  accounts?: Record<string, string>;
  /** Seed scripts that should fail, keyed by basename, with their exit code. */
  failingSeedScripts?: Record<string, { exitCode: number; stderr: string }>;
}

export class FakeContainerRuntime implements ContainerRuntimePort {
  readonly name = 'fake-docker';
  readonly containers = new Map<string, FakeContainer>();
  /** Every spec `create()` was called with, for flag assertions. */
  readonly created: ContainerSpec[] = [];
  readonly removed: string[] = [];
  /** Every exec, for asserting that reads run as the unprivileged user. */
  readonly execs: Array<{ container: string; request: ContainerExecRequest }> = [];

  /** Seed scripts the provider installed and ran, in order, as `name`. */
  readonly seedScriptsRun: string[] = [];

  /**
   * Lab networks this fake daemon holds, keyed by name.
   *
   * A fake cannot show that `--internal` really blocks egress — that belongs to
   * the integration suite against a real daemon. What it does model is the
   * lifecycle the provider is responsible for: that a network is created before
   * the container that joins it, that it is removed when the sandbox is, and
   * that one session's network is never named by another's teardown.
   */
  readonly networks = new Map<string, NetworkInfo>();
  /** Every network spec `networkCreate()` was called with. */
  readonly networksCreated: NetworkSpec[] = [];
  readonly networksRemoved: string[] = [];

  #images: Set<string>;
  unreachable: string | undefined;
  #seed: Record<string, Partial<FakeEntry>>;
  processes: string[];
  sockets: string[];
  accounts: Record<string, string>;
  /**
   * Raw `/proc/<pid>/environ` bytes per pid, for `process_environ`.
   *
   * Stated as the NUL-separated bytes the kernel actually exposes, rather than
   * as a parsed map, so a test exercises the same parsing the real reader does.
   */
  environs: Record<number, string>;
  #failingSeedScripts: Record<string, { exitCode: number; stderr: string }>;

  constructor(options: FakeRuntimeOptions = {}) {
    this.#images = new Set(
      options.images ?? ['jumptotech/lab-linux:latest', 'jumptotech/lab-terraform:latest'],
    );
    this.unreachable = options.unreachable;
    this.#seed = options.seed ?? {};
    this.processes = options.processes ?? [];
    this.sockets = options.sockets ?? [];
    this.accounts = options.accounts ?? {};
    this.environs = options.environs ?? {};
    this.#failingSeedScripts = options.failingSeedScripts ?? {};
  }

  async ping(): Promise<string> {
    if (this.unreachable) throw new Error(this.unreachable);
    return '28.0.0-fake';
  }

  async imageExists(image: string): Promise<boolean> {
    if (this.unreachable) throw new Error(this.unreachable);
    return this.#images.has(image);
  }

  addImage(image: string): void {
    this.#images.add(image);
  }

  removeImage(image: string): void {
    this.#images.delete(image);
  }

  async create(spec: ContainerSpec): Promise<ContainerInfo> {
    if (this.unreachable) throw new Error(this.unreachable);
    if (!this.#images.has(spec.image)) {
      throw new Error(`Unable to find image '${spec.image}' locally`);
    }
    if (this.containers.has(spec.name)) {
      throw new Error(`Conflict. The container name "/${spec.name}" is already in use`);
    }

    this.created.push(spec);
    const files = new Map<string, FakeEntry>();
    files.set(spec.workdir, {
      type: 'directory',
      content: '',
      mode: '755',
      owner: spec.user,
      group: spec.user,
    });
    for (const [path, entry] of Object.entries(this.#seed)) {
      files.set(path, {
        type: entry.type ?? 'file',
        content: entry.content ?? '',
        mode: entry.mode ?? '644',
        owner: entry.owner ?? spec.user,
        group: entry.group ?? spec.user,
      });
    }

    const info: ContainerInfo = {
      name: spec.name,
      id: `sha256:${spec.name}`,
      state: 'running',
      image: spec.image,
      labels: { ...spec.labels },
    };
    this.containers.set(spec.name, { info, spec, files });
    return info;
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    if (this.unreachable) throw new Error(this.unreachable);
    return this.containers.get(name)?.info ?? null;
  }

  async list(labelSelector: string): Promise<ContainerInfo[]> {
    if (this.unreachable) throw new Error(this.unreachable);
    const [key, value] = labelSelector.split('=');
    return [...this.containers.values()]
      .map((c) => c.info)
      .filter((info) => key !== undefined && info.labels[key] === value);
  }

  async remove(name: string): Promise<void> {
    if (this.unreachable) throw new Error(this.unreachable);
    this.removed.push(name);
    this.containers.delete(name);
  }

  /** Register a container this platform did not create, for cleanup-safety tests. */
  addForeignContainer(name: string, labels: Record<string, string> = {}): void {
    this.containers.set(name, {
      info: { name, id: `sha256:${name}`, state: 'running', image: 'someone-else', labels },
      spec: {
        name,
        image: 'someone-else',
        labels,
        user: 'root',
        workdir: '/',
        cpus: '1',
        memory: '1g',
        pidsLimit: 100,
        network: 'bridge',
        hostname: 'other',
        command: ['sleep', 'infinity'],
      },
      files: new Map(),
    });
  }

  /** Read the virtual filesystem directly, for assertions. */
  entry(container: string, path: string): FakeEntry | undefined {
    return this.containers.get(container)?.files.get(path);
  }

  /** Place an entry as if the student had created it. */
  put(container: string, path: string, entry: Partial<FakeEntry> = {}): void {
    const found = this.containers.get(container);
    if (!found) throw new Error(`no such container ${container}`);
    found.files.set(path, {
      type: entry.type ?? 'file',
      content: entry.content ?? '',
      mode: entry.mode ?? '644',
      owner: entry.owner ?? found.spec.user,
      group: entry.group ?? found.spec.user,
    });
  }

  /**
   * Interpret the small set of argv shapes the provider actually runs.
   *
   * Anything else exits non-zero rather than being guessed at — a provider that
   * started running something new would fail loudly here rather than silently
   * appearing to work.
   */
  // ------------------------------------------------------------- networks

  async networkCreate(spec: NetworkSpec): Promise<void> {
    if (this.unreachable) throw new Error(this.unreachable);
    assertValidContainerNetworkRef(spec.name);
    this.networksCreated.push(spec);
    // Re-entrant, like the real thing: creating one that exists is success.
    if (!this.networks.has(spec.name)) {
      this.networks.set(spec.name, {
        name: spec.name,
        id: `netid-${spec.name}`,
        labels: { ...spec.labels },
      });
    }
  }

  async networkInspect(name: string): Promise<NetworkInfo | null> {
    if (this.unreachable) throw new Error(this.unreachable);
    assertValidContainerNetworkRef(name);
    return this.networks.get(name) ?? null;
  }

  async networkRemove(name: string): Promise<void> {
    if (this.unreachable) throw new Error(this.unreachable);
    assertValidContainerNetworkRef(name);
    this.networksRemoved.push(name);
    this.networks.delete(name);
  }

  async networkList(labelSelector: string): Promise<NetworkInfo[]> {
    if (this.unreachable) throw new Error(this.unreachable);
    const [key, value] = labelSelector.split('=');
    return [...this.networks.values()].filter((n) => n.labels[String(key)] === value);
  }

  /** Put a network into the fake daemon without going through the provider. */
  addNetwork(name: string, labels: Record<string, string> = {}): void {
    this.networks.set(name, { name, id: `netid-${name}`, labels });
  }

  async exec(name: string, request: ContainerExecRequest): Promise<ContainerExecResult> {
    if (this.unreachable) throw new Error(this.unreachable);
    this.execs.push({ container: name, request });

    const container = this.containers.get(name);
    if (!container) return fail(`Error: No such container: ${name}`);

    const [command, ...args] = request.argv;
    const target = args[args.length - 1] ?? '';

    switch (command) {
      case '/usr/bin/id':
        return ok(`${request.user ?? container.spec.user}\n`);

      case '/usr/bin/env': {
        const binary = args[0];
        if (binary === 'terraform' && container.spec.image.includes('terraform')) {
          return ok('Terraform v1.9.8\non linux_arm64\n');
        }
        return fail(`env: '${String(binary)}': No such file or directory`);
      }

      case '/usr/bin/stat': {
        const entry = container.files.get(target);
        if (!entry) {
          return fail(`stat: cannot statx '${target}': No such file or directory`);
        }
        const kind = entry.type === 'directory' ? 'directory' : 'regular file';
        return ok(
          `${kind}|${entry.mode}|${entry.owner}|${entry.group}|${entry.content.length}\n`,
        );
      }

      case '/bin/cat': {
        const entry = container.files.get(target);
        if (!entry || entry.type !== 'file') {
          return fail(`cat: ${target}: No such file or directory`);
        }
        return ok(entry.content);
      }

      case '/bin/mkdir': {
        const parts = target.split('/').filter(Boolean);
        let path = '';
        for (const part of parts) {
          path += `/${part}`;
          if (!container.files.has(path)) {
            container.files.set(path, {
              type: 'directory',
              content: '',
              mode: '755',
              owner: request.user ?? container.spec.user,
              group: request.user ?? container.spec.user,
            });
          }
        }
        return ok('');
      }

      case '/usr/bin/tee': {
        container.files.set(target, {
          type: 'file',
          content: request.stdin ?? '',
          mode: '644',
          owner: request.user ?? container.spec.user,
          group: request.user ?? container.spec.user,
        });
        return ok(request.stdin ?? '');
      }

      case '/bin/chmod': {
        const entry = container.files.get(target);
        if (!entry) return fail(`chmod: cannot access '${target}': No such file or directory`);
        entry.mode = (args[0] ?? '644').replace(/^0+(?=\d{3})/, '');
        return ok('');
      }

      case '/bin/rm': {
        for (const path of [...container.files.keys()]) {
          if (path === target || path.startsWith(`${target}/`)) container.files.delete(path);
        }
        return ok('');
      }

      /*
       * `sh -c 'exec "$0"' <path>` — how the provider runs a seed script, and
       * how the verifier runs a student's script. The fake records the run and
       * reports the outcome the test asked for; it never executes anything.
       */
      case '/bin/sh': {
        const script = args[2] ?? '';
        const name = script.split('/').pop() ?? '';
        if (script.startsWith('/opt/jumptotech/seed/')) {
          this.seedScriptsRun.push(name);
          const failure = this.#failingSeedScripts[name];
          if (failure) {
            return { exitCode: failure.exitCode, stdout: '', stderr: failure.stderr, timedOut: false };
          }
          return ok('');
        }
        const entry = container.files.get(script);
        if (!entry) return fail(`sh: ${script}: No such file or directory`);
        return ok(entry.content);
      }

      // --- allow-listed inspection commands, for the `linux` family ---------
      case 'cat': {
        // Only `/proc/<pid>/environ` is modelled here; everything else a lab
        // reads goes through the filesystem port, not an inspection command.
        const match = /^\/proc\/(\d+)\/environ$/.exec(String(args[0] ?? ''));
        if (!match) return fail(`fake runtime: unexpected cat target '${String(args[0])}'`);
        const bytes = this.environs[Number(match[1])];
        return bytes === undefined ? fail('No such file or directory') : ok(bytes);
      }

      case 'ps':
        return ok(this.processes.join('\n') + (this.processes.length ? '\n' : ''));

      case 'ss':
        return ok(this.sockets.join('\n') + (this.sockets.length ? '\n' : ''));

      case 'getent': {
        const answer = this.accounts[`${String(args[0])}:${String(args[1])}`];
        return answer === undefined ? fail('') : ok(`${answer}\n`);
      }

      default:
        return fail(`fake runtime: unexpected command '${String(command)}'`);
    }
  }
}

function ok(stdout: string): ContainerExecResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function fail(stderr: string): ContainerExecResult {
  return { exitCode: 1, stdout: '', stderr, timedOut: false };
}
