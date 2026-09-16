/**
 * Output flow control — the bound on what one slow reader can make a shared
 * relay hold. See `src/output-flow.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutputFlow, resolveOutputFlowOptions } from '../src/output-flow.js';

const LIMITS = { highWaterBytes: 100, lowWaterBytes: 40, hardLimitBytes: 1_000, pollIntervalMs: 10 };

function fixture() {
  const socket = { bufferedAmount: 0 };
  const source = { pause: vi.fn(), resume: vi.fn() };
  const onOverflow = vi.fn();
  const flow = createOutputFlow(socket, source, onOverflow, LIMITS);
  return { socket, source, onOverflow, flow };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('output flow control', () => {
  it('leaves a source alone while the peer keeps up', () => {
    const { socket, source, onOverflow, flow } = fixture();
    socket.bufferedAmount = 100;
    flow.afterSend();
    expect(source.pause).not.toHaveBeenCalled();
    expect(onOverflow).not.toHaveBeenCalled();
    expect(flow.paused).toBe(false);
  });

  it('pauses the source once the peer stops reading, and only once', () => {
    const { socket, source, flow } = fixture();
    socket.bufferedAmount = 101;
    flow.afterSend();
    socket.bufferedAmount = 150;
    flow.afterSend();
    expect(source.pause).toHaveBeenCalledTimes(1);
    expect(flow.paused).toBe(true);
    flow.dispose();
  });

  it('resumes only after the socket drains below the low-water mark', async () => {
    vi.useFakeTimers();
    const { socket, source, flow } = fixture();
    socket.bufferedAmount = 500;
    flow.afterSend();

    socket.bufferedAmount = 60;
    await vi.advanceTimersByTimeAsync(50);
    expect(source.resume).not.toHaveBeenCalled();

    socket.bufferedAmount = 40;
    await vi.advanceTimersByTimeAsync(10);
    expect(source.resume).toHaveBeenCalledTimes(1);
    expect(flow.paused).toBe(false);

    // And it can pause again on the next surge.
    socket.bufferedAmount = 101;
    flow.afterSend();
    expect(source.pause).toHaveBeenCalledTimes(2);
    flow.dispose();
  });

  it('reports an overflow once when the queue passes the hard limit anyway', () => {
    const { socket, onOverflow, flow } = fixture();
    socket.bufferedAmount = 1_001;
    flow.afterSend();
    flow.afterSend();
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it('reports an overflow that grows while paused, from the poll', async () => {
    vi.useFakeTimers();
    const { socket, source, onOverflow, flow } = fixture();
    socket.bufferedAmount = 200;
    flow.afterSend();
    socket.bufferedAmount = 5_000;
    await vi.advanceTimersByTimeAsync(10);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(source.resume).not.toHaveBeenCalled();
  });

  it('bounds a source that cannot pause by the hard limit', () => {
    const socket = { bufferedAmount: 0 };
    const onOverflow = vi.fn();
    const flow = createOutputFlow(
      socket,
      {
        pause: () => {
          throw new Error('not pausable');
        },
        resume: () => undefined,
      },
      onOverflow,
      LIMITS,
    );
    socket.bufferedAmount = 500;
    expect(() => flow.afterSend()).not.toThrow();
    socket.bufferedAmount = 2_000;
    flow.afterSend();
    expect(onOverflow).toHaveBeenCalledTimes(1);
    flow.dispose();
  });

  it('does nothing after dispose', async () => {
    vi.useFakeTimers();
    const { socket, source, onOverflow, flow } = fixture();
    socket.bufferedAmount = 200;
    flow.afterSend();
    flow.dispose();
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    socket.bufferedAmount = 5_000;
    flow.afterSend();
    expect(source.resume).not.toHaveBeenCalled();
    expect(onOverflow).not.toHaveBeenCalled();
  });

  it('refuses limits that cannot work', () => {
    expect(() => resolveOutputFlowOptions({ lowWaterBytes: 200, highWaterBytes: 100 })).toThrow(RangeError);
    expect(() => resolveOutputFlowOptions({ highWaterBytes: 1_000, hardLimitBytes: 1_000 })).toThrow(RangeError);
    expect(() => resolveOutputFlowOptions({ pollIntervalMs: 0 })).toThrow(RangeError);
    expect(resolveOutputFlowOptions()).toMatchObject({ highWaterBytes: 1024 * 1024 });
  });
});
