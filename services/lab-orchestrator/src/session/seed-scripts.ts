/**
 * Baseline seed scripts for container-backed labs.
 *
 * The third setup mechanism, alongside `manifests.ts` (Kubernetes objects) and
 * `setup-files.ts` (starter files a student could have written themselves):
 *
 * ```yaml
 * setup:
 *   seed_scripts:
 *     - setup/seed.sh     # inside the lab directory
 * ```
 *
 * ## Why this exists at all
 *
 * `setup.files` writes content as the unprivileged sandbox user, which is
 * enough for a Terraform skeleton and enough for a permissions lab about the
 * student's own home directory. It is *not* enough to stage a lab about system
 * administration: an accounts lab needs a group that already exists, a services
 * lab needs a supervised process already running, a log-analysis lab needs
 * `/var/log` populated by something other than the student. Those are the
 * labs the Linux track is made of, and none of them can be seeded by writing a
 * file as `student`.
 *
 * ## What keeps it safe
 *
 * A seed script is *platform content*, on exactly the same footing as a
 * Kubernetes setup manifest:
 *
 *   · it is a path into the lab's own directory, re-checked after resolution
 *     (`resolveLabAssetPath`) — lab.yaml carries a filename, never a command;
 *   · it must be a real script with a `#!` line, so a stray data file cannot be
 *     handed to the sandbox as executable content;
 *   · it is size-capped, so a lab cannot push an unbounded payload into a
 *     sandbox;
 *   · nothing student-supplied and nothing reachable from an HTTP route can
 *     ever reach this loader — the only caller is the provider, during
 *     `create()`, from a lab definition loaded off disk at startup.
 *
 * Where it runs matters as much as what it is. The container provider writes
 * each script into a root-owned directory inside *one session's* container,
 * runs it there, and removes it before the student's terminal opens. It never
 * runs on the host, and it cannot reach another student's sandbox.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LabDefinitionError,
  resolveLabAssetPath,
  type LoadedLabDefinition,
} from '../lab-definition.js';

/** Upper bound on one seed script. Generous for a lab, far from unbounded. */
export const MAX_SEED_SCRIPT_BYTES = 64 * 1024;

export interface LoadedSeedScript {
  /** Basename only — the provider owns the directory these land in. */
  name: string;
  content: string;
  /** The lab-relative path, for error messages and reset reporting. */
  source: string;
}

export async function loadSeedScripts(lab: LoadedLabDefinition): Promise<LoadedSeedScript[]> {
  const scripts: LoadedSeedScript[] = [];

  for (const relative of lab.setup.seed_scripts) {
    const absolute = resolveLabAssetPath(lab, relative, 'Seed script');

    let content: Buffer;
    try {
      content = await readFile(absolute);
    } catch (cause) {
      throw new LabDefinitionError(
        `Cannot read seed script '${relative}': ${(cause as Error).message}`,
        lab.sourcePath,
        [],
        lab.id,
      );
    }

    if (content.byteLength === 0) {
      throw new LabDefinitionError(`Seed script '${relative}' is empty`, lab.sourcePath, [], lab.id);
    }
    if (content.byteLength > MAX_SEED_SCRIPT_BYTES) {
      throw new LabDefinitionError(
        `Seed script '${relative}' is ${content.byteLength} bytes; the limit is ${MAX_SEED_SCRIPT_BYTES}`,
        lab.sourcePath,
        [],
        lab.id,
      );
    }
    if (!content.subarray(0, 2).equals(Buffer.from('#!'))) {
      throw new LabDefinitionError(
        `Seed script '${relative}' must begin with a #! interpreter line`,
        lab.sourcePath,
        [],
        lab.id,
      );
    }

    scripts.push({
      name: path.basename(relative),
      content: content.toString('utf8'),
      source: relative,
    });
  }

  return scripts;
}
