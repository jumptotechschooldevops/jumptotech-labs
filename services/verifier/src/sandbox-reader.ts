/**
 * Memoised, sandbox-scoped reads for one verification run.
 *
 * The container counterpart of `VerifyReader`. Same two properties, for the
 * same reasons:
 *
 *   - **Each path is read at most once per run**, so a lab asking three
 *     questions about one file ("does it exist", "is the mode right", "who owns
 *     it") cannot produce a self-contradictory report by observing three
 *     different states.
 *   - **The sandbox is fixed at construction.** A handler is never given the
 *     chance to name one, so it cannot read another student's sandbox — and the
 *     port it is handed only reaches inside one container, as the unprivileged
 *     student user.
 *
 * Paths were already validated by the lab schema and are re-resolved against
 * the sandbox home by the provider before any read; nothing here can widen
 * that. See `session/sandbox-paths.ts`.
 */
import type { SandboxPathRead } from '@jumptotech/lab-orchestrator';

/** The read primitive a sandbox provider offers the verifier. */
export interface SandboxPort {
  read(relativePath: string, options?: { maxBytes?: number }): Promise<SandboxPathRead | null>;
}

/**
 * The slice of Terraform state the checks care about.
 *
 * Deliberately minimal, and deliberately read from the state file rather than
 * by running `terraform`: the verifier must not depend on being able to execute
 * a student-influenced working directory, and `terraform.tfstate` is the
 * authoritative record of what an apply actually produced.
 */
export interface TerraformStateSnapshot {
  version: number;
  resources: Array<{
    /** `managed` | `data`. */
    mode: string;
    type: string;
    name: string;
    provider?: string;
    instanceCount: number;
  }>;
  outputs: Record<string, { value: unknown; type?: unknown; sensitive?: boolean }>;
}

export const TERRAFORM_STATE_FILE = 'terraform.tfstate';
export const TERRAFORM_LOCK_FILE = '.terraform.lock.hcl';
export const TERRAFORM_WORK_DIR = '.terraform';

export class SandboxReader {
  readonly #cache = new Map<string, Promise<SandboxPathRead | null>>();

  constructor(private readonly port: SandboxPort) {}

  path(relativePath: string, options?: { maxBytes?: number }): Promise<SandboxPathRead | null> {
    const key = `${relativePath}#${options?.maxBytes ?? 'default'}`;
    const existing = this.#cache.get(key);
    if (existing) return existing;
    const promise = this.port.read(relativePath, options);
    this.#cache.set(key, promise);
    return promise;
  }

  /** `dir/name`, for the fixed file names the Terraform checks look for. */
  join(dir: string, name: string): string {
    return dir === '.' ? name : `${dir.replace(/\/+$/, '')}/${name}`;
  }

  /**
   * Parse `terraform.tfstate` in a working directory.
   *
   * Returns `null` when there is no state at all — which is the honest answer
   * for "the student has not applied anything yet", and is reported as such
   * rather than as a parse failure.
   */
  async terraformState(dir: string): Promise<TerraformStateSnapshot | null> {
    const read = await this.path(this.join(dir, TERRAFORM_STATE_FILE));
    if (!read || read.type !== 'file' || read.content === undefined) return null;
    return parseTerraformState(read.content);
  }
}

/** Parse a Terraform state document defensively. Returns null on anything odd. */
export function parseTerraformState(text: string): TerraformStateSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const doc = parsed as Record<string, unknown>;
  const rawResources = Array.isArray(doc.resources) ? doc.resources : [];
  const resources: TerraformStateSnapshot['resources'] = [];

  for (const entry of rawResources) {
    if (typeof entry !== 'object' || entry === null) continue;
    const resource = entry as Record<string, unknown>;
    if (typeof resource.type !== 'string' || typeof resource.name !== 'string') continue;
    resources.push({
      mode: typeof resource.mode === 'string' ? resource.mode : 'managed',
      type: resource.type,
      name: resource.name,
      ...(typeof resource.provider === 'string' ? { provider: resource.provider } : {}),
      instanceCount: Array.isArray(resource.instances) ? resource.instances.length : 0,
    });
  }

  const outputs: TerraformStateSnapshot['outputs'] = {};
  if (typeof doc.outputs === 'object' && doc.outputs !== null) {
    for (const [name, raw] of Object.entries(doc.outputs as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const output = raw as Record<string, unknown>;
      outputs[name] = {
        value: output.value,
        ...(output.type !== undefined ? { type: output.type } : {}),
        ...(typeof output.sensitive === 'boolean' ? { sensitive: output.sensitive } : {}),
      };
    }
  }

  return {
    version: typeof doc.version === 'number' ? doc.version : 0,
    resources,
    outputs,
  };
}
