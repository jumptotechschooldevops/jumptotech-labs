/**
 * The classroom pages, as an instructor and an administrator use them — and
 * as a student who types the address.
 *
 * The link is hidden from students, but hiding is not the protection: the API
 * refuses them (apps/api/test/classroom-admin.test.ts), and this proves the
 * page then says so rather than going blank. Every other failure an
 * instructor meets mid-class — the platform unreachable, a refresh that
 * fails, a Support ID that is gone — renders as words and a way forward.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from './routed-app';
import { apiMock, resetApiMock } from './api-mock';
import { TEST_SESSION } from './auth-harness';
import { ApiRequestError } from '../src/lib/api';
import type { AuthSession } from '../src/lib/auth';
import type { ClassroomOverview, ClassroomRow, SessionDetailResponse } from '../src/lib/classroomTypes';

vi.mock('../src/components/LabTerminal', () => ({ LabTerminal: () => null }));
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

const as = (role: 'STUDENT' | 'INSTRUCTOR' | 'ADMIN'): AuthSession => ({
  ...TEST_SESSION,
  identity: { ...TEST_SESSION.identity!, role, displayName: `Test ${role}` },
});

function row(overrides: Partial<ClassroomRow> = {}): ClassroomRow {
  return {
    sessionId: 'sess-aaaa1111bbbb',
    student: { userId: 'u-amy', name: 'Amy Park', email: 'amy@example.test' },
    lab: { id: 'LINUX-001', title: 'Files and Directories', track: 'linux' },
    provider: 'linux',
    runtime: 'Linux labs',
    status: 'ACTIVE',
    state: { label: 'Running', tone: 'ok' },
    occupiesSlot: true,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    statusChangedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 30_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    secondsRemaining: 3600,
    secondsUntilIdle: 1100,
    lastCheck: null,
    lastReset: null,
    cleanup: 'not-started',
    attention: [],
    ...overrides,
  };
}

function overview(overrides: Partial<ClassroomOverview> = {}): ClassroomOverview {
  return {
    generatedAt: new Date().toISOString(),
    viewer: { role: 'INSTRUCTOR', canEndSessions: false, operatorDetail: false },
    capacity: { active: 1, max: 5, available: 4, full: false, perStudentLimit: 1 },
    newLabs: { verdict: 'yes', summary: 'Students can start labs.', reasons: [] },
    runtimes: [
      { provider: 'linux', label: 'Linux labs', state: 'available' },
      { provider: 'kubernetes', label: 'Kubernetes labs', state: 'unavailable' },
    ],
    cleanupWorker: { healthy: true, lastRunAt: new Date().toISOString() },
    sessions: [row()],
    recent: [],
    problems: [],
    ...overrides,
  };
}

const apiError = (status: number, code: string, message: string) => new ApiRequestError(status, { code, message });

beforeEach(() => {
  resetApiMock();
});

describe('who sees the classroom', () => {
  it('a student has no Classroom link, and typing the address shows a refusal, not a blank page', async () => {
    apiMock.classroom.overview.mockRejectedValue(apiError(403, 'FORBIDDEN', 'Your account does not have permission to do that.'));
    renderApp('#/classroom', as('STUDENT'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Not available for your account' })).toBeTruthy();
    expect(screen.getByText(/ask an administrator to give your account the INSTRUCTOR role/)).toBeTruthy();
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(nav.queryByRole('link', { name: 'Classroom' })).toBeNull();
  });

  it('an instructor has the link', async () => {
    apiMock.classroom.overview.mockResolvedValue(overview());
    renderApp('#/classroom', as('INSTRUCTOR'));
    const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
    expect((await nav.findByRole('link', { name: 'Classroom' })).getAttribute('aria-current')).toBe('page');
  });
});

describe('the overview', () => {
  it('shows a full class: 5 / 5, capacity reached, every student, and the refused sixth', async () => {
    const names = ['Amy', 'Ben', 'Cai', 'Dee', 'Eve'];
    apiMock.classroom.overview.mockResolvedValue(
      overview({
        capacity: { active: 5, max: 5, available: 0, full: true, perStudentLimit: 1 },
        newLabs: {
          verdict: 'no',
          summary: 'Students cannot start new labs right now.',
          reasons: ['Classroom capacity is full: 5 of 5 labs are running. A slot frees when a student ends their lab.'],
        },
        sessions: names.map((name, i) =>
          row({ sessionId: `sess-${i}000aaaa1111`, student: { userId: `u-${name}`, name }, lab: { id: `LAB-00${i}`, title: `Lab ${i}`, track: 't' } }),
        ),
        problems: [
          {
            eventId: '9',
            at: new Date().toISOString(),
            operation: 'start',
            outcome: 'refused',
            code: 'LAB_CAPACITY_REACHED',
            text: 'Start refused — classroom capacity was full',
            problem: true,
            lab: { id: 'LINUX-005', title: 'x', track: 'linux' },
            student: { userId: 'u-fin', name: 'Fin' },
            by: 'student',
          },
        ],
      }),
    );
    renderApp('#/classroom', as('INSTRUCTOR'));
    expect((await screen.findByTestId('capacity')).textContent).toContain('5 / 5');
    expect(screen.getByText(/Classroom capacity reached/)).toBeTruthy();
    expect(screen.getByTestId('new-labs').textContent).toContain('Students cannot start new labs right now.');
    const running = within(screen.getByRole('table', { name: 'Labs in progress' }));
    for (const name of names) expect(running.getByRole('link', { name })).toBeTruthy();
    expect(running.getAllByRole('row')).toHaveLength(6);
    expect(screen.getByText(/Start refused — classroom capacity was full/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fin' })).toBeTruthy();
    // Runtime health in words.
    expect(screen.getByText('Kubernetes labs').parentElement!.textContent).toContain('Unavailable');
  });

  it('lists what needs attention with the next step', async () => {
    apiMock.classroom.overview.mockResolvedValue(
      overview({
        sessions: [
          row({
            state: { label: 'Needs Reset', tone: 'problem' },
            status: 'DEGRADED',
            attention: [
              {
                code: 'ENVIRONMENT_BROKEN',
                message: 'The lab environment is broken: a Reset failed or was interrupted.',
                nextStep: 'Ask the student to press Reset.',
                severity: 'problem',
              },
            ],
            lastCheck: { at: new Date().toISOString(), outcome: 'error', code: 'ENVIRONMENT_UNREACHABLE', text: 'Check could not run (platform problem)' },
          }),
        ],
      }),
    );
    renderApp('#/classroom', as('INSTRUCTOR'));
    const attention = within(await screen.findByRole('table', { name: 'Labs that need attention' }));
    expect(attention.getByText(/a Reset failed or was interrupted/)).toBeTruthy();
    expect(attention.getByText('Ask the student to press Reset.')).toBeTruthy();
    expect(attention.getByText('Check could not run (platform problem)')).toBeTruthy();
  });

  it('keeps the last answer on screen when a refresh fails, and says how old it is', async () => {
    apiMock.classroom.overview
      .mockResolvedValueOnce(overview())
      .mockRejectedValueOnce(apiError(0, 'API_UNREACHABLE', 'Cannot reach the API.'))
      .mockResolvedValue(overview({ capacity: { active: 2, max: 5, available: 3, full: false, perStudentLimit: 1 } }));
    renderApp('#/classroom', as('INSTRUCTOR'));
    expect((await screen.findByTestId('capacity')).textContent).toContain('1 / 5');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Could not refresh — showing what was true at/)).toBeTruthy();
    expect(screen.getByTestId('capacity').textContent).toContain('1 / 5');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByTestId('capacity').textContent).toContain('2 / 5'));
    expect(screen.queryByText(/Could not refresh/)).toBeNull();
  });

  it('when the platform cannot be reached at all, says so and offers a retry', async () => {
    apiMock.classroom.overview.mockRejectedValueOnce(apiError(0, 'API_UNREACHABLE', 'Cannot reach the API.')).mockResolvedValue(overview());
    renderApp('#/classroom', as('INSTRUCTOR'));
    expect(await screen.findByRole('heading', { name: 'Cannot reach JumpToTech Labs' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findByTestId('capacity')).textContent).toContain('1 / 5');
  });

  it('when the session store is down, shows the platform’s own words', async () => {
    apiMock.classroom.overview.mockRejectedValue(
      new ApiRequestError(503, {
        code: 'SESSION_STORE_UNAVAILABLE',
        message: 'Lab sessions cannot be read right now — the platform database is not answering.',
        remediation: 'Students cannot start labs either. Escalate to DevOps (P0 if every student is affected).',
      }),
    );
    renderApp('#/classroom', as('INSTRUCTOR'));
    expect(await screen.findByText(/the platform database is not answering/)).toBeTruthy();
    expect(screen.getByText(/Escalate to DevOps/)).toBeTruthy();
  });

  it('a pasted Support ID opens that lab; a name searches', async () => {
    apiMock.classroom.overview.mockResolvedValue(overview());
    apiMock.classroom.searchStudents.mockResolvedValue({
      query: 'amy',
      limit: 20,
      students: [{ student: { userId: 'u-amy', name: 'Amy Park', email: 'amy@example.test' }, role: 'STUDENT', liveSessions: [row()] }],
    });
    apiMock.classroom.session.mockResolvedValue(detail());
    renderApp('#/classroom', as('INSTRUCTOR'));
    const input = await screen.findByRole('textbox', { name: /Name, email, or the Support ID/ });

    fireEvent.change(input, { target: { value: 'amy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    const results = within(await screen.findByRole('list', { name: 'Students found' }));
    expect(results.getByRole('link', { name: 'Amy Park' })).toBeTruthy();
    expect(apiMock.classroom.searchStudents).toHaveBeenCalledWith('amy');

    fireEvent.change(input, { target: { value: 'sess-aaaa1111bbbb' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(window.location.hash).toBe('#/classroom/sessions/sess-aaaa1111bbbb'));
  });
});

function detail(overrides: Partial<SessionDetailResponse> = {}): SessionDetailResponse {
  return {
    sessionId: 'sess-aaaa1111bbbb',
    tracked: true,
    session: row(),
    environment: { phase: 'ready', checkedAt: new Date().toISOString() },
    attempt: {
      attemptId: 'a1',
      labId: 'LINUX-001',
      status: 'IN_PROGRESS',
      startedAt: new Date().toISOString(),
      checkCount: 2,
      resetCount: 1,
    },
    timeline: [
      {
        eventId: '2',
        at: new Date().toISOString(),
        operation: 'check',
        outcome: 'fail',
        text: 'Check ran — not complete yet',
        problem: false,
        lab: { id: 'LINUX-001', title: 'Files', track: 'linux' },
        student: { userId: 'u-amy', name: 'Amy Park' },
        by: 'student',
      },
    ],
    actions: { canEnd: false },
    ...overrides,
  };
}

describe('one lab', () => {
  it('an instructor sees state, facts and history, and no End button', async () => {
    apiMock.classroom.session.mockResolvedValue(detail());
    renderApp('#/classroom/sessions/sess-aaaa1111bbbb', as('INSTRUCTOR'));
    expect((await screen.findByTestId('support-id')).textContent).toContain('sess-aaaa1111bbbb');
    expect(screen.getByText('Amy Park')).toBeTruthy();
    expect(screen.getByTestId('environment').textContent).toMatch(/Reachable/);
    expect(screen.getByText(/2 Checks graded, 1 Reset/)).toBeTruthy();
    expect(screen.getByText('Check ran — not complete yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /End this student/ })).toBeNull();
  });

  it('an administrator ends it only after a confirmation that names the student, lab and Support ID', async () => {
    apiMock.classroom.session
      .mockResolvedValueOnce(detail({ actions: { canEnd: true } }))
      .mockResolvedValue(
        detail({
          session: row({ status: 'EXPIRED', state: { label: 'Ended by staff', tone: 'done' }, occupiesSlot: false, cleanup: 'confirmed' }),
          environment: null,
          actions: { canEnd: false },
        }),
      );
    apiMock.classroom.endSession.mockResolvedValue({
      before: 'ACTIVE',
      after: 'EXPIRED',
      cleanup: 'confirmed',
      session: row({ status: 'EXPIRED' }),
    });
    renderApp('#/classroom/sessions/sess-aaaa1111bbbb', as('ADMIN'));
    fireEvent.click(await screen.findByRole('button', { name: /End this student’s lab/ }));

    const dialog = within(screen.getByRole('alertdialog', { name: 'End this student’s lab?' }));
    expect(dialog.getByText('Amy Park')).toBeTruthy();
    expect(dialog.getByText('LINUX-001 — Files and Directories')).toBeTruthy();
    expect(dialog.getByText('sess-aaaa1111bbbb')).toBeTruthy();
    expect(apiMock.classroom.endSession).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'End lab' }));
    });
    expect(apiMock.classroom.endSession).toHaveBeenCalledWith('sess-aaaa1111bbbb');
    expect(await screen.findByText(/confirmed removed. The slot is free/)).toBeTruthy();
    expect(await screen.findByText('Ended by staff')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /End this student’s lab/ })).toBeNull();
  });

  it('an End the server refuses is shown, and the page re-reads the truth', async () => {
    apiMock.classroom.session.mockResolvedValue(detail({ actions: { canEnd: true } }));
    apiMock.classroom.endSession.mockRejectedValue(
      apiError(409, 'SESSION_ALREADY_FINISHED', 'This lab has already finished (Ended by student).'),
    );
    renderApp('#/classroom/sessions/sess-aaaa1111bbbb', as('ADMIN'));
    fireEvent.click(await screen.findByRole('button', { name: /End this student’s lab/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End lab' }));
    });
    expect(await screen.findByText('This lab has already finished (Ended by student).')).toBeTruthy();
    expect(apiMock.classroom.session.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a lab whose live record is gone still shows what happened', async () => {
    apiMock.classroom.session.mockResolvedValue(
      detail({
        tracked: false,
        session: undefined,
        summary: {
          student: { userId: 'u-amy', name: 'Amy Park' },
          lab: { id: 'LINUX-001', title: 'Files', track: 'linux' },
          note: 'This lab finished more than a few minutes ago; its live record is gone, but what happened to it is below.',
        },
        environment: null,
      }),
    );
    renderApp('#/classroom/sessions/sess-aaaa1111bbbb', as('INSTRUCTOR'));
    expect(await screen.findByText(/its live record is gone/)).toBeTruthy();
    expect(screen.getByText('Check ran — not complete yet')).toBeTruthy();
  });

  it('an unknown Support ID says so', async () => {
    apiMock.classroom.session.mockRejectedValue(apiError(404, 'SESSION_NOT_FOUND', 'No lab with that Support ID.'));
    renderApp('#/classroom/sessions/sess-0000000000ff', as('INSTRUCTOR'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy();
    expect(screen.getByText('No lab with that Support ID.')).toBeTruthy();
  });
});
