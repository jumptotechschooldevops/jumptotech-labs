/**
 * The verifier runs inside the api process, on text the student wrote.
 *
 * A pattern that backtracks quadratically on that text holds the event loop —
 * every student's Start, Check, terminal credential exchange and status poll —
 * for as long as it runs. The only bound is one Check in flight per session,
 * and five students can each send one. These inputs took seconds to tens of
 * seconds through the patterns they replaced; each is far larger than any
 * file a sandbox read returns, so a quadratic pass could not finish in time.
 */
import { describe, expect, it } from 'vitest';
import { verifyLab } from '../src/index.js';
import { withoutShellComment, withoutShellComments } from '../src/ci/workflow.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { FakeSandbox } from './sandbox-fake.js';

/** Generous for linear work on a loaded machine; hopeless for quadratic. */
const BUDGET_MS = 3_000;

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

describe('student text is scanned in linear time', () => {
  it('file_content equals: a long run of whitespace that does not end the file', async () => {
    const lab = (await realCatalog()).get('LINUX-007');
    // Within the sandbox's 64 KiB read cap: the real read delivers all of it.
    const content = `${' '.repeat(65_000)}x`;
    const sandbox = new FakeSandbox({ files: { '/home/student/analysis/error-count.txt': { content } } });
    const started = performance.now();
    const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001', sandbox });
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    expect(result.checks[0]?.status).toBe('fail');
  });

  it('shell comments: a line of " #" repeated', () => {
    const line = ' #'.repeat(500_000);
    const { value, ms } = timed(() => withoutShellComments(`${line}\r\n${line}`));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toBe(' \n ');
  });
});

describe('a shell comment runs to the end of the line, as the shell reads it', () => {
  it.each([
    ['a carriage return', '# node build.mjs\rtrue'],
    ['U+2028', '# node build.mjs true'],
    ['U+2029', '# node build.mjs true'],
  ])('%s inside a comment does not end it', (_name, line) => {
    expect(withoutShellComment(line)).toBe('');
  });

  it('keeps code, and what precedes a comment', () => {
    expect(withoutShellComment('node build.mjs  # then test')).toBe('node build.mjs  ');
    expect(withoutShellComment('echo ${{ env.A }}#not-a-comment')).toBe('echo ${{ env.A }}#not-a-comment');
    expect(withoutShellComment('curl https://example.test/#anchor')).toBe('curl https://example.test/#anchor');
  });
});
