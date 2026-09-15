/**
 * V1 EPIC-02 — the learning path in the browser.
 *
 * The routed app, mounted whole, so every page is reached the way a student
 * reaches it: by address. What is asserted is what a student can rely on —
 * statuses in words, gaps shown as gaps, nothing locked away, and nothing shown
 * as progress when progress could not be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { ApiRequestError } from '../src/lib/api';
import { hrefFor, parseRoute } from '../src/lib/router';
import { go, renderApp } from './routed-app';
import {
  apiMock,
  learningPathDetail,
  learningPathProgress,
  resetApiMock,
  sessionInfo,
  sessionsResponse,
} from './api-mock';

vi.mock('../src/components/LabTerminal', () => ({ LabTerminal: () => null }));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

beforeEach(() => {
  resetApiMock();
});

const stageItem = (title: string) =>
  screen.getByRole('link', { name: new RegExp(`Stage \\d+:\\s*${title}$`) }).closest('li')! as HTMLElement;
const panel = (name: string | RegExp) => screen.getByRole('heading', { name }).closest('section')! as HTMLElement;

describe('learning path routes', () => {
  it('parses and builds path and stage addresses, and refuses malformed ones', () => {
    expect(parseRoute('#/paths')).toEqual({ name: 'paths' });
    expect(parseRoute('#/paths/devops-engineer')).toEqual({ name: 'path', pathId: 'devops-engineer' });
    expect(parseRoute('#/paths/devops-engineer/stages/linux')).toEqual({
      name: 'stage',
      pathId: 'devops-engineer',
      stageId: 'linux',
    });
    expect(hrefFor({ name: 'stage', pathId: 'devops-engineer', stageId: 'helm-gitops' })).toBe(
      '#/paths/devops-engineer/stages/helm-gitops',
    );
    expect(parseRoute('#/paths/Bad_Path')).toEqual({ name: 'notFound' });
    expect(parseRoute('#/paths/devops-engineer/linux')).toEqual({ name: 'notFound' });
    // Existing addresses are unchanged.
    expect(parseRoute('#/labs/LINUX-001')).toEqual({ name: 'lab', labId: 'LINUX-001' });
    expect(parseRoute('#/tracks/linux')).toEqual({ name: 'track', trackId: 'linux' });
  });
});

describe('the learning path page', () => {
  it('shows a loading state while the path loads', async () => {
    apiMock.getLearningPath.mockReturnValue(new Promise(() => undefined));
    renderApp('#/paths/devops-engineer');
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText('Loading the learning path…')).toBeTruthy();
  });

  it('lists the stages in order with their status in words, the current stage, and the next lab', async () => {
    renderApp('#/paths/devops-engineer');

    expect(await screen.findByRole('heading', { level: 1, name: 'DevOps Engineer path' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('of 3 labs in this path completed')).toBeTruthy());

    const items = within(screen.getByRole('heading', { name: 'Stages, in order' }).closest('section')!).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    const linux = stageItem('Linux');
    expect(within(linux).getByText('Not started')).toBeTruthy();
    expect(within(linux).getByText('You are here')).toBeTruthy();
    expect(within(linux).getByRole('progressbar', { name: 'Linux: 0 of 2 core labs completed' })).toBeTruthy();
    expect(within(linux).getByRole('link', { name: /Linux$/ }).getAttribute('href')).toBe('#/paths/devops-engineer/stages/linux');

    const git = stageItem('Git & Software Delivery');
    expect(within(git).getByText('Coming soon')).toBeTruthy();
    expect(within(git).getByText('No labs yet')).toBeTruthy();
    expect(within(git).queryByRole('progressbar')).toBeNull();

    const kubernetes = stageItem('Kubernetes');
    expect(within(kubernetes).getByText('Earlier stage first')).toBeTruthy();
    expect(within(kubernetes).getByText(/Recommended after Linux/)).toBeTruthy();
    expect(within(kubernetes).getByText(/1 skill coming soon/)).toBeTruthy();

    const progress = panel('Your progress');
    expect(within(progress).getByText('Start here. Linux is the first stage of the DevOps Engineer path.')).toBeTruthy();
    expect(within(progress).getByRole('link', { name: /Start learning\s*: LINUX-001/ }).getAttribute('href')).toBe('#/labs/LINUX-001');
    expect(within(progress).getByText(/A lab counts only when Verify passed it/)).toBeTruthy();
  });

  it('does not call a stage with curriculum gaps "Completed"', async () => {
    apiMock.getLearningPathProgress.mockResolvedValue(
      learningPathProgress(
        { 'LINUX-001': 'COMPLETED', 'LINUX-002': 'COMPLETED', 'K8S-001': 'COMPLETED' },
        { kind: 'PATH_COMPLETE', labId: undefined, labTitle: undefined, stageId: undefined, reason: 'You have completed every lab currently available in the DevOps Engineer path.' },
      ),
    );
    renderApp('#/paths/devops-engineer');

    await waitFor(() => expect(within(stageItem('Linux')).getByText('Completed')).toBeTruthy());
    expect(within(stageItem('Kubernetes')).getByText('Available labs completed')).toBeTruthy();
    expect(within(stageItem('Git & Software Delivery')).getByText('Coming soon')).toBeTruthy();
    expect(within(panel('Your progress')).queryByRole('link', { name: /Continue learning|Start learning/ })).toBeNull();
  });

  it('still shows the path when progress is unavailable — without statuses, and never as zero', async () => {
    apiMock.getLearningPathProgress.mockRejectedValue(
      new ApiRequestError(503, { code: 'PROGRESS_UNAVAILABLE', message: 'Your progress could not be read right now.' }),
    );
    renderApp('#/paths/devops-engineer');

    expect(await screen.findByText(/Your progress could not be loaded, so stage statuses are not shown/)).toBeTruthy();
    expect(stageItem('Linux')).toBeTruthy();
    expect(screen.queryByText('Not started')).toBeNull();
    expect(screen.queryByText(/labs in this path completed/)).toBeNull();
    expect(screen.getByText('Progress is unavailable right now')).toBeTruthy();

    apiMock.getLearningPathProgress.mockResolvedValue(learningPathProgress());
    act(() => within(panel('Your progress')).getByRole('button', { name: 'Try again' }).click());
    await waitFor(() => expect(within(stageItem('Linux')).getByText('Not started')).toBeTruthy());
  });

  it('says so when the path cannot be reached, with Try again', async () => {
    apiMock.getLearningPath.mockRejectedValue(new ApiRequestError(0, { code: 'API_UNREACHABLE', message: 'x' }));
    renderApp('#/paths/devops-engineer');

    expect(await screen.findByRole('heading', { level: 1, name: 'The learning path could not be loaded' })).toBeTruthy();
    apiMock.getLearningPath.mockResolvedValue({ learningPath: learningPathDetail() });
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    expect(await screen.findByRole('heading', { level: 1, name: 'DevOps Engineer path' })).toBeTruthy();
  });

  it('shows Learning path not found for an unknown path', async () => {
    apiMock.getLearningPath.mockRejectedValue(
      new ApiRequestError(404, { code: 'LEARNING_PATH_NOT_FOUND', message: 'No learning path has that id.' }),
    );
    renderApp('#/paths/site-reliability');
    expect(await screen.findByRole('heading', { level: 1, name: 'Learning path not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See all learning paths' }).getAttribute('href')).toBe('#/paths');
  });

  it('lists every path at #/paths', async () => {
    renderApp('#/paths');
    expect(await screen.findByRole('heading', { level: 1, name: 'Learning paths' })).toBeTruthy();
    const link = await screen.findByRole('link', { name: 'DevOps Engineer path' });
    expect(link.getAttribute('href')).toBe('#/paths/devops-engineer');
  });
});

describe('a stage page', () => {
  it('opens directly by address with what, why, labs in order, skills and the next step', async () => {
    apiMock.getLearningPathProgress.mockResolvedValue(learningPathProgress({ 'LINUX-001': 'COMPLETED' }));
    renderApp('#/paths/devops-engineer/stages/linux');

    expect(await screen.findByRole('heading', { level: 1, name: 'Linux' })).toBeTruthy();
    expect(document.title).toBe('Linux · JumpToTech Labs');
    expect(screen.getByText('Stage 1 of 3')).toBeTruthy();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'DevOps Engineer path' }).getAttribute('href')).toBe('#/paths/devops-engineer');

    expect(screen.getByRole('heading', { name: 'What you will learn' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Why this matters in DevOps work' })).toBeTruthy();

    const labs = within(screen.getByRole('heading', { name: 'Labs in recommended order' }).closest('section')!).getAllByRole('listitem');
    expect(labs.map((item) => within(item).getByRole('heading').textContent)).toEqual([
      'LINUX-001 Files and Directories',
      'LINUX-002 File Permissions',
    ]);
    await waitFor(() => expect(within(labs[0]!).getByText('Completed')).toBeTruthy());
    expect(within(labs[1]!).getByText('Not started')).toBeTruthy();
    expect(within(labs[1]!).getByText('Recommended first: LINUX-001')).toBeTruthy();

    const progress = panel('Your progress');
    expect(within(progress).getByText('of 2 labs completed')).toBeTruthy();
    expect(within(progress).getByRole('progressbar', { name: 'Linux: 1 of 2 labs completed' })).toBeTruthy();
    expect(within(progress).getByRole('link', { name: /Continue learning\s*: LINUX-002/ }).getAttribute('href')).toBe('#/labs/LINUX-002');

    const skills = panel('Skills in this stage');
    expect(within(skills).getByText('The Linux filesystem').closest('li')!.textContent).toMatch(/All labs completed\s*1 of 1 lab/);
    expect(within(skills).getByText('File permissions').closest('li')!.textContent).toMatch(/Not started/);
  });

  it('shows a coming-soon stage honestly, with nothing to count', async () => {
    renderApp('#/paths/devops-engineer/stages/git');

    expect(await screen.findByRole('heading', { level: 1, name: 'Git & Software Delivery' })).toBeTruthy();
    expect(screen.getByText('JumpToTech Labs does not have Git labs yet.')).toBeTruthy();
    expect(screen.getByText('There are no labs in this stage yet.')).toBeTruthy();
    expect(within(panel('Skills coming soon')).getByText('Git fundamentals.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Nothing to count yet: this stage has no labs.')).toBeTruthy());
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('recommends an earlier stage without locking the labs away', async () => {
    renderApp('#/paths/devops-engineer/stages/kubernetes');

    expect(await screen.findByRole('heading', { level: 1, name: 'Kubernetes' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/You can still open any lab here/)).toBeTruthy());
    expect(within(panel('Before you start')).getByText(/finish first \(not yet\)/)).toBeTruthy();
    // The lab is still one click away.
    expect(screen.getByRole('link', { name: 'K8S-001 Create Your First Pod' }).getAttribute('href')).toBe('#/labs/K8S-001');
  });

  it('offers Continue lab, not a second launch, while a lab is running', async () => {
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ labId: 'K8S-001' }), labTitle: 'Create Your First Pod' }]),
    );
    renderApp('#/paths/devops-engineer/stages/linux');

    const progress = await waitFor(() => panel('Your progress'));
    await waitFor(() => expect(within(progress).getByText(/you can run one lab at a time/)).toBeTruthy());
    expect(within(progress).getByRole('link', { name: 'Continue lab' }).getAttribute('href')).toBe('#/labs/K8S-001/workspace');
    expect(within(progress).queryByRole('link', { name: /Start this stage|Continue learning/ })).toBeNull();
  });

  it('shows Stage not found for a stage the path does not have', async () => {
    renderApp('#/paths/devops-engineer/stages/quantum');
    expect(await screen.findByRole('heading', { level: 1, name: 'Stage not found' })).toBeTruthy();
  });

  it('keeps the Learning Path section marked while moving from path to stage', async () => {
    renderApp('#/paths/devops-engineer');
    await screen.findByRole('heading', { level: 1, name: 'DevOps Engineer path' });
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(nav.getByRole('link', { name: 'Learning Path' }).getAttribute('aria-current')).toBe('page');

    act(() => go('#/paths/devops-engineer/stages/linux'));
    await screen.findByRole('heading', { level: 1, name: 'Linux' });
    expect(nav.getByRole('link', { name: 'Learning Path' }).getAttribute('aria-current')).toBe('page');
    expect(document.activeElement?.id).toBe('main');
  });
});
