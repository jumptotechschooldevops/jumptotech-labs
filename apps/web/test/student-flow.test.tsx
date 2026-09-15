/**
 * Student beta experience — one student, start to finish, through the routed app.
 *
 * Dashboard → catalog → lab page → Launch → workspace → Verify (fail) → Reset →
 * Verify (pass) → End → dashboard. The API is stubbed and the terminal emulator
 * is a stand-in; everything between them is the shipped application. This is
 * the jsdom half of the E2E story: it runs on every `npm test`, and the real
 * browser against a real stack is the documented release smoke in
 * docs/student-experience.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { TerminalEvent } from '../src/components/LabTerminal';
import type { TerminalGrant } from '../src/lib/types';
import { go, renderApp } from './routed-app';
import {
  apiMock,
  attemptSummary,
  progressSnapshot,
  resetApiMock,
  sessionInfo,
  sessionsResponse,
  verification,
} from './api-mock';

vi.mock('../src/components/LabTerminal', async () => {
  const React = await import('react');
  const LabTerminal = React.forwardRef(function FakeTerminal(
    props: { grant: TerminalGrant | null; connectKey?: number; onEvent: (event: TerminalEvent) => void },
    ref: React.Ref<unknown>,
  ) {
    const { grant, connectKey = 0, onEvent } = props;
    React.useImperativeHandle(ref, () => ({ clear: () => undefined, focus: () => undefined, writeNotice: () => undefined }));
    React.useEffect(() => {
      if (!grant) {
        onEvent({ status: 'idle' });
        return;
      }
      onEvent({ status: 'connecting' });
      onEvent({ status: 'connected' });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [grant?.token, connectKey]);
    return React.createElement('div', { 'data-testid': 'terminal', 'data-token': grant?.token ?? '' });
  });
  return { LabTerminal };
});

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

beforeEach(() => {
  resetApiMock();
});

describe('a student’s first lab', () => {
  it('goes from the dashboard to a completed lab and back, without a dead end', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderApp('#/');
    await screen.findByRole('heading', { level: 1, name: 'Welcome, Test Student' });

    // Catalog: find the lab.
    act(() => go('#/labs'));
    await screen.findByRole('heading', { level: 1, name: 'Lab catalog' });
    await waitFor(() => expect(screen.getAllByRole('article').length).toBe(3));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'files' } });
    const view = screen.getByRole('link', { name: /^View lab\s*: Files and Directories$/ });

    // Lab page: read, then Launch.
    act(() => go(view.getAttribute('href')!));
    await screen.findByRole('heading', { level: 1, name: 'Files and Directories' });
    apiMock.startLab.mockResolvedValue({
      session: sessionInfo(),
      attempt: attemptSummary(),
      environment: { environmentId: 'e', provider: 'docker-linux', phase: 'ready', namespace: '' },
      steps: [{ id: 'environment-created', label: 'Environment created', status: 'ok' }],
      terminal: { url: 'ws://terminal', token: 'start-token' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Launch lab' }));
    act(() => window.dispatchEvent(new HashChangeEvent('hashchange')));

    // Workspace: the terminal is attached with the token Start returned.
    await screen.findByText('Terminal: Connected');
    expect(screen.getByTestId('terminal').getAttribute('data-token')).toBe('start-token');
    expect(apiMock.issueTerminal).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Active lab\s*LINUX-001/ })).toBeTruthy();
    const actions = () => within(screen.getByRole('group', { name: 'Lab actions' }));

    // Verify: not yet.
    apiMock.checkSolution.mockResolvedValueOnce(verification(false, { session: sessionInfo() }));
    fireEvent.click(actions().getByRole('button', { name: 'Verify' }));
    await screen.findByText('Not complete yet — 1 of 2 checks passing');

    // Reset, confirmed.
    apiMock.resetLab.mockResolvedValue({
      message: 'Lab reset successfully.',
      removed: [],
      restored: [],
      steps: [],
      environment: { environmentId: 'e', provider: 'docker-linux', phase: 'ready', namespace: '' },
      session: sessionInfo(),
      attempt: attemptSummary({ resetCount: 1 }),
      clearTerminal: true,
      reconnectTerminal: true,
    });
    fireEvent.click(actions().getByRole('button', { name: 'Reset' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset lab' }));
    await screen.findByText('Your environment was reset to its starting state.');

    // Verify: passed, and saved.
    apiMock.getProgress.mockResolvedValue(progressSnapshot({ 'LINUX-001': 'COMPLETED' }));
    apiMock.checkSolution.mockResolvedValueOnce(
      verification(true, { session: sessionInfo(), attempt: attemptSummary({ status: 'PASSED' }), newlyCompleted: true }),
    );
    fireEvent.click(actions().getByRole('button', { name: 'Verify' }));
    await screen.findByText('Lab passed — every check passes');

    // End, confirmed.
    apiMock.endLab.mockResolvedValue({
      message: 'Lab environment released.',
      session: sessionInfo({ status: 'ENDED' }),
      attempt: attemptSummary({ status: 'PASSED' }),
      steps: [],
    });
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    fireEvent.click(actions().getByRole('button', { name: 'End lab' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'End lab' }));
    await screen.findByRole('heading', { name: 'Lab ended' });
    expect(screen.getByText(/You completed this lab/)).toBeTruthy();
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.queryByRole('link', { name: /Active lab/ })).toBeNull();

    // Back on the dashboard: nothing running, one lab completed.
    act(() => go('#/'));
    await screen.findByRole('heading', { level: 1, name: /Welcome/ });
    await waitFor(() => expect(screen.getByText('of 3 labs completed')).toBeTruthy());
    expect(screen.getByText('1', { selector: '.stat__value' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'You have a lab running' })).toBeNull();

    expect(apiMock.startLab).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
  });
});
