/**
 * Progressive hints.
 *
 * Hints are revealed one at a time, in order, and never all at once. A student
 * who is nearly there gets a nudge; only a student who keeps asking reaches the
 * concrete guidance. Revealing the whole ladder immediately would make the
 * first hint pointless, because the last one would already be on screen.
 *
 * No hint contains a copy-pasteable solution — that is a content rule enforced
 * when the lab is authored (see `lab-definition.ts`), not something this
 * component can guarantee.
 *
 * Usage is reported through `onReveal` rather than stored. PLATFORM-005 hangs
 * persistence off exactly that seam — the lab page forwards the event to the
 * API, which records it against the student's attempt — and this component did
 * not change to make that work. It still owns only what is on screen.
 *
 * The callback fires once per hint, when it is first revealed: `revealed` never
 * goes backwards, so re-rendering cannot replay it. The server is idempotent
 * per (attempt, level) anyway, because a component contract is not somewhere to
 * put a correctness guarantee.
 */
import { useCallback, useState } from 'react';
import type { LabHint } from '../lib/types';

export interface HintPanelProps {
  hints: LabHint[];
  /** Called with the hint that was just revealed, and how many are now open. */
  onReveal?: (hint: LabHint, revealedCount: number) => void;
}

export function HintPanel({ hints, onReveal }: HintPanelProps) {
  const [revealed, setRevealed] = useState(0);

  const revealNext = useCallback(() => {
    if (revealed >= hints.length) return;
    const hint = hints[revealed];
    setRevealed(revealed + 1);
    // Reported outside the state updater: React may invoke an updater more than
    // once, and a reveal that is *reported* twice would be a lie about what the
    // student did — however forgiving the server is about receiving it twice.
    if (hint) onReveal?.(hint, revealed + 1);
  }, [hints, onReveal, revealed]);

  if (hints.length === 0) return null;

  const remaining = hints.length - revealed;
  const allRevealed = remaining === 0;

  return (
    <section className="brief__section hints" aria-label="Hints">
      <h2 className="brief__heading">
        Hints
        <span className="hints__count">
          {revealed} of {hints.length}
        </span>
      </h2>

      {revealed === 0 && (
        <p className="hints__intro">
          Stuck? Hints unlock one at a time, from a gentle nudge to concrete guidance.
        </p>
      )}

      <ol className="hints__list">
        {hints.slice(0, revealed).map((hint) => (
          <li key={hint.level} className="hints__item">
            <span className="hints__level">Hint {hint.level}</span>
            <p className="hints__text">{hint.text}</p>
          </li>
        ))}
      </ol>

      {allRevealed ? (
        <p className="hints__exhausted">
          That is every hint for this lab. The linked documentation above covers the rest.
        </p>
      ) : (
        <button type="button" className="btn btn--ghost hints__reveal" onClick={revealNext}>
          {revealed === 0 ? 'Show a hint' : `Show hint ${revealed + 1}`}
          <span className="hints__remaining">
            {remaining} left
          </span>
        </button>
      )}
    </section>
  );
}
