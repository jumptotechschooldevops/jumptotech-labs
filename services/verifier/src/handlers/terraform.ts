/**
 * Terraform requirement handlers.
 *
 * The rule these exist to enforce: **`terraform apply` having been typed is not
 * a pass.** Every check below reads what a run actually left behind —
 * `.terraform/` and the dependency lock file for init, `terraform.tfstate` for
 * resources and outputs — so a student whose apply errored does not pass, and a
 * student who reached the same state a different way does.
 *
 * State is read, never executed. The verifier does not run `terraform show` in
 * the student's working directory: that would mean executing a directory whose
 * contents the student controls, from the platform's own verification path, for
 * information the state file already contains.
 */
import { fail, missingPath, pass, type SandboxVerifierHandler } from '../contract.js';
import {
  TERRAFORM_LOCK_FILE,
  TERRAFORM_STATE_FILE,
  TERRAFORM_WORK_DIR,
} from '../sandbox-reader.js';

export const terraformInitialized: SandboxVerifierHandler<'terraform_initialized'> = {
  type: 'terraform_initialized',
  label: (r) => `Terraform is initialized in ${r.dir}`,
  async run(requirement, reader) {
    const dir = await reader.path(requirement.dir);
    if (!dir) return missingPath('directory', requirement.dir);
    if (dir.type !== 'directory') {
      return fail(`'${requirement.dir}' is not a directory`);
    }

    const work = await reader.path(reader.join(requirement.dir, TERRAFORM_WORK_DIR));
    if (!work || work.type !== 'directory') {
      return fail(
        `'${requirement.dir}' has no ${TERRAFORM_WORK_DIR} directory — Terraform has not been initialized here`,
      );
    }

    const lock = await reader.path(reader.join(requirement.dir, TERRAFORM_LOCK_FILE));
    if (!lock || lock.type !== 'file') {
      return fail(
        `'${requirement.dir}' has no ${TERRAFORM_LOCK_FILE} — the provider dependencies were not recorded`,
      );
    }
    return pass();
  },
};

export const terraformResourceExists: SandboxVerifierHandler<'terraform_resource_exists'> = {
  type: 'terraform_resource_exists',
  label: (r) => `Terraform state contains ${r.resource_type}.${r.name}`,
  async run(requirement, reader) {
    const state = await reader.terraformState(requirement.dir);
    if (!state) {
      return fail(
        `No readable Terraform state in '${requirement.dir}' — nothing has been applied there yet`,
      );
    }

    const match = state.resources.find(
      (resource) =>
        resource.mode === 'managed' &&
        resource.type === requirement.resource_type &&
        resource.name === requirement.name,
    );
    if (!match) {
      const present = state.resources
        .filter((r) => r.mode === 'managed')
        .map((r) => `${r.type}.${r.name}`);
      return fail(
        present.length > 0
          ? `Terraform state holds ${present.join(', ')}, but not ${requirement.resource_type}.${requirement.name}`
          : `Terraform state holds no managed resources yet`,
      );
    }
    if (match.instanceCount === 0) {
      return fail(
        `${requirement.resource_type}.${requirement.name} is declared but has no instance in state — the apply did not create it`,
      );
    }
    return pass();
  },
};

export const terraformOutputEquals: SandboxVerifierHandler<'terraform_output_equals'> = {
  type: 'terraform_output_equals',
  label: (r) => `Terraform output ${r.name} has the expected value`,
  async run(requirement, reader) {
    const state = await reader.terraformState(requirement.dir);
    if (!state) {
      return fail(
        `No readable Terraform state in '${requirement.dir}' — nothing has been applied there yet`,
      );
    }

    const output = state.outputs[requirement.name];
    if (!output) {
      const names = Object.keys(state.outputs);
      return fail(
        names.length > 0
          ? `Terraform state declares outputs ${names.join(', ')}, but not '${requirement.name}'`
          : `Terraform state declares no outputs`,
      );
    }

    // Outputs are compared as their string form: a lab that wants a number and
    // a lab that wants the digits of one mean the same thing to a student, and
    // the state file's JSON typing is not what the exercise is teaching.
    const actual = renderOutput(output.value);
    if (actual !== requirement.value) {
      return fail(`Output '${requirement.name}' is ${actual === '' ? 'empty' : `'${actual}'`}`);
    }
    return pass();
  },
};

function renderOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export { TERRAFORM_STATE_FILE };
