/**
 * Memoised, sandbox-scoped reads for one Docker verification run.
 *
 * The Docker counterpart of `reader.ts`, and it exists for the same two
 * reasons. A lab typically asks several questions about one object ("does the
 * container exist", "is its image right", "is it running"); without memoisation
 * each would re-read it, and worse, could observe *different* states mid-check
 * and produce a self-contradictory report. Reading each object at most once per
 * run keeps a single report consistent with itself.
 *
 * The sandbox is fixed at construction. A handler is never given the chance to
 * name a daemon, so it cannot read outside the session it is grading — the
 * `DockerEnginePort` it holds can only reach one sandbox's daemon.
 */
import type {
  DockerContainerSnapshot,
  DockerEnginePort,
  DockerImageSnapshot,
  DockerNetworkSnapshot,
  DockerVolumeSnapshot,
} from '@jumptotech/lab-orchestrator';
import type { WorkspacePort } from '@jumptotech/lab-orchestrator';

export class DockerVerifyReader {
  readonly #cache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly docker: DockerEnginePort,
    /** The sandbox name. Reported in failure detail so a student sees scope. */
    readonly namespace: string,
    /** Where the student's authored files live, for workspace checks. */
    private readonly workspace?: { port: WorkspacePort; sessionId: string },
  ) {}

  #once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#cache.get(key);
    if (existing) return existing as Promise<T>;
    const promise = load();
    this.#cache.set(key, promise);
    return promise;
  }

  container(name: string): Promise<DockerContainerSnapshot | null> {
    return this.#once(`container/${name}`, () => this.docker.inspectContainer(name));
  }

  image(reference: string): Promise<DockerImageSnapshot | null> {
    return this.#once(`image/${reference}`, () => this.docker.inspectImage(reference));
  }

  volume(name: string): Promise<DockerVolumeSnapshot | null> {
    return this.#once(`volume/${name}`, () => this.docker.inspectVolume(name));
  }

  network(name: string): Promise<DockerNetworkSnapshot | null> {
    return this.#once(`network/${name}`, () => this.docker.inspectNetwork(name));
  }

  /**
   * Read a file from the student's workspace, or `null` when absent.
   *
   * Returns `null` — not an error — when no workspace is configured, so a
   * deployment without one reports "the file is not there" rather than
   * crashing a check the student cannot influence.
   */
  file(path: string): Promise<string | null> {
    return this.#once(`file/${path}`, async () => {
      if (!this.workspace) return null;
      return this.workspace.port.read(this.workspace.sessionId, path);
    });
  }

  /** True when workspace checks can actually be answered. */
  get hasWorkspace(): boolean {
    return this.workspace !== undefined;
  }
}
