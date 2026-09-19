/**
 * A refused launch is an answer about that moment, not about the lab.
 *
 * The refusal used to live in the app until the next launch. A student refused
 * with "You already have a lab running", who then ended that lab and came back,
 * was still told they had a lab running; one refused for capacity saw the same
 * "all environments are in use" alert, as if new, twenty minutes later.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { TerminalEvent } from '../src/components/LabTerminal';
import type { TerminalGrant } from '../src/lib/types';
import { ApiRequestError } from '../src/lib/api';
import { go, renderApp } from './routed-app';
import { apiMock, labDetail, resetApiMock, sessionInfo, sessionsResponse } from './api-mock';

vi.mock('../src/components/LabTerminal', async () => {
  const React = await import('react');
  const LabTerminal = React.forwardRef(function FakeTerminal(
    props: { grant: TerminalGrant | null; onEvent: (event: TerminalEvent) => void },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({ clear: () => undefined, focus: () => undefined, writeNotice: () => undefined }));
    return React.createElement('div', { 'data-testid': 'terminal' });
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
    Promise.resolve(labDetail({ id, title: id === 'LINUX-002' ? 'Permissions' : 'Files and Directories' })),
  );
});

async function launchFromLabPage(labId: string) {
  act(() => go(`#/labs/${labId}`));
  const launch = await screen.findByRole('button', { name: 'Launch lab' });
  await waitFor(() => expect(apiMock.listMySessions).toHaveBeenCalled());
  fireEvent.click(launch);
}

describe('a refused launch', () => {
  it('is not repeated as "you already have a lab running" once that lab has ended', async () => {
    renderApp('#/');
    await screen.findByRole('heading', { level: 1, name: 'Welcome, Test Student' });

    // Another tab started LINUX-001 after this one read the session list.
    apiMock.startLab.mockRejectedValue(
      new ApiRequestError(429, {
        code: 'STUDENT_SESSION_LIMIT_REACHED',
        message: 'You already have a practice environment running.',
        details: { activeSessions: 1, maxActiveSessionsPerStudent: 1 },
      }),
    );
    await launchFromLabPage('LINUX-002');
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ labId: 'LINUX-001' }), labTitle: 'Files and Directories' }], 1),
    );
    expect(await screen.findByRole('heading', { name: 'You already have a lab running' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Continue LINUX-001' })).toBeTruthy();

    // The student ends LINUX-001 (elsewhere), then comes back to LINUX-002.
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([], 1));
    act(() => go('#/'));
    await screen.findByRole('heading', { level: 1, name: /Welcome/ });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => go('#/labs/LINUX-002'));
    await screen.findByRole('heading', { level: 1, name: 'Permissions' });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Launch lab' })).toBeTruthy());
    expect(screen.queryByText('You already have a lab running')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try launching again' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  }, 20_000);

  it('is not shown again as a new capacity alert after the student has moved on', async () => {
    renderApp('#/');
    await screen.findByRole('heading', { level: 1, name: 'Welcome, Test Student' });
    apiMock.startLab.mockRejectedValue(
      new ApiRequestError(503, { code: 'LAB_CAPACITY_REACHED', message: 'All 5 practice environments are currently in use.' }),
    );
    await launchFromLabPage('LINUX-001');
    expect(await screen.findByText('All lab environments are in use')).toBeTruthy();

    act(() => go('#/progress'));
    await screen.findByRole('heading', { level: 1, name: 'Your progress' });
    act(() => go('#/labs/LINUX-001/workspace'));
    await screen.findByRole('heading', { level: 1, name: /LINUX-001 is not running/ });
    expect(screen.queryByText('All lab environments are in use')).toBeNull();

    act(() => go('#/labs/LINUX-001'));
    await screen.findByRole('button', { name: 'Launch lab' });
    expect(screen.queryByText('All lab environments are in use')).toBeNull();
  }, 20_000);
});
