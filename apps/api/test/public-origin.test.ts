import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import {
  httpOriginToWebSocketBase,
  resolvePublicOrigin,
  resolveTerminalWsBaseForClient,
} from '../src/public-origin.js';

function mockRequest(headers: Record<string, string | undefined>): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as Request;
}

describe('resolvePublicOrigin', () => {
  it('prefers PUBLIC_ORIGIN when configured', () => {
    const req = mockRequest({ host: 'localhost:3000' });
    expect(resolvePublicOrigin(req, { publicOrigin: 'https://student.example/' })).toBe(
      'https://student.example',
    );
  });

  it('infers the origin from forwarded proxy headers', () => {
    const req = mockRequest({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'abc.trycloudflare.com',
      host: 'localhost:3000',
    });
    expect(resolvePublicOrigin(req)).toBe('https://abc.trycloudflare.com');
  });
});

describe('httpOriginToWebSocketBase', () => {
  it('maps https to wss and http to ws', () => {
    expect(httpOriginToWebSocketBase('https://labs.example.com')).toBe('wss://labs.example.com');
    expect(httpOriginToWebSocketBase('http://localhost:3000')).toBe('ws://localhost:3000');
  });
});

describe('resolveTerminalWsBaseForClient', () => {
  it('returns a public wss base when the proxy forwarded a host', () => {
    const req = mockRequest({
      'x-forwarded-proto': 'https',
      host: 'student.example',
    });
    expect(
      resolveTerminalWsBaseForClient(req, {
        defaultTerminalWsUrl: 'ws://localhost:4001',
      }),
    ).toBe('wss://student.example');
  });

  it('falls back to the configured default without proxy headers', () => {
    const req = mockRequest({});
    expect(
      resolveTerminalWsBaseForClient(req, {
        defaultTerminalWsUrl: 'ws://localhost:4001',
      }),
    ).toBe('ws://localhost:4001');
  });
});
