/**
 * The `route` label is the template, whatever the request's own spelling.
 *
 * Express matches mount paths case-insensitively and `req.baseUrl` keeps the
 * request's casing, so `/api/LABS`, `/api/lAbS`, … each became a new label
 * value: thousands of casings per route, fifteen series each, minted by any
 * signed-in student.
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { routeTemplate } from '../src/http-metrics.js';

const request = (baseUrl: string, path?: string) =>
  ({ baseUrl, ...(path !== undefined ? { route: { path } } : {}) }) as unknown as Request;

describe('routeTemplate', () => {
  it('gives every casing of a mount the same label', () => {
    const labels = ['/api/labs', '/api/LABS', '/api/lAbS', '/API/Labs'].map((base) => routeTemplate(request(base, '/:labId')));
    expect(new Set(labels)).toEqual(new Set(['/api/labs/:labId']));
    expect(routeTemplate(request('/api/Me/Learning-Paths', '/'))).toBe('/api/me/learning-paths');
  });

  it('keeps the template, and says unmatched when nothing matched', () => {
    expect(routeTemplate(request('/api/sessions', '/:sessionId/check'))).toBe('/api/sessions/:sessionId/check');
    expect(routeTemplate(request('/api/LABS'))).toBe('unmatched');
  });
});
