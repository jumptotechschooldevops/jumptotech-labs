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

export function buildProviderRegistry(options: BuildProviderRegistryOptions): ProviderRegistry {
  const { config } = options;
  const registry = new ProviderRegistry();

  registry.register({ provider: options.kubernetes });

  const runtime =
    options.containerRuntime ?? new DockerCliRuntime({ binary: config.sandbox.containerBinary });

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
