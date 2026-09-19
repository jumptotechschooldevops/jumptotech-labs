/**
 * Student beta experience — the active lab workspace.
 *
 * The terminal emulator is replaced by a stand-in that reports connection
 * events the way the real one does; everything else — session state, polling,
 * terminal grants, Verify, Reset, End — is the shipped page against a stubbed
 * API. The properties that matter:
 *
 *   - a reloaded page finds the running lab and mints a fresh terminal token
 *   - actions exist only in states where the API accepts them
 *   - pass, fail and platform error read differently
 *   - Reset and End explain themselves and require confirmation
 *   - an ended lab shows no terminal and no controls
 *   - a dropped terminal can be reconnected; an ended one is not retried
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ApiRequestError } from '../src/lib/api';
import { AUTO_RECONNECTS, WorkspacePage } from '../src/pages/WorkspacePage';
import type { TerminalEvent } from '../src/components/LabTerminal';
import type { TerminalGrant } from '../src/lib/types';
import { renderWithProviders } from './app-harness';
import {
  apiMock,
  attemptSummary,
  labDetail,
  learningPathProgress,
  resetApiMock,
  sessionInfo,
  sessionsResponse,
  verification,
} from './api-mock';

const terminal = vi.hoisted(() => ({
  autoConnect: true,
  last: null as null | { grant: TerminalGrant | null; connectKey: number; onEvent: (event: TerminalEvent) => void },
}));

vi.mock('../src/components/LabTerminal', async () => {
  const React = await import('react');
  const LabTerminal = React.forwardRef(function FakeTerminal(
    props: { grant: TerminalGrant | null; connectKey?: number; onEvent: (event: TerminalEvent) => void },
    ref: React.Ref<unknown>,
  ) {
    const { grant, connectKey = 0, onEvent } = props;
    React.useImperativeHandle(ref, () => ({ clear: () => undefined, focus: () => undefined, writeNotice: () => undefined }));
    React.useEffect(() => {
      terminal.last = { grant, connectKey, onEvent };
      if (!grant) {
        onEvent({ status: 'idle' });
        return;
      }
      onEvent({ status: 'connecting' });
      if (terminal.autoConnect) onEvent({ status: 'connected' });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [grant?.token, connectKey]);
    return React.createElement('div', {
      'data-testid': 'terminal',
      'data-token': grant?.token ?? '',
      'data-url': grant?.url ?? '',
      'data-connect-key': String(connectKey),
    });
  });
  return { LabTerminal };
});

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

const SESSION_ID = 'sess-0000000000000001';

beforeEach(() => {
  resetApiMock();
  terminal.autoConnect = true;
  terminal.last = null;
  apiMock.listMySessions.mockResolvedValue(
    sessionsResponse([{ session: sessionInfo(), labTitle: 'Files and Directories', attempt: attemptSummary() }]),
  );
  apiMock.issueTerminal.mockResolvedValue({ session: sessionInfo(), terminal: { url: 'ws://terminal', token: 'fresh-token' } });
  // The real API answers for the session that was asked about.
  apiMock.getSession.mockImplementation((id: string) =>
    Promise.resolve({ session: sessionInfo({ sessionId: id }), environment: null }),
  );
  window.history.replaceState(null, '', '/#/labs/LINUX-001/workspace');
});

afterEach(() => {
  vi.useRealTimers();
});

const bar = () => within(screen.getByRole('group', { name: 'Lab actions' }));
const button = (name: string) => bar().getByRole('button', { name }) as HTMLButtonElement;

async function renderConnected() {
  renderWithProviders(<WorkspacePage labId="LINUX-001" />);
  await screen.findByText('Terminal: Connected');
}

describe('finding the running lab', () => {
  it('reattaches after a reload by minting a fresh terminal token — never from storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await renderConnected();

    expect(apiMock.issueTerminal).toHaveBeenCalledTimes(1);
    expect(apiMock.issueTerminal).toHaveBeenCalledWith(SESSION_ID);
    expect(screen.getByTestId('terminal').getAttribute('data-token')).toBe('fresh-token');
    // The socket goes to this page's own origin (proxied /terminal), never to the
    // API's configured fallback — which on a shared laptop is another stack's terminal.
    expect(screen.getByTestId('terminal').getAttribute('data-url')).toBe(`ws://${window.location.host}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Files and Directories' })).toBeTruthy();
    expect(button('Verify').disabled).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('finds a lab that appears after the page loaded (a reload during Start)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'LINUX-001 is not running' })).toBeTruthy();

    // The start the reload cancelled in the browser reaches the server.
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ status: 'CREATING' }), labTitle: 'Files and Directories' }]),
    );
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'LINUX-001 is not running' })).toBeNull());
    // The workspace for that session, not an empty state.
    expect(await screen.findByRole('group', { name: 'Lab actions' })).toBeTruthy();
  });

  it('stops re-checking a lab that is really not running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);
    await screen.findByRole('heading', { level: 1, name: 'LINUX-001 is not running' });
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    const calls = apiMock.listMySessions.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(1 + 10 + 1);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(apiMock.listMySessions.mock.calls.length).toBe(calls);
  });

  it('says a lab is not running, and points at the lab page, when there is no session for it', async () => {
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);

    expect(await screen.findByRole('heading', { level: 1, name: 'LINUX-001 is not running' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the lab page' }).getAttribute('href')).toBe('#/labs/LINUX-001');
    expect(screen.queryByTestId('terminal')).toBeNull();
  });

  it('does not allow Verify, or ask for a terminal, before the environment is ready — and polls until it is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ status: 'CREATING' }), labTitle: 'Files and Directories' }]),
    );
    apiMock.getSession
      .mockResolvedValueOnce({ session: sessionInfo({ status: 'CREATING' }), environment: null })
      .mockResolvedValue({ session: sessionInfo({ status: 'ACTIVE' }), environment: null });
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);

    expect(await screen.findByText('Preparing your lab environment…')).toBeTruthy();
    // Found after a reload: the page did not send the start, and still says what is going on.
    expect(screen.getByText(/This can take a little while, and this page updates by itself/)).toBeTruthy();
    await waitFor(() => expect(apiMock.getSession).toHaveBeenCalledTimes(1));
    expect(button('Verify').disabled).toBe(true);
    expect(button('Reset').disabled).toBe(true);
    expect(apiMock.issueTerminal).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(3_100));
    await screen.findByText('Terminal: Connected');
    expect(apiMock.issueTerminal).toHaveBeenCalledTimes(1);
    expect(button('Verify').disabled).toBe(false);
  });
});

describe('Verify', () => {
  it('reports a pass, marks the lab completed, and refreshes saved progress', async () => {
    apiMock.checkSolution.mockResolvedValue(
      verification(true, {
        session: sessionInfo(),
        attempt: attemptSummary({ status: 'PASSED', completedAt: '2026-09-15T10:00:00Z' }),
        newlyCompleted: true,
      }),
    );
    await renderConnected();
    const progressLoads = apiMock.getProgress.mock.calls.length;

    fireEvent.click(button('Verify'));

    expect(await screen.findByText('Lab passed — every check passes')).toBeTruthy();
    expect(screen.getByText(/Saved to your progress/)).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('2 of 2 passing')).toBeTruthy();
    await waitFor(() => expect(apiMock.getProgress.mock.calls.length).toBeGreaterThan(progressLoads));
  });

  it('reports what does not pass yet, check by check', async () => {
    apiMock.checkSolution.mockResolvedValue(verification(false, { session: sessionInfo() }));
    await renderConnected();

    fireEvent.click(button('Verify'));

    expect(await screen.findByText('Not complete yet — 1 of 2 checks passing')).toBeTruthy();
    expect(screen.getByText('1 of 2 passing')).toBeTruthy();
    expect(screen.getByText('The path still exists')).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('keeps a platform error apart from a failed task', async () => {
    apiMock.checkSolution.mockRejectedValue(
      new ApiRequestError(503, { code: 'ENVIRONMENT_UNREACHABLE', message: 'connect ECONNREFUSED', details: { checks: [] } }),
    );
    await renderConnected();

    fireEvent.click(button('Verify'));

    expect(await screen.findByText('Verification could not run')).toBeTruthy();
    expect(screen.queryByText(/Not complete yet/)).toBeNull();
    expect(screen.queryByText(/passing$/)).toBeNull();
  });

  it('treats a 200 that is not a verification result as a platform fault — never a verdict, never a blank page', async () => {
    // Seen in the pre-merge browser run: `{ ok: true, data: {} }` blanked the app.
    apiMock.checkSolution.mockResolvedValue({});
    await renderConnected();

    fireEvent.click(button('Verify'));

    expect(await screen.findByText('The platform sent an unexpected response')).toBeTruthy();
    expect(screen.getByText('BAD_RESPONSE')).toBeTruthy();
    expect(screen.queryByText(/Not complete yet|Lab passed/)).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Files and Directories' })).toBeTruthy();
    expect(button('Verify').disabled).toBe(false);
  });

  it('sends one check for a double click', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.checkSolution.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderConnected();

    fireEvent.click(button('Verify'));
    fireEvent.click(bar().getByRole('button', { name: /Verif/ }));

    expect(apiMock.checkSolution).toHaveBeenCalledTimes(1);
    expect((bar().getByRole('button', { name: 'Verifying…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(verification(false)));
  });
});

describe('hints', () => {
  beforeEach(() => {
    apiMock.getLab.mockImplementation((id: string) =>
      Promise.resolve(
        labDetail({
          id,
          hints: [
            { level: 1, text: 'A gentle nudge.' },
            { level: 2, text: 'A closer look.' },
            { level: 3, text: 'Concrete guidance.' },
          ],
        }),
      ),
    );
  });

  it('shows again, after a reload, the hints this attempt already revealed — without recording them twice', async () => {
    apiMock.getAttempt.mockResolvedValue({
      student: { studentId: 'dev-student', displayName: 'Dev Student' },
      attempt: {
        ...attemptSummary(),
        hints: [
          { level: 1, revealedAt: '2026-09-14T10:05:00Z' },
          { level: 2, revealedAt: '2026-09-14T10:09:00Z' },
        ],
        hintsUsed: 2,
      },
    });
    await renderConnected();

    const hints = within(screen.getByRole('region', { name: 'Hints' }));
    expect(await hints.findByText('Hint 2')).toBeTruthy();
    expect(hints.getByText('Hint 1')).toBeTruthy();
    expect(hints.queryByText('Hint 3')).toBeNull();
    expect(hints.getByText('2 of 3')).toBeTruthy();
    expect(apiMock.getAttempt).toHaveBeenCalledWith('attempt-1');
    expect(apiMock.recordHint).not.toHaveBeenCalled();

    // The next reveal is the next hint, and only that one is recorded.
    fireEvent.click(hints.getByRole('button', { name: /Show hint 3/ }));
    expect(hints.getByText('Hint 3')).toBeTruthy();
    await waitFor(() => expect(apiMock.recordHint).toHaveBeenCalledTimes(1));
    expect(apiMock.recordHint).toHaveBeenCalledWith(SESSION_ID, 3);
  });

  it('starts closed when the attempt cannot be read', async () => {
    apiMock.getAttempt.mockRejectedValue(new ApiRequestError(503, { code: 'PROGRESS_UNAVAILABLE', message: 'down' }));
    await renderConnected();
    const hints = within(screen.getByRole('region', { name: 'Hints' }));
    await waitFor(() => expect(apiMock.getAttempt).toHaveBeenCalled());
    expect(hints.getByText('0 of 3')).toBeTruthy();
    expect(hints.getByRole('button', { name: /Show a hint/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Reset', () => {
  it('explains what reset does to this environment, and does nothing until confirmed', async () => {
    await renderConnected();
    fireEvent.click(button('Reset'));

    const dialog = screen.getByRole('alertdialog', { name: 'Reset this lab?' });
    expect(within(dialog).getByText(/Files, running processes and shell history are lost/)).toBeTruthy();
    expect(within(dialog).getByText(/progress and any completion are kept/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(apiMock.resetLab).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resets, reconnects the terminal to the new container, and clears the old verdict', async () => {
    apiMock.checkSolution.mockResolvedValue(verification(false, { session: sessionInfo() }));
    apiMock.resetLab.mockResolvedValue({
      message: 'Lab reset successfully.',
      removed: ['container/lab-sbx-test'],
      restored: [],
      steps: [],
      environment: { environmentId: 'e', provider: 'docker-linux', phase: 'ready', namespace: '' },
      session: sessionInfo(),
      clearTerminal: true,
      reconnectTerminal: true,
    });
    await renderConnected();
    fireEvent.click(button('Verify'));
    await screen.findByText(/Not complete yet/);

    fireEvent.click(button('Reset'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset lab' }));

    expect(await screen.findByText('Your environment was reset to its starting state.')).toBeTruthy();
    expect(apiMock.resetLab).toHaveBeenCalledWith(SESSION_ID);
    expect(screen.getByTestId('terminal').getAttribute('data-connect-key')).toBe('1');
    expect(screen.queryByText(/Not complete yet/)).toBeNull();
    expect(screen.getByText(/Not verified yet/)).toBeTruthy();
  });

  it('while the reset runs, the old shell dying reads as the reset, not as "The shell exited."', async () => {
    let answer: (value: unknown) => void = () => undefined;
    apiMock.resetLab.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await renderConnected();

    fireEvent.click(button('Reset'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset lab' }));
    // Measured: the container is removed about a second into the reset and the
    // service closes the socket with `exit 137` long before the reset answers.
    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'SHELL_EXITED' }));

    expect(await screen.findByText('Terminal: Resetting your environment…')).toBeTruthy();
    expect(screen.queryByText('Terminal: The shell exited.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();

    await act(async () => {
      answer({
        message: 'Lab reset successfully.',
        removed: [],
        restored: [],
        steps: [],
        environment: { environmentId: 'e', provider: 'docker-linux', phase: 'ready', namespace: '' },
        session: sessionInfo(),
        clearTerminal: true,
        reconnectTerminal: true,
      });
    });
    expect(await screen.findByText('Terminal: Connected')).toBeTruthy();
  });

  it('shows a failed reset as an environment that needs another reset — with only Reset and End offered', async () => {
    apiMock.resetLab.mockRejectedValue(
      new ApiRequestError(503, {
        code: 'SESSION_RESET_FAILED',
        message: 'container did not start',
        details: { session: sessionInfo({ status: 'DEGRADED' }) },
      }),
    );
    await renderConnected();
    fireEvent.click(button('Reset'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset lab' }));

    expect(await screen.findByText('The reset did not finish')).toBeTruthy();
    expect(screen.getByText('Your environment needs a reset')).toBeTruthy();
    expect(button('Verify').disabled).toBe(true);
    expect(button('Reset').disabled).toBe(false);
    expect(button('End lab').disabled).toBe(false);
  });
});

describe('End lab', () => {
  it('requires confirmation, then shows the outcome with no terminal and no controls', async () => {
    apiMock.endLab.mockResolvedValue({
      message: 'Lab environment released.',
      session: sessionInfo({ status: 'ENDED', endedAt: new Date().toISOString() }),
      attempt: attemptSummary({ status: 'ENDED' }),
      steps: [],
    });
    await renderConnected();

    fireEvent.click(button('End lab'));
    const dialog = screen.getByRole('alertdialog', { name: 'End this lab?' });
    expect(within(dialog).getByText(/This cannot be undone/)).toBeTruthy();
    expect(apiMock.endLab).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'End lab' }));

    expect(await screen.findByRole('heading', { name: 'Lab ended' })).toBeTruthy();
    expect(apiMock.endLab).toHaveBeenCalledWith(SESSION_ID);
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Lab actions' })).toBeNull();
    expect(screen.getByText(/not completed yet/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to labs' })).toBeTruthy();
  });

  it('shows an End that is still cleaning up as shutting down, not as failed, and offers no second End', async () => {
    apiMock.endLab.mockRejectedValue(
      new ApiRequestError(503, {
        code: 'DESTROY_FAILED',
        message: 'The lab environment is still shutting down.',
        details: { session: sessionInfo({ status: 'ENDING' }), steps: [] },
      }),
    );
    await renderConnected();
    fireEvent.click(button('End lab'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'End lab' }));

    expect(await screen.findByText('Your lab is still shutting down')).toBeTruthy();
    expect(screen.getByText('Shutting down your lab environment…')).toBeTruthy();
    expect(button('End lab').disabled).toBe(true);
    expect(button('Verify').disabled).toBe(true);
  });
});

describe('after the lab has ended', () => {
  async function endLab() {
    apiMock.endLab.mockResolvedValue({
      message: 'Lab environment released.',
      session: sessionInfo({ status: 'ENDED' }),
      steps: [],
    });
    await renderConnected();
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    fireEvent.click(button('End lab'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'End lab' }));
    await screen.findByRole('heading', { name: 'Lab ended' });
  }

  it('shows the new environment preparing when the student launches again — not the old summary', async () => {
    await endLab();
    let resolve!: (value: unknown) => void;
    apiMock.startLab.mockReturnValue(new Promise((r) => (resolve = r)));
    apiMock.issueTerminal.mockResolvedValue({ session: sessionInfo({ sessionId: 'sess-0000000000000002' }), terminal: { url: 'ws://t', token: 'unused' } });

    fireEvent.click(screen.getByRole('button', { name: 'Launch a fresh environment' }));

    expect(await screen.findByText('Preparing your lab environment…')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Lab ended' })).toBeNull();
    expect(button('Verify').disabled).toBe(true);

    await act(async () =>
      resolve({
        session: sessionInfo({ sessionId: 'sess-0000000000000002' }),
        environment: { environmentId: 'e', provider: 'docker-linux', phase: 'ready', namespace: '' },
        steps: [],
        terminal: { url: 'ws://t', token: 'second-start' },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-token')).toBe('second-start'));
    expect(button('Verify').disabled).toBe(false);
  });

  it('after a completed lab, leads on to the learning path rather than back into the same lab', async () => {
    apiMock.endLab.mockResolvedValue({
      message: 'Lab environment released.',
      session: sessionInfo({ status: 'ENDED' }),
      attempt: attemptSummary({ status: 'PASSED' }),
      steps: [],
    });
    await renderConnected();
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    fireEvent.click(button('End lab'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'End lab' }));
    await screen.findByRole('heading', { name: 'Lab ended' });

    const next = screen.getByRole('link', { name: 'Continue the learning path' });
    expect(next.getAttribute('href')).toBe('#/paths/devops-engineer');
    expect(next.className).toMatch(/btn--primary/);
    expect(screen.getByRole('button', { name: 'Launch again' }).className).not.toMatch(/btn--primary/);
  });

  async function passAndEnd() {
    apiMock.endLab.mockResolvedValue({
      message: 'Lab environment released.',
      session: sessionInfo({ status: 'ENDED' }),
      attempt: attemptSummary({ status: 'PASSED' }),
      steps: [],
    });
    await renderConnected();
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    fireEvent.click(button('End lab'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'End lab' }));
    await screen.findByRole('heading', { name: 'Lab ended' });
  }

  it('after a completed lab, names the next lab from the learning path and links straight to it', async () => {
    apiMock.getLearningPathProgress.mockResolvedValue(
      learningPathProgress({ 'LINUX-001': 'COMPLETED' }, {
        kind: 'NEXT_IN_STAGE',
        labId: 'LINUX-002',
        labTitle: 'Permissions',
        reason: 'LINUX-002 is the next lab in Linux.',
      }),
    );
    await passAndEnd();

    expect(await screen.findByRole('heading', { name: 'Next recommended lab' })).toBeTruthy();
    expect(screen.getByText('LINUX-002 is the next lab in Linux.')).toBeTruthy();
    const next = screen.getByRole('link', { name: /Continue learning.*LINUX-002/ });
    expect(next.getAttribute('href')).toBe('#/labs/LINUX-002');
    expect(next.className).toMatch(/btn--primary/);
    // The path is still one click away, but it is no longer the main action.
    expect(screen.getByRole('link', { name: 'Continue the learning path' }).className).not.toMatch(/btn--primary/);
    // Read after End, so the finished lab is counted.
    expect(apiMock.getLearningPathProgress).toHaveBeenCalledWith('devops-engineer');
  });

  it('after a completed lab, offers only the path when the path does not name a lab to open', async () => {
    // The end has not finished yet, so the student still counts as running a lab.
    apiMock.getLearningPathProgress.mockResolvedValue(
      learningPathProgress({ 'LINUX-001': 'COMPLETED' }, {
        kind: 'RESUME_ACTIVE',
        labId: 'LINUX-001',
        labTitle: 'Files and Directories',
        reason: 'You have a lab running.',
      }),
    );
    await passAndEnd();
    await waitFor(() => expect(apiMock.getLearningPathProgress).toHaveBeenCalled());

    expect(screen.queryByRole('heading', { name: 'Next recommended lab' })).toBeNull();
    expect(screen.queryByText('You have a lab running.')).toBeNull();
    expect(screen.getByRole('link', { name: 'Continue the learning path' }).className).toMatch(/btn--primary/);
  });

  it('does not suggest a next lab for a lab that was not completed', async () => {
    await endLab();
    expect(apiMock.getLearningPathProgress).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Next recommended lab' })).toBeNull();
  });

  it('explains a relaunch the platform refused, on the summary', async () => {
    await endLab();
    apiMock.startLab.mockRejectedValue(
      new ApiRequestError(503, { code: 'LAB_CAPACITY_REACHED', message: 'All 5 practice environments are currently in use.' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Launch a fresh environment' }));

    expect(await screen.findByText('All lab environments are in use')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lab ended' })).toBeTruthy();
  });
});

/*
 * Late answers. Found by an independent review of this page and reproduced
 * before the fixes; each test is the student's sequence.
 */
