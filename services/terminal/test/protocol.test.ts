import { describe, expect, it } from 'vitest';
import { ProtocolError, clampCols, clampRows, parseClientMessage } from '../src/protocol.js';

describe('parseClientMessage', () => {
  it('parses an auth frame and clamps its geometry', () => {
    const msg = parseClientMessage(JSON.stringify({ type: 'auth', token: 'abc', cols: 9999, rows: 0 }));

    expect(msg).toEqual({ type: 'auth', token: 'abc', cols: 500, rows: 5 });
  });

  it('parses input and resize frames', () => {
    expect(parseClientMessage('{"type":"input","data":"ls\\n"}')).toEqual({
      type: 'input',
      data: 'ls\n',
    });
    expect(parseClientMessage('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: 'resize',
      cols: 120,
      rows: 40,
    });
  });

  it.each([
    ['not JSON', 'hello'],
    ['a JSON array', '[]'],
    ['null', 'null'],
    ['an unknown type', '{"type":"exec","command":"id"}'],
    ['auth without a token', '{"type":"auth"}'],
    ['auth with a non-string token', '{"type":"auth","token":123}'],
    ['input without data', '{"type":"input"}'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseClientMessage(raw)).toThrow(ProtocolError);
  });

  it('rejects an oversized frame', () => {
    const huge = JSON.stringify({ type: 'input', data: 'x'.repeat(200_000) });
    expect(() => parseClientMessage(huge)).toThrow(/maximum frame size/);
  });

  it('rejects an oversized input payload inside a legal frame', () => {
    const raw = JSON.stringify({ type: 'input', data: 'x'.repeat(9_000) });
    expect(() => parseClientMessage(raw)).toThrow(/too large/);
  });
});

describe('geometry clamping', () => {
  it.each([
    [undefined, 80],
    ['abc', 80],
    [Number.NaN, 80],
    [-5, 20],
    [10_000, 500],
    [120, 120],
  ])('clampCols(%s) === %s', (input, expected) => {
    expect(clampCols(input)).toBe(expected);
  });

  it.each([
    [undefined, 24],
    [-1, 5],
    [10_000, 200],
    [40, 40],
  ])('clampRows(%s) === %s', (input, expected) => {
    expect(clampRows(input)).toBe(expected);
  });
});
