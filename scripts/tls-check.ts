/**
 * BETA-P0-017 — is the public TLS edge healthy, and when must its certificate be renewed?
 *
 *   npm run tls:check -- --origin https://labs.example.com \
 *       --cert-dir infrastructure/docker/nginx/tls
 *
 *   # before DNS points at the host, or against a staging CA:
 *   npm run tls:check -- --origin https://labs.example.com --connect 203.0.113.10 \
 *       --ca-file staging-root.pem
 *
 * Checks the installed files (--cert-dir), a fully verified HTTPS connection,
 * the port-80 redirect, and, with --expect-acme, the ACME HTTP-01 route. The
 * origin defaults to PUBLIC_ORIGIN. Run it on a schedule and alert on the exit
 * status: docs/runbooks/production-tls.md §5.
 *
 * Exit: 0 OK, 1 WARNING (renewal due), 2 CRITICAL, or the check could not run.
 * Prints host names, dates and fingerprints. Never prints key material.
 *
 * The checks live in services/observability/src/tls-certificate-health.ts,
 * where services/observability/test/tls-certificate-health.test.ts proves them.
 */
import { runTlsCheck } from '../services/observability/src/tls-certificate-health.js';

try {
  const { exitCode, output } = await runTlsCheck(process.argv.slice(2), process.env);
  (exitCode === 0 ? process.stdout : process.stderr).write(output);
  process.exitCode = exitCode;
} catch (error) {
  process.stderr.write(`tls-check: the check could not run: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
