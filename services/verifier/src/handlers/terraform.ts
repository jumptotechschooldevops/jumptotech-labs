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
 *
 * ## Values never leave this module (PLATFORM-SEC)
 *
 * A `CheckResult` carries one free-text field, `detail`, and it is serialised
 * straight into the API response the browser reads. So `detail` is the whole
 * disclosure surface of a check, and the rule these handlers keep is simple:
 *
 *   · an **expected** value is never repeated, because it is the answer;
 *   · an **actual** value is never repeated, because the platform cannot know
 *     it is safe to — `sensitive` marks only the outputs whose author thought
 *     to mark them;
 *   · **names, addresses, types and counts** are fine, and are what failures
 *     are built from.
 *
 * Expected values live in `lab.yaml` on the server and reach nothing else: the
 * catalog API projects requirements to `label ?? type` and never their fields,
 * the sandbox seeding path never sees a requirement, and the progress store
 * persists a check *count* rather than any check detail. Comparison happens
 * here, in the verifier process, and only its verdict travels.
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

    if (outputMatches(output.value, requirement.value)) return pass();

    /*
     * PLATFORM-SEC. Neither value goes into this message.
     *
     * Not the *expected* value, because it is the answer — telling a student
     * what the output should have been turns a failed check into a solution.
     * Not the *actual* value either, because the platform cannot know it is
     * safe to repeat: `sensitive` marks the ones an author knew about, and the
     * lesson of a sensitive-data lab is precisely that an unmarked output can
     * still hold a credential.
     *
     * What is left is enough to act on and carries nothing secret: the name
     * the student chose, and the shape of what they produced. A type is
     * structural metadata, not a value — knowing an output is a list rather
     * than a string tells you where to look and reveals nothing about it.
     */
    if (output.sensitive === true) {
      return fail(
        `Terraform output '${requirement.name}' does not match the required value. It is marked sensitive, so the platform does not read its value into this message.`,
      );
    }
    return fail(
      `Terraform output '${requirement.name}' does not match the required value (the output is ${describeShape(output.value)}).`,
    );
  },
};

/**
 * Does an output hold the value a lab asked for?
 *
 * Two comparisons, chosen by what the output actually is rather than by what
 * the lab wrote:
 *
 *   · **Primitives** compare by their canonical string form, so a lab may write
 *     `value: '8080'` for a number output. This is the long-standing behaviour
 *     and labs depend on it.
 *   · **Lists and objects** compare *structurally*. The lab's expected string is
 *     parsed as JSON and deep-compared, so `{"b":2,"a":1}` matches an output of
 *     `{"a":1,"b":2}` — Terraform does not promise key order, and a check that
 *     depended on it would fail correct work. Only if the expected text is not
 *     valid JSON does this fall back to comparing canonical renderings.
 *
 * Deliberately never a substring match: `terraform_output_equals` means equals.
 */
export function outputMatches(actual: unknown, expected: string): boolean {
  if (Array.isArray(actual) || (typeof actual === 'object' && actual !== null)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(expected);
    } catch {
      return renderOutput(actual) === expected;
    }
    return deepEquals(actual, parsed);
  }
  return renderOutput(actual) === expected;
}

/** Structural equality. Object key order is irrelevant; array order is not. */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => deepEquals(entry, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.hasOwn(right, key) && deepEquals(left[key], right[key]));
  }
  return false;
}

/**
 * The *shape* of an output, for a failure message. Never its contents.
 *
 * Lengths are included for containers because "a list of 3" is a useful nudge
 * and says nothing about what is in it. Nothing is reported for a primitive
 * beyond its type — not even whether it is empty, since emptiness is a fact
 * about the value.
 */
function describeShape(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `a list of ${value.length} item${value.length === 1 ? '' : 's'}`;
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object': {
      const keys = Object.keys(value as Record<string, unknown>).length;
      return `an object with ${keys} attribute${keys === 1 ? '' : 's'}`;
    }
    default:
      return 'an unrecognised type';
  }
}

function renderOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export { TERRAFORM_STATE_FILE };
