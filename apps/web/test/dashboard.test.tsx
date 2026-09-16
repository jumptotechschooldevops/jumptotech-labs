/**
 * Student beta experience — the dashboard shows only what the platform knows.
 *
 * Identity, the running lab, progress, recent attempts and the learning path
 * with its next lab (V1 EPIC-02) — each with its own loading and failure state,
 * and none of them fabricated when its source is unavailable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { ApiRequestError } from '../src/lib/api';
import { DashboardPage } from '../src/pages/DashboardPage';
import { renderWithProviders } from './app-harness';
import {
  apiMock,
  attemptSummary,
  learningPathProgress,
  progressSnapshot,
  resetApiMock,
  sessionInfo,
  sessionsResponse,
} from './api-mock';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

beforeEach(() => {
  resetApiMock();
});

const panel = (name: string | RegExp) => screen.getByRole('heading', { name }).closest('section')!;

describe('the dashboard', () => {
  it('welcomes a first-time student and shows how a lab works', async () => {
    renderWithProviders(<DashboardPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome, Test Student' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'How a lab works' })).toBeTruthy();
    expect(screen.getByText(/No lab attempts yet/)).toBeTruthy();
  });

  it('shows the learning path, verified path progress, and the next lab with its reason', async () => {
    renderWithProviders(<DashboardPage />);

    const path = await waitFor(() => panel('DevOps Engineer path'));
    await waitFor(() => expect(within(path).getByText('of 3 labs in this path completed')).toBeTruthy());
    expect(within(path).getByText('Start your DevOps journey', { exact: false })).toBeTruthy();
    expect(within(path).getByRole('heading', { name: 'Next recommended lab' })).toBeTruthy();
    expect(within(path).getByText('Files and Directories')).toBeTruthy();
    expect(within(path).getByText('Start here. Linux is the first stage of the DevOps Engineer path.')).toBeTruthy();
    expect(within(path).getByRole('link', { name: /Start learning\s*: LINUX-001/ }).getAttribute('href')).toBe('#/labs/LINUX-001');
    expect(within(path).getByRole('link', { name: 'View path' }).getAttribute('href')).toBe('#/paths/devops-engineer');
    expect(within(path).getByRole('link', { name: 'Linux' }).getAttribute('href')).toBe('#/paths/devops-engineer/stages/linux');
    // The old catalog-order rule is gone: there is one answer to "what next".
    expect(screen.queryByRole('heading', { name: 'Next up' })).toBeNull();
  });

  it('continues the journey with the stage the student is in', async () => {
    apiMock.getLearningPathProgress.mockResolvedValue(
      learningPathProgress(
        { 'LINUX-001': 'COMPLETED' },
        {
          kind: 'NEXT_IN_STAGE',
          labId: 'LINUX-002',
          labTitle: 'File Permissions',
          reason: 'Next in Linux. Finish the Linux stage before starting Kubernetes.',
        },
      ),
    );
    renderWithProviders(<DashboardPage />);

    const path = await waitFor(() => panel('DevOps Engineer path'));
    await waitFor(() => expect(within(path).getByText('Continue your DevOps journey', { exact: false })).toBeTruthy());
    expect(within(path).getByRole('progressbar', { name: 'DevOps Engineer path: 1 of 3 labs completed' })).toBeTruthy();
    expect(within(path).getByText('Next in Linux. Finish the Linux stage before starting Kubernetes.')).toBeTruthy();
    expect(within(path).getByRole('link', { name: /Continue learning\s*: LINUX-002/ }).getAttribute('href')).toBe('#/labs/LINUX-002');
  });

  it('shows real completed-of-total progress, overall and per track', async () => {
    apiMock.getProgress.mockResolvedValue(progressSnapshot({ 'LINUX-001': 'COMPLETED', 'K8S-001': 'IN_PROGRESS' }));
    renderWithProviders(<DashboardPage />);

    await waitFor(() => expect(within(panel('Your progress')).getByText('of 3 labs completed')).toBeTruthy());
    expect(within(panel('Your progress')).getByText('1')).toBeTruthy();
    expect(within(panel('Your progress')).getByText('1 lab in progress')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Linux: 1 of 2 labs completed' })).toBeTruthy();
  });

  it('welcomes a returning student back and lists recent attempts', async () => {
    apiMock.listAttempts.mockResolvedValue({
      attempts: [attemptSummary({ status: 'PASSED', labId: 'LINUX-001' })],
      count: 1,
    });
    renderWithProviders(<DashboardPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back, Test Student' })).toBeTruthy();
    const recent = panel('Recent activity');
    expect(within(recent).getByText('Passed')).toBeTruthy();
    expect(within(recent).getByRole('link', { name: /Files and Directories/ }).getAttribute('href')).toBe('#/labs/LINUX-001');
    expect(screen.queryByRole('heading', { name: 'How a lab works' })).toBeNull();
  });

  it('puts a running lab first, with Continue', async () => {
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ labId: 'K8S-001' }), labTitle: 'Create Your First Pod' }]),
    );
    apiMock.getLearningPathProgress.mockResolvedValue(
      learningPathProgress(
        {},
        {
          kind: 'RESUME_ACTIVE',
          labId: 'K8S-001',
          labTitle: 'Create Your First Pod',
          stageId: 'kubernetes',
          reason: 'You have a lab running. Continue it, or end it, before starting another — you can run one lab at a time.',
        },
      ),
    );
    renderWithProviders(<DashboardPage />);

    const running = await waitFor(() => panel('You have a lab running'));
    expect(within(running).getByText('Ready')).toBeTruthy();
    expect(within(running).getByRole('link', { name: 'Continue lab' }).getAttribute('href')).toBe('#/labs/K8S-001/workspace');
    // The path explains the one-lab rule instead of offering a second lab to start.
    const path = await waitFor(() => panel('DevOps Engineer path'));
    await waitFor(() => expect(within(path).getByText(/you can run one lab at a time/)).toBeTruthy());
    expect(within(path).queryByRole('link', { name: /Continue learning|Start learning/ })).toBeNull();
    expect(screen.getAllByRole('link', { name: /Continue lab/ })).toHaveLength(1);
  });

  it('says progress is unavailable rather than showing zero — and suggests nothing it cannot justify', async () => {
    const unavailable = new ApiRequestError(503, {
      code: 'PROGRESS_UNAVAILABLE',
      message: 'Your progress could not be read right now.',
    });
    apiMock.getProgress.mockRejectedValue(unavailable);
    apiMock.getLearningPathProgress.mockRejectedValue(unavailable);
    renderWithProviders(<DashboardPage />);

    await waitFor(() => expect(screen.getAllByText('Progress is unavailable right now')).toHaveLength(2));
    expect(screen.queryByText(/of 3 labs completed/)).toBeNull();
    expect(screen.queryByText(/labs in this path completed/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Next recommended lab' })).toBeNull();
    expect(within(panel('Your progress')).getByRole('button', { name: 'Try again' })).toBeTruthy();

    apiMock.getLearningPathProgress.mockResolvedValue(learningPathProgress());
    act(() => within(panel('DevOps Engineer path')).getByRole('button', { name: 'Try again' }).click());
    await waitFor(() => expect(within(panel('DevOps Engineer path')).getByText('of 3 labs in this path completed')).toBeTruthy());
  });

  it('says so when the learning path cannot be loaded, without inventing one', async () => {
    apiMock.getLearningPath.mockRejectedValue(new ApiRequestError(0, { code: 'API_UNREACHABLE', message: 'x' }));
    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText('We could not load your learning path')).toBeTruthy();
    const path = panel('Your learning path');
    expect(within(path).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(path).queryByRole('progressbar')).toBeNull();
  });

  it('says so when it cannot check for a running lab', async () => {
    apiMock.listMySessions.mockRejectedValue(new ApiRequestError(0, { code: 'API_UNREACHABLE', message: 'x' }));
    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText('We could not check whether you have a lab running')).toBeTruthy();
  });
});
