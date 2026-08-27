/**
 * Provider composition.
 *
 * The one place in the application that decides *which* sandbox backends this
 * deployment offers. Everything downstream — the session manager, the reaper,
 * the verifier, the terminal binding, the catalog — asks the registry rather
 * than naming a backend.
 *
 * Four backends are wired live, and one is registered but switched off:
 *
 * | Provider | State | Why |
 * |---|---|---|
 * | `kubernetes` | live | kind cluster, one namespace per session |
 * | `linux` | live when Docker + the sandbox image are present | one container per session |
 * | `terraform` | live when Docker + the sandbox image are present | one container per session |
 * | `docker` | live when `DOCKER_TRACK_ENABLED` and a host daemon are present | one `docker:dind` sandbox per session, reached over mutual TLS |
 * | `aws` | **disabled** | no student ever gets real cloud credentials yet |
 *
 * PLATFORM-004 shipped `docker` disabled, because neither candidate design for
 * a per-session daemon was safe enough at the time. It is live now, but on the
 * same two independent gates the disabled providers use: the registration below
 * is conditional on configuration, *and* the provider reports itself
 * unavailable from its own `availability()` unless `sandboxDaemonAvailable` was
 * passed. "We accidentally shipped Docker labs backed by the host socket" is
 * still the failure mode worth spending a redundant check on — and the one
 * thing neither gate can be talked into is mounting the host socket, which no
 * code path in `DockerLabProvider` contains.
 */
import {
  AwsLabProvider,
  AWS_PROVIDER_DISABLED_REASON,
  AWS_PROVIDER_REMEDIATION,
  BrokerDockerEngines,
  BrokerRuntime,
  DockerCliFactory,
  DockerCliRuntime,
  DockerLabProvider,
  DOCKER_PROVIDER_DISABLED_REASON,
  DOCKER_PROVIDER_REMEDIATION,
  LinuxLabProvider,
  type DockerEngineFactory,
  type RequirementWaiter,
  type WorkspacePort,
  ProviderRegistry,
  AnsibleLabProvider,
  CicdLabProvider,
  TerraformLabProvider,
  type ContainerRuntimePort,
  type LabProvider,
} from '@jumptotech/lab-orchestrator';
import type { ApiConfig } from './config.js';

