/**
 * test-support/strict-vitest.ts: the CI runtime steps fail when a suite that
 * step exists to run skipped itself instead. What it decides from vitest's
 * JSON report is proven here; that it is what CI runs is proven in
 * ci-gate-wiring.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { strictRunProblems, type VitestJsonReport } from '@jumptotech/test-support/strict-vitest';

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
