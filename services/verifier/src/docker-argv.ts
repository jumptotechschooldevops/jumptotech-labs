/**
 * The program an exec-form ENTRYPOINT starts, as a path the checks can compare.
 *
 * An exec-form entrypoint is handed to the kernel as-is, so a first element
 * with a slash in it is a path, and a relative one is resolved from the
 * working directory: `ENTRYPOINT ["./batch.sh"]` under `WORKDIR /app` starts
 * /app/batch.sh, exactly as `["/app/batch.sh"]` does. A bare name (`batch.sh`)
 * is looked up on PATH instead, never in the working directory, so it is left
 * alone — and so is everything after the program, which is its arguments.
 *
 * Resolution never makes an unrelated program match: `./batch.sh` under a
 * different WORKDIR, or `/bin/sh /app/batch.sh`, still names something else.
 */
import path from 'node:path';

export function resolveEntrypoint(argv: readonly string[], workingDir: string): string[] {
  const [program, ...rest] = argv;
  if (program === undefined || program.startsWith('/') || !program.includes('/')) return [...argv];
  return [path.posix.resolve(workingDir || '/', program), ...rest];
}