describe('answers that arrive late', () => {
  it('a Verify that answers after End does not bring the ended lab back', async () => {
    let answerCheck!: (value: unknown) => void;
    apiMock.checkSolution.mockReturnValue(new Promise((resolve) => (answerCheck = resolve)));
    apiMock.endLab.mockResolvedValue({ message: 'ok', session: sessionInfo({ status: 'ENDED' }), steps: [] });
    await renderConnected();

    fireEvent.click(button('Verify'));
    fireEvent.click(button('End lab'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'End lab' }));
    await screen.findByRole('heading', { name: 'Lab ended' });

    // The check answers with the session as the API read it before checking: ACTIVE.
    apiMock.getSession.mockResolvedValue({ session: sessionInfo({ status: 'ENDED' }), environment: null });
    await act(async () =>
      answerCheck(
        verification(true, {
          session: sessionInfo(),
          attempt: attemptSummary({ status: 'PASSED', completedAt: '2026-09-14T10:30:00Z' }),
          newlyCompleted: true,
        }),
      ),
    );

    expect(screen.getByRole('heading', { name: 'Lab ended' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Lab actions' })).toBeNull();
    expect(screen.queryByTestId('terminal')).toBeNull();
    // What the check did record is still worth knowing.
    expect(screen.getByText('You completed this lab. It is saved to your progress.')).toBeTruthy();
  });

  it('Verify clears an idle warning the check itself answered, instead of keeping the stale copy', async () => {
    const idle = sessionInfo({ idleWarning: true, secondsUntilIdle: 60 });
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([{ session: idle, labTitle: 'Files and Directories' }]));
    apiMock.getSession.mockResolvedValue({ session: idle, environment: null });
    await renderConnected();
    expect(await screen.findByText(/Are you still working/)).toBeTruthy();

    // The check counts as activity; its response still carries the copy read before it ran.
    apiMock.checkSolution.mockResolvedValue(verification(false, { session: idle }));
    apiMock.getSession.mockResolvedValue({ session: sessionInfo({ idleWarning: false }), environment: null });
    fireEvent.click(button('Verify'));
    await screen.findByText(/Not complete yet/);

    await waitFor(() => expect(screen.queryByText(/Are you still working/)).toBeNull());
  });

  it('a lab launched again starts with no verdict and no hints from the attempt before', async () => {
    apiMock.getLab.mockImplementation((id: string) =>
      Promise.resolve(
        labDetail({ id, hints: [{ level: 1, text: 'N1' }, { level: 2, text: 'N2' }, { level: 3, text: 'N3' }] }),
      ),
    );
    apiMock.getAttempt.mockImplementation((id: string) =>
      Promise.resolve({
        student: { studentId: 's', displayName: 'S' },
        attempt: {
          ...attemptSummary({ attemptId: id }),
          hints: id === 'attempt-1' ? [{ level: 1, revealedAt: 'x' }, { level: 2, revealedAt: 'x' }] : [],
          hintsUsed: id === 'attempt-1' ? 2 : 0,
        },
      }),
    );
    apiMock.checkSolution.mockResolvedValue(verification(true, { attempt: attemptSummary({ status: 'PASSED' }), newlyCompleted: true }));
    apiMock.endLab.mockResolvedValue({
      message: 'ok',
      session: sessionInfo({ status: 'ENDED' }),
      attempt: attemptSummary({ status: 'PASSED' }),
      steps: [],
    });
    await renderConnected();
    await within(screen.getByRole('region', { name: 'Hints' })).findByText('Hint 2');
    fireEvent.click(button('Verify'));
    await screen.findByText('Lab passed — every check passes');
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    fireEvent.click(button('End lab'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'End lab' }));
    await screen.findByRole('heading', { name: 'Lab ended' });

    let answerStart!: (value: unknown) => void;
    apiMock.startLab.mockReturnValue(new Promise((resolve) => (answerStart = resolve)));
    fireEvent.click(screen.getByRole('button', { name: 'Launch again' }));
    await screen.findByText('Preparing your lab environment…');
    expect(screen.queryByText('Lab passed — every check passes')).toBeNull();

    await act(async () =>
      answerStart({
        session: sessionInfo({ sessionId: 'sess-0000000000000002' }),
        attempt: attemptSummary({ attemptId: 'attempt-2' }),
        environment: { environmentId: 'e', provider: 'docker-linux', phase: 'ready', namespace: '' },
        steps: [],
        terminal: { url: 'ws://t', token: 'second' },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-token')).toBe('second'));
    await waitFor(() => expect(apiMock.getAttempt).toHaveBeenCalledWith('attempt-2'));
    const hints = within(screen.getByRole('region', { name: 'Hints' }));
    await waitFor(() => expect(hints.getByText('0 of 3')).toBeTruthy());
    expect(hints.queryByText('Hint 1')).toBeNull();
  }, 20_000);

  it('closes an End dialog left open when the lab expires, so it cannot send a refused request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderConnected();
    fireEvent.click(button('End lab'));
    expect(screen.getByRole('alertdialog', { name: 'End this lab?' })).toBeTruthy();

    apiMock.getSession.mockResolvedValue({ session: sessionInfo({ status: 'EXPIRED' }), environment: null });
    await act(() => vi.advanceTimersByTimeAsync(15_100));
    await screen.findByRole('heading', { name: 'Your lab environment expired' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(apiMock.endLab).not.toHaveBeenCalled();
  });

  it('closes a Reset dialog left open when the lab starts shutting down', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderConnected();
    fireEvent.click(button('Reset'));
    expect(screen.getByRole('alertdialog', { name: 'Reset this lab?' })).toBeTruthy();

    apiMock.getSession.mockResolvedValue({ session: sessionInfo({ status: 'EXPIRING' }), environment: null });
    await act(() => vi.advanceTimersByTimeAsync(15_100));
    await screen.findByText('Time is up — removing your environment…');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(apiMock.resetLab).not.toHaveBeenCalled();
  });
});

describe('when the session list cannot be read', () => {
  it('says so, instead of claiming the lab is not running', async () => {
    apiMock.listMySessions.mockRejectedValueOnce(new ApiRequestError(0, { code: 'API_UNREACHABLE', message: 'x' }));
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);

    expect(await screen.findByRole('heading', { level: 1, name: 'We could not check whether this lab is running' })).toBeTruthy();
    expect(screen.queryByText(/is not running/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Terminal: Connected');
  });
});

describe('the terminal connection', () => {
  it('offers Reconnect after the shell exits, with a fresh token', async () => {
    await renderConnected();
    apiMock.issueTerminal.mockResolvedValue({ session: sessionInfo(), terminal: { url: 'ws://terminal', token: 'second-token' } });

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'SHELL_EXITED' }));
    expect(screen.getByText('Terminal: The shell exited.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-token')).toBe('second-token'));
    expect(apiMock.issueTerminal).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Terminal: Connected')).toBeTruthy();
  });

  it('does not retry a terminal whose lab has ended — it re-reads the session instead', async () => {
    await renderConnected();
    apiMock.getSession.mockResolvedValue({ session: sessionInfo({ status: 'ENDED' }), environment: null });

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'SESSION_ENDED' }));

    expect(await screen.findByRole('heading', { name: 'Lab ended' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(apiMock.issueTerminal).toHaveBeenCalledTimes(1);
  });

  it('offers Reconnect when another tab takes the terminal over, instead of claiming the lab ended', async () => {
    await renderConnected();
    const reads = apiMock.getSession.mock.calls.length;

    // What the terminal service sends the older socket when a second one attaches.
    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'SESSION_ENDED' }));

    await waitFor(() => expect(apiMock.getSession.mock.calls.length).toBeGreaterThan(reads));
    expect(await screen.findByText('Terminal: Disconnected — this terminal was opened in another tab or window.')).toBeTruthy();
    expect(screen.queryByText(/this lab has ended/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Lab ended' })).toBeNull();
    expect(button('Verify').disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(apiMock.issueTerminal).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Terminal: Connected')).toBeTruthy();
  });

  it('forgets a session that no longer exists, app-wide, so nothing keeps pointing at it', async () => {
    await renderConnected();
    const listReads = apiMock.listMySessions.mock.calls.length;
    apiMock.getSession.mockRejectedValue(new ApiRequestError(404, { code: 'SESSION_NOT_FOUND', message: 'No such lab session.' }));
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'SESSION_ENDED' }));

    expect(await screen.findByRole('heading', { name: 'This lab environment no longer exists' })).toBeTruthy();
    await waitFor(() => expect(apiMock.listMySessions.mock.calls.length).toBeGreaterThan(listReads));
  });

  it('re-reads the session as soon as it is adopted, so a stale list cannot show a stale countdown or hide the idle warning', async () => {
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ secondsRemaining: 3600 }), labTitle: 'Files and Directories' }]),
    );
    apiMock.getSession.mockResolvedValue({
      session: sessionInfo({ secondsRemaining: 600, idleWarning: true, secondsUntilIdle: 100 }),
      environment: null,
    });
    await renderConnected();

    expect(await screen.findByText(/Are you still working/)).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toMatch(/^(10:00|09:5\d)$/);
  });

  it('leaves no automatic reconnect pending when the page goes away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = renderWithProviders(<WorkspacePage labId="LINUX-001" />);
    await screen.findByText('Terminal: Connected');

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'CONNECTION_LOST' }));
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rides out a terminal restart: retries a dropped or broker-refused terminal for about a minute, then asks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    terminal.autoConnect = false;
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);
    await screen.findByText('Connecting to your terminal…');
    // The status line can render before the terminal component has mounted.
    await waitFor(() => expect(terminal.last).not.toBeNull());
    const key = () => Number(screen.getByTestId('terminal').getAttribute('data-connect-key'));

    // Each attempt is refused while the service is down, with a mix of codes a restart produces.
    const codes = ['CONNECTION_LOST', 'BROKER_UNREACHABLE', 'CONNECTION_LOST', 'CREDENTIALS_UNAVAILABLE', 'PTY_SPAWN_FAILED', 'CONNECTION_LOST'];
    for (const [i, code] of codes.entries()) {
      const before = key();
      act(() => terminal.last!.onEvent({ status: 'disconnected', code }));
      await act(() => vi.advanceTimersByTimeAsync(AUTO_RECONNECTS[i]! + 50));
      expect(key(), `attempt ${i + 1} after ${code}`).toBe(before + 1);
    }
    // Out of automatic attempts: the next drop waits for the student.
    const before = key();
    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'CONNECTION_LOST' }));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(key()).toBe(before);
    expect(AUTO_RECONNECTS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(45_000);
  });

  /*
   * A drop schedules an automatic reconnect, up to 25 s out. A student who
   * presses Reconnect meanwhile gets a working shell — and the pending timer
   * used to fire later anyway, bump the connection and replace that shell with
   * a new one: whatever they had typed, their working directory, a running
   * command, gone.
   */
  it('cancels a pending automatic reconnect once the student reconnects by hand', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderConnected();
    const key = () => Number(screen.getByTestId('terminal').getAttribute('data-connect-key'));

    // Five drops in a row: the next automatic attempt is 25 s away.
    for (let i = 0; i < 4; i += 1) {
      act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'CONNECTION_LOST' }));
      await act(() => vi.advanceTimersByTimeAsync(AUTO_RECONNECTS[i]! + 50));
    }
    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'CONNECTION_LOST' }));

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(screen.getByText('Terminal: Connected')).toBeTruthy());
    const working = key();

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(key()).toBe(working);
    expect(screen.getByText('Terminal: Connected')).toBeTruthy();
  });

  it('cancels a pending automatic reconnect when a connection succeeds some other way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderConnected();
    const key = () => Number(screen.getByTestId('terminal').getAttribute('data-connect-key'));

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'CONNECTION_LOST' }));
    // The terminal reports connected before the retry fires (a reset's reconnect, a reattach).
    act(() => terminal.last!.onEvent({ status: 'connected' }));
    const working = key();

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(key()).toBe(working);
  });

  it('never retries a sandbox mismatch; it re-reads the session instead', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderConnected();
    const before = Number(screen.getByTestId('terminal').getAttribute('data-connect-key'));
    const reads = apiMock.getSession.mock.calls.length;

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'SANDBOX_REF_MISMATCH' }));
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(Number(screen.getByTestId('terminal').getAttribute('data-connect-key'))).toBe(before);
    expect(apiMock.getSession.mock.calls.length).toBeGreaterThan(reads);
  });

  it('mints one new token when the old one is refused', async () => {
    await renderConnected();
    apiMock.issueTerminal.mockResolvedValue({ session: sessionInfo(), terminal: { url: 'ws://terminal', token: 'renewed' } });

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'UNAUTHORIZED' }));

    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-token')).toBe('renewed'));
    expect(apiMock.issueTerminal).toHaveBeenCalledTimes(2);
  });

  it('says it is trying again, rather than asking, while an automatic retry is on its way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    terminal.autoConnect = false;
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);
    await screen.findByText('Connecting to your terminal…');
    await waitFor(() => expect(terminal.last).not.toBeNull());

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'CONNECTION_LOST' }));
    expect(screen.getByText('Connecting to your terminal…')).toBeTruthy();
    expect(screen.getByText('The connection did not get through. Trying again…')).toBeTruthy();
    expect(screen.queryByText('The terminal could not connect')).toBeNull();
    expect(screen.getByText(/Terminal: Connection to the terminal was lost\. Reconnecting…/)).toBeTruthy();

    // Once the automatic attempts are spent, the student is asked.
    for (const delay of AUTO_RECONNECTS) {
      await act(() => vi.advanceTimersByTimeAsync(delay + 50));
      act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'CONNECTION_LOST' }));
    }
    expect(screen.getByText('The terminal could not connect')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(/Reconnecting…/)).toBeNull();
  });

  it('explains a terminal that never connected, and lets the student try again', async () => {
    terminal.autoConnect = false;
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);
    await screen.findByText('Connecting to your terminal…');

    act(() => terminal.last!.onEvent({ status: 'disconnected', code: 'CAPACITY' }));
    expect(screen.getByText('The terminal could not connect')).toBeTruthy();
    expect(screen.getByText('The terminal service is busy right now.', { selector: '.overlay__text' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(apiMock.issueTerminal).toHaveBeenCalledTimes(2));
  });
});

