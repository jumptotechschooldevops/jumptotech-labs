/**
 * Regression: the start overlay must dismiss after the terminal connects.
 *
 * A single effect that both flipped `starting → ready` and scheduled
 * `ready → active` cleared its own timeout when the phase change re-ran the
 * effect, leaving the overlay stuck on "Lab Ready" and blocking the terminal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { LabPage } from '../src/pages/LabPage';
import k8s006 from './fixtures/lab-k8s-006.json';
import type { TerminalStatus } from '../src/components/LabTerminal';

vi.mock('../src/components/LabTerminal', () => ({
  LabTerminal: ({
    url,
    token,
    onStatusChange,
  }: {
    url: string | null;
    token: string | null;
    onStatusChange: (status: TerminalStatus) => void;
  }) => {
    useEffect(() => {
      if (!url || !token) return;
      onStatusChange('connecting');
      onStatusChange('connected');
    }, [url, token, onStatusChange]);
    return <div data-testid="lab-terminal-stub" />;
  },
}));

const getLab = vi.fn();
const startLab = vi.fn();

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      getLab: (...args: unknown[]) => getLab(...args),
      startLab: (...args: unknown[]) => startLab(...args),
      getSession: vi.fn(),
      checkSolution: vi.fn(),
      resetLab: vi.fn(),
      endLab: vi.fn(),
      continueLab: vi.fn(),
      recordHint: vi.fn(),
    },
  };
});

beforeEach(() => {
  getLab.mockResolvedValue(k8s006);
  startLab.mockResolvedValue({
    session: {
      sessionId: 'sess-test',
      labId: 'K8S-006',
      status: 'ACTIVE',
      provider: 'kubernetes',
      sandboxKind: 'namespace',
      sandboxRef: 'lab-test',
      namespace: 'lab-test',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      secondsRemaining: 3600,
      secondsUntilIdle: 1200,
      idleWarning: false,
      idleTimeoutSeconds: 1200,
      warningSeconds: 300,
    },
    attempt: null,
    environment: { provider: 'kind', providerId: 'kubernetes', phase: 'ready' },
    steps: [{ id: 'environment-created', label: 'Environment created', status: 'ok' }],
    terminal: { url: 'ws://localhost:3000', token: 'test-token' },
  });
});

describe('LabPage start overlay lifecycle', () => {
  it('clears the overlay shortly after the terminal connects', async () => {
    render(<LabPage labId="K8S-006" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Lab' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Start Lab' }));

    await waitFor(() => expect(screen.getByText('Lab Ready')).toBeTruthy());
    expect(screen.getByText('Terminal connected')).toBeTruthy();

    await waitFor(
      () => {
        expect(screen.queryByText('Lab Ready')).toBeNull();
      },
      { timeout: 3000 },
    );
    expect(screen.queryByText('Start Lab')).toBeNull();
  });
});
