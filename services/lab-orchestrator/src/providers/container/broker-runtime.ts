/**
 * `ContainerRuntimePort` over the runtime broker.
 *
 * The seam this implements was designed for exactly this: provider code asks a
 * port for a container, and does not know whether the answer came from a local
 * daemon or from a service one hop away. `DockerCliRuntime` is the local
 * answer; this is the remote one, and switching between them is a single line
 * in the composition root.
 *
 * ```text
 *   LinuxLabProvider ─► ContainerRuntimePort ─┬─► DockerCliRuntime   (a laptop)
 *                                             └─► BrokerRuntime ──► sandboxd
 * ```
 *
 * What it buys is the whole point of the architecture: with this in place the
 * API creates, reads and destroys student sandboxes **while holding no
 * container runtime of its own**. The socket lives in `sandboxd`, which is
 * internal-only and offers eleven verbs; the API — the service behind `/api`,
 * the one a browser can reach — has nothing a bug in it could turn into root on
 * the runtime host.
 *
 * Validation is deliberately *not* duplicated here. Every name, image,
 * capability and environment name is checked by the `DockerCliRuntime` running
 * inside the broker, on the privileged side of the boundary, where the check
 * still holds if this client is wrong. Adding a second copy here would invite
 * the two to drift and would suggest the remote check is optional.
 */
import { currentRequestId, REQUEST_ID_HEADER } from '@jumptotech/observability';
import type {
  ContainerExecRequest,
  ContainerExecResult,
  ContainerInfo,
  ContainerRuntimePort,
  ContainerSpec,
  NetworkInfo,
  NetworkSpec,
} from './runtime.js';
import { ContainerRuntimeError } from './runtime.js';

/** The ambient correlation id as a header, or nothing outside a request. */
function requestIdHeader(): Record<string, string> {
  const id = currentRequestId();
  return id ? { [REQUEST_ID_HEADER]: id } : {};
}

export interface BrokerRuntimeOptions {
  /** `http://sandboxd:4002`. Configuration, never a value from a request. */
  baseUrl: string;
  /** Authenticates this service to the broker. */
  secret: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

interface BrokerEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

export class BrokerRuntime implements ContainerRuntimePort {
  readonly name = 'sandboxd';
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: BrokerRuntimeOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async ping(): Promise<string> {
    const { version } = await this.#call<{ version: string }>('ping', {});
    return version;
  }

  async imageExists(image: string): Promise<boolean> {
    const { exists } = await this.#call<{ exists: boolean }>('imageExists', { image });
    return exists;
  }

  async create(spec: ContainerSpec): Promise<ContainerInfo> {
    const { container } = await this.#call<{ container: ContainerInfo }>('create', { spec });
    return container;
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    const { container } = await this.#call<{ container: ContainerInfo | null }>('inspect', { name });
    return container;
  }

  async list(labelSelector: string): Promise<ContainerInfo[]> {
    const { containers } = await this.#call<{ containers: ContainerInfo[] }>('list', {
      labelSelector,
    });
    return containers;
  }

  async remove(name: string): Promise<void> {
    await this.#call('remove', { name });
  }

  async exec(name: string, request: ContainerExecRequest): Promise<ContainerExecResult> {
    const { result } = await this.#call<{ result: ContainerExecResult }>('exec', { name, request });
    return result;
  }

  async networkCreate(spec: NetworkSpec): Promise<void> {
    await this.#call('networkCreate', { spec });
  }

  async networkInspect(name: string): Promise<NetworkInfo | null> {
    const { network } = await this.#call<{ network: NetworkInfo | null }>('networkInspect', { name });
    return network;
  }

  async networkRemove(name: string): Promise<void> {
    await this.#call('networkRemove', { name });
  }

  async networkList(labelSelector: string): Promise<NetworkInfo[]> {
    const { networks } = await this.#call<{ networks: NetworkInfo[] }>('networkList', {
      labelSelector,
    });
    return networks;
  }

  async #call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/runtime`, {
        method: 'POST',
        headers: {
          /*
           * Correlation across the process boundary — PLATFORM-003.
           *
           * Purely descriptive: the broker uses it to tag its log lines and
           * for nothing else. It is never an authorization input, never a key
           * into a store, and never trusted to be unique. Authorization here
           * is, and remains, the scoped `x-internal-secret` below.
           */
          ...requestIdHeader(),
          'content-type': 'application/json',
          'x-internal-secret': this.#secret,
        },
        body: JSON.stringify({ op, ...payload }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ContainerRuntimeError(`the runtime broker is unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    let envelope: BrokerEnvelope;
    try {
      envelope = (await response.json()) as BrokerEnvelope;
    } catch {
      throw new ContainerRuntimeError(
        `the runtime broker returned a non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!response.ok || !envelope.ok) {
      // Carried through verbatim: the broker's refusals are the ones an
      // operator needs to read, and rewording them here would hide which side
      // said no.
      throw new ContainerRuntimeError(
        envelope.error?.message ?? `the runtime broker refused '${op}' (HTTP ${response.status})`,
      );
    }
    return (envelope.data ?? {}) as T;
  }
}
