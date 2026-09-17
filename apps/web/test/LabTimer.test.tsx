import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { LabTimer } from '../src/components/LabTimer';

describe('LabTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the full duration before the lab starts', () => {
    render(<LabTimer startedAt={null} durationSeconds={30 * 60} onExpire={vi.fn()} />);
    expect(screen.getByText('30:00')).toBeDefined();
  });

  it('counts down from the start time', () => {
    const start = Date.now();
    render(<LabTimer startedAt={start} durationSeconds={30 * 60} onExpire={vi.fn()} />);

    act(() => {
      vi.advanceTimersByTime(65_000);
    });

    expect(screen.getByText('28:55')).toBeDefined();
  });

  it('fires onExpire exactly once when it reaches zero', () => {
    const onExpire = vi.fn();
    render(<LabTimer startedAt={Date.now()} durationSeconds={2} onExpire={onExpire} />);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(screen.getByText('00:00')).toBeDefined();
  });

  it('fires onWarning once when five minutes are left, and not for a lab that is already over', () => {
    const onWarning = vi.fn();
    render(<LabTimer startedAt={Date.now()} durationSeconds={302} onExpire={vi.fn()} onWarning={onWarning} />);
    expect(onWarning).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(onWarning).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onWarning).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    render(<LabTimer startedAt={Date.now()} durationSeconds={0} onExpire={vi.fn()} onWarning={late} />);
    expect(late).not.toHaveBeenCalled();
  });

  it('never renders a negative time', () => {
    render(<LabTimer startedAt={Date.now()} durationSeconds={1} onExpire={vi.fn()} />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText('00:00')).toBeDefined();
  });
});
