/**
 * test-support/strict-vitest.ts: the CI runtime steps fail when a suite that
 * step exists to run skipped itself instead. What it decides from vitest's
 * JSON report is proven here; that it is what CI runs is proven in
 * ci-gate-wiring.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { namedFilesNotRun, strictRunProblems, type VitestJsonReport } from '@jumptotech/test-support/strict-vitest';

const file = (name: string, ...statuses: string[]): VitestJsonReport['testResults'][number] => ({
  name: `/repo/services/x/test/${name}`,
  assertionResults: statuses.map((status, index) => ({ fullName: `${name} case ${index}`, status })),
});
const report = (...files: VitestJsonReport['testResults']): VitestJsonReport => ({
  numTotalTests: files.reduce((sum, f) => sum + f.assertionResults.length, 0),
  testResults: files,
});

describe('a strict vitest run', () => {
  it('passes when every test it collected passed', () => {
    expect(strictRunProblems(report(file('a.test.ts', 'passed', 'passed')), '/repo')).toEqual([]);
  });

  it('fails when nothing ran at all', () => {
    expect(strictRunProblems(report(), '/repo')).toEqual(['no test ran']);
  });

  it('fails on a suite that skipped itself, in one line naming the file', () => {
    expect(strictRunProblems(report(file('b-integration.test.ts', 'skipped', 'skipped', 'skipped')), '/repo')).toEqual([
      'services/x/test/b-integration.test.ts: none of its 3 tests ran (skipped)',
    ]);
  });

  it('names each skipped or todo test in a suite that otherwise ran', () => {
    expect(strictRunProblems(report(file('c.test.ts', 'passed', 'skipped', 'todo')), '/repo')).toEqual([
      'services/x/test/c.test.ts: skipped: c.test.ts case 1',
      'services/x/test/c.test.ts: todo: c.test.ts case 2',
    ]);
  });

  it('fails on a collected file with no tests in it', () => {
    expect(strictRunProblems(report(file('a.test.ts', 'passed'), file('empty.test.ts')), '/repo')).toEqual([
      'services/x/test/empty.test.ts: no test ran',
    ]);
  });
});

/*
 * vitest treats file arguments as filters, and a filter that matches nothing
 * among several others is silently dropped: `vitest run a.test.ts missing.test.ts`
 * exits 0 having run only `a` (measured, vitest 3.2.7), and so did this runner.
 * A step naming five suites (NET-004 … NET-008) stayed green with one renamed
 * away. Every file a step names must be in what ran.
 */
describe('a strict vitest run, against the files it was asked for', () => {
  const ran = report(file('a.test.ts', 'passed'), file('b.test.ts', 'passed'));

  it('passes when every named file ran', () => {
    expect(namedFilesNotRun(['test/a.test.ts', 'test/b.test.ts', '--root', 'services/x'], ran, '/repo')).toEqual([]);
  });

  it('names a file that was asked for and did not run', () => {
    expect(
      namedFilesNotRun(['test/a.test.ts', 'test/renamed.test.ts', '--root', 'services/x'], ran, '/repo'),
    ).toEqual(['test/renamed.test.ts: named by this step, but no such test file ran']);
  });

  it('reads --root in either form, and ignores option values and flags', () => {
    expect(
      namedFilesNotRun(
        ['--root=services/x', 'test/a.test.ts', '-t', 'some name.ts', '--testTimeout=900000', '--no-file-parallelism'],
        ran,
        '/repo',
      ),
    ).toEqual([]);
    expect(namedFilesNotRun(['test/a.test.ts', '--root=services/y'], ran, '/repo')).toEqual([
      'test/a.test.ts: named by this step, but no such test file ran',
    ]);
  });
});
