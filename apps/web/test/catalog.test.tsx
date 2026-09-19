/**
 * Student beta experience — the lab catalog is usable at 114 labs.
 *
 * Search, track, difficulty and status filters over the API's own catalog;
 * grouping in the API's track order; progress badges only where progress was
 * read; deliberate loading, empty and error states. Nothing in the page is keyed
 * to a lab id or a track name, so the fixtures are deliberately small and
 * synthetic — `live-payloads.test.tsx` covers the shipped catalog.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ApiRequestError } from '../src/lib/api';
import { CatalogPage } from '../src/pages/CatalogPage';
import { useCatalog } from '../src/lib/CatalogContext';
import { renderWithProviders } from './app-harness';
import {
  LABS,
  TRACKS,
  apiMock,
  labSummary,
  progressSnapshot,
  resetApiMock,
  sessionInfo,
  sessionsResponse,
  trackSummary,
} from './api-mock';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  const { apiMock: mock } = await import('./api-mock');
  return { ...actual, api: mock };
});

beforeEach(() => {
  resetApiMock();
  window.history.replaceState(null, '', '/#/labs');
});

const cards = () => screen.queryAllByRole('article');
const cardIds = () => cards().map((card) => card.querySelector('.labcard__id')?.textContent);
const card = (id: string) => cards().find((c) => within(c).queryByText(id))!;

async function renderCatalog(props: Parameters<typeof CatalogPage>[0] = {}) {
  renderWithProviders(<CatalogPage {...props} />);
  await waitFor(() => expect(cards().length).toBeGreaterThan(0));
}

describe('the catalog', () => {
  it('groups labs under their track, in the order the API gives tracks', async () => {
    await renderCatalog();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Kubernetes', 'Linux']);
    expect(cardIds()).toEqual(['K8S-001', 'LINUX-001', 'LINUX-002']);
    expect(screen.getByText(TRACKS[1]!.tagline!)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Showing all 3 labs');
  });

  it('finds labs by title, id, topic or skill', async () => {
    await renderCatalog();
    const search = screen.getByRole('searchbox', { name: 'Search' });

    fireEvent.change(search, { target: { value: 'permissions' } });
    expect(cardIds()).toEqual(['LINUX-002']);
    expect(screen.getByRole('status').textContent).toBe('Showing 1 of 3 labs');

    fireEvent.change(search, { target: { value: 'pods' } });
    expect(cardIds()).toEqual(['K8S-001']);

    fireEvent.change(search, { target: { value: 'linux-001' } });
    expect(cardIds()).toEqual(['LINUX-001']);

    // Every word must match somewhere.
    fireEvent.change(search, { target: { value: 'linux pods' } });
    expect(cardIds()).toEqual([]);
  });

  it('narrows by track and difficulty, and keeps the filters in the URL', async () => {
    await renderCatalog();

    fireEvent.change(screen.getByRole('combobox', { name: 'Track' }), { target: { value: 'linux' } });
    expect(cardIds()).toEqual(['LINUX-001', 'LINUX-002']);
    expect(window.location.hash).toBe('#/labs?track=linux');

    fireEvent.change(screen.getByRole('combobox', { name: 'Difficulty' }), { target: { value: 'intermediate' } });
    expect(cardIds()).toEqual(['LINUX-002']);
    expect(window.location.hash).toBe('#/labs?track=linux&level=intermediate');
  });

  it('starts from the filters in the address', async () => {
    await renderCatalog({ initialFilters: { track: 'kubernetes' } });
    expect(cardIds()).toEqual(['K8S-001']);
    expect((screen.getByRole('combobox', { name: 'Track' }) as HTMLSelectElement).value).toBe('kubernetes');
  });

  it('shows where the student stands, and filters by it', async () => {
    apiMock.getProgress.mockResolvedValue(progressSnapshot({ 'LINUX-001': 'COMPLETED', 'K8S-001': 'IN_PROGRESS' }));
    await renderCatalog();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Status' })).toBeTruthy());

    expect(within(card('LINUX-001')).getByText('Completed')).toBeTruthy();
    expect(within(card('K8S-001')).getByText('In progress')).toBeTruthy();
    // Nothing at all on a lab never opened: a badge on every untouched card is noise.
    expect(within(card('LINUX-002')).queryByText(/Not started|In progress|Completed/)).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'COMPLETED' } });
    expect(cardIds()).toEqual(['LINUX-001']);
  });

  it('still renders the whole catalog when progress cannot be read — and offers no status filter it cannot apply', async () => {
    apiMock.getProgress.mockRejectedValue(
      new ApiRequestError(503, { code: 'PROGRESS_UNAVAILABLE', message: 'Your progress could not be read right now.' }),
    );
    await renderCatalog();
    await waitFor(() => expect(apiMock.getProgress).toHaveBeenCalled());
    expect(cardIds()).toHaveLength(3);
    expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull();
    // …and says why the badges are missing, rather than looking like lost progress.
    expect(await screen.findByText(/Your progress could not be loaded just now/)).toBeTruthy();
    expect(screen.getByText(/Your saved progress is not affected/)).toBeTruthy();

    apiMock.getProgress.mockResolvedValue(progressSnapshot({ 'LINUX-001': 'COMPLETED' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(card('LINUX-001')).getByText('Completed')).toBeTruthy());
    expect(screen.queryByText(/Your progress could not be loaded just now/)).toBeNull();
  });

  it('keeps the badges it already showed when a later progress refresh fails', async () => {
    apiMock.getProgress.mockResolvedValue(progressSnapshot({ 'LINUX-001': 'COMPLETED' }));
    let catalog!: ReturnType<typeof useCatalog>;
    function Probe() {
      catalog = useCatalog();
      return null;
    }
    renderWithProviders(
      <>
        <CatalogPage />
        <Probe />
      </>,
    );
    await waitFor(() => expect(within(card('LINUX-001')).getByText('Completed')).toBeTruthy());

    apiMock.getProgress.mockRejectedValue(new ApiRequestError(0, { code: 'API_UNREACHABLE', message: 'x' }));
    act(() => catalog.reloadProgress());
    await waitFor(() => expect(apiMock.getProgress).toHaveBeenCalledTimes(2));

    expect(within(card('LINUX-001')).getByText('Completed')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeTruthy();
    expect(screen.queryByText(/Your progress could not be loaded just now/)).toBeNull();
  });

  it('says so when nothing matches, and clears in one click', async () => {
    await renderCatalog();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'zzzz' } });
    expect(screen.getByRole('heading', { name: 'No labs match' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(cardIds()).toHaveLength(3);
    expect(window.location.hash).toBe('#/labs');
  });

  it('links every card to its lab page, and a running lab straight back into it', async () => {
    apiMock.listMySessions.mockResolvedValue(
      sessionsResponse([{ session: sessionInfo({ labId: 'K8S-001' }), labTitle: 'Create Your First Pod' }]),
    );
    await renderCatalog();
    await waitFor(() => expect(screen.getByRole('link', { name: /Continue lab/ })).toBeTruthy());

    expect(screen.getByRole('link', { name: /^View lab\s*: Files and Directories$/ }).getAttribute('href')).toBe(
      '#/labs/LINUX-001',
    );
    expect(screen.getByRole('link', { name: /^Continue lab\s*: Create Your First Pod$/ }).getAttribute('href')).toBe(
      '#/labs/K8S-001/workspace',
    );
    expect(screen.getByText('Running')).toBeTruthy();
  });

  it('renders a track it has never heard of, from the payload alone', async () => {
    const labs = [...LABS, labSummary({ id: 'QUANTUM-001', track: 'quantum', provider: 'quantum', title: 'Entangle Two Qubits' })];
    apiMock.listLabs.mockResolvedValue({
      labs,
      tracks: [...TRACKS, trackSummary({ track: 'quantum', title: 'Quantum', tagline: undefined, labCount: 1 })],
      providers: [],
      count: labs.length,
    });
    await renderCatalog();
    expect(screen.getByRole('heading', { name: 'Quantum' })).toBeTruthy();
    expect(screen.getByText('Entangle Two Qubits')).toBeTruthy();
  });

  it('explains a catalog it could not load, and retries', async () => {
    apiMock.listLabs.mockRejectedValueOnce(
      new ApiRequestError(0, { code: 'API_UNREACHABLE', message: 'Cannot reach http://x', remediation: 'docker compose ps' }),
    );
    renderWithProviders(<CatalogPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Cannot reach JumpToTech Labs')).toBeTruthy();
    expect(within(alert).getByText('API_UNREACHABLE')).toBeTruthy();
    expect(alert.textContent).not.toMatch(/docker/);

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(cards()).toHaveLength(3));
  });

  it('never puts grading data on a card', async () => {
    const { container } = renderWithProviders(<CatalogPage />);
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    expect(container.textContent).not.toMatch(/requirement|expected|setup\//i);
  });
});
