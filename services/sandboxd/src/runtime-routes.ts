/**
 * The runtime control plane.
 *
 * The attach path (`attach.ts`) is what a *student* reaches. This is what the
 * *API* reaches: create a session's sandbox, read a file back for the verifier,
 * tear it down when the reaper says so. Before this existed, the API did that
 * work by holding the host's Docker socket — and the API is the service behind
 * `/api`, reachable from a browser, so that socket was root-equivalent
 * privilege one HTTP bug away from the public internet.
 *
 * ## Why this is a boundary and not a Docker proxy
 *
 * A generic daemon proxy would be no better than the socket. Four things make
 * this different:
 *
 *   1. **A closed operation list.** `ContainerRuntimePort` and nothing else —
 *      twelve verbs, named here, dispatched by a `switch`. There is no
 *      passthrough, no `--` escape, no raw argv, no image build, no bind mount
 *      parameter and no way to express one.
 *   2. **The same validation, on the privileged side.** Every operation runs
 *      through `DockerCliRuntime`, so the name patterns, the image pattern, the
 *      capability allow-list and the env-name pattern all execute *here*, in
 *      the process that actually holds the runtime — not only in the caller
 *      that could be wrong.
 *   3. **Ownership is enforced, not trusted.** Nothing is created without this
 *      broker's own runtime-owner label, and nothing is inspected, exec'd into
 *      or removed unless the live object already carries it. An API that asked
 *      to delete another deployment's container is refused by the process
 *      holding the socket, which is the only place that refusal is worth
 *      anything.
 *   4. **Not browser-reachable.** Internal secret required, `Origin` refused,
 *      no route in the web proxy points here.
 *
 * The one deliberate asymmetry: `list` is scoped to this broker's owner before
 * it returns, so a reaper driving this service cannot even *see* somebody
 * else's sandboxes, let alone remove them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MANAGED_CONTAINER_LABEL,
  MANAGED_CONTAINER_SELECTOR,
  RUNTIME_OWNER_LABEL,
  ContainerRuntimeError,
  isContainerNetworkRef,
  type ContainerInfo,
  type ContainerRuntimePort,
  type ContainerSpec,
  type NetworkInfo,
} from '@jumptotech/lab-orchestrator';

/** Every verb this control plane answers. Anything else is a 400. */
export const RUNTIME_OPERATIONS = [
  'ping',
  'imageExists',
  'create',
  'inspect',
  'list',
  'remove',
  'exec',
  'networkCreate',
  'networkInspect',
  'networkRemove',
  'networkList',
] as const;

export type RuntimeOperation = (typeof RUNTIME_OPERATIONS)[number];

export class RuntimeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeRequestError';
  }
}

export interface RuntimeHandlerOptions {
  runtime: ContainerRuntimePort;
  /** Every object this broker touches must carry this owner. */
  runtimeOwner: string;
}

function ownedByMe(labels: Record<string, string> | undefined, owner: string): boolean {
  if (!labels) return false;
  return labels[MANAGED_CONTAINER_LABEL] === 'true' && labels[RUNTIME_OWNER_LABEL] === owner;
}

/**
 * Refuse to touch an object this broker does not own.
 *
 * The `notFound` shape matters: for a container that exists but belongs to
 * somebody else, the honest answer to "does *my* deployment have this" is no.
 * Returning a distinct "forbidden" would confirm the container's existence to a
 * caller that has no business knowing.
 */
async function requireOwnedContainer(
  runtime: ContainerRuntimePort,
  name: string,
  owner: string,
): Promise<ContainerInfo> {
  const info = await runtime.inspect(name);
  if (!info || !ownedByMe(info.labels, owner)) {
    throw new RuntimeRequestError(404, 'SANDBOX_NOT_FOUND', `no sandbox '${name}' on this runtime`);
  }
  return info;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeRequestError(400, 'BAD_REQUEST', `'${field}' must be a non-empty string`);
  }
  return value;
}

