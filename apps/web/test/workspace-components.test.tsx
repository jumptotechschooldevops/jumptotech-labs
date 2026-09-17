/**
 * Student beta experience — the confirmation dialog and the verification panel.
 *
 * The dialog guards the two actions that destroy something (End, Reset), so it
 * has to behave like a real modal for keyboard and screen-reader users. The
 * panel is how a student learns whether their work passes, so pass, fail and
 * "the platform could not look" must never read alike.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { PageErrorBoundary } from '../src/components/PageErrorBoundary';
import { VerificationPanel } from '../src/components/VerificationPanel';
import { attemptSummary, verification } from './api-mock';

function Harness({ busy = false, onConfirm = () => undefined }: { busy?: boolean; onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        End lab
      </button>
      <ConfirmDialog
        open={open}
        title="End this lab?"
        confirmLabel="Confirm end"
        busy={busy}
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      >
        <p>Your lab environment will be deleted.</p>
      </ConfirmDialog>
    </>
  );
}

describe('ConfirmDialog', () => {
  it('is a labelled modal that starts on the safe choice', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'End lab' }));

    const dialog = screen.getByRole('alertdialog', { name: 'End this lab?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('closes on Escape and gives focus back to what opened it', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'End lab' });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the dialog', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'End lab' }));
    const dialog = screen.getByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm end' });

    confirm.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('cannot be dismissed while the action is running', () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'End lab' }));
    rerender(<Harness busy />);

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm end…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('confirms only when asked', () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'End lab' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm end' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('PageErrorBoundary', () => {
  function Boom(): never {
    throw new TypeError("Cannot read properties of undefined (reading 'filter')");
  }

  it('turns a page that fails to render into a message with a way out, instead of a blank app', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <PageErrorBoundary>
        <Boom />
      </PageErrorBoundary>,
    );
    quiet.mockRestore();

    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading', { level: 1, name: 'This page could not be shown' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Go to your dashboard' }).getAttribute('href')).toBe('#/');
    expect(alert.textContent).not.toMatch(/filter|TypeError/);
  });

  it('renders its page untouched when nothing fails', () => {
    render(
      <PageErrorBoundary>
        <p>fine</p>
      </PageErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('VerificationPanel', () => {
  it('invites a first check before anything has been verified', () => {
    render(<VerificationPanel state={{ kind: 'idle' }} />);
    expect(screen.getByText(/Not verified yet/)).toBeTruthy();
  });

  it('says a lab completed earlier is still completed', () => {
    render(<VerificationPanel state={{ kind: 'idle' }} alreadyCompleted />);
    expect(screen.getByText(/already completed this lab/)).toBeTruthy();
  });

  it('shows that checking is under way', () => {
    render(<VerificationPanel state={{ kind: 'checking' }} />);
    expect(screen.getByText('Checking your environment…')).toBeTruthy();
  });

  it('reports a pass, and says when it was the one that saved the completion', () => {
    render(<VerificationPanel state={{ kind: 'result', result: verification(true), newlyCompleted: true }} />);
    expect(screen.getByText('Lab passed — every check passes')).toBeTruthy();
    expect(screen.getByText(/Saved to your progress/)).toBeTruthy();
    expect(screen.queryByText('What to look at next')).toBeNull();
  });

  it('says a repeated pass is already recorded only when the api returned the recorded attempt', () => {
    const result = verification(true, { attempt: attemptSummary({ status: 'PASSED' }) });
    render(<VerificationPanel state={{ kind: 'result', result, newlyCompleted: false }} />);
    expect(screen.getByText(/already recorded as completed/)).toBeTruthy();
  });

  it('does not claim a pass was saved when the progress store could not record it', () => {
    // The api's `record()` swallows a failed write so the check still answers;
    // the response then carries no attempt. "Already recorded" would send the
    // student off to end a lab whose completion was never stored.
    render(<VerificationPanel state={{ kind: 'result', result: verification(true), newlyCompleted: false }} />);
    expect(screen.getByText('Lab passed — every check passes')).toBeTruthy();
    expect(screen.queryByText(/already recorded|Saved to your progress/)).toBeNull();
    expect(screen.getByText(/could not be saved/)).toBeTruthy();
  });

  it('reports a failure check by check, with what the verifier saw and where to look next', () => {
    render(<VerificationPanel state={{ kind: 'result', result: verification(false), newlyCompleted: false }} />);
    expect(screen.getByText('Not complete yet — 1 of 2 checks passing')).toBeTruthy();
    const failing = screen.getByText('app.log was moved, not copied').closest('li')!;
    expect(within(failing).getByText('The path still exists')).toBeTruthy();
    expect(within(failing).getByText(/Not passing yet/)).toBeTruthy();
    expect(screen.getByText('What to look at next')).toBeTruthy();
  });

  it('explains checks that were not run', () => {
    const result = verification(false);
    result.checks.push({ id: 'x-3', label: 'The archive contains app.log', status: 'skipped' });
    render(<VerificationPanel state={{ kind: 'result', result, newlyCompleted: false }} />);
    expect(screen.getByText(/Checks marked – were not run/)).toBeTruthy();
  });

  it('never presents a platform error as a failed task', () => {
    render(
      <VerificationPanel
        state={{ kind: 'error', error: { code: 'ENVIRONMENT_UNREACHABLE', message: 'connect ECONNREFUSED' } }}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Verification could not run')).toBeTruthy();
    expect(within(alert).getByText(/not a mistake in your work/)).toBeTruthy();
    expect(within(alert).getByText('ENVIRONMENT_UNREACHABLE')).toBeTruthy();
    expect(screen.queryByText(/Not complete yet/)).toBeNull();
    expect(screen.queryByText('What to look at next')).toBeNull();
  });
});
