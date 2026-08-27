/**
 * `sandboxd` entrypoint.
 *
 * Refuses to start rather than starting weakly: `loadSandboxdConfig` throws
 * when the internal secret or the derivation secret is missing, and the runtime
 * is probed once here so an operator learns at boot that the daemon address is
 * wrong, instead of learning it from a student whose lab would not open.
 */
import { DockerCliFactory, DockerCliRuntime } from '@jumptotech/lab-orchestrator';
import { DockerOps } from './docker-ops.js';
import { loadSandboxdConfig } from './config.js';
import { DockerSandboxInspector } from './inspector.js';
import { createSandboxd } from './server.js';

const config = loadSandboxdConfig();
const inspector = new DockerSandboxInspector({ binary: config.containerBinary });

/*
 * The same `DockerCliRuntime` the API used to hold, moved to the process that
 * should have held it all along. Every name, image, capability and environment
 * name a caller sends is validated by *this* copy, on the privileged side of
 * the boundary — see `runtime-routes.ts`.
 */
const runtime = new DockerCliRuntime({ binary: config.containerBinary });

/*
 * The Docker track, when this deployment runs it.
 *
 * `DockerCliFactory` is the real socket-backed engine — the one the API used to
 * hold. It lives here now, behind fourteen named operations that take a session
 * id and never a container name, an image or a privilege flag.
 */
const docker = config.docker
  ? new DockerOps({
      engines: new DockerCliFactory(),
      derivationSecret: config.derivationSecret,
      runtimeOwner: config.runtimeOwner,
      policy: config.docker,
    })
  : undefined;

const server = createSandboxd({ config, inspector, runtime, ...(docker ? { docker } : {}) });

server.listen(config.port, config.bindAddress, () => {
  console.log(
    `[sandboxd] runtime broker listening on ${config.bindAddress}:${config.port} (owner=${config.runtimeOwner})`,
  );
});

/*
 * A failed probe is a warning, not an exit. The runtime may come up after this
 * process does, and refusing to serve `/health` would then make an ordinary
 * start-order race look like a deployment failure.
 */
void inspector
  .ping()
  .then((version) => console.log(`[sandboxd] container runtime ready (server ${version})`))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sandboxd] container runtime is not reachable yet: ${message}`);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[sandboxd] ${signal} — closing shells`);
    server.close(() => process.exit(0));
  });
}
