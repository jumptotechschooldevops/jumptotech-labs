import { describe, expect, it, vi } from 'vitest';
import { describeApiTarget, resolveApiBase, resolveTerminalWsBase } from '../src/lib/urls';

describe('resolveApiBase', () => {
  it('returns an empty string when VITE_API_URL is unset (same-origin)', () => {
    vi.stubEnv('VITE_API_URL', '');
    expect(resolveApiBase()).toBe('');
  });

  it('uses an explicit VITE_API_URL when set', () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:4000/');
    expect(resolveApiBase()).toBe('http://localhost:4000');
  });
});

describe('resolveTerminalWsBase', () => {
  it('derives wss from an https page origin when env is unset', () => {
    vi.stubEnv('VITE_TERMINAL_WS_URL', '');
    vi.stubGlobal('window', {
      location: { protocol: 'https:', host: 'labs.example.com' },
    } as Window);
    expect(resolveTerminalWsBase()).toBe('wss://labs.example.com');
  });

  it('uses an explicit VITE_TERMINAL_WS_URL when set', () => {
    vi.stubEnv('VITE_TERMINAL_WS_URL', 'ws://localhost:4001/');
    expect(resolveTerminalWsBase()).toBe('ws://localhost:4001');
  });

  it('falls back to the API-provided URL without a browser', () => {
    vi.stubEnv('VITE_TERMINAL_WS_URL', '');
    const original = globalThis.window;
    // @ts-expect-error — exercise the non-browser path in unit tests.
    delete globalThis.window;
    expect(resolveTerminalWsBase('wss://labs.example.com')).toBe('wss://labs.example.com');
    globalThis.window = original;
  });
});

describe('describeApiTarget', () => {
  it('names same-origin targets clearly', () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://labs.example.com' },
    } as Window);
    expect(describeApiTarget('')).toBe('https://labs.example.com (same origin)');
  });
});
