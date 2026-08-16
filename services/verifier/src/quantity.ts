/**
 * Kubernetes resource quantity parsing.
 *
 * Quantities are compared by *value*, not by spelling. A student who writes
 * `0.1` where the lab asks for `100m`, or `65536Ki` where it asks for `64Mi`,
 * has produced exactly the same Pod specification and must pass. Comparing the
 * raw strings would fail them for a formatting preference.
 *
 * Reference: https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/quantity/
 */

/** Binary (power-of-two) suffixes. */
const BINARY: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/** Decimal (power-of-ten) suffixes, including the sub-unit ones. */
const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

const QUANTITY = /^([0-9]+(?:\.[0-9]+)?)([EPTGMK]i|[numkMGTPE])?(?:e([+-]?[0-9]+))?$/;

/**
 * Parse a quantity into a plain number of base units
 * (cores for CPU, bytes for memory). Returns `null` for anything unparseable.
 */
export function parseQuantity(value: string): number | null {
  const trimmed = value.trim();
  const match = QUANTITY.exec(trimmed);
  if (!match) return null;

  const [, digits, suffix, exponent] = match;
  const base = Number(digits);
  if (!Number.isFinite(base)) return null;

  let multiplier = 1;
  if (suffix) {
    if (suffix in BINARY) multiplier = BINARY[suffix]!;
    else if (suffix in DECIMAL) multiplier = DECIMAL[suffix]!;
    else return null;
  }

  const scientific = exponent ? 10 ** Number(exponent) : 1;
  return base * multiplier * scientific;
}

/**
 * Do two quantities describe the same amount?
 *
 * A relative tolerance absorbs binary floating-point error on values such as
 * `0.1` (100m), which cannot be represented exactly.
 */
export function quantitiesEqual(a: string, b: string): boolean {
  const left = parseQuantity(a);
  const right = parseQuantity(b);
  if (left === null || right === null) return a.trim() === b.trim();
  if (left === right) return true;
  const scale = Math.max(Math.abs(left), Math.abs(right), 1e-12);
  return Math.abs(left - right) / scale < 1e-9;
}
