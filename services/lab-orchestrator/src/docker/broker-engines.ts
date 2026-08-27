/**
 * `DockerEngineFactory` over the runtime broker.
 *
 * The Docker track was the last thing asking the API to hold a host Docker
 * socket. Every other track had already moved behind `sandboxd`; this one could
 * not, because it drives `DockerEnginePort` — a 23-method interface — rather
 * than the eleven-verb `ContainerRuntimePort` the broker spoke.
 *
 * ```text
 *   DockerLabProvider ─► DockerEngineFactory ─┬─► DockerCliFactory   (a laptop)
 *                                             └─► BrokerDockerEngines ─► sandboxd
 * ```
 *
 * ## Why this is not a 23-method proxy
 *
 * Only fourteen of those methods are ever called — eight on the host engine,
 * six against a session's own daemon — and the broker implements exactly those,
 * as *named operations* rather than as a passthrough. So the wire carries
 * `createSandbox { sessionId, labId, expiresAtMs }`, not a `RunContainerSpec`
 * with an image and a `--privileged` flag in it.
 *
 * The nine methods nobody calls are still on this class, because the interface
 * requires them — and every one of them **throws**. That is the point:
 * `pullImage`, `removeImage`, `startContainer`, `stopContainer`,
 * `containerLogs`, `listImages`, `listVolumes`, `removeVolume` and
 * `removeNetwork` are not reachable from the API in a brokered deployment, and
 * a future caller that starts using one gets a loud failure here rather than a
 * quiet widening of the broker's surface.
 *
 * ## Session identity
 *
 * `DockerEngineFactory.session()` takes a *sandbox reference*, because that is
 * what the provider and the requirement waiter hold. The broker will not accept
 * one: every operation is keyed on a **session id**, from which the broker
 * derives the sandbox name itself. So this class carries the session id
 * alongside the reference, resolved through `bindSession`, and refuses to build
 * a session engine for a sandbox it has never been told the session for.
 * Guessing a sandbox name therefore buys nothing — there is no wire field for
 * it.
 */
import { currentRequestId, REQUEST_ID_HEADER } from '@jumptotech/observability';
import {
  DockerUnreachableError,
  type CreateNetworkSpec,
  type DockerContainerSnapshot,
  type DockerContainerSummary,
  type DockerEngineFactory,
  type DockerEnginePort,
  type DockerExecResult,
  type DockerFileRead,
  type DockerImageSnapshot,
  type DockerImageSummary,
  type DockerNetworkSnapshot,
  type DockerNetworkSummary,
  type DockerVersion,
  type DockerVolumeSnapshot,
  type DockerVolumeSummary,
  type RunContainerSpec,
} from './port.js';
import { SESSION_LABEL, LAB_LABEL, EXPIRES_AT_LABEL } from '../k8s/labels.js';
import { isContainerSandboxRef } from '../session/identifiers.js';