/** Run one operation. Exported so the request plumbing and the policy stay separable. */
export async function runRuntimeOperation(
  op: string,
  payload: Record<string, unknown>,
  options: RuntimeHandlerOptions,
): Promise<unknown> {
  const { runtime, runtimeOwner } = options;

  if (!(RUNTIME_OPERATIONS as readonly string[]).includes(op)) {
    throw new RuntimeRequestError(
      400,
      'UNKNOWN_OPERATION',
      `'${String(op)}' is not a runtime operation this broker offers`,
    );
  }

  switch (op as RuntimeOperation) {
    case 'ping':
      return { version: await runtime.ping() };

    case 'imageExists':
      return { exists: await runtime.imageExists(str(payload.image, 'image')) };

    case 'create': {
      const spec = payload.spec as ContainerSpec | undefined;
      if (!spec || typeof spec !== 'object') {
        throw new RuntimeRequestError(400, 'BAD_REQUEST', "'spec' must be an object");
      }
      /*
       * The owner stamp is applied *here*, not taken on trust. A caller cannot
       * create a sandbox this broker would then refuse to reap, and cannot
       * create one wearing another deployment's owner.
       */
      const labels = {
        ...spec.labels,
        [MANAGED_CONTAINER_LABEL]: 'true',
        [RUNTIME_OWNER_LABEL]: runtimeOwner,
      };
      return { container: await runtime.create({ ...spec, labels }) };
    }

    case 'inspect': {
      const info = await runtime.inspect(str(payload.name, 'name'));
      // Not an error: the caller asks "is it there", and "not mine" is "no".
      return { container: info && ownedByMe(info.labels, runtimeOwner) ? info : null };
    }

    case 'list': {
      const selector =
        typeof payload.labelSelector === 'string' && payload.labelSelector.length > 0
          ? payload.labelSelector
          : MANAGED_CONTAINER_SELECTOR;
      const all = await runtime.list(selector);
      // Scoped before it is returned: a reaper cannot see, and therefore cannot
      // remove, a sandbox belonging to another deployment on the same runtime.
      return { containers: all.filter((c) => ownedByMe(c.labels, runtimeOwner)) };
    }

    case 'remove': {
      const name = str(payload.name, 'name');
      const info = await runtime.inspect(name);
      // Removing something already gone is success — teardown is re-entrant by
      // design, and the reaper retries. Removing something that is *there* but
      // not ours is a refusal.
      if (!info) return { removed: false };
      if (!ownedByMe(info.labels, runtimeOwner)) {
        throw new RuntimeRequestError(
          403,
          'SANDBOX_NOT_OWNED',
          `'${name}' is not owned by this runtime broker`,
        );
      }
      await runtime.remove(name);
      return { removed: true };
    }

    case 'exec': {
      const name = str(payload.name, 'name');
      await requireOwnedContainer(runtime, name, runtimeOwner);
      const request = payload.request as { argv?: unknown } | undefined;
      if (!request || !Array.isArray(request.argv)) {
        throw new RuntimeRequestError(400, 'BAD_REQUEST', "'request.argv' must be an array");
      }
      return { result: await runtime.exec(name, request as never) };
    }

    case 'networkCreate': {
      const spec = payload.spec as { name?: unknown; labels?: Record<string, string> } | undefined;
      if (!spec || !isContainerNetworkRef(spec.name)) {
        throw new RuntimeRequestError(400, 'BAD_REQUEST', "'spec.name' is not a lab network name");
      }
      await runtime.networkCreate({
        name: spec.name,
        labels: {
          ...spec.labels,
          [MANAGED_CONTAINER_LABEL]: 'true',
          [RUNTIME_OWNER_LABEL]: runtimeOwner,
        },
      });
      return { created: true };
    }

    case 'networkInspect': {
      const info = await runtime.networkInspect(str(payload.name, 'name'));
      return { network: info && ownedByMe(info.labels, runtimeOwner) ? info : null };
    }

    case 'networkRemove': {
      const name = str(payload.name, 'name');
      const info = await runtime.networkInspect(name);
      if (!info) return { removed: false };
      if (!ownedByMe(info.labels, runtimeOwner)) {
        throw new RuntimeRequestError(
          403,
          'NETWORK_NOT_OWNED',
          `'${name}' is not owned by this runtime broker`,
        );
      }
      await runtime.networkRemove(name);
      return { removed: true };
    }

    case 'networkList': {
      const selector =
        typeof payload.labelSelector === 'string' && payload.labelSelector.length > 0
          ? payload.labelSelector
          : MANAGED_CONTAINER_SELECTOR;
      const all: NetworkInfo[] = await runtime.networkList(selector);
      return { networks: all.filter((n) => ownedByMe(n.labels, runtimeOwner)) };
    }
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Read a bounded JSON body, or refuse. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new RuntimeRequestError(413, 'BODY_TOO_LARGE', 'request body is too large');
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new RuntimeRequestError(400, 'BAD_JSON', 'request body is not a JSON object');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Translate any throw into a response shape the client understands. */
export function runtimeErrorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof RuntimeRequestError) {
    return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
  }
  if (error instanceof ContainerRuntimeError) {
    // A refusal from the validation inside `DockerCliRuntime` — a bad image
    // reference, a capability that is not grantable, a malformed name.
    return {
      status: 400,
      body: { ok: false, error: { code: 'CONTAINER_RUNTIME_ERROR', message: error.message } },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 502, body: { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message } } };
}
