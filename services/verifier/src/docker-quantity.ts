/**
 * Docker quantity parsing.
 *
 * The Docker counterpart of `quantity.ts`. A resource-limits lab must grade the
 * constraint the daemon is enforcing, not the spelling the student used:
 * `--memory 512m`, `--memory 512M`, and `--memory 536870912` all produce the
 * same `HostConfig.Memory`, so all three are the same answer.
 *
 * Docker's own suffixes are binary — `1k` is 1024 bytes, not 1000 — which is
 * what `docker run --help` documents and what the daemon applies.
 */

const MEMORY_MULTIPLIERS: Record<string, number> = {
  '': 1,
  b: 1,
  bytes: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

export class InvalidDockerQuantityError extends Error {
  constructor(value: string, kind: string) {
    super(`'${value}' is not a valid Docker ${kind} value`);
    this.name = 'InvalidDockerQuantityError';
  }
}

/** `512m` → 536870912. Accepts a bare byte count too. */
export function parseDockerMemory(value: string): number {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)\s*$/i.exec(value);
  if (!match) throw new InvalidDockerQuantityError(value, 'memory');

  const amount = Number.parseFloat(match[1] ?? '');
  const suffix = (match[2] ?? '').toLowerCase();
  const multiplier = MEMORY_MULTIPLIERS[suffix];
  if (!Number.isFinite(amount) || multiplier === undefined) {
    throw new InvalidDockerQuantityError(value, 'memory');
  }
  return Math.round(amount * multiplier);
}

/** `0.5` → 500000000 NanoCPUs, which is how the daemon stores `--cpus`. */
export function parseDockerCpus(value: string): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new InvalidDockerQuantityError(value, 'CPU');
  }
  return Math.round(amount * 1e9);
}

/** Render bytes the way a student would recognise them. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0';
  for (const [suffix, unit] of [
    ['g', 1024 ** 3],
    ['m', 1024 ** 2],
    ['k', 1024],
  ] as const) {
    if (bytes >= unit && bytes % unit === 0) return `${bytes / unit}${suffix}`;
  }
  return `${bytes} bytes`;
}

/** Render NanoCPUs back as the `--cpus` value that produced them. */
export function formatNanoCpus(nanoCpus: number): string {
  if (nanoCpus <= 0) return 'unlimited';
  const cpus = nanoCpus / 1e9;
  return Number.isInteger(cpus) ? String(cpus) : cpus.toFixed(2).replace(/0+$/, '');
}

/** Do two memory values describe the same limit? */
export function memoryEqual(a: string, b: string): boolean {
  try {
    return parseDockerMemory(a) === parseDockerMemory(b);
  } catch {
    return false;
  }
}