export interface BrokerDockerOptions {
  /** `http://sandboxd:4002`. Configuration, never a value from a request. */
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** A file read as it travels: bytes base64-encoded, because JSON has no Buffer. */
interface WireFileRead {
  contentBase64: string;
  declaredSize: number;
  truncated: boolean;
}

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

function notBrokeredError(method: string): DockerUnreachableError {
  return new DockerUnreachableError(
    `'${method}' is not a brokered Docker operation. The API holds no container runtime in this ` +
      'deployment, and sandboxd offers a closed list of operations that does not include this one.',
  );
}

/** Thrown where control flow needs the `never`, e.g. to narrow a union. */
function notBrokered(method: string): never {
  throw notBrokeredError(method);
}

/**
 * Returned by every method the broker deliberately does not offer.
 *
 * A *rejected promise* rather than a synchronous throw, so an un-brokered
 * method fails the same way a brokered one does when the broker is down. A
 * caller writing `await engine.pullImage(…)` inside a `try` should not have to
 * know which of the two it got.
 */
function notBrokeredAsync<T>(method: string): Promise<T> {
  return Promise.reject(notBrokeredError(method));
}

class BrokerCall {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: BrokerDockerOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/docker`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': this.#secret,
          // Correlation only — see broker-runtime.ts.
          ...(currentRequestId() ? { [REQUEST_ID_HEADER]: currentRequestId()! } : {}),
        },
        body: JSON.stringify({ op, ...payload }),
        signal: controller.signal,
      });
    } catch (error) {
      /*
       * Fail closed, and as the *environment* being unreachable rather than as
       * an unexpected error: the provider already knows how to report that
       * against the right provisioning step, and a student sees "environment
       * unreachable" instead of a stack trace.
       */
      const message = error instanceof Error ? error.message : String(error);
      throw new DockerUnreachableError(`the runtime broker is unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    let envelope: Envelope;
    try {
      envelope = (await response.json()) as Envelope;
    } catch {
      throw new DockerUnreachableError(
        `the runtime broker returned a non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!response.ok || !envelope.ok) {
      const message = envelope.error?.message ?? `the runtime broker refused '${op}' (HTTP ${response.status})`;
      // A broker that cannot reach its daemon is the environment being down;
      // anything else is a refusal and must not be mistaken for one.
      if (envelope.error?.code === 'DOCKER_UNREACHABLE') {
        throw new DockerUnreachableError(message);
      }
      throw new Error(message);
    }
    return (envelope.data ?? {}) as T;
  }
}

/** The host engine: this deployment's own sandbox lifecycle. */
class BrokerHostEngine implements DockerEnginePort {
  readonly #broker: BrokerCall;
  readonly #sessions: SessionIndex;

  constructor(broker: BrokerCall, sessions: SessionIndex) {
    this.#broker = broker;
    this.#sessions = sessions;
  }

  async ping(): Promise<void> {
    await this.version();
  }

  async version(): Promise<DockerVersion> {
    const { version } = await this.#broker.call<{ version: DockerVersion }>('hostVersion', {});
    return version;
  }

  /**
   * Create this session's sandbox.
   *
   * The spec is read for the three session-varying facts and then **discarded**:
   * the image, the privilege, the resource ceilings, the network and the volume
   * are the broker's own configuration, and none of them travels. What the
   * provider passes here still shapes nothing on the wire, which is exactly the
   * property worth having.
   */
  async runContainer(spec: RunContainerSpec): Promise<string> {
    const labels = spec.labels ?? {};
    const sessionId = labels[SESSION_LABEL];
    const labId = labels[LAB_LABEL];
    const expiresAtMs = Number(labels[EXPIRES_AT_LABEL]);
    if (!sessionId || !labId || !Number.isFinite(expiresAtMs)) {
      throw new Error(
        'a brokered sandbox must carry session, lab and expiry labels; nothing else about it is sent',
      );
    }
    const { sandboxRef } = await this.#broker.call<{ sandboxRef: string }>('createSandbox', {
      sessionId,
      labId,
      expiresAtMs,
    });
    this.#sessions.bind(sandboxRef, sessionId);
    return sandboxRef;
  }

  async inspectContainer(name: string): Promise<DockerContainerSnapshot | null> {
    const { container } = await this.#broker.call<{ container: DockerContainerSnapshot | null }>(
      'inspectSandbox',
      { sessionId: this.#sessions.require(name) },
    );
    return container;
  }

  async listContainers(): Promise<DockerContainerSummary[]> {
    const { containers } = await this.#broker.call<{ containers: DockerContainerSummary[] }>(
      'listManagedSandboxes',
      {},
    );
    // Every sandbox the broker reports is one this deployment owns, so the
    // reaper can address each of them by session afterwards.
    for (const c of containers) {
      const sessionId = c.labels?.[SESSION_LABEL];
      if (sessionId) this.#sessions.bind(c.name, sessionId);
    }
    return containers;
  }

  async removeContainer(name: string): Promise<void> {
    await this.#broker.call('removeSandbox', { sessionId: this.#sessions.require(name) });
  }

  async createNetwork(_spec: CreateNetworkSpec): Promise<void> {
    // The name is not sent: the broker uses the network it is configured with.
    await this.#broker.call('createSandboxNetwork', {});
  }

  async createVolume(): Promise<void> {
    // Created as part of `createSandbox`, from the derived sandbox name. There
    // is no independent volume-creation operation to expose.
  }

  /**
   * Read one of a session's three TLS client files.
   *
   * The only exec-shaped call the platform makes on the host engine, and the
   * broker does not accept an argv for it: it takes a session id and one of
   * three file names, and runs the `cat` itself.
   */
  async execInContainer(name: string, argv: string[]): Promise<DockerExecResult> {
    const sessionId = this.#sessions.require(name);

    const file = certificateFileFrom(argv);
    if (file) {
      return this.#broker.call<DockerExecResult>('readCertificate', { sessionId, file });
    }
    if (isCliVersionProbe(argv)) {
      return this.#broker.call<DockerExecResult>('sandboxCliVersion', { sessionId });
    }
    // Two recognised shapes, and everything else refused. The argv itself is
    // never sent: each shape maps to an operation that builds its own.
    notBrokered(`execInContainer(${argv.join(' ')})`);
  }

  // --- deliberately not brokered ------------------------------------------
  startContainer(): Promise<void> {
    return notBrokeredAsync('startContainer');
  }
  stopContainer(): Promise<void> {
    return notBrokeredAsync('stopContainer');
  }
  containerLogs(): Promise<string> {
    return notBrokeredAsync('containerLogs');
  }
  copyFileFromContainer(): Promise<DockerFileRead | null> {
    return notBrokeredAsync('copyFileFromContainer on the host engine');
  }
  inspectImage(): Promise<DockerImageSnapshot | null> {
    return notBrokeredAsync('inspectImage on the host engine');
  }
  listImages(): Promise<DockerImageSummary[]> {
    return notBrokeredAsync('listImages');
  }
  pullImage(): Promise<void> {
    return notBrokeredAsync('pullImage');
  }
  removeImage(): Promise<void> {
    return notBrokeredAsync('removeImage');
  }
  inspectVolume(): Promise<DockerVolumeSnapshot | null> {
    return notBrokeredAsync('inspectVolume on the host engine');
  }
  listVolumes(): Promise<DockerVolumeSummary[]> {
    return notBrokeredAsync('listVolumes');
  }
  /**
   * A no-op, because `removeSandbox` already did it.
   *
   * The provider removes the sandbox and then its named data volume, in two
   * calls. Brokering the second as its own verb would mean accepting a volume
   * name from the caller — so the broker removes it as part of destroying the
   * sandbox instead, derived from the same session. This exists so the
   * provider's second call is harmless rather than a refusal that would abort a
   * destroy that has in fact fully succeeded.
   */
  async removeVolume(): Promise<void> {
    // Intentionally empty. See above.
  }
  inspectNetwork(): Promise<DockerNetworkSnapshot | null> {
    return notBrokeredAsync('inspectNetwork on the host engine');
  }
  listNetworks(): Promise<DockerNetworkSummary[]> {
    return notBrokeredAsync('listNetworks');
  }
  removeNetwork(): Promise<void> {
    return notBrokeredAsync('removeNetwork');
  }
}

/** A session's own daemon: reads only, and only inside that session's sandbox. */
class BrokerSessionEngine implements DockerEnginePort {
  readonly #broker: BrokerCall;
  readonly #sessionId: string;

  constructor(broker: BrokerCall, sessionId: string) {
    this.#broker = broker;
    this.#sessionId = sessionId;
  }

  async ping(): Promise<void> {
    await this.version();
  }

  async version(): Promise<DockerVersion> {
    const { version } = await this.#broker.call<{ version: DockerVersion }>('sessionVersion', {
      sessionId: this.#sessionId,
    });
    return version;
  }

  async inspectContainer(name: string): Promise<DockerContainerSnapshot | null> {
    const { container } = await this.#broker.call<{ container: DockerContainerSnapshot | null }>(
      'sessionInspectContainer',
      { sessionId: this.#sessionId, name },
    );
    return container;
  }

  async inspectImage(reference: string): Promise<DockerImageSnapshot | null> {
    const { image } = await this.#broker.call<{ image: DockerImageSnapshot | null }>(
      'sessionInspectImage',
      { sessionId: this.#sessionId, reference },
    );
    return image;
  }

  async inspectVolume(name: string): Promise<DockerVolumeSnapshot | null> {
    const { volume } = await this.#broker.call<{ volume: DockerVolumeSnapshot | null }>(
      'sessionInspectVolume',
      { sessionId: this.#sessionId, name },
    );
    return volume;
  }

  async inspectNetwork(name: string): Promise<DockerNetworkSnapshot | null> {
    const { network } = await this.#broker.call<{ network: DockerNetworkSnapshot | null }>(
      'sessionInspectNetwork',
      { sessionId: this.#sessionId, name },
    );
    return network;
  }

  async listContainers(options?: { all?: boolean }): Promise<DockerContainerSummary[]> {
    const { containers } = await this.#broker.call<{ containers: DockerContainerSummary[] }>(
      'sessionListContainers',
      { sessionId: this.#sessionId, all: options?.all === true },
    );
    return containers;
  }

  async copyFileFromContainer(
    name: string,
    path: string,
    options?: { maxBytes?: number },
  ): Promise<DockerFileRead | null> {
    const { file } = await this.#broker.call<{ file: WireFileRead | null }>('sessionCopyFile', {
      sessionId: this.#sessionId,
      container: name,
      path,
      ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });
    if (!file) return null;
    // Back to a real Buffer. The verifier's binary check reads bytes, and a
    // JSON-flattened Buffer is not one — see the encoder in `docker-ops.ts`.
    return {
      content: Buffer.from(file.contentBase64, 'base64'),
      declaredSize: file.declaredSize,
      truncated: file.truncated,
    };
  }

  // --- seeding and resetting a lab's declared state -----------------------
  //
  // The platform writes to a session's own daemon, and always has: a lab's
  // starting condition is *built* there — DOCKER-010, DOCKER-011 and
  // DOCKER-012 hand the student pre-broken containers to diagnose — and
  // `reset` tears it back down. Everything below exists for that.
  //
  // It costs nothing: this daemon lives inside the student's own sandbox, and
  // they already hold a client certificate and a shell for it. The boundary is
  // which sandbox these reach, and that is decided by the session id the
  // broker derives from — not by anything here.

  async pullImage(reference: string): Promise<void> {
    await this.#broker.call('sessionPullImage', { sessionId: this.#sessionId, reference });
  }

  async runContainer(spec: RunContainerSpec): Promise<string> {
    const { id } = await this.#broker.call<{ id: string }>('sessionRunContainer', {
      sessionId: this.#sessionId,
      spec,
    });
    return id;
  }

  async stopContainer(name: string, timeoutSeconds?: number): Promise<void> {
    await this.#broker.call('sessionStopContainer', {
      sessionId: this.#sessionId,
      name,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    });
  }

  async removeContainer(
    name: string,
    options?: { force?: boolean; volumes?: boolean },
  ): Promise<void> {
    await this.#broker.call('sessionRemoveContainer', {
      sessionId: this.#sessionId,
      name,
      force: options?.force === true,
      volumes: options?.volumes === true,
    });
  }

  async createNetwork(spec: CreateNetworkSpec): Promise<void> {
    await this.#broker.call('sessionCreateNetwork', { sessionId: this.#sessionId, spec });
  }

  async createVolume(name: string): Promise<void> {
    await this.#broker.call('sessionCreateVolume', { sessionId: this.#sessionId, name });
  }

  async removeNetwork(name: string): Promise<void> {
    await this.#broker.call('sessionRemoveNetwork', { sessionId: this.#sessionId, name });
  }

  async removeVolume(name: string, force?: boolean): Promise<void> {
    await this.#broker.call('sessionRemoveVolume', {
      sessionId: this.#sessionId,
      name,
      force: force === true,
    });
  }

  async removeImage(reference: string, force?: boolean): Promise<void> {
    await this.#broker.call('sessionRemoveImage', {
      sessionId: this.#sessionId,
      reference,
      force: force === true,
    });
  }

  async listImages(): Promise<DockerImageSummary[]> {
    const { images } = await this.#broker.call<{ images: DockerImageSummary[] }>(
      'sessionListImages',
      { sessionId: this.#sessionId },
    );
    return images;
  }

  async listVolumes(): Promise<DockerVolumeSummary[]> {
    const { volumes } = await this.#broker.call<{ volumes: DockerVolumeSummary[] }>(
      'sessionListVolumes',
      { sessionId: this.#sessionId },
    );
    return volumes;
  }

  async listNetworks(): Promise<DockerNetworkSummary[]> {
    const { networks } = await this.#broker.call<{ networks: DockerNetworkSummary[] }>(
      'sessionListNetworks',
      { sessionId: this.#sessionId },
    );
    return networks;
  }

  // --- deliberately not brokered ------------------------------------------
  //
  // Two, and both for the same reason: nothing in the platform calls them, and
  // each is the shape of a capability worth not having. `execInContainer` is
  // arbitrary execution; `startContainer` would let a stopped container a lab
  // deliberately left stopped be started behind the student's back.
  startContainer(): Promise<void> {
    return notBrokeredAsync('startContainer on a session daemon');
  }
  containerLogs(): Promise<string> {
    return notBrokeredAsync('containerLogs on a session daemon');
  }
  execInContainer(): Promise<DockerExecResult> {
    return notBrokeredAsync('execInContainer on a session daemon');
  }
}

/**
 * Which session a sandbox reference belongs to.
 *
 * Populated only from the platform's own output — the reference a
 * `createSandbox` returned, or the session label on a sandbox the broker
 * listed. A reference that never came from one of those has no entry, and
 * `require` refuses rather than guessing, so an arbitrary container name cannot
 * be turned into a broker call at all.
 */
class SessionIndex {
  readonly #bySandbox = new Map<string, string>();

  bind(sandboxRef: string, sessionId: string): void {
    if (isContainerSandboxRef(sandboxRef)) this.#bySandbox.set(sandboxRef, sessionId);
  }

  lookup(sandboxRef: string): string | undefined {
    return this.#bySandbox.get(sandboxRef);
  }

  require(sandboxRef: string): string {
    const sessionId = this.#bySandbox.get(sandboxRef);
    if (!sessionId) {
      throw new Error(
        `'${sandboxRef}' is not a sandbox this process has a session for. Brokered Docker ` +
          'operations are addressed by session, never by container name.',
      );
    }
    return sessionId;
  }

  forget(sandboxRef: string): void {
    this.#bySandbox.delete(sandboxRef);
  }
}

export class BrokerDockerEngines implements DockerEngineFactory {
  readonly host: DockerEnginePort;
  readonly #broker: BrokerCall;
  readonly #sessions = new SessionIndex();
  readonly #cache = new Map<string, DockerEnginePort>();

  constructor(options: BrokerDockerOptions) {
    this.#broker = new BrokerCall(options);
    this.host = new BrokerHostEngine(this.#broker, this.#sessions);
  }

  /**
   * Tell this factory which session a sandbox belongs to.
   *
   * Called by the provider when it starts a session, so that later calls —
   * a verifier read, a reaper sweep — can address the sandbox by the session it
   * belongs to rather than by its name.
   */
  bindSession(sandboxRef: string, sessionId: string): void {
    this.#sessions.bind(sandboxRef, sessionId);
  }

  session(sandbox: string, sessionId?: string): DockerEnginePort {
    /*
     * A caller that knows whose session this is says so, and that is the
     * normal path: the API holds the session record whenever it verifies,
     * resets or reaps. The index is the fallback for callers that do not — and
     * it is populated only from this platform's own output, never from a name
     * somebody supplied.
     */
    if (sessionId) this.#sessions.bind(sandbox, sessionId);
    const resolved = sessionId ?? this.#sessions.lookup(sandbox);
    if (!resolved) {
      // Fail closed, and say why: this is the path an arbitrary container name
      // would have to travel, and it stops here.
      throw new Error(
        `Refusing to address '${sandbox}': no session is bound to it. Brokered Docker ` +
          'operations are keyed on a session id, which the broker derives the sandbox name from.',
      );
    }
    const cached = this.#cache.get(sandbox);
    if (cached) return cached;
    const engine = new BrokerSessionEngine(this.#broker, resolved);
    this.#cache.set(sandbox, engine);
    return engine;
  }

  /** Drop a sandbox once it is gone, so a reused name cannot inherit a session. */
  forget(sandbox: string): void {
    this.#cache.delete(sandbox);
    this.#sessions.forget(sandbox);
  }
}

/**
 * The certificate file an `execInContainer` argv is asking for, if any.
 *
 * The provider reads its session's TLS material with `cat /certs/client/<f>`.
 * Rather than forward the argv, this recognises exactly that shape and turns it
 * into the typed operation — and returns `null` for anything else, which the
 * caller turns into a refusal.
 */
function isCliVersionProbe(argv: string[]): boolean {
  return (
    argv.length === 4 &&
    argv[0] === 'docker' &&
    argv[1] === 'version' &&
    argv[2] === '--format' &&
    argv[3] === '{{.Client.Version}}'
  );
}

function certificateFileFrom(argv: string[]): string | null {
  if (argv.length !== 2 || argv[0] !== 'cat') return null;
  const match = /^\/certs\/client\/(ca\.pem|cert\.pem|key\.pem)$/.exec(argv[1] ?? '');
  return match ? (match[1] as string) : null;
}
