/**
 * `vitest run`, except that a skipped test fails the run.
 *
 * Every INTEGRATION suite skips itself when its infrastructure is missing — no
 * RUN_*_TESTS gate, no kubeconfig, no image, no PTY — and says why. That is the
 * right behaviour on a laptop and the wrong one in a CI job whose only purpose
 * is to run that suite: a renamed gate variable, a kubeconfig written somewhere
 * new or an image built under another tag turns the job into a green tick that
 * proved nothing. vitest has no switch for this (exit 0 with every test
 * skipped), so the CI runtime steps run their suites through here instead:
 *
 *   npx tsx test-support/strict-vitest.ts test/x-integration.test.ts --root services/y
 *
 * Arguments are passed to `vitest run` unchanged. vitest's own exit status wins
 * when it is non-zero; on success the JSON report is read back and the run
 * fails if no test ran, a test file it names did not run, or any test was
 * skipped or left as todo, naming each one.
 * Unit runs (`npm test`) are deliberately not strict: several suites skip on
 * purpose there (test-support/README.md → INTEGRATION).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The subset of vitest's `--reporter=json` output this reads. */
export interface VitestJsonReport {
  numTotalTests: number;
  testResults: Array<{
    name: string;
    assertionResults: Array<{ fullName: string; status: string }>;
  }>;
}

/** Why a successful vitest run still proved nothing; empty when it proved everything it ran. */
export function strictRunProblems(report: VitestJsonReport, cwd = process.cwd()): string[] {
  const problems: string[] = [];
  if (report.numTotalTests === 0 || report.testResults.length === 0) {
    problems.push('no test ran');
  }
  for (const file of report.testResults) {
    const name = path.relative(cwd, file.name) || file.name;
    const tests = file.assertionResults;
    const notPassed = tests.filter((test) => test.status !== 'passed');
    if (tests.length === 0) {
      problems.push(`${name}: no test ran`);
    } else if (notPassed.length === tests.length) {
      // The usual shape: the whole suite skipped itself. One line, not forty.
      problems.push(`${name}: none of its ${tests.length} tests ran (${[...new Set(notPassed.map((t) => t.status))].join(', ')})`);
    } else {
      for (const test of notPassed) problems.push(`${name}: ${test.status}: ${test.fullName}`);
    }
  }
  return problems;
}

/** vitest options that take the next argument as their value. */
const OPTIONS_WITH_VALUE = new Set(['--root', '-r', '--dir', '--config', '-c', '-t', '--testNamePattern', '--project']);

/**
 * Test files this step named that are not in what ran.
 *
 * vitest reads file arguments as filters, and one that matches nothing among
 * several others is dropped without a word: `vitest run a.test.ts
 * missing.test.ts` exits 0 having run `a` alone (measured, vitest 3.2.7). So a
 * step naming five suites stayed green with one of them renamed away.
 */
export function namedFilesNotRun(args: readonly string[], report: VitestJsonReport, cwd = process.cwd()): string[] {
  let root = cwd;
  const named: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--root' || arg === '-r') {
      root = path.resolve(cwd, args[index + 1] ?? '.');
      index += 1;
    } else if (arg.startsWith('--root=')) {
      root = path.resolve(cwd, arg.slice('--root='.length));
    } else if (OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
    } else if (!arg.startsWith('-') && /\.(test|spec)\.[cm]?[jt]sx?$/.test(arg)) {
      named.push(arg);
    }
  }
  const ran = new Set(report.testResults.map((file) => path.resolve(file.name)));
  return named
    .filter((arg) => !ran.has(path.resolve(root, arg)))
    .map((arg) => `${arg}: named by this step, but no such test file ran`);
}

function main(args: string[]): number {
  const dir = mkdtempSync(path.join(tmpdir(), 'strict-vitest-'));
  const reportFile = path.join(dir, 'report.json');
  try {
    const run = spawnSync(
      'npx',
      ['vitest', 'run', ...args, '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`],
      { stdio: 'inherit' },
    );
    if (run.error) {
      console.error(`strict-vitest: could not start vitest: ${run.error.message}`);
      return 1;
    }
    if (run.status !== 0) return run.status ?? 1;

    let report: VitestJsonReport;
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8')) as VitestJsonReport;
    } catch (error) {
      console.error(`strict-vitest: vitest exited 0 but wrote no readable report (${(error as Error).message})`);
      return 1;
    }
    const problems = [...namedFilesNotRun(args, report), ...strictRunProblems(report)];
    if (problems.length === 0) return 0;
    console.error('\nstrict-vitest: this step must run every test it names, and did not:');
    // `::error::` is a GitHub Actions annotation; elsewhere it is a readable prefix.
    for (const problem of problems) console.error(`::error::${problem}`);
    console.error('The skip reason is printed above by the suite itself.');
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
