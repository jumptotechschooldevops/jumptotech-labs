/**
 * The Docker track's brokered operations.
 *
 * The Docker provider is the one track whose sandbox is itself a *daemon*: a
 * `docker:dind` container the student builds and runs things on over mutual
 * TLS. Driving those sandboxes needs `DockerEnginePort` rather than the
 * eleven-verb `ContainerRuntimePort` the other tracks use, and that is why the
 * track was still asking the API to hold a host Docker socket after every other
 * track had stopped.
 *
 * This module is the answer. It is not a proxy for `DockerEnginePort`: it is a
 * closed list of **fourteen named operations**, none of which takes a command
 * line, an image, a mount, a capability, or a privilege flag from its caller.
 *
 * ```text
 *   api ──POST /v1/docker { op, sessionId, … }──► sandboxd ──► host daemon
 *                                                    │
 *                                        derives the sandbox name,
 *                                        re-derives it from the container's
 *                                        own label, and builds the run spec
 *                                        from its own configuration
 * ```
 *
 * ## The two things that make this a boundary
 *
 * **1. The sandbox is never named by the caller — twice over.**
 *
 * Creation takes a session id and derives the container name from it. Every
 * other operation takes the derived name and then *re-derives* it from the
 * session id stamped on the live container:
 *
 * ```text
 *   requested ref ─► inspect ─► labels[session-id] ─► deriveSandboxRef(…) ─► must equal requested ref
 * ```
 *
 * A container hand-created under a plausible name carries no session label and
 * fails; one carrying a *forged* session label derives to a different name and
 * fails too. The loop can only close for a container this platform created for
 * that session.
 *
 * **2. The run spec is built here, from configuration.**
 *
 * `runContainer` on the wire would mean a caller choosing an image, a mount
 * list, and `--privileged`. So it is not on the wire. `createSandbox` carries a
 * session id, a lab id and an expiry, and *this* process supplies the image,
 * the privilege, the memory, the CPU, the pids limit, the network and the
 * volume — from its own `DOCKER_SANDBOX_*` configuration. There is no argument
 * a compromised API could set to run a different image, add a bind mount, or
 * ask for privilege on something that is not a sandbox.
 *
 * ## Why the session scope is wider, and why that is still safe
 *
 * The operations below split into two groups, and the split is not arbitrary.
 *
 * *Host scope* is narrow because that is where privilege lives: it creates
 * `--privileged` containers on the machine's own daemon, so every operation is
 * either parameterless or takes a session id and nothing else.
 *
 * *Session scope* is wide — it can run, stop, remove, pull and list — because
 * it addresses **the daemon inside one student's sandbox**, and everything on
 * that daemon is already theirs. They hold a client certificate for it and a
 * shell to use it from; the platform writing there grants nobody anything they
 * did not already have. The platform needs those writes for real work: seeding
 * a lab's declared starting state is how DOCKER-010, DOCKER-011 and DOCKER-012
 * present the pre-broken containers a student is asked to diagnose, and `reset`
 * is how they get a clean one back.
 *
 * So the security property is not "the platform only reads a session's
 * daemon" — it never did. It is that **every one of these is routed through a
 * sandbox derived from a session id**, so the only daemon any of them can
 * reach is that session's own. Two things still do not appear even here:
 * `execInContainer`, because nothing needs it and it is the one shaped like
 * arbitrary execution; and `privileged`, which `sessionRunContainer` forces off
 * regardless of what it is sent.
 */
import {
  COMPONENT_LABEL,
  CONTAINER_SANDBOX_PREFIX,
  DockerUnreachableError,
  EXPIRES_AT_LABEL,
  LAB_LABEL,
  MANAGED_LABEL,
  MANAGED_SELECTOR,
  SANDBOX_COMPONENT,
  PROVIDER_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  assertValidContainerSandboxRef,
  assertValidSessionId,
  deriveSandboxRef,
  isContainerSandboxRef,
  ownershipLabels,
  type DockerContainerSnapshot,
  type DockerEngineFactory,
  type DockerSandboxPolicy,
  type RunContainerSpec,
} from '@jumptotech/lab-orchestrator';

export { SANDBOX_COMPONENT };

/** Where `docker:dind` writes the TLS material it mints at startup. */
export const CERT_DIR = '/certs';
/** The only three files `readCertificate` will ever read. A closed list. */
export const CERTIFICATE_FILES = ['ca.pem', 'cert.pem', 'key.pem'] as const;
export type CertificateFile = (typeof CERTIFICATE_FILES)[number];

