/**
 * Memoised, sandbox-scoped reads for one verification run.
 *
 * The container counterpart of `VerifyReader`. Same two properties, for the
 * same reasons:
 *
 *   - **Each path is read at most once per run**, so a lab asking three
 *     questions about one file ("does it exist", "is the mode right", "who owns
 *     it") cannot produce a self-contradictory report by observing three
 *     different states. The same memoisation covers Terraform state, the
 *     scanned configuration, and the two tool checks.
 *   - **The sandbox is fixed at construction.** A handler is never given the
 *     chance to name one, so it cannot read another student's sandbox — and the
 *     port it is handed only reaches inside one container, as the unprivileged
 *     student user.
 *
 * Paths were already validated by the lab schema and are re-resolved against
 * the sandbox home by the provider before any read; nothing here can widen
 * that. See `session/sandbox-paths.ts`.
 *
 * ## Terraform
 *
 * State and configuration are *read*: `terraform.tfstate` is parsed as JSON,
 * and `.tf` files are scanned for their block structure. Neither needs
 * Terraform to run, which is what lets a troubleshooting lab report honestly on
 * a configuration that does not even parse.
 *
 * Two questions have no answer on disk — is the configuration valid, is it
 * canonically formatted — and those run `terraform validate` / `terraform fmt
 * -check` through the provider's allow-listed tool port. Both are documented
 * read-only subcommands: no state is written, no provider API is contacted. If
 * the provider offers no tool port, the checks are *skipped* with a reason,
 * never failed: a missing platform capability is not a student's mistake.
 */
import {
  parseTerraformState,
  scanHcl,
  scanHclFiles,
  TerraformStateParseError,
  type ExecResult,
  type HclDocument,
  type SandboxListOptions,
  type SandboxPathRead,
  type SandboxToolRequest,
  type TerraformState,
} from '@jumptotech/lab-orchestrator';

/** The read primitive a sandbox provider offers the verifier. */
export interface SandboxPort {
  read(relativePath: string, options?: { maxBytes?: number }): Promise<SandboxPathRead | null>;
  /** Optional: list files under a directory, for configuration checks. */
  list?(relativeDir: string, options?: SandboxListOptions): Promise<string[]>;
  /** Optional: run one allow-listed read-only tool. The provider picks which. */
  runTool?(request: SandboxToolRequest): Promise<ExecResult>;
}

export const TERRAFORM_STATE_FILE = 'terraform.tfstate';
export const TERRAFORM_LOCK_FILE = '.terraform.lock.hcl';
export const TERRAFORM_WORK_DIR = '.terraform';

/** Cap on a single `.tf` file, and on everything scanned in one directory. */
const MAX_CONFIG_FILE_BYTES = 64 * 1024;
const MAX_CONFIG_TOTAL_BYTES = 512 * 1024;
const MAX_CONFIG_FILES = 60;

/** `terraform validate` reported the configuration valid, or said why not. */
export interface TerraformValidateResult {
  valid: boolean;
  /** Error diagnostics, already truncated for display. */
  diagnostics: string[];
  /** Set when validate could not run at all (e.g. the directory is not initialised). */
  error?: string;
}

/** `terraform fmt -check -recursive` found nothing to rewrite, or listed files. */
export interface TerraformFormatResult {
  formatted: boolean;
  /** Files `terraform fmt` would rewrite, as Terraform printed them. */
  files: string[];
  error?: string;
}

/**
 * Raised when a check needs a sandbox capability the provider does not offer.
 *
 * Reported as a skipped check with this message, never as a failure: the
 * student did nothing wrong when the platform cannot look.
 */
export class SandboxCapabilityMissingError extends Error {
  readonly code = 'SANDBOX_CAPABILITY_MISSING';
  constructor(capability: string) {
    super(`This lab environment cannot ${capability}`);
    this.name = 'SandboxCapabilityMissingError';
  }
}

