/**
 * A workspace the student is not looking at costs the platform nothing.
 *
 * The page polls `GET /api/sessions/:id` every 15 s while the lab is steady and
 * every 3 s while it is transitional. Each poll is not a row read: the handler
 * asks the provider for live environment status, which is a `docker inspect`
 * through the runtime broker for a container lab, and a `ping` + `version` +
 * `listNodes` + `getNamespace` round trip for a Kubernetes one.
 *
 * The rate is therefore per *open tab*, not per student: a workspace left open
 * in a background tab, a second tab on the same lab, or yesterday's tab still
 * open on a laptop lid, each pay the full rate for as long as they exist. Four
 * requests a minute is nothing for one student and is the difference between
 * 7 and 27 runtime inspections a second across a hundred of them — work done
 * for a screen nobody is looking at.
 *
 * Invariant: a hidden tab issues no polls, and a tab that comes back issues one
 * straight away rather than waiting out the interval. Polling has never counted
 * as activity (the server does not stamp it), so nothing about a lab's lifetime
 * changes either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { WorkspacePage } from '../src/pages/WorkspacePage';
import type { TerminalEvent } from '../src/components/LabTerminal';
import type { TerminalGrant } from '../src/lib/types';
import { renderWithProviders } from './app-harness';
import { apiMock, attemptSummary, resetApiMock, sessionInfo, sessionsResponse } from './api-mock';

const terminal = vi.hoisted(() => ({
  last: null as null | { grant: TerminalGrant | null; connectKey: number; onEvent: (event: TerminalEvent) => void },
}));

vi.mock('../src/components/LabTerminal', async () => {
  const React = await import('react');
  const LabTerminal = React.forwardRef(function FakeTerminal(
    props: { grant: TerminalGrant | null; connectKey?: number; onEvent: (event: TerminalEvent) => void },
    ref: React.Ref<unknown>,
  ) {
    const { grant, connectKey = 0, onEvent } = props;
    React.useImperativeHandle(ref, () => ({
      clear: () => undefined,
      focus: () => undefined,
      writeNotice: () => undefined,
    }));
    React.useEffect(() => {
      terminal.last = { grant, connectKey, onEvent };
      if (!grant) {
        onEvent({ status: 'idle' });
        return;
      }
      onEvent({ status: 'connecting' });
      onEvent({ status: 'connected' });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [grant?.token, connectKey]);
    return React.createElement('div', { 'data-testid': 'terminal' });
  });
  return { LabTerminal };
});

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

let hidden = false;

function setVisibility(next: 'visible' | 'hidden'): void {
  hidden = next === 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  resetApiMock();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  apiMock.listMySessions.mockResolvedValue(
    sessionsResponse([{ session: sessionInfo(), labTitle: 'Files and Directories', attempt: attemptSummary() }]),
  );
  apiMock.issueTerminal.mockResolvedValue({
    session: sessionInfo(),
    terminal: { url: 'ws://terminal', token: 'fresh-token' },
  });
  apiMock.getSession.mockImplementation((id: string) =>
    Promise.resolve({ session: sessionInfo({ sessionId: id }), environment: null }),
  );
  window.history.replaceState(null, '', '/#/labs/LINUX-001/workspace');
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderConnected() {
  renderWithProviders(<WorkspacePage labId="LINUX-001" />);
  await screen.findByText('Terminal: Connected');
}

describe('a workspace tab nobody is looking at', () => {
  it('stops polling the session while the tab is hidden, and resumes at once when it comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderConnected();
    // Four steady intervals with the tab in front: the page keeps up to date.
    for (let i = 0; i < 4; i += 1) await act(() => vi.advanceTimersByTimeAsync(15_100));
    const whileWatched = apiMock.getSession.mock.calls.length;
    expect(whileWatched).toBeGreaterThanOrEqual(4);

    await act(async () => setVisibility('hidden'));
    for (let i = 0; i < 40; i += 1) await act(() => vi.advanceTimersByTimeAsync(15_100));
    expect(apiMock.getSession.mock.calls.length).toBe(whileWatched);

    await act(async () => setVisibility('visible'));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(apiMock.getSession.mock.calls.length).toBe(whileWatched + 1);
  });

  it('polls a transitional lab on the fast interval only while it is on screen', async () => {
    apiMock.getSession.mockImplementation((id: string) =>
      Promise.resolve({ session: sessionInfo({ sessionId: id, status: 'RESETTING' }), environment: null }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderConnected();
    for (const step of [3_200, 3_200, 3_200]) await act(() => vi.advanceTimersByTimeAsync(step));
    const transitional = apiMock.getSession.mock.calls.length;
    // One read on adoption, then one per fast interval.
    expect(transitional).toBeGreaterThanOrEqual(4);

    await act(async () => setVisibility('hidden'));
    for (let i = 0; i < 20; i += 1) await act(() => vi.advanceTimersByTimeAsync(3_200));
    expect(apiMock.getSession.mock.calls.length).toBe(transitional);
  });

  it('still shows the lab when the tab comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderConnected();
    await act(async () => setVisibility('hidden'));
    for (let i = 0; i < 4; i += 1) await act(() => vi.advanceTimersByTimeAsync(15_100));
    await act(async () => setVisibility('visible'));
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(within(screen.getByRole('group', { name: 'Lab actions' })).getByRole('button', { name: 'Verify' })).toBeTruthy();
  });
});
