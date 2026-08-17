/**
 * PLATFORM-005 — the student dashboard (story test requirements 1, 10–13).
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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProgressPage } from '../src/pages/ProgressPage';
import type { AttemptSummary, ProgressSnapshot } from '../src/lib/types';
import progressFixture from './fixtures/me-progress.json';
import attemptsFixture from './fixtures/me-attempts.json';

const PROGRESS = progressFixture as unknown as ProgressSnapshot;
const ATTEMPTS = attemptsFixture as unknown as { attempts: AttemptSummary[] };

const getProgress = vi.fn();
const listAttempts = vi.fn();

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      getProgress: (...args: unknown[]) => getProgress(...args),
      listAttempts: (...args: unknown[]) => listAttempts(...args),
    },
  };
});

beforeEach(() => {
  getProgress.mockReset();
  listAttempts.mockReset();
  getProgress.mockResolvedValue(PROGRESS);
  listAttempts.mockResolvedValue({ attempts: ATTEMPTS.attempts, count: ATTEMPTS.attempts.length });
});

async function renderPage(onOpenLab = vi.fn()) {
  render(<ProgressPage onBack={vi.fn()} onOpenLab={onOpenLab} />);
  await waitFor(() => expect(screen.getByText(/of 12 labs completed/)).toBeTruthy());
  return { onOpenLab };
}

describe('ProgressPage', () => {
  it('shows overall progress across every track', async () => {
    await renderPage();

    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('of 12 labs completed')).toBeTruthy();
    expect(screen.getByText(/17% complete/)).toBeTruthy();
    expect(screen.getByText(/2 in progress/)).toBeTruthy();
  });

  it('shows completed / total for Kubernetes, Linux and Terraform', async () => {
    await renderPage();

    // The three tracks, each with its own denominator taken from the catalog.
    const kubernetes = screen.getByRole('progressbar', {
      name: /Kubernetes: 1 of 10 labs completed/,
    });
    expect(kubernetes.getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByRole('progressbar', { name: /Linux: 1 of 1/ })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /Terraform: 0 of 1/ })).toBeTruthy();

    for (const heading of ['Kubernetes', 'Linux', 'Terraform']) {
      expect(screen.getByRole('heading', { name: heading }), heading).toBeTruthy();
    }
  });

  it('marks each lab completed, in progress, or neither', async () => {
    const { container } = render(<ProgressPage onBack={vi.fn()} onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('of 12 labs completed')).toBeTruthy());

    const completed = container.querySelectorAll('.tracklabs__item--completed');
    const inProgress = container.querySelectorAll('.tracklabs__item--in_progress');
    const notStarted = container.querySelectorAll('.tracklabs__item--not_started');

    expect(completed).toHaveLength(2);
    expect(inProgress).toHaveLength(2);
    expect(notStarted).toHaveLength(8);
    expect(completed[0]?.textContent).toContain('K8S-001');
  });

  it('lists recent attempts with their real outcomes', async () => {
    await renderPage();

    expect(screen.getByRole('heading', { name: 'Recent lab attempts' })).toBeTruthy();
    // The four statuses the fixtures actually contain, each rendered as itself
    // rather than collapsed into "done / not done".
    expect(screen.getAllByText('Passed')).toHaveLength(2);
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Ended')).toBeTruthy();

    // Each title appears twice — once in its track list, once in the history.
    expect(screen.getAllByText('Move Configuration into a ConfigMap')).toHaveLength(2);
    expect(screen.getAllByText('Terraform Init, Plan & Apply')).toHaveLength(2);
  });

  it('opens a lab from its attempt', async () => {
    const { onOpenLab } = await renderPage();

    fireEvent.click(screen.getByTitle('Open K8S-001'));
    expect(onOpenLab).toHaveBeenCalledWith('K8S-001');
  });

  it('says the identity is a development one, not a login', async () => {
    await renderPage();

    expect(screen.getByText('dev-student-001')).toBeTruthy();
    expect(screen.getByText(/development identity — no sign-in yet/)).toBeTruthy();
  });

  it('warns when the deployment has no database behind it', async () => {
    getProgress.mockResolvedValue({
      ...PROGRESS,
      student: { ...PROGRESS.student, durable: false },
    });
    await renderPage();

    // The honest version of "your progress is saved": it is not, here.
    expect(screen.getByText('not saved to a database')).toBeTruthy();
  });

  it('does not show a warning when progress really is persisted', async () => {
    await renderPage();
    expect(screen.queryByText('not saved to a database')).toBeNull();
  });

  it('reports a failure instead of an empty dashboard', async () => {
    getProgress.mockRejectedValue(
      Object.assign(new Error('unavailable'), {
        error: { code: 'PROGRESS_UNAVAILABLE', message: 'Your progress could not be read.' },
      }),
    );
    render(<ProgressPage onBack={vi.fn()} onOpenLab={vi.fn()} />);

    // An empty dashboard and a broken one look identical to a student, so the
    // page must never render the first when it means the second.
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/of 12 labs completed/)).toBeNull();
  });

  it('invites a brand-new student to start rather than showing nothing', async () => {
    getProgress.mockResolvedValue({
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
    listAttempts.mockResolvedValue({ attempts: [], count: 0 });

    await renderPage();
    expect(screen.getByText(/No attempts yet/)).toBeTruthy();
    expect(screen.getByText('of 12 labs completed')).toBeTruthy();
  });
});
