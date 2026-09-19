/**
 * What Verify found — and, as importantly, what it did not.
 *
 * Five states, visually and textually distinct:
 *
 * ```text
 *   idle      not verified yet (in this visit)
 *   checking  the verifier is reading the environment
 *   passed    every check passed
 *   failed    the environment was read; some checks do not pass yet
 *   error     the environment could NOT be read — nothing was checked
 * ```
 *
 * `failed` and `error` must never look alike. A failure is the most normal
 * event in the product: the student is not done yet. An error is the platform
 * failing to look, and presenting it as a failed task would tell a student their
 * correct work is wrong.
 *
 * Everything shown comes from the verifier's own result. Check details are the
 * verifier's words about what it observed; the expected values that would be
 * the solution are not in the payload, so they cannot be shown here.
 */
import type { ApiError, CheckResult, VerificationResult } from '../lib/types';
import { describeError } from '../lib/errors';
import { formatMoment, plural } from '../lib/format';
import { InlineText } from './RichText';

export type VerifyState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'result'; result: VerificationResult; newlyCompleted: boolean }
  | { kind: 'error'; error: ApiError };

const MARK: Record<CheckResult['status'], string> = { pass: '✓', fail: '✗', skipped: '–' };
const STATUS_TEXT: Record<CheckResult['status'], string> = {
  pass: 'Passed',
  fail: 'Not passing yet',
  skipped: 'Not checked',
};

export function VerificationPanel({
  state,
  alreadyCompleted = false,
}: {
  state: VerifyState;
  /** The saved attempt was completed earlier — say so, even before verifying again. */
  alreadyCompleted?: boolean;
}) {
  return (
    <section className={`verify verify--${state.kind === 'result' ? (state.result.passed ? 'passed' : 'failed') : state.kind}`} aria-labelledby="verify-heading">
      <h2 id="verify-heading" className="verify__heading">
        Verification
      </h2>
      {/* One polite live region for the whole panel, so each state change is
          announced once and a screen reader never has to hunt for the verdict. */}
      <div aria-live="polite" aria-atomic="false">
        {state.kind === 'idle' ? (
          <p className="verify__idle">
            {alreadyCompleted
              ? 'You have already completed this lab. You can keep practising and verify again at any time.'
              : 'Not verified yet. When you think you are done — or want to see how far you have got — press Verify. It checks the real state of your environment.'}
          </p>
        ) : null}

        {state.kind === 'checking' ? (
          <p className="verify__checking">
            <span className="spinner spinner--sm" aria-hidden="true" /> Checking your environment…
          </p>
        ) : null}

        {state.kind === 'error' ? <VerifyError error={state.error} /> : null}

        {state.kind === 'result' ? <VerifyResult result={state.result} newlyCompleted={state.newlyCompleted} /> : null}
      </div>
    </section>
  );
}

function VerifyError({ error }: { error: ApiError }) {
  const described = describeError(error, 'verify');
  return (
    <div className="verify__error" role="alert">
      <p className="verify__verdict verify__verdict--error">
        <span aria-hidden="true">⚠ </span>
        {described.title}
      </p>
      <p className="verify__text">{described.message}</p>
      {described.guidance ? <p className="verify__text">{described.guidance}</p> : null}
      <p className="verify__reference">
        Reference: <code>{described.reference}</code>
      </p>
    </div>
  );
}

function VerifyResult({ result, newlyCompleted }: { result: VerificationResult; newlyCompleted: boolean }) {
  const passing = result.checks.filter((check) => check.status === 'pass').length;
  const failing = result.checks.filter((check) => check.status === 'fail');
  const skipped = result.checks.filter((check) => check.status === 'skipped').length;

  return (
    <div>
      <p className={`verify__verdict verify__verdict--${result.passed ? 'passed' : 'failed'}`}>
        <span aria-hidden="true">{result.passed ? '✓ ' : '✗ '}</span>
        {result.passed
          ? 'Lab passed — every check passes'
          : `Not complete yet — ${passing} of ${plural(result.checks.length, 'check')} passing`}
      </p>
      {result.passed ? (
        <p className="verify__text">
          {newlyCompleted
            ? 'Saved to your progress. Keep exploring if you like — when you are done, press End lab to free your environment and see your next lab.'
            : result.attempt?.status === 'PASSED'
              ? 'This lab is already recorded as completed.'
              : // The api answers a check even when it could not write the result (its
                // progress store was unreachable), and then returns no attempt.
                'Your result could not be saved just now. Press Verify again in a moment, before you end the lab.'}
        </p>
      ) : null}

      <ul className="verify__checks">
        {result.checks.map((check, index) => (
          <li key={`${index}-${check.id}`} className={`verify__check verify__check--${check.status}`}>
            <span className="verify__mark" aria-hidden="true">
              {MARK[check.status]}
            </span>
            <span className="verify__label">
              <InlineText text={check.label} />
              <span className="visually-hidden"> — {STATUS_TEXT[check.status]}</span>
            </span>
            {check.detail ? <span className="verify__detail">{check.detail}</span> : null}
          </li>
        ))}
      </ul>

      {!result.passed ? (
        <div className="verify__next">
          <p className="verify__next-title">What to look at next</p>
          <ul>
            {failing.length > 0 ? (
              <li>
                Start with {failing.length === 1 ? 'the check' : 'the first check'} marked ✗ — its note says what the
                verifier found.
              </li>
            ) : null}
            <li>Inspect the current state from the terminal, fix what differs, then press Verify again.</li>
            {skipped > 0 ? <li>Checks marked – were not run; they usually depend on an earlier check passing.</li> : null}
            <li>Stuck? The instructions panel has hints that unlock one at a time.</li>
          </ul>
        </div>
      ) : null}

      <p className="verify__when">Checked {formatMoment(result.checkedAt)}</p>
    </div>
  );
}