/** Every Docker operation this broker answers. Anything else is refused. */
export const DOCKER_OPERATIONS = [
  // --- host scope: the platform's own sandbox lifecycle -------------------
  'hostVersion',
  'createSandboxNetwork',
  'createSandbox',
  'inspectSandbox',
  'removeSandbox',
  'listManagedSandboxes',
  'readCertificate',
  'sandboxCliVersion',
  // --- session scope: reads against one session's own daemon --------------
  'sessionVersion',
  'sessionInspectContainer',
  'sessionInspectImage',
  'sessionInspectVolume',
  'sessionInspectNetwork',
  'sessionCopyFile',
  'sessionListContainers',
  'sessionListImages',
  'sessionListVolumes',
  'sessionListNetworks',
  // --- session scope: seeding and resetting a lab's declared state ---------
  'sessionPullImage',
  'sessionRunContainer',
  'sessionStopContainer',
  'sessionRemoveContainer',
  'sessionCreateNetwork',
  'sessionCreateVolume',
  'sessionRemoveNetwork',
  'sessionRemoveVolume',
  'sessionRemoveImage',
] as const;

export type DockerOperation = (typeof DOCKER_OPERATIONS)[number];

export class DockerOpDeniedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DockerOpDeniedError';
  }
}

export interface DockerOpsOptions {
  engines: DockerEngineFactory;
  /** Must equal the API's `NAMESPACE_DERIVATION_SECRET`. */
  derivationSecret: string;
  runtimeOwner: string;
  policy: DockerSandboxPolicy;
}

/**
 * A Docker resource name a student may legitimately have created.
 *
 * These reach the *inner* daemon — the one that exists only inside the
 * student's own sandbox container — so the isolation is the sandbox boundary,
 * not this pattern. It exists so a malformed value cannot become an argument:
 * Docker's own object-name grammar, and nothing that starts with a dash.
 */
const DOCKER_OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/** An absolute path inside a container, for the one file-read operation. */
const CONTAINER_PATH = /^\/[A-Za-z0-9._\-/]{0,255}$/;

function objectName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DOCKER_OBJECT_NAME.test(value)) {
    throw new DockerOpDeniedError(400, 'BAD_REQUEST', `'${field}' is not a valid Docker object name`);
  }
  return value;
}

export class DockerOps {
  readonly #engines: DockerEngineFactory;
  readonly #derivationSecret: string;
  readonly #runtimeOwner: string;
  readonly #policy: DockerSandboxPolicy;

  constructor(options: DockerOpsOptions) {
    this.#engines = options.engines;
    this.#derivationSecret = options.derivationSecret;
    this.#runtimeOwner = options.runtimeOwner;
    this.#policy = options.policy;
  }

