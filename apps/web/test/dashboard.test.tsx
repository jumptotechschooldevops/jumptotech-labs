/**
 * Student beta experience — the dashboard shows only what the platform knows.
 *
 * Identity, the running lab, progress, recent attempts and a rule-based next
 * lab — each with its own loading and failure state, and none of them
 * fabricated when its source is unavailable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { ApiRequestError } from '../src/lib/api';
import { DashboardPage } from '../src/pages/DashboardPage';
import { renderWithProviders } from './app-harness';
import {
  apiMock,
  attemptSummary,
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

  it('suggests a first lab by a stated rule', async () => {
    renderWithProviders(<DashboardPage />);

    const next = await waitFor(() => panel('Next up'));
    expect(within(next).getByText('Create Your First Pod')).toBeTruthy();
    expect(within(next).getByText('The first lab in Kubernetes — a good place to begin.')).toBeTruthy();
    expect(within(next).getByRole('link', { name: 'View lab' }).getAttribute('href')).toBe('#/labs/K8S-001');
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
    renderWithProviders(<DashboardPage />);

    const running = await waitFor(() => panel('You have a lab running'));
    expect(within(running).getByText('Ready')).toBeTruthy();
    expect(within(running).getByRole('link', { name: 'Continue lab' }).getAttribute('href')).toBe('#/labs/K8S-001/workspace');
    // The running lab is not also offered as "next".
    await waitFor(() => expect(apiMock.getProgress).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Next up' })).toBeNull();
  });

  it('says progress is unavailable rather than showing zero — and suggests nothing it cannot justify', async () => {
    apiMock.getProgress.mockRejectedValue(
      new ApiRequestError(503, { code: 'PROGRESS_UNAVAILABLE', message: 'Your progress could not be read right now.' }),
    );
    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText('Progress is unavailable right now')).toBeTruthy();
    expect(screen.queryByText(/of 3 labs completed/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Next up' })).toBeNull();
    expect(within(panel('Your progress')).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says so when it cannot check for a running lab', async () => {
    apiMock.listMySessions.mockRejectedValue(new ApiRequestError(0, { code: 'API_UNREACHABLE', message: 'x' }));
    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText('We could not check whether you have a lab running')).toBeTruthy();
  });
});
