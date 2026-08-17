/**
 * Provider composition.
 *
 * The one place in the application that decides *which* sandbox backends this
 * deployment offers. Everything downstream — the session manager, the reaper,
 * the verifier, the terminal binding, the catalog — asks the registry rather
 * than naming a backend.
 *
 * Two backends are wired live (`kubernetes`, and the container-backed `linux`
 * and `terraform`), and two are registered but switched off:
 *
 * | Provider | State | Why |
 * |---|---|---|
 * | `kubernetes` | live | kind cluster, one namespace per session |
 * | `linux` | live when Docker + the sandbox image are present | one container per session |
 * | `terraform` | live when Docker + the sandbox image are present | one container per session |
 * | `docker` | **disabled** | a per-session daemon is not safe here yet |
 * | `aws` | **disabled** | no student ever gets real cloud credentials yet |
 *
 * The two disabled providers are registered with `enabled: false` *and* report
 * themselves unavailable from their own `availability()`. Two independent gates
 * on purpose: "we accidentally shipped Docker labs backed by the host socket"
 * is the failure mode worth spending a redundant check on.
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
  ProviderRegistry,
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
    provider: new DockerLabProvider({ runtime, image: config.sandbox.dockerImage }),
    enabled: false,
    disabledReason: DOCKER_PROVIDER_DISABLED_REASON,
    remediation: DOCKER_PROVIDER_REMEDIATION,
  });

  registry.register({
    provider: new AwsLabProvider(),
    enabled: false,
    disabledReason: AWS_PROVIDER_DISABLED_REASON,
    remediation: AWS_PROVIDER_REMEDIATION,
  });

  return registry;
}
