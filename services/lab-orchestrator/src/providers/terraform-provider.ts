/**
 * The Terraform provider — a local Terraform sandbox that needs no cloud.
 *
 * The purpose of a Terraform lab at this level is the *language and the
 * workflow*: variables, locals, outputs, `init` / `plan` / `apply`, and reading
 * state back. None of that requires an AWS account, and requiring one would put
 * a credential and a bill in front of a beginner for no pedagogical gain.
 *
 * ```text
 *   Student session
 *        ↓
 *   TerraformLabProvider
 *        ↓
 *   container from jumptotech/lab-terraform   (terraform CLI baked in)
 *        ↓
 *   --network none  +  a filesystem provider mirror
 *        ↓
 *   terraform init / plan / apply against hashicorp/local + hashicorp/random
 *        ↓
 *   verifier reads terraform.tfstate and the files the run produced
 * ```
 *
 * **Why the sandbox has no network.** The image ships a filesystem mirror of
 * the providers the labs use, and `TF_CLI_CONFIG_FILE` points Terraform at it,
 * so `terraform init` resolves offline. That removes the registry as a
 * dependency of a lab starting, removes egress from the student's sandbox, and
 * makes the exercise deterministic.
 *
 * **Verification never trusts the transcript.** `terraform apply` having been
 * typed proves nothing; the checks read `terraform.tfstate` and the artifacts
 * on disk, so a student who reaches the same state another way passes, and a
 * student who typed the command but whose apply failed does not.
 */
import type { ContainerRuntimePort } from './container/runtime.js';
import { ContainerLabProvider } from './container/sandbox-provider.js';

export const DEFAULT_TERRAFORM_SANDBOX_IMAGE = 'jumptotech/lab-terraform:latest';

export interface TerraformProviderOptions {
  runtime: ContainerRuntimePort;
  image?: string;
  home?: string;
  now?: () => number;
  /** Which runtime owns these sandboxes; see RUNTIME_OWNER_LABEL. */
  runtimeOwner?: string;
}

export class TerraformLabProvider extends ContainerLabProvider {
  constructor(options: TerraformProviderOptions) {
    super({
      id: 'terraform',
      name: 'docker-terraform',
      runtime: options.runtime,
      image: options.image ?? DEFAULT_TERRAFORM_SANDBOX_IMAGE,
      // Provisioning fails loudly if the CLI is missing, rather than handing a
      // student a Terraform lab with no terraform in it.
      requiredBinaries: ['terraform'],
      ...(options.home ? { home: options.home } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.runtimeOwner ? { runtimeOwner: options.runtimeOwner } : {}),
    });
  }
}
