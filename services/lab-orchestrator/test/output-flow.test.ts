/**
 * Output flow control — the bound on what one slow reader can make a shared
 * relay hold. See `src/output-flow.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOutputFlow,
  pausableSocket,
  ptyInputQueueReadable,
  ptyPendingInputBytes,
  resolveOutputFlowOptions,
} from '../src/output-flow.js';

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

describe('pending input of a node-pty terminal', () => {
  /** node-pty 1.1's Unix terminal: a write stream holding `{ buffer, offset }` tasks. */
  const ptyWith = (queue: Array<{ buffer: Buffer; offset: number }>) => ({ _writeStream: { _writeQueue: queue } });

  it('counts what is queued and not yet written, net of a partial write', () => {
    const term = ptyWith([
      { buffer: Buffer.alloc(8_192), offset: 4_096 },
      { buffer: Buffer.alloc(8_192), offset: 0 },
    ]);
    expect(ptyInputQueueReadable(term)).toBe(true);
    expect(ptyPendingInputBytes(term)).toBe(12_288);
  });

  it('reports an empty queue as nothing pending', () => {
    expect(ptyPendingInputBytes(ptyWith([]))).toBe(0);
  });

  it('reports nothing pending, and says so, for a terminal without that queue', () => {
    for (const term of [{}, null, undefined, { _writeStream: {} }, { _writeStream: { _writeQueue: 'x' } }]) {
      expect(ptyInputQueueReadable(term)).toBe(false);
      expect(ptyPendingInputBytes(term)).toBe(0);
    }
  });

  it('drives the flow control with the roles swapped: the queue pauses the socket input arrives on', () => {
    const queue: Array<{ buffer: Buffer; offset: number }> = [];
    const term = ptyWith(queue);
    const socket = { pause: vi.fn(), resume: vi.fn() };
    const flow = createOutputFlow(
      { get bufferedAmount() { return ptyPendingInputBytes(term); } },
      socket,
      vi.fn(),
      LIMITS,
    );
    queue.push({ buffer: Buffer.alloc(150), offset: 0 });
    flow.afterSend();
    expect(socket.pause).toHaveBeenCalledTimes(1);
    expect(flow.paused).toBe(true);
    flow.dispose();
  });
});

describe('a socket paused for input pressure', () => {
  function socketDouble() {
    return { readyState: 1, OPEN: 1, pause: vi.fn(), resume: vi.fn(), ping: vi.fn() };
  }

  it('probes its peer only while paused', async () => {
    vi.useFakeTimers();
    const ws = socketDouble();
    const source = pausableSocket(ws, 100);

    await vi.advanceTimersByTimeAsync(500);
    expect(ws.ping).not.toHaveBeenCalled();

    source.pause();
    source.pause();
    expect(ws.pause).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(350);
    // One probe timer however often it is paused.
    expect(ws.ping).toHaveBeenCalledTimes(3);

    source.resume();
    expect(ws.resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.ping).toHaveBeenCalledTimes(3);
  });

  it('stops probing once the socket is no longer open', async () => {
    vi.useFakeTimers();
    const ws = socketDouble();
    const source = pausableSocket(ws, 100);
    source.pause();
    await vi.advanceTimersByTimeAsync(150);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    ws.readyState = 3;
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops probing if a probe throws', async () => {
    vi.useFakeTimers();
    const ws = socketDouble();
    ws.ping.mockImplementation(() => {
      throw new Error('not open');
    });
    pausableSocket(ws, 100).pause();
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
