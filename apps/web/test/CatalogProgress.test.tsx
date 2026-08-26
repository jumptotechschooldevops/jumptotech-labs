/**
 * PLATFORM-005 — completion state in the existing catalog.
 *
 * The catalog is still a pure read of lab metadata; progress arrives from a
 * second request and decorates it. These tests pin both halves of that: the
 * badges appear when progress is available, and the catalog renders normally
 * when it is not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { renderWithAuth } from './auth-harness';
import { CatalogPage } from '../src/pages/CatalogPage';
import type { LabSummary, ProgressSnapshot, TrackSummary } from '../src/lib/types';
import progressFixture from './fixtures/me-progress.json';
import catalog from './fixtures/labs.json';

const CATALOG = catalog as unknown as { labs: LabSummary[]; tracks: TrackSummary[]; count: number };
const PROGRESS = progressFixture as unknown as ProgressSnapshot;

const listLabs = vi.fn();
const getProgress = vi.fn();

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      listLabs: (...args: unknown[]) => listLabs(...args),
      getProgress: (...args: unknown[]) => getProgress(...args),
    },
  };
});

beforeEach(() => {
  listLabs.mockReset();
  getProgress.mockReset();
  listLabs.mockResolvedValue(CATALOG);
  getProgress.mockResolvedValue(PROGRESS);
});

async function renderCatalog(props: Partial<Parameters<typeof CatalogPage>[0]> = {}) {
  renderWithAuth(<CatalogPage onOpenLab={vi.fn()} {...props} />);
  await waitFor(() => expect(screen.getByText('Create Your First Pod')).toBeTruthy());
}

describe('the catalog shows where the student stands', () => {
  it('marks completed and in-progress labs', async () => {
    await renderCatalog();
    await waitFor(() => expect(screen.getAllByText('✓ Completed').length).toBeGreaterThan(0));

    // The fixture has K8S-001 and LINUX-001 completed, K8S-004 and TF-001 open.
    expect(screen.getAllByText('✓ Completed')).toHaveLength(2);
    expect(screen.getAllByText('In progress')).toHaveLength(2);
  });

  it('says nothing at all about a lab the student has never opened', async () => {
    const { container } = renderWithAuth(<CatalogPage onOpenLab={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('✓ Completed').length).toBe(2));

    // Ten Kubernetes labs, eight of them untouched: no badge, no "Not started"
    // noise on every card — the plain card already says it.
    expect(container.querySelectorAll('.labcard--completed')).toHaveLength(2);
    expect(screen.queryByText('Not started')).toBeNull();
  });

  it('offers the progress page with the running count', async () => {
    const onOpenProgress = vi.fn();
    await renderCatalog({ onOpenProgress });
    await waitFor(() => expect(screen.getByText('2/12')).toBeTruthy());

    expect(screen.getByRole('button', { name: /My progress/ })).toBeTruthy();
  });

  it('renders the whole catalog when progress cannot be read', async () => {
    getProgress.mockRejectedValue(new Error('progress store is down'));
    await renderCatalog();

    // Losing the badges is the entire cost of the progress store being down.
    expect(screen.getAllByRole('button', { name: 'Open lab' })).toHaveLength(CATALOG.labs.length);
    expect(screen.queryByText('✓ Completed')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
