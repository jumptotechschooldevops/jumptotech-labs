/** Read a variable the suite cannot run without. Fails closed; never defaults. */
export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set; run the suite through e2e/stack.sh`);
  return value.replace(/\/$/, '');
}