describe('inactivity', () => {
  it('warns before an idle environment is removed, and Stay active records activity', async () => {
    const idle = sessionInfo({ idleWarning: true, secondsUntilIdle: 150 });
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([{ session: idle, labTitle: 'Files and Directories' }]));
    apiMock.getSession.mockResolvedValue({ session: idle, environment: null });
    apiMock.recordActivity.mockResolvedValue({ session: sessionInfo({ idleWarning: false }) });
    await renderConnected();

    expect(screen.getByText(/removed in about 3 minutes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay active' }));

    await waitFor(() => expect(screen.queryByText(/Are you still working/)).toBeNull());
    expect(apiMock.recordActivity).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe('the time limit', () => {
  /*
   * The api sends `secondsRemaining: 0` for every status but ACTIVE and
   * RESETTING (SessionManager.view). The page counted that as time running out:
   * a lab that still had most of its hour showed "Time is up … being removed"
   * and a red 00:00 while it was being prepared, needed a reset, or was ending.
   */
  it.each(['CREATING', 'DEGRADED', 'ENDING'] as const)(
    'does not say time is up for a %s lab that still has time',
    async (status) => {
      const session = sessionInfo({ status, secondsRemaining: 0, secondsUntilIdle: 0 });
      apiMock.listMySessions.mockResolvedValue(sessionsResponse([{ session, labTitle: 'Files and Directories' }]));
      apiMock.getSession.mockResolvedValue({ session, environment: null });
      renderWithProviders(<WorkspacePage labId="LINUX-001" />);
      await waitFor(() => expect(apiMock.getSession).toHaveBeenCalled());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      });

      expect(screen.queryByText(/Time is up/)).toBeNull();
      expect(screen.queryByText('00:00')).toBeNull();
    },
  );

  it('warns once, in words, when five minutes are left, and says to verify now', async () => {
    const session = sessionInfo({ secondsRemaining: 240 });
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([{ session, labTitle: 'Files and Directories' }]));
    apiMock.getSession.mockResolvedValue({ session, environment: null });
    await renderConnected();

    const heading = await screen.findByText(/minutes left in this lab/);
    const banner = heading.closest('[role="status"]');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toMatch(/Press Verify now/);
  });

  it('does not warn while plenty of time is left', async () => {
    await renderConnected();
    expect(screen.queryByText(/minutes left in this lab/)).toBeNull();
  });

  it('still says time is up when an active lab reaches its limit', async () => {
    const session = sessionInfo({ secondsRemaining: 1 });
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([{ session, labTitle: 'Files and Directories' }]));
    apiMock.getSession.mockResolvedValue({ session, environment: null });
    await renderConnected();

    expect(await screen.findByText(/Time is up/, undefined, { timeout: 5_000 })).toBeTruthy();
  });
});

describe('a lab the platform removed', () => {
  /*
   * The reaper removes an idle lab through the same EXPIRING → EXPIRED path as
   * the time limit, with statusReason "idle for more than 1200s". The page read
   * only the status and told a student who had stepped away for twenty minutes
   * of a sixty-minute lab that its time ran out.
   */
  async function renderRemoved(statusReason: string) {
    apiMock.getSession.mockResolvedValue({
      session: sessionInfo({ status: 'EXPIRED', statusReason, secondsRemaining: 0 }),
      environment: null,
    });
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);
  }

  it('says a lab removed for inactivity was removed for inactivity', async () => {
    await renderRemoved('idle for more than 1200s');
    expect(await screen.findByRole('heading', { name: 'Your lab environment was removed after inactivity' })).toBeTruthy();
    expect(screen.queryByText(/time ran out/)).toBeNull();
  });

  it('does not say "Time is up" while a lab is being removed for inactivity', async () => {
    apiMock.getSession.mockResolvedValue({
      session: sessionInfo({ status: 'EXPIRING', statusReason: 'idle for more than 1200s', secondsRemaining: 0 }),
      environment: null,
    });
    renderWithProviders(<WorkspacePage labId="LINUX-001" />);
    expect(await screen.findByText('Removing your environment after inactivity…')).toBeTruthy();
    expect(screen.queryByText(/Time is up/)).toBeNull();
  });

  it('still says a lab that reached its time limit expired', async () => {
    await renderRemoved('absolute session lifetime reached');
    expect(await screen.findByRole('heading', { name: 'Your lab environment expired' })).toBeTruthy();
  });
});
