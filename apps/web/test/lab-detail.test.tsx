/**
 * Student beta experience — a lab's page, before Launch.
 *
 * Launch is the one primary action, it is only offered when it can work, and a
 * refusal is explained in words with the API's code kept as a reference:
 *
 *   - double clicks send one start request
 *   - a lab already running for this student is continued, not relaunched
 *   - a student at their own limit is sent to the lab they already have
 *   - global capacity says what it means and when to retry
 *   - a lab this platform cannot run offers no button
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ApiRequestError } from '../src/lib/api';
import { LabDetailPage } from '../src/pages/LabDetailPage';
import { renderWithProviders } from './app-harness';
import { apiMock, labDetail, resetApiMock, sessionInfo, sessionsResponse } from './api-mock';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

beforeEach(() => {
  resetApiMock();
  window.history.replaceState(null, '', '/#/labs/LINUX-001');
});

async function renderDetail(labId = 'LINUX-001') {
  renderWithProviders(<LabDetailPage labId={labId} />);
  await screen.findByRole('heading', { level: 1, name: 'Files and Directories' });
  // The session list decides what the launch panel offers; let it land.
  await waitFor(() => expect(apiMock.listMySessions).toHaveBeenCalled());
}

describe('before launch', () => {
  it('says what the student will do, what they will get, and what Launch does', async () => {
    await renderDetail();
    expect(screen.getByText('Build a small project directory tree and move a log file into an archive.', { selector: 'p.page-header__description' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your environment' })).toBeTruthy();
    expect(screen.getByText('Linux container')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What Verify checks' })).toBeTruthy();
    expect(screen.getByText('The project directory exists')).toBeTruthy();
    expect(screen.getByText(/deleted when you end the lab, after a period of inactivity/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Launch lab' })).toBeTruthy();
    // Hints wait for a running lab, where revealing one can be recorded.
    expect(screen.queryByRole('button', { name: /Show a hint/ })).toBeNull();
    expect(screen.getByText('2 hints are available once the lab is running.')).toBeTruthy();
  });

  it('renders backticked commands in the task as code', async () => {
    await renderDetail();
    const code = screen.getAllByText('project', { selector: 'code' });
    expect(code.length).toBeGreaterThan(0);
  });

  it('sends exactly one start request however many times Launch is pressed', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.startLab.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderDetail();

    const launch = screen.getByRole('button', { name: 'Launch lab' });
    fireEvent.click(launch);
    fireEvent.click(launch);
    fireEvent.click(launch);

    await waitFor(() => expect(apiMock.startLab).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.startLab).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/labs/LINUX-001/workspace');
    expect(await screen.findByText('Preparing your lab environment…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Launch lab' })).toBeNull();

    resolve({
      session: sessionInfo(),
      environment: { environmentId: 'e', provider: 'docker-linux', phase: 'ready', namespace: '' },
      steps: [],
      terminal: { url: 'ws://t', token: 'tkn' },
    });
    expect(await screen.findByRole('link', { name: 'Continue lab' })).toBeTruthy();
  });

  it('continues a lab that is already running for this student instead of offering Launch', async () => {
    apiMock.listMySessions.mockResolvedValue(sessionsResponse([{ session: sessionInfo(), labTitle: 'Files and Directories' }]));
    await renderDetail();

    const link = await screen.findByRole('link', { name: 'Continue lab' });
    expect(link.getAttribute('href')).toBe('#/labs/LINUX-001/workspace');
    expect(screen.queryByRole('button', { name: /Launch/ })).toBeNull();
  });

  it('sends a student at their own limit to the lab they already have', async () => {
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ labId: 'K8S-001', sessionId: 'sess-00000000000000aa' }), labTitle: 'Create Your First Pod' }], 1),
    );
    await renderDetail();

    expect(await screen.findByText('You already have a lab running')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continue K8S-001' }).getAttribute('href')).toBe('#/labs/K8S-001/workspace');
    expect(screen.queryByRole('button', { name: /Launch/ })).toBeNull();
    expect(screen.queryByText(/start another/i)).toBeNull();
  });

  it('turns a per-student refusal it did not foresee into Continue, not a dead end', async () => {
    apiMock.startLab.mockRejectedValue(
      new ApiRequestError(429, {
        code: 'STUDENT_SESSION_LIMIT_REACHED',
        message: 'You already have a practice environment running.',
        details: { activeSessions: 1, maxActiveSessionsPerStudent: 1 },
      }),
    );
    await renderDetail();
    // Another tab started a lab after this page loaded.
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ labId: 'K8S-001' }), labTitle: 'Create Your First Pod' }], 1),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Launch lab' }));

    expect(await screen.findByRole('link', { name: 'Continue K8S-001' })).toBeTruthy();
    expect(apiMock.listMySessions).toHaveBeenCalledTimes(2);
  });

  it('explains global capacity plainly, keeps the code as a reference, and lets the student retry', async () => {
    apiMock.startLab.mockRejectedValueOnce(
      new ApiRequestError(503, {
        code: 'LAB_CAPACITY_REACHED',
        message: 'All 5 practice environments are currently in use.',
        details: { activeSessions: 5, maxActiveSessions: 5 },
      }),
    );
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Launch lab' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('All lab environments are in use')).toBeTruthy();
    expect(within(alert).getByText('Please try again in a few minutes.')).toBeTruthy();
    expect(within(alert).getByText('LAB_CAPACITY_REACHED')).toBeTruthy();
    expect(alert.textContent).not.toMatch(/\b5\b/);

    expect(screen.getByRole('button', { name: 'Try launching again' })).toBeTruthy();
  });

  it('offers no Launch for a lab this platform cannot run, and says why', async () => {
    apiMock.getLab.mockResolvedValue(
      labDetail({ availability: { available: false, reason: "sandbox image 'jumptotech/linux' is not built" } }),
    );
    await renderDetail();
    expect(screen.getByText('This lab cannot be started right now')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Launch/ })).toBeNull();
  });

  it('is honest that AWS labs are simulated', async () => {
    apiMock.getLab.mockResolvedValue(labDetail({ id: 'AWS-001', track: 'aws', title: 'Files and Directories' }));
    await renderDetail('AWS-001');
    expect(screen.getByText(/AWS labs are simulated/)).toBeTruthy();
  });

  it('explains a lab that does not exist', async () => {
    apiMock.getLab.mockRejectedValue(new ApiRequestError(404, { code: 'LAB_NOT_FOUND', message: 'Lab NOPE-001 not found' }));
    renderWithProviders(<LabDetailPage labId="NOPE-001" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Lab not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse labs' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