export interface BuildProviderRegistryOptions {
  config: ApiConfig;
  /** The Kubernetes provider, already built by the substrate factory. */
  kubernetes: LabProvider;
  /** Injected in tests so no real daemon is touched. */
  containerRuntime?: ContainerRuntimePort;
  /** Host Docker access, for the per-session `docker:dind` sandboxes. */
  engines?: DockerEngineFactory;
  /** Where Docker-track students author files. */
  workspace?: WorkspacePort;
  /** Confirms a lab's declared initial state actually materialised. */
  waitForRequirements?: RequirementWaiter;
  /**
   * Injected in tests so provisioning does not spend real seconds waiting.
   *
   * Production leaves it unset and each provider uses its own real sleep. It
   * exists so the composition regression suite can exercise *this* graph —
   * the one production builds — rather than a hand-assembled stand-in that
   * can drift away from it.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The container runtime for the sandbox-backed tracks — Linux, Networking, CS,
 * Terraform, Ansible and CI/CD.
 *
 * Three shapes, in descending order of how much privilege this process ends up
 * holding:
 *
 *   1. `runtimeBrokerUrl` — none at all. Sandboxes are created, read and
 *      destroyed through `sandboxd`, which is the only service with a runtime
 *      and is not reachable from a browser. This is what a deployment uses.
 *   2. `runtimeHost` — a dedicated runtime node over TLS. Better than the
 *      host's own daemon, still real privilege in this process.
 *   3. neither — the ambient Docker. A laptop, and the test suite.
 *
 * The broker wins when both are set, because a deployment that has one must
 * never silently fall back to driving a daemon itself.
 *
 * Exported because `buildSandboxComposition` needs the *same* runtime for the
 * Ansible reader that the providers get. It previously built its own
 * `DockerCliRuntime` there and passed it down, which quietly overrode any
 * choice made here — the composition root won, and the setting did nothing.
 * One function, called once, is what stops that from being possible.
 */
export function buildContainerRuntime(config: ApiConfig): ContainerRuntimePort {
  if (config.sandbox.runtimeBrokerUrl) {
    return new BrokerRuntime({
      baseUrl: config.sandbox.runtimeBrokerUrl,
      secret: config.sandbox.runtimeBrokerCredential,
    });
  }
  return new DockerCliRuntime({
    binary: config.sandbox.containerBinary,
    ...(config.sandbox.runtimeHost ? { dockerHost: config.sandbox.runtimeHost } : {}),
    ...(config.sandbox.runtimeCertPath ? { certPath: config.sandbox.runtimeCertPath } : {}),
  });
}

/**
 * The Docker track's engine factory.
 *
 * The same choice `buildContainerRuntime` makes, for the one track that speaks
 * `DockerEnginePort` instead of `ContainerRuntimePort`:
 *
 *   1. `runtimeBrokerUrl` — this process holds no Docker access at all. Sandbox
 *      creation, certificate reads and verifier reads go through `sandboxd` as
 *      fourteen named operations. This is what a deployment uses.
 *   2. neither — a local daemon, for a laptop and for the test suite.
 *
 * The broker wins when set, for the same reason it does there: a deployment
 * that has one must never silently fall back to driving a daemon itself.
 */
export function buildDockerEngines(config: ApiConfig): DockerEngineFactory {
  if (config.sandbox.runtimeBrokerUrl) {
    return new BrokerDockerEngines({
      baseUrl: config.sandbox.runtimeBrokerUrl,
      secret: config.sandbox.dockerBrokerCredential,
    });
  }
  return new DockerCliFactory(config.dockerHost ? { dockerHost: config.dockerHost } : {});
}

export function buildProviderRegistry(options: BuildProviderRegistryOptions): ProviderRegistry {
  const { config } = options;
  const registry = new ProviderRegistry();

  registry.register({ provider: options.kubernetes });

  const runtime = options.containerRuntime ?? buildContainerRuntime(config);

  registry.register({
    provider: new LinuxLabProvider({
      runtime,
      image: config.sandbox.linuxImage,
      home: config.policy.sandbox.home,
      runtimeOwner: config.sandbox.runtimeOwner,
    }),
    ...(config.sandbox.linuxEnabled
      ? {}
      : {
          enabled: false,
          disabledReason: 'The Linux provider is switched off (LINUX_PROVIDER_ENABLED=false).',
        }),
  });

  registry.register({
    provider: new TerraformLabProvider({
      runtime,
      image: config.sandbox.terraformImage,
      home: config.policy.sandbox.home,
      runtimeOwner: config.sandbox.runtimeOwner,
    }),
    ...(config.sandbox.terraformEnabled
      ? {}
      : {
          enabled: false,
          disabledReason:
            'The Terraform provider is switched off (TERRAFORM_PROVIDER_ENABLED=false).',
        }),
  });

  registry.register({
    provider: new AnsibleLabProvider({
      runtime,
      image: config.sandbox.ansibleImage,
      runtimeOwner: config.sandbox.runtimeOwner,
    }),
    ...(config.sandbox.ansibleEnabled
      ? {}
      : {
          enabled: false,
          disabledReason: 'The Ansible provider is switched off (ANSIBLE_PROVIDER_ENABLED=false).',
        }),
  });

  registry.register({
    provider: new CicdLabProvider({
      runtime,
      image: config.sandbox.cicdImage,
      home: config.policy.sandbox.home,
      runtimeOwner: config.sandbox.runtimeOwner,
    }),
    ...(config.sandbox.cicdEnabled
      ? {}
      : {
          enabled: false,
          disabledReason: 'The CI/CD provider is switched off (CICD_PROVIDER_ENABLED=false).',
        }),
  });

  /*
   * The Docker track: one `docker:dind` sandbox per session.
   *
   * Registered whether or not it is enabled, so the catalog can say *why* a
   * Docker lab cannot start here rather than hiding the track. `enabled: false`
   * and the provider's own `sandboxDaemonAvailable` gate are deliberately
   * redundant.
   */
  if (options.engines) {
    registry.register({
      provider: new DockerLabProvider({
        engines: options.engines,
        sandboxDaemonAvailable: config.dockerEnabled,
        runtimeOwner: config.sandbox.runtimeOwner,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.waitForRequirements
          ? { waitForRequirements: options.waitForRequirements }
          : {}),
      }),
      ...(config.dockerEnabled
        ? {}
        : {
            enabled: false,
            disabledReason: DOCKER_PROVIDER_DISABLED_REASON,
            remediation: DOCKER_PROVIDER_REMEDIATION,
          }),
    });
  }

  registry.register({
    provider: new AwsLabProvider(),
    enabled: false,
    disabledReason: AWS_PROVIDER_DISABLED_REASON,
    remediation: AWS_PROVIDER_REMEDIATION,
  });

  return registry;
}
