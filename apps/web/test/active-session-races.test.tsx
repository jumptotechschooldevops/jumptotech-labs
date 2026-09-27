/**
 * A session-list read that started before a change must not undo it.
 *
 * `refresh()` was generation-guarded against *other refreshes*, but a launch
 * or an End did not move the generation. A read of `GET /api/sessions` that
 * was in flight when a launch finished — the tab regained focus mid-launch,
 * say — resolved afterwards with a list taken before the new session existed:
 * the new lab vanished from every other page (which then offered Launch, and
 * was refused as a second lab) and its terminal grant was thrown away. An End
 * could be undone the same way, the ended lab reappearing as running.
 *
 * Such a read is now not applied but made again, so what lands is the list as
 * the server has it after the change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { ActiveSessionProvider, useActiveSession, type ActiveSessionState } from '../src/lib/ActiveSessionContext';
import type { MySessionsResponse, StartLabResponse } from '../src/lib/types';
import { apiMock, resetApiMock, sessionInfo, sessionsResponse } from './api-mock';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mount() {
  const state: { current: ActiveSessionState | null } = { current: null };
  function Probe() {
    state.current = useActiveSession();
    return null;
  }
  render(
    <ActiveSessionProvider>
      <Probe />
    </ActiveSessionProvider>,
  );
  return state;
}

const SESSION = sessionInfo({ sessionId: 'sess-00000000000000a1', labId: 'LINUX-001' });

function started(): StartLabResponse {
  return {
    session: SESSION,
    environment: {} as StartLabResponse['environment'],
    steps: [],
    terminal: { url: 'ws://localhost:4001/terminal', token: 'synthetic-token' },
  };
}

beforeEach(() => {
  resetApiMock();
});

describe('active sessions — a stale list read', () => {
  it('does not drop a lab that finished launching while the read was in flight', async () => {
    const state = mount();
    await waitFor(() => expect(state.current?.status).toBe('ready'));

    // The tab regains focus: a read begins, and the server answers it from
    // before the launch below created anything.
    const stale = deferred<MySessionsResponse>();
    apiMock.listMySessions.mockReturnValueOnce(stale.promise);
    await act(async () => {
      void state.current!.refresh();
    });

    apiMock.startLab.mockResolvedValueOnce(started());
    await act(async () => {
      await state.current!.launch('LINUX-001', 'Files and Directories');
    });
    expect(state.current!.entries.map((e) => e.session.sessionId)).toEqual([SESSION.sessionId]);

    // The server now lists the new session; the stale answer does not.
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: SESSION, labTitle: 'Files and Directories' }]),
    );
    await act(async () => {
      stale.resolve(sessionsResponse([]));
      await stale.promise;
    });

    expect(state.current!.entries.map((e) => e.session.sessionId)).toEqual([SESSION.sessionId]);
    expect(state.current!.grantFor(SESSION.sessionId)).not.toBeNull();
  });

  it('does not bring back a lab that was ended while the read was in flight', async () => {
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: SESSION, labTitle: 'Files and Directories' }]),
    );
    const state = mount();
    await waitFor(() => expect(state.current?.entries).toHaveLength(1));

    const stale = deferred<MySessionsResponse>();
    apiMock.listMySessions.mockReturnValueOnce(stale.promise);
    await act(async () => {
      void state.current!.refresh();
    });

    // The student ends the lab; the page adopts the ENDED copy.
    await act(async () => {
      state.current!.adoptSession({ ...SESSION, status: 'ENDED' });
    });
    expect(state.current!.entries).toEqual([]);

    apiMock.listMySessions.mockResolvedValue(sessionsResponse([]));
    await act(async () => {
      stale.resolve(sessionsResponse([{ session: SESSION, labTitle: 'Files and Directories' }]));
      await stale.promise;
    });

    expect(state.current!.entries).toEqual([]);
  });
});
