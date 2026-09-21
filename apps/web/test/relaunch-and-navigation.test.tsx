/**
 * The routed app across a launch and across navigation.
 *
 *   - a hint cannot be revealed before the lab's attempt exists, so none is
 *     read and then lost when the new attempt's panel replaces it
 *   - the student's running-lab list is re-read on navigation, so a lab the
 *     platform removed does not keep "you already have a lab running" — and no
 *     Launch — on every other lab's page
 *
 * Both reproduced against the app before they were fixed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { TerminalEvent } from '../src/components/LabTerminal';
import type { TerminalGrant } from '../src/lib/types';
import { go, renderApp } from './routed-app';
import { apiMock, attemptSummary, labDetail, resetApiMock, sessionInfo, sessionsResponse } from './api-mock';

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
  apiMock.getLab.mockImplementation((id: string) =>
    Promise.resolve(
      labDetail({
        id,
        title: id === 'LINUX-002' ? 'Permissions' : 'Files and Directories',
        hints: [{ level: 1, text: 'N1' }, { level: 2, text: 'N2' }],
      }),
    ),
  );
  apiMock.getAttempt.mockImplementation((id: string) =>
    Promise.resolve({ student: { studentId: 's' }, attempt: { ...attemptSummary({ attemptId: id }), hints: [], hintsUsed: 0 } }),
  );
});

describe('a first launch', () => {
  it('shows hints only once the environment — and its attempt — exist', async () => {
    renderApp('#/labs/LINUX-001');
    const launch = await screen.findByRole('button', { name: 'Launch lab' });
    await waitFor(() => expect(apiMock.listMySessions).toHaveBeenCalled());
    let answerStart!: (value: unknown) => void;
    apiMock.startLab.mockReturnValue(new Promise((resolve) => (answerStart = resolve)));
    fireEvent.click(launch);
    await screen.findByText('Preparing your lab environment…', undefined, { timeout: 5000 });
    expect(screen.queryByRole('region', { name: 'Hints' })).toBeNull();

    await act(async () =>
      answerStart({
        session: sessionInfo(),
        attempt: attemptSummary({ attemptId: 'attempt-1' }),
        environment: { environmentId: 'e', provider: 'docker-linux', phase: 'ready', namespace: '' },
        steps: [],
        terminal: { url: 'ws://t', token: 'tkn' },
      }),
    );
    await screen.findByText('Terminal: Connected');
    const hints = within(await screen.findByRole('region', { name: 'Hints' }));
    fireEvent.click(hints.getByRole('button', { name: /Show a hint/ }));
    expect(hints.getByText('N1')).toBeTruthy();
    await waitFor(() => expect(apiMock.recordHint).toHaveBeenCalledWith('sess-0000000000000001', 1));
  });
});

describe('the running-lab list', () => {
  it('is re-read on navigation, so a lab the platform removed stops blocking Launch', async () => {
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([{ session: sessionInfo(), labTitle: 'Files and Directories' }]));
    renderApp('#/');
    await screen.findByRole('heading', { name: 'You have a lab running' });

    // The idle reaper removes LINUX-001 while the student reads other pages.
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    act(() => go('#/labs/LINUX-002'));
    await screen.findByRole('heading', { level: 1, name: 'Permissions' });
    expect(await screen.findByRole('button', { name: 'Launch lab' })).toBeTruthy();
    expect(screen.queryByText('You already have a lab running')).toBeNull();
  });
});
