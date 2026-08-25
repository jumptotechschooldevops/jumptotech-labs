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
  parseTerraformState,
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

/**
 * Load a state document, honouring an alternate file name.
 *
 * `reader.terraformState` resolves the default name only, so a check that
 * accepted `state_file` and then called it would silently grade the wrong
 * document. Both state-reading handlers go through here instead.
 */
async function readStateDocument(
  reader: Parameters<SandboxVerifierHandler<'terraform_resource_exists'>['run']>[1],
  dir: string,
  stateFile?: string,
) {
  if (stateFile === undefined) return reader.terraformState(dir);
  const read = await reader.path(reader.join(dir, stateFile));
  if (!read || read.type !== 'file' || read.content === undefined || read.truncated) return null;
  return parseTerraformState(read.content);
}

export const terraformResourceExists: SandboxVerifierHandler<'terraform_resource_exists'> = {
  type: 'terraform_resource_exists',
  label: (r) => `Terraform state contains ${r.resource_type}.${r.name}`,
  async run(requirement, reader) {
    const state = await readStateDocument(reader, requirement.dir, requirement.state_file);
    if (!state) {
      const where = requirement.state_file
        ? `'${reader.join(requirement.dir, requirement.state_file)}'`
        : `'${requirement.dir}'`;
      return fail(`No readable Terraform state at ${where} — nothing has been applied there yet`);
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

/**
 * Nothing managed remains — at one address, or anywhere in the state.
 *
 * ### Why this reads the state file rather than running Terraform
 *
 * The alternative would be `terraform state list` or `terraform show -json`
 * through a tool port. Parsing state directly wins on every axis that matters
 * here: it is deterministic (no CLI version can change the answer), it cannot
 * be fooled by output formatting, it executes nothing in a directory whose
 * contents the student controls, and it keeps this platform's rule that
 * verification reads and does not run. The state file is also the artifact
 * Terraform itself treats as authoritative, so nothing is lost by reading it.
 *
 * ### Why a missing state file FAILS
 *
 * A completed `terraform destroy` leaves a valid state file behind — verified
 * against the CLI this sandbox ships: `resources: []`, `outputs: {}`, and the
 * serial incremented past its pre-destroy value, with the previous state kept
 * in `terraform.tfstate.backup`. "No state file" is therefore not evidence of
 * a destroy; it is evidence that something removed the file. Treating absence
 * as success would make `rm terraform.tfstate` a valid solution to every
 * destroy lab, which is precisely the shortcut this check exists to refuse.
 *
 * ### What a failure is allowed to say
 *
 * Counts and resource *addresses* only — `local_file.report`, never an
 * attribute, never an output value, never a fragment of the state document.
 * An address is a type and a label the student chose; a value may be a secret.
 * The two are not the same kind of thing and are not treated the same way.
 */
export const terraformStateAbsent: SandboxVerifierHandler<'terraform_state_absent'> = {
  type: 'terraform_state_absent',
  label: (r) =>
    r.address
      ? `Terraform state no longer contains ${r.address}`
      : 'Terraform state contains no managed resources',
  async run(requirement, reader) {
    const stateFile = requirement.state_file ?? TERRAFORM_STATE_FILE;
    const statePath = reader.join(requirement.dir, stateFile);

    // Distinguish "no file" from "unreadable file" before parsing, so the two
    // very different situations do not collapse into one message.
    const read = await reader.path(statePath);
    if (!read) {
      return fail(
        `No Terraform state at '${statePath}' — a completed destroy leaves its state file behind, so a missing file is not evidence that anything was destroyed`,
      );
    }
    if (read.type !== 'file') {
      return fail(`'${statePath}' is not a regular file, so it cannot be read as Terraform state`);
    }

    // Parsed from the bytes just read, not through `reader.terraformState`,
    // which resolves the default file name only — that would silently ignore
    // `state_file` and grade the wrong document.
    if (read.content === undefined || read.truncated) {
      return fail(
        `The Terraform state at '${statePath}' could not be read in full, so what it manages cannot be established`,
      );
    }
    const state = parseTerraformState(read.content);
    if (!state) {
      // Deliberately says nothing about the contents: an unparseable state may
      // be unparseable *because* it holds something the platform must not read.
      return fail(
        `The Terraform state at '${statePath}' could not be read as valid state — it is empty or malformed, so what it manages cannot be established`,
      );
    }

    // `managed` only. A data source is a reading of something Terraform does
    // not own, so it never keeps this check from passing.
    const managed = state.resources.filter((resource) => resource.mode === 'managed');

    if (requirement.address !== undefined) {
      const separator = requirement.address.indexOf('.');
      const wantedType = requirement.address.slice(0, separator);
      const wantedName = requirement.address.slice(separator + 1);
      const match = managed.find(
        (resource) => resource.type === wantedType && resource.name === wantedName,
      );
      // Declared but with no instance is genuine absence: nothing exists.
      if (!match || match.instanceCount === 0) return pass();
      return fail(
        `'${requirement.address}' is still in the Terraform state with ${match.instanceCount} instance${match.instanceCount === 1 ? '' : 's'}`,
      );
    }

    const remaining = managed.filter((resource) => resource.instanceCount > 0);
    if (remaining.length === 0) return pass();

    const instances = remaining.reduce((total, resource) => total + resource.instanceCount, 0);
    const shown = remaining.slice(0, 5).map((resource) => `${resource.type}.${resource.name}`);
    const suffix = remaining.length > shown.length ? `, and ${remaining.length - shown.length} more` : '';
    return fail(
      `Terraform state still contains ${instances} managed resource instance${instances === 1 ? '' : 's'}: ${shown.join(', ')}${suffix}`,
    );
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
