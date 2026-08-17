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
} from '../src/index.js';

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
}

export class FakeContainerRuntime implements ContainerRuntimePort {
  readonly name = 'fake-docker';
  readonly containers = new Map<string, FakeContainer>();
  /** Every spec `create()` was called with, for flag assertions. */
  readonly created: ContainerSpec[] = [];
  readonly removed: string[] = [];
  /** Every exec, for asserting that reads run as the unprivileged user. */
  readonly execs: Array<{ container: string; request: ContainerExecRequest }> = [];

  #images: Set<string>;
  unreachable: string | undefined;
  #seed: Record<string, Partial<FakeEntry>>;
  /** When set, `terraform validate` reports this diagnostic. */
  validateError: string | null = null;
  /** When non-empty, `terraform fmt -check` names these files. */
  unformattedFiles: string[] = [];

  constructor(options: FakeRuntimeOptions = {}) {
    this.#images = new Set(
      options.images ?? ['jumptotech/lab-linux:latest', 'jumptotech/lab-terraform:latest'],
    );
    this.unreachable = options.unreachable;
    this.#seed = options.seed ?? {};
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
        if (binary !== 'terraform' || !container.spec.image.includes('terraform')) {
          return fail(`env: '${String(binary)}': No such file or directory`);
        }
        // The three subcommands the platform itself ever runs: a version probe
        // at provisioning time, and the two read-only checks.
        switch (args[1]) {
          case 'validate':
            return this.validateError
              ? {
                  exitCode: 1,
                  stdout: JSON.stringify({
                    valid: false,
                    diagnostics: [{ severity: 'error', summary: this.validateError }],
                  }),
                  stderr: '',
                  timedOut: false,
                }
              : ok(JSON.stringify({ valid: true, diagnostics: [] }));
          case 'fmt':
            return this.unformattedFiles.length > 0
              ? {
                  exitCode: 3,
                  stdout: `${this.unformattedFiles.join('\n')}\n`,
                  stderr: '',
                  timedOut: false,
                }
              : ok('');
          default:
            return ok('Terraform v1.9.8\non linux_arm64\n');
        }
      }

      /**
       * `find <dir> -maxdepth N -type f [-name *.suffix]`.
       *
       * Only the shape `listSandboxFiles` builds is interpreted; the depth and
       * the suffix are honoured so a test can prove the bounds are real.
       */
      case '/usr/bin/find': {
        const root = args[0] ?? '';
        const depth = Number.parseInt(args[args.indexOf('-maxdepth') + 1] ?? '1', 10);
        const nameIndex = args.indexOf('-name');
        const pattern = nameIndex === -1 ? null : (args[nameIndex + 1] ?? '');
        const prefix = `${root.replace(/\/+$/, '')}/`;

        const matches = [...container.files.entries()]
          .filter(([path, entry]) => entry.type === 'file' && path.startsWith(prefix))
          .map(([path]) => path)
          .filter((path) => path.slice(prefix.length).split('/').length <= depth)
          .filter((path) => (pattern ? path.endsWith(pattern.replace('*', '')) : true))
          .sort();
        return ok(matches.length > 0 ? `${matches.join('\n')}\n` : '');
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
