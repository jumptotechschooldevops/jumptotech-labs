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