  /**
   * The sandbox name for a session id. Computed, never received.
   *
   * Identical to the derivation the API and the attach path use, keyed on the
   * same secret — which is what makes a key mismatch fail closed rather than
   * fail open.
   */
  #refFor(sessionId: unknown): string {
    let id: string;
    try {
      id = assertValidSessionId(sessionId);
    } catch {
      throw new DockerOpDeniedError(400, 'INVALID_SESSION_ID', 'That is not a lab session id.');
    }
    return deriveSandboxRef({
      sessionId: id,
      secret: this.#derivationSecret,
      prefix: CONTAINER_SANDBOX_PREFIX,
    });
  }

  /**
   * Resolve a session to its live sandbox, or refuse.
   *
   * The four label checks are the same ones the reaper applies before it
   * deletes anything, and the fifth — re-deriving the name from the container's
   * own session label — is what makes a forged label useless.
   */
  async #ownedSandbox(sessionId: unknown): Promise<{ ref: string; snapshot: DockerContainerSnapshot }> {
    const ref = this.#refFor(sessionId);
    assertValidContainerSandboxRef(ref);

    const snapshot = await this.#engines.host.inspectContainer(ref);
    if (!snapshot) {
      throw new DockerOpDeniedError(404, 'SANDBOX_NOT_FOUND', 'This session has no Docker sandbox.');
    }

    const labels = snapshot.labels ?? {};
    if (labels[MANAGED_LABEL] !== 'true') {
      throw new DockerOpDeniedError(403, 'SANDBOX_NOT_MANAGED', 'That container was not created by this platform.');
    }
    if (labels[RUNTIME_OWNER_LABEL] !== this.#runtimeOwner) {
      throw new DockerOpDeniedError(403, 'SANDBOX_NOT_OWNED', 'That container belongs to a different runtime owner.');
    }
    if (labels[COMPONENT_LABEL] !== SANDBOX_COMPONENT) {
      throw new DockerOpDeniedError(403, 'SANDBOX_NOT_A_SANDBOX', 'That container is not a Docker lab sandbox.');
    }
    if (labels[PROVIDER_LABEL] !== 'docker') {
      throw new DockerOpDeniedError(403, 'SANDBOX_WRONG_PROVIDER', 'That container belongs to another provider.');
    }

    /*
     * The loop-closer. A container may only be addressed as session X's
     * sandbox if deriving from the session id *it carries* produces the name we
     * arrived at. Forging the label changes the derivation and fails.
     */
    const stamped = labels[SESSION_LABEL];
    if (!stamped || this.#refFor(stamped) !== ref) {
      throw new DockerOpDeniedError(
        403,
        'SANDBOX_SESSION_MISMATCH',
        'That container does not belong to this session.',
      );
    }

    return { ref, snapshot };
  }

  /** Dispatch one operation. The `switch` is the closed list. */
  async run(op: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!(DOCKER_OPERATIONS as readonly string[]).includes(op)) {
      throw new DockerOpDeniedError(
        400,
        'UNKNOWN_OPERATION',
        `'${String(op)}' is not a Docker operation this broker offers`,
      );
    }

    switch (op as DockerOperation) {
      // ------------------------------------------------------------- host
      case 'hostVersion':
        return { version: await this.#engines.host.version() };

      case 'createSandboxNetwork': {
        /*
         * The shared bridge sandboxes join so the terminal can reach them over
         * TLS. Its name is *this service's* configuration — a caller cannot
         * name a network, so `bridge`, `host` and the `kind` network are not
         * reachable from here however wrong the API is.
         */
        await this.#engines.host.createNetwork({
          name: this.#policy.network,
          driver: 'bridge',
          labels: { [MANAGED_LABEL]: 'true', [RUNTIME_OWNER_LABEL]: this.#runtimeOwner },
        });
        return { network: this.#policy.network };
      }

      case 'createSandbox': {
        /*
         * The whole run spec is built here. See the module header: the caller
         * supplies who the session is, and nothing about what runs.
         */
        const ref = this.#refFor(payload.sessionId);
        const sessionId = assertValidSessionId(payload.sessionId);
        const labId = objectName(payload.labId, 'labId');
        const expiresAtMs = Number(payload.expiresAtMs);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
          throw new DockerOpDeniedError(400, 'BAD_REQUEST', "'expiresAtMs' must be a positive number");
        }

        const labels = ownershipLabels({
          sessionId,
          labId,
          expiresAtMs,
          component: SANDBOX_COMPONENT,
          provider: 'docker',
          runtimeOwner: this.#runtimeOwner,
        });
        const volume = `${ref}-data`;

        // Re-entrant, matching the provider contract: a create over an
        // existing sandbox replaces it rather than failing.
        await this.#engines.host.removeContainer(ref, { force: true, volumes: true });
        await this.#engines.host.createVolume(volume, {
          [MANAGED_LABEL]: 'true',
          [SESSION_LABEL]: sessionId,
          [RUNTIME_OWNER_LABEL]: this.#runtimeOwner,
        });

        const daemonArgs = ['--storage-driver', 'overlay2'];
        if (this.#policy.registryMirror) {
          daemonArgs.push('--registry-mirror', this.#policy.registryMirror);
          if (this.#policy.registryMirror.startsWith('http://')) {
            daemonArgs.push(
              '--insecure-registry',
              this.#policy.registryMirror.replace(/^http:\/\//, ''),
            );
          }
        }

        await this.#engines.host.runContainer({
          name: ref,
          image: this.#policy.image,
          detach: true,
          // Lands in the daemon's server certificate SANs, which is what lets
          // the student verify `tcp://jtt-lab-…:2376`.
          hostname: ref,
          network: this.#policy.network,
          privileged: this.#policy.privileged,
          restartPolicy: `on-failure:${this.#policy.restartAttempts}`,
          memory: this.#policy.memory,
          cpus: this.#policy.cpus,
          pidsLimit: this.#policy.pidsLimit,
          env: { DOCKER_TLS_CERTDIR: CERT_DIR },
          volumes: [{ volume, destination: '/var/lib/docker' }],
          labels,
          args: daemonArgs,
        });

        return {
          sandboxRef: ref,
          image: this.#policy.image,
          network: this.#policy.network,
          volume,
        };
      }

      case 'inspectSandbox': {
        // Not an error when absent: "is my sandbox there" is a question with a
        // legitimate `no`.
        try {
          const { snapshot } = await this.#ownedSandbox(payload.sessionId);
          return { container: snapshot };
        } catch (error) {
          if (error instanceof DockerOpDeniedError && error.status === 404) {
            return { container: null };
          }
          throw error;
        }
      }

      case 'removeSandbox': {
        const ref = this.#refFor(payload.sessionId);
        const snapshot = await this.#engines.host.inspectContainer(ref);
        // Removing something already gone is success: teardown is re-entrant
        // and the reaper retries.
        if (!snapshot) return { removed: false };
        // Present, so it must prove itself ours before it can be destroyed.
        await this.#ownedSandbox(payload.sessionId);
        await this.#engines.host.removeContainer(ref, { force: true, volumes: true });
        /*
         * And the named data volume, which `docker rm -v` does not touch.
         *
         * `-v` removes a container's *anonymous* volumes; the sandbox's
         * `/var/lib/docker` is a named one, created above so it can be labelled
         * and reaped. Leaving it behind leaks a volume per session — each
         * holding a whole daemon's image store — until a disk fills up.
         *
         * Derived from the sandbox name, so it is as session-scoped as the
         * container was, and a failure here is not fatal: the container is
         * already gone and the reaper re-enters teardown.
         */
        await this.#engines.host.removeVolume(`${ref}-data`, true).catch(() => undefined);
        return { removed: true };
      }

      case 'listManagedSandboxes': {
        const containers = await this.#engines.host.listContainers({
          all: true,
          labelSelector: MANAGED_SELECTOR,
        });
        /*
         * Scoped before it is returned. A reaper driving this broker cannot
         * see, and therefore cannot remove, a sandbox belonging to another
         * deployment sharing this daemon.
         */
        return {
          containers: containers.filter(
            (c) =>
              isContainerSandboxRef(c.name) &&
              c.labels?.[COMPONENT_LABEL] === SANDBOX_COMPONENT &&
              c.labels?.[PROVIDER_LABEL] === 'docker' &&
              c.labels?.[RUNTIME_OWNER_LABEL] === this.#runtimeOwner,
          ),
        };
      }

      case 'readCertificate': {
        /*
         * The one operation that runs a command inside a sandbox, and it is a
         * closed one: three file names, one directory, both constants here.
         * The caller contributes a session id and picks one of three.
         */
        const file = String(payload.file);
        if (!(CERTIFICATE_FILES as readonly string[]).includes(file)) {
          throw new DockerOpDeniedError(
            400,
            'BAD_REQUEST',
            `'${file}' is not a session certificate file (${CERTIFICATE_FILES.join(', ')})`,
          );
        }
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const result = await this.#engines.host.execInContainer(
          ref,
          ['cat', `${CERT_DIR}/client/${file}`],
          { timeoutMs: 15_000 },
        );
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }

      case 'sandboxCliVersion': {
        /*
         * The provisioning check that the student's `docker` client works
         * against their own daemon. Fixed argv, built here — the caller sends a
         * session id and nothing else, so this cannot become a way to run a
         * chosen command inside a sandbox.
         */
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const result = await this.#engines.host.execInContainer(
          ref,
          ['docker', 'version', '--format', '{{.Client.Version}}'],
          { timeoutMs: 30_000 },
        );
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }

      // ---------------------------------------------------------- session
      //
      // Everything below reads the daemon *inside* one session's sandbox. The
      // sandbox is resolved from the session id first, so the only daemon any
      // of these can reach is that session's own.

      case 'sessionVersion': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        return { version: await this.#engines.session(ref).version() };
      }

      case 'sessionInspectContainer': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const name = objectName(payload.name, 'name');
        return { container: await this.#engines.session(ref).inspectContainer(name) };
      }

      case 'sessionInspectImage': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const reference = objectName(payload.reference, 'reference');
        return { image: await this.#engines.session(ref).inspectImage(reference) };
      }

      case 'sessionInspectVolume': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const name = objectName(payload.name, 'name');
        return { volume: await this.#engines.session(ref).inspectVolume(name) };
      }

      case 'sessionInspectNetwork': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const name = objectName(payload.name, 'name');
        return { network: await this.#engines.session(ref).inspectNetwork(name) };
      }

      case 'sessionListContainers': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const all = payload.all === true;
        return { containers: await this.#engines.session(ref).listContainers({ all }) };
      }

      case 'sessionListImages': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        return { images: await this.#engines.session(ref).listImages() };
      }

      case 'sessionListVolumes': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        return { volumes: await this.#engines.session(ref).listVolumes() };
      }

      case 'sessionListNetworks': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        return { networks: await this.#engines.session(ref).listNetworks() };
      }

      case 'sessionPullImage': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const reference = objectName(payload.reference, 'reference');
        await this.#engines.session(ref).pullImage(reference);
        return { pulled: reference };
      }

      case 'sessionRunContainer': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const spec = payload.spec as Record<string, unknown> | undefined;
        if (!spec || typeof spec !== 'object') {
          throw new DockerOpDeniedError(400, 'BAD_REQUEST', "'spec' must be an object");
        }
        return {
          id: await this.#engines.session(ref).runContainer({
            ...(spec as unknown as RunContainerSpec),
            name: objectName(spec.name, 'spec.name'),
            image: objectName(spec.image, 'spec.image'),
            /*
             * Forced off, whatever arrived.
             *
             * Nothing a lab declares needs it — `DockerSetupPlan` cannot even
             * express it — and the sandbox this runs inside is already
             * `--privileged`, so a privileged container *within* it is the one
             * place an escape would gain depth. Refusing it costs nothing and
             * removes the question.
             */
            privileged: false,
          }),
        };
      }

      case 'sessionStopContainer': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const name = objectName(payload.name, 'name');
        const timeout = Number(payload.timeoutSeconds);
        await this.#engines
          .session(ref)
          .stopContainer(name, Number.isFinite(timeout) && timeout >= 0 ? timeout : undefined);
        return { stopped: name };
      }

      case 'sessionRemoveContainer': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const name = objectName(payload.name, 'name');
        await this.#engines.session(ref).removeContainer(name, {
          force: payload.force === true,
          volumes: payload.volumes === true,
        });
        return { removed: name };
      }

      case 'sessionCreateNetwork': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const spec = payload.spec as Record<string, unknown> | undefined;
        const name = objectName(spec?.name, 'spec.name');
        await this.#engines.session(ref).createNetwork({
          name,
          ...(typeof spec?.driver === 'string' ? { driver: objectName(spec.driver, 'spec.driver') } : {}),
          ...(spec?.internal === true ? { internal: true } : {}),
        });
        return { created: name };
      }

      case 'sessionCreateVolume': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const name = objectName(payload.name, 'name');
        await this.#engines.session(ref).createVolume(name);
        return { created: name };
      }

      case 'sessionRemoveNetwork': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const name = objectName(payload.name, 'name');
        await this.#engines.session(ref).removeNetwork(name);
        return { removed: name };
      }

      case 'sessionRemoveVolume': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const name = objectName(payload.name, 'name');
        await this.#engines.session(ref).removeVolume(name, payload.force === true);
        return { removed: name };
      }

      case 'sessionRemoveImage': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const reference = objectName(payload.reference, 'reference');
        await this.#engines.session(ref).removeImage(reference, payload.force === true);
        return { removed: reference };
      }

      case 'sessionCopyFile': {
        const { ref } = await this.#ownedSandbox(payload.sessionId);
        const container = objectName(payload.container, 'container');
        const path = String(payload.path);
        if (!CONTAINER_PATH.test(path)) {
          throw new DockerOpDeniedError(400, 'BAD_REQUEST', `'${path}' is not a valid container path`);
        }
        const maxBytes = Number(payload.maxBytes);
        const file = await this.#engines.session(ref).copyFileFromContainer(container, path, {
          ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
        });
        if (!file) return { file: null };
        /*
         * base64, not the Buffer.
         *
         * `JSON.stringify` turns a Buffer into `{type:'Buffer',data:[…]}`, and
         * the far side gets a plain object — so `content.includes(0)` in the
         * verifier's binary check threw, and a whole lab's grading failed with
         * an internal error. A file read is bytes, and bytes need an encoding
         * that survives JSON.
         */
        return {
          file: {
            contentBase64: file.content.toString('base64'),
            declaredSize: file.declaredSize,
            truncated: file.truncated,
          },
        };
      }
    }
  }
}

/** Translate a throw into a response the client understands. */
export function dockerErrorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof DockerOpDeniedError) {
    return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
  }
  if (error instanceof DockerUnreachableError) {
    return {
      status: 502,
      body: { ok: false, error: { code: 'DOCKER_UNREACHABLE', message: error.message } },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 502, body: { ok: false, error: { code: 'DOCKER_OPERATION_FAILED', message } } };
}
