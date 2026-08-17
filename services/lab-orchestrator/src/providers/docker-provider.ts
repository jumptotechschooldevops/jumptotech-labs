/**
 * The Docker provider — contract and architecture, deliberately not enabled.
 *
 * A Docker lab is different in kind from a Linux or Terraform lab: the student
 * does not merely run commands *inside* a container, they need a Docker daemon
 * to build images against, run containers on, and inspect. That is the one
 * thing this platform must never hand over casually.
 *
 * ## What must not happen
 *
 * ```text
 *   ✗ -v /var/run/docker.sock:/var/run/docker.sock
 * ```
 *
 * Mounting the host socket into a student sandbox is equivalent to giving the
 * student root on the host: they can start a privileged container, bind-mount
 * `/`, and read or replace anything — including every other student's sandbox
 * and the platform's own secrets. No amount of RBAC above it matters. This
 * provider will never do that, and no configuration flag enables it.
 *
 * ## The two candidate designs
 *
 * **A. Rootless Docker-in-Docker, one daemon per session.** Each sandbox runs
 * its own rootless `dockerd` inside its own container; the student's CLI talks
 * to that daemon over a unix socket that exists only inside their sandbox.
 * Blast radius is one session. Costs: rootless DinD needs `user_namespaces`,
 * usually a `fuse-overlayfs` or `vfs` storage driver, and often `--privileged`
 * or a substantial capability set on the outer container — which is exactly the
 * thing this platform refuses to grant by default. Making it safe means
 * gVisor/Kata (a real kernel boundary) underneath, which is a substrate change,
 * not a code change.
 *
 * **B. A brokered daemon.** The student's CLI talks to a platform-owned proxy
 * that speaks the Docker API and allow-lists the operations a lab needs
 * (`build`, `run`, `ps`, `logs`, `rm`), rejects the dangerous ones (`--
 * privileged`, bind mounts, host networking, socket mounts), and stamps every
 * created object with the session's ownership labels so cleanup stays exact.
 * Blast radius is whatever the allow-list permits. Costs: the proxy is the
 * whole security boundary, and a single missed field in the run spec undoes it.
 *
 * ## The PLATFORM-004 decision
 *
 * Neither is safe enough to ship in this story, and shipping a "Docker track"
 * backed by the host socket would be worse than shipping nothing. So the
 * provider exists — same contract, same registry entry, same tests, same
 * cleanup path — and reports itself unavailable with the reason above. The
 * catalog therefore shows Docker as *Coming soon* rather than as a lab that
 * fails on click, and there is no Docker lab in `labs/`.
 *
 * When the substrate can offer a real kernel boundary, enabling this is:
 * construct it with a runtime and `enabled: true`, add the sandbox image, and
 * add `labs/docker/…`. Nothing above the provider changes.
 */
import type { ProviderAvailability } from './catalog.js';
import { unavailable } from './catalog.js';
import type { ContainerRuntimePort } from './container/runtime.js';
import { ContainerLabProvider } from './container/sandbox-provider.js';

export const DEFAULT_DOCKER_SANDBOX_IMAGE = 'jumptotech/lab-docker:latest';

export const DOCKER_PROVIDER_DISABLED_REASON =
  'Docker labs need a per-session Docker daemon. Sharing the host daemon would give a student root on the host, so this provider ships as architecture only.';

export const DOCKER_PROVIDER_REMEDIATION =
  'See README → Docker sandbox strategy. Enabling it requires rootless Docker-in-Docker or a brokered daemon on a substrate with a real kernel boundary (gVisor / Kata / Firecracker).';

export interface DockerProviderOptions {
  runtime: ContainerRuntimePort;
  image?: string;
  home?: string;
  /**
   * Opt-in for a future substrate that can host a per-session daemon safely.
   *
   * Default `false`, and the registry additionally registers this provider as
   * disabled — two independent gates, because "we accidentally shipped Docker
   * labs backed by the host socket" is the failure this file exists to prevent.
   */
  sandboxDaemonAvailable?: boolean;
  now?: () => number;
}

export class DockerLabProvider extends ContainerLabProvider {
  readonly #sandboxDaemonAvailable: boolean;

  constructor(options: DockerProviderOptions) {
    super({
      id: 'docker',
      name: 'docker-sandbox',
      runtime: options.runtime,
      image: options.image ?? DEFAULT_DOCKER_SANDBOX_IMAGE,
      requiredBinaries: ['docker'],
      ...(options.home ? { home: options.home } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.#sandboxDaemonAvailable = options.sandboxDaemonAvailable ?? false;
  }

  /**
   * Unavailable until a per-session daemon exists — checked before, and
   * independently of, whether a container runtime happens to be reachable.
   */
  override async availability(): Promise<ProviderAvailability> {
    if (!this.#sandboxDaemonAvailable) {
      return unavailable(DOCKER_PROVIDER_DISABLED_REASON, DOCKER_PROVIDER_REMEDIATION);
    }
    return super.availability();
  }
}
