/**
 * Validate the whole lab catalog and every learning path, without a runtime.
 *
 *   npm run validate:labs -- [--labs-dir labs] [--json] [--strict]
 *
 * Loads `labs/` through the same registry the API uses, then runs
 * `validateCatalog`: schema, ids and layout, the prerequisite graph, provider
 * contracts, setup assets read through the providers' own loaders, learning
 * path structure and coverage, and content hygiene. It needs no Docker, no
 * cluster and no database.
 *
 * Exit: 0 no errors (warnings are printed but do not fail, unless --strict),
 * 1 errors found, 2 the validator itself could not run.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LabRegistry, formatCatalogReport, validateCatalog } from '@jumptotech/lab-orchestrator';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'labs-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
    },
  });

  const labsDir = path.resolve(REPO_ROOT, values['labs-dir'] ?? 'labs');
  const registry = new LabRegistry(labsDir);
  await registry.load();
  const report = await validateCatalog({ labsDir, registry });

  process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : formatCatalogReport(report)}\n`);

  if (report.errors > 0) return 1;
  if (values.strict && report.warnings > 0) return 1;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`validate-labs could not run: ${(error as Error).stack ?? String(error)}\n`);
    process.exit(2);
  },
);