export class SandboxReader {
  readonly #cache = new Map<string, Promise<unknown>>();

  constructor(private readonly port: SandboxPort) {}

  #once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#cache.get(key);
    if (existing) return existing as Promise<T>;
    const promise = load();
    this.#cache.set(key, promise);
    return promise;
  }

  path(relativePath: string, options?: { maxBytes?: number }): Promise<SandboxPathRead | null> {
    return this.#once(`path:${relativePath}#${options?.maxBytes ?? 'default'}`, () =>
      this.port.read(relativePath, options),
    );
  }

  /** `dir/name`, for the fixed file names the Terraform checks look for. */
  join(dir: string, name: string): string {
    return dir === '.' ? name : `${dir.replace(/\/+$/, '')}/${name}`;
  }

  /**
   * Parsed `terraform.tfstate` for a working directory, or `null`.
   *
   * `null` means *no readable state*: either the student has not applied
   * anything yet, or what is on disk cannot be parsed. Both are reported to the
   * student the same way, because both mean the same thing for grading — there
   * is nothing to grade against — and a JSON parser's complaint is not a useful
   * thing to put in a checklist. `stateProblem()` carries the detail for the
   * one check that needs to tell them apart.
   */
  async terraformState(dir: string, stateFile?: string): Promise<TerraformState | null> {
    return (await this.#stateResult(dir, stateFile)).state;
  }

  /** Why state could not be read, when a file was there but unusable. */
  async stateProblem(dir: string, stateFile?: string): Promise<string | undefined> {
    return (await this.#stateResult(dir, stateFile)).problem;
  }

  /**
   * Where a lab's state lives, relative to the sandbox home.
   *
   * `stateFile` is the local backend's `path` argument: absent for every lab
   * using the default, present for the one that teaches relocating it. Resolved
   * here rather than in each handler so "no readable state in X" always names
   * the file the check actually looked at.
   */
  statePath(dir: string, stateFile?: string): string {
    return this.join(dir, stateFile ?? TERRAFORM_STATE_FILE);
  }

  #stateResult(
    dir: string,
    stateFile?: string,
  ): Promise<{ state: TerraformState | null; problem?: string }> {
    const relative = this.statePath(dir, stateFile);
    return this.#once(`state:${relative}`, async () => {
      const read = await this.path(relative);
      if (!read || read.type !== 'file' || read.content === undefined) return { state: null };
      if (read.truncated) {
        return {
          state: null,
          problem: `${relative} is too large for the platform to read`,
        };
      }
      try {
        return { state: parseTerraformState(read.content) };
      } catch (error) {
        return {
          state: null,
          problem: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  /**
   * The dependency lock file's block structure, or `null` when there is none.
   *
   * `.terraform.lock.hcl` is HCL, so the same scanner that reads a student's
   * `.tf` files reads it — no second parser, and no need to run Terraform to
   * find out what `init` resolved.
   */
  terraformLock(dir: string): Promise<HclDocument | null> {
    return this.#once(`lock:${dir}`, async () => {
      const read = await this.path(this.join(dir, TERRAFORM_LOCK_FILE), {
        maxBytes: MAX_CONFIG_FILE_BYTES,
      });
      if (!read || read.type !== 'file' || read.content === undefined) return null;
      return scanHcl(read.content, TERRAFORM_LOCK_FILE);
    });
  }

  /** The block structure of every `.tf` file in a directory tree, merged. */
  terraformConfig(dir: string): Promise<HclDocument> {
    return this.#once(`config:${dir}`, async () => {
      const files = await this.#terraformConfigFiles(dir);
      return scanHclFiles(files);
    });
  }

  /** `.tf` paths present in the directory, relative to it, for failure messages. */
  async terraformConfigPaths(dir: string): Promise<string[]> {
    return (await this.#terraformConfigFiles(dir)).map((file) => file.path);
  }

  /** `terraform validate` in a working directory. */
  terraformValidate(dir: string): Promise<TerraformValidateResult> {
    return this.#once(`validate:${dir}`, async () => {
      const result = await this.#runTerraform(dir, ['validate', '-json', '-no-color']);

      // `terraform validate` refuses to run before `init`, and says so on
      // stderr rather than in JSON. Reporting that verbatim is more useful to a
      // student than "invalid configuration" would be.
      const parsed = parseValidateJson(result.stdout);
      if (parsed) return parsed;

      const stderr = firstLine(result.stderr);
      return {
        valid: false,
        diagnostics: [],
        error: stderr || `terraform validate produced no output (exit ${result.exitCode})`,
      };
    });
  }

  /** `terraform fmt -check -recursive` in a working directory. */
  terraformFormatted(dir: string): Promise<TerraformFormatResult> {
    return this.#once(`formatted:${dir}`, async () => {
      // `-check` reports; it never rewrites. `-list` names the offending files.
      const result = await this.#runTerraform(dir, [
        'fmt',
        '-check',
        '-recursive',
        '-list=true',
        '-no-color',
      ]);
      if (result.exitCode === 0) return { formatted: true, files: [] };

      const files = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (files.length > 0) return { formatted: false, files };

      // Exit 3 means "files need formatting". Anything else is a real failure —
      // most often a parse error, which `terraform_valid` reports properly.
      const stderr = firstLine(result.stderr);
      return {
        formatted: false,
        files: [],
        error: stderr || `terraform fmt produced no output (exit ${result.exitCode})`,
      };
    });
  }

  // --------------------------------------------------------------- helpers

  #terraformConfigFiles(dir: string): Promise<Array<{ path: string; text: string }>> {
    return this.#once(`configFiles:${dir}`, async () => {
      if (!this.port.list) {
        throw new SandboxCapabilityMissingError('read Terraform configuration files');
      }
      const names = (
        await this.port.list(dir, { suffix: '.tf', maxDepth: 4, maxEntries: MAX_CONFIG_FILES })
      ).slice(0, MAX_CONFIG_FILES);

      const files: Array<{ path: string; text: string }> = [];
      let totalBytes = 0;
      for (const name of names) {
        const read = await this.path(this.join(dir, name), { maxBytes: MAX_CONFIG_FILE_BYTES });
        if (!read || read.type !== 'file' || read.content === undefined) continue;
        totalBytes += read.content.length;
        if (totalBytes > MAX_CONFIG_TOTAL_BYTES) break;
        files.push({ path: name, text: read.content });
      }
      return files;
    });
  }

  async #runTerraform(dir: string, args: string[]): Promise<ExecResult> {
    if (!this.port.runTool) {
      throw new SandboxCapabilityMissingError('run Terraform commands');
    }
    return this.port.runTool({ tool: 'terraform', args, dir, timeoutMs: 60_000 });
  }
}

// --- terraform validate -json ----------------------------------------------

interface ValidateJson {
  valid?: unknown;
  diagnostics?: Array<{
    severity?: string;
    summary?: string;
    detail?: string;
    range?: { filename?: string };
  }>;
}

function parseValidateJson(stdout: string): TerraformValidateResult | null {
  const text = stdout.trim();
  if (!text.startsWith('{')) return null;

  let raw: ValidateJson;
  try {
    raw = JSON.parse(text) as ValidateJson;
  } catch {
    return null;
  }
  if (typeof raw.valid !== 'boolean') return null;

  const diagnostics = (raw.diagnostics ?? [])
    .filter((d) => d.severity !== 'warning')
    .slice(0, 10)
    .map((d) => {
      const where = d.range?.filename ? `${d.range.filename}: ` : '';
      return `${where}${d.summary ?? 'error'}${d.detail ? ` — ${truncate(d.detail, 200)}` : ''}`;
    });

  return { valid: raw.valid, diagnostics };
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? ''
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export { parseTerraformState, TerraformStateParseError };
export type { TerraformState };
