/**
 * PLATFORM-005 — the progress page (story test requirements 1, 10–13).
 *
 * Rendered against payloads captured verbatim from the real API, in the same
 * spirit as the PLATFORM-003 fixtures: what is asserted here is that the page
 * shows what the server actually sends, not what a hand-written object made
 * convenient.
 *
 * Refresh them by driving the API and saving `.data`:
 *   curl -s localhost:4000/api/me/progress | jq '.data' > test/fixtures/me-progress.json
 *   curl -s localhost:4000/api/me/attempts | jq '.data' > test/fixtures/me-attempts.json
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { ApiRequestError } from '../src/lib/api';
import { ProgressPage } from '../src/pages/ProgressPage';
import type { AttemptSummary, ProgressSnapshot } from '../src/lib/types';
import progressFixture from './fixtures/me-progress.json';
import attemptsFixture from './fixtures/me-attempts.json';
import { renderWithProviders } from './app-harness';
import { apiMock, resetApiMock } from './api-mock';

const PROGRESS = progressFixture as unknown as ProgressSnapshot;
const ATTEMPTS = attemptsFixture as unknown as { attempts: AttemptSummary[] };

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

beforeEach(() => {
  resetApiMock();
  apiMock.getProgress.mockResolvedValue(PROGRESS);
  apiMock.listAttempts.mockResolvedValue({ attempts: ATTEMPTS.attempts, count: ATTEMPTS.attempts.length });
});

async function renderPage() {
  const result = renderWithProviders(<ProgressPage />);
  await waitFor(() => expect(screen.getByText('of 12 labs completed')).toBeTruthy());
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Recent lab attempts' })).toBeTruthy());
  return result;
}

describe('ProgressPage', () => {
  it('shows overall progress across every track', async () => {
    await renderPage();

    expect(screen.getByText('2', { selector: '.stat__value' })).toBeTruthy();
    expect(screen.getByText('of 12 labs completed')).toBeTruthy();
    expect(screen.getByText(/17% complete/)).toBeTruthy();
    expect(screen.getByText(/2 in progress/)).toBeTruthy();
  });

  it('shows completed / total for Kubernetes, Linux and Terraform', async () => {
    await renderPage();

    // The three tracks, each with its own denominator taken from the catalog.
    const kubernetes = screen.getByRole('progressbar', { name: /Kubernetes: 1 of 10 labs completed/ });
    expect(kubernetes.getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByRole('progressbar', { name: /Linux: 1 of 1/ })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /Terraform: 0 of 1/ })).toBeTruthy();

    for (const heading of ['Kubernetes', 'Linux', 'Terraform']) {
      expect(screen.getByRole('heading', { name: heading }), heading).toBeTruthy();
    }
  });

  it('marks each lab completed, in progress, or neither — in words as well as symbols', async () => {
    const { container } = await renderPage();

    const completed = container.querySelectorAll('.tracklabs__item--completed');
    const inProgress = container.querySelectorAll('.tracklabs__item--in_progress');
    const notStarted = container.querySelectorAll('.tracklabs__item--not_started');

    expect(completed).toHaveLength(2);
    expect(inProgress).toHaveLength(2);
    expect(notStarted).toHaveLength(8);
    expect(completed[0]?.textContent).toContain('K8S-001');
    expect(completed[0]?.textContent).toContain('completed');
  });

  it('lists recent attempts with their real outcomes', async () => {
    await renderPage();

    // The statuses the fixtures actually contain, each rendered as itself
    // rather than collapsed into "done / not done".
    expect(screen.getAllByText('Passed')).toHaveLength(2);
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Ended')).toBeTruthy();

    // Each title appears twice — once in its track list, once in the history.
    expect(screen.getAllByText('Move Configuration into a ConfigMap')).toHaveLength(2);
    expect(screen.getAllByText('Terraform Init, Plan & Apply')).toHaveLength(2);
  });

  it('links each attempt to its lab', async () => {
    await renderPage();
    const links = screen.getAllByRole('link', { name: /K8S-001/ });
    expect(links.every((link) => link.getAttribute('href') === '#/labs/K8S-001')).toBe(true);
  });

  it('says a development identity is not a real sign-in — and only when it is one', async () => {
    const { unmount } = await renderPage();
    expect(screen.getByText(/Development identity — not a real sign-in/)).toBeTruthy();
    unmount();

    apiMock.getProgress.mockResolvedValue({ ...PROGRESS, student: { ...PROGRESS.student, authenticated: true } });
    await renderPage();
    expect(screen.queryByText(/Development identity/)).toBeNull();
    expect(screen.queryByText(/no sign-in/)).toBeNull();
  });

  it('warns when the deployment has no database behind it', async () => {
    apiMock.getProgress.mockResolvedValue({ ...PROGRESS, student: { ...PROGRESS.student, durable: false } });
    await renderPage();

    // The honest version of "your progress is saved": it is not, here.
    expect(screen.getByText(/Not saved to a database/)).toBeTruthy();
  });

  it('does not show a warning when progress really is persisted', async () => {
    await renderPage();
    expect(screen.queryByText(/Not saved to a database/)).toBeNull();
  });

  it('reports a failure instead of an empty dashboard', async () => {
    apiMock.getProgress.mockRejectedValue(
      new ApiRequestError(503, { code: 'PROGRESS_UNAVAILABLE', message: 'Your progress could not be read right now.' }),
    );
    renderWithProviders(<ProgressPage />);

    // An empty dashboard and a broken one look identical to a student, so the
    // page must never render the first when it means the second.
    expect(await screen.findByText('Progress is unavailable right now')).toBeTruthy();
    expect(screen.getByText('PROGRESS_UNAVAILABLE')).toBeTruthy();
    expect(screen.queryByText(/of 12 labs completed/)).toBeNull();
  });

  it('invites a brand-new student to start rather than showing nothing', async () => {
    apiMock.getProgress.mockResolvedValue({
      ...PROGRESS,
      overall: { total: 12, completed: 0, inProgress: 0, notStarted: 12, percent: 0 },
      tracks: PROGRESS.tracks.map((track) => ({
        ...track,
        completed: 0,
        inProgress: 0,
        notStarted: track.total,
        percent: 0,
        labs: track.labs.map((lab) => ({
          ...lab,
          status: 'NOT_STARTED' as const,
          attemptCount: 0,
          completionCount: 0,
          completedAt: null,
          lastCompletedAt: null,
        })),
      })),
    });
    apiMock.listAttempts.mockResolvedValue({ attempts: [], count: 0 });

    await renderPage();
    expect(await screen.findByText(/No attempts yet/)).toBeTruthy();
    expect(screen.getByText('of 12 labs completed')).toBeTruthy();
  });
});
