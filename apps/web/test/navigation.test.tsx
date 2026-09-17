/**
 * Student beta experience — a student always knows where they are.
 *
 * The routed app, mounted whole: the current section is marked, the document
 * title follows the page, a running lab is one click away from anywhere, and an
 * address that is not a page says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { renderApp, go } from './routed-app';
import { apiMock, resetApiMock, sessionInfo, sessionsResponse } from './api-mock';

// The routed app imports the workspace; a real xterm has no business in jsdom.
vi.mock('../src/components/LabTerminal', () => ({ LabTerminal: () => null }));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

beforeEach(() => {
  resetApiMock();
});

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
const current = () => nav().getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page').map((l) => l.textContent);

describe('navigation', () => {
  it('offers the same six sections everywhere, and marks the current one', async () => {
    renderApp('#/');
    await screen.findByRole('heading', { level: 1, name: /Welcome/ });

    expect(nav().getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Dashboard',
      'Learning Path',
      'Labs',
      'Tracks',
      'Progress',
      'Help',
    ]);
    expect(current()).toEqual(['Dashboard']);
    // The title is set by the page's effect, which React may run in a later task
    // than the commit that put the heading on screen: wait for it, don't race it.
    await waitFor(() => expect(document.title).toBe('Dashboard · JumpToTech Labs'));

    act(() => go('#/labs'));
    await screen.findByRole('heading', { level: 1, name: 'Lab catalog' });
    expect(current()).toEqual(['Labs']);
    await waitFor(() => expect(document.title).toBe('Lab catalog · JumpToTech Labs'));

    act(() => go('#/labs/LINUX-001'));
    await screen.findByRole('heading', { level: 1, name: 'Files and Directories' });
    // A lab page lives under Labs.
    expect(current()).toEqual(['Labs']);

    act(() => go('#/tracks/linux'));
    await screen.findByRole('heading', { level: 1, name: 'Linux' });
    expect(current()).toEqual(['Tracks']);

    // A stage lives under Learning Path.
    act(() => go('#/paths/devops-engineer/stages/linux'));
    await screen.findByRole('heading', { level: 1, name: 'Linux' });
    expect(current()).toEqual(['Learning Path']);
    await waitFor(() => expect(document.title).toBe('Linux · JumpToTech Labs'));
  });

  it('moves focus to the new page on navigation, for keyboard and screen-reader users', async () => {
    renderApp('#/');
    await screen.findByRole('heading', { level: 1, name: /Welcome/ });
    act(() => go('#/help'));
    await screen.findByRole('heading', { level: 1, name: 'How JumpToTech Labs works' });
    expect(document.activeElement?.id).toBe('main');
  });

  it('shows a running lab in the top bar, linked straight back into it', async () => {
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ labId: 'LINUX-001' }), labTitle: 'Files and Directories' }]),
    );
    renderApp('#/help');

    const indicator = await screen.findByRole('link', { name: /Active lab\s*LINUX-001\s*, Ready/ });
    expect(indicator.getAttribute('href')).toBe('#/labs/LINUX-001/workspace');
  });

  it('keeps the app on screen when the api names a session status this bundle does not know', async () => {
    // A tab left open across a deployment that adds a status.
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([
        { session: sessionInfo({ labId: 'LINUX-001', status: 'MIGRATING' as never }), labTitle: 'Files and Directories' },
      ]),
    );
    renderApp('#/help');

    expect(await screen.findByRole('link', { name: /Active lab\s*LINUX-001\s*, Updating/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'How JumpToTech Labs works' })).toBeTruthy();
  });

  it('shows nothing about a lab when none is running', async () => {
    renderApp('#/help');
    await waitFor(() => expect(apiMock.listMySessions).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Active lab/ })).toBeNull();
  });

  it('says an unknown address is not a page, instead of quietly showing another one', async () => {
    renderApp('#/definitely-not-a-page');
    // Level 1: the empty state is the page, and a page keeps its h1 (axe page-has-heading-one).
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to your dashboard' })).toBeTruthy();
  });

  it('offers a skip link to the content', async () => {
    renderApp('#/help');
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeTruthy();
    expect(screen.getByRole('main').id).toBe('main');
  });
});
