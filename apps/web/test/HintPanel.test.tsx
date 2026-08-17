/**
 * PLATFORM-003 — progressive hints (story test requirement 36).
 *
 * The behaviour under test is that hints unlock one at a time. Revealing the
 * whole ladder at once would make the gentle first hint pointless, because the
 * concrete third one would already be on screen.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HintPanel } from '../src/components/HintPanel';
import type { LabHint } from '../src/lib/types';

const HINTS: LabHint[] = [
  { level: 1, text: 'Think about which controller keeps Pods running.' },
  { level: 2, text: 'Look at the replica count and the rollout status.' },
  { level: 3, text: 'The Deployment must be named frontend with three replicas.' },
];

/** Click through the reveal button n times. `fireEvent` wraps each click in act(). */
function reveal(times: number): void {
  for (let i = 0; i < times; i += 1) {
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
  }
}

describe('HintPanel', () => {
  it('renders nothing when a lab declares no hints', () => {
    const { container } = render(<HintPanel hints={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows no hint text until the student asks', () => {
    render(<HintPanel hints={HINTS} />);

    expect(screen.queryByText(HINTS[0]!.text)).toBeNull();
    expect(screen.queryByText(HINTS[1]!.text)).toBeNull();
    expect(screen.queryByText(HINTS[2]!.text)).toBeNull();
    expect(screen.getByText('0 of 3')).toBeTruthy();
  });

  it('reveals hints one at a time, in order', () => {
    render(<HintPanel hints={HINTS} />);

    reveal(1);
    expect(screen.getByText(HINTS[0]!.text)).toBeTruthy();
    // The later hints stay hidden — this is the whole point of the ladder.
    expect(screen.queryByText(HINTS[1]!.text)).toBeNull();
    expect(screen.queryByText(HINTS[2]!.text)).toBeNull();
    expect(screen.getByText('1 of 3')).toBeTruthy();

    reveal(1);
    expect(screen.getByText(HINTS[1]!.text)).toBeTruthy();
    expect(screen.queryByText(HINTS[2]!.text)).toBeNull();

    reveal(1);
    expect(screen.getByText(HINTS[2]!.text)).toBeTruthy();
    expect(screen.getByText('3 of 3')).toBeTruthy();
  });

  it('keeps earlier hints on screen as later ones unlock', () => {
    render(<HintPanel hints={HINTS} />);
    reveal(3);

    for (const hint of HINTS) expect(screen.getByText(hint.text)).toBeTruthy();
  });

  it('labels the next hint and counts down what is left', () => {
    render(<HintPanel hints={HINTS} />);

    expect(screen.getByRole('button', { name: /show a hint/i })).toBeTruthy();
    expect(screen.getByText('3 left')).toBeTruthy();

    reveal(1);
    expect(screen.getByRole('button', { name: /show hint 2/i })).toBeTruthy();
    expect(screen.getByText('2 left')).toBeTruthy();
  });

  it('stops offering hints once the ladder is exhausted', () => {
    render(<HintPanel hints={HINTS} />);
    reveal(3);

    expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
    expect(screen.getByText(/that is every hint/i)).toBeTruthy();
  });

  /*
   * `onReveal` was the seam PLATFORM-003 left for persistence, and PLATFORM-005
   * hangs hint tracking off it: the lab page forwards each event to the API,
   * which records it against the student's attempt.
   */
  it('reports each reveal so usage can be persisted', () => {
    const onReveal = vi.fn();
    render(<HintPanel hints={HINTS} onReveal={onReveal} />);

    reveal(2);

    expect(onReveal).toHaveBeenCalledTimes(2);
    expect(onReveal).toHaveBeenNthCalledWith(1, HINTS[0], 1);
    expect(onReveal).toHaveBeenNthCalledWith(2, HINTS[1], 2);
  });

  it('reports a hint exactly once, however the panel re-renders', () => {
    const onReveal = vi.fn();
    const { rerender } = render(<HintPanel hints={HINTS} onReveal={onReveal} />);

    reveal(1);
    // A re-render for any unrelated reason must not replay the event: the
    // server is idempotent, but a component that double-reports is still
    // lying about what the student did.
    rerender(<HintPanel hints={HINTS} onReveal={onReveal} />);
    rerender(<HintPanel hints={HINTS} onReveal={onReveal} />);

    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith(HINTS[0], 1);
  });

  it('handles a single-hint ladder', () => {
    render(<HintPanel hints={[HINTS[0]!]} />);
    reveal(1);

    expect(screen.getByText(HINTS[0]!.text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
  });
});
