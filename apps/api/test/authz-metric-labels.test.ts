/**
 * `jtt_authz_decisions_total` has a bounded label set.
 *
 * `authenticate` audits a refused credential with the request line as its
 * action, and the composition root used that action as the metric label, so
 * every distinct path an anonymous caller sent — `GET /api/sessions/<random>`
 * needs no credential at all to reach the middleware — created a permanent
 * series in the api's heap and in Prometheus.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuthError, type IdentityResolver } from '../src/auth/identity.js';
import { authenticate, authzDecisionLabels, type AuthAuditEvent } from '../src/auth/middleware.js';

const refusing: IdentityResolver = {
  mode: 'oidc',
  async resolve() {
    throw new AuthError('AUTH_REQUIRED', 'This request requires authentication.');
  },
};

describe('authz decision metric labels', () => {
  it('count every anonymous request under one action, whatever its path', async () => {
    const events: AuthAuditEvent[] = [];
    const app = express();
    app.use('/api/sessions', authenticate(refusing, (event) => events.push(event)));

    for (let i = 0; i < 25; i += 1) {
      await request(app).get(`/api/sessions/probe-${i}`).expect(401);
    }

    // The audit line keeps what was asked for…
    expect(new Set(events.map((e) => e.action)).size).toBe(25);
    // …and the metric does not turn it into 25 series.
    const series = new Set(events.map((e) => JSON.stringify(authzDecisionLabels(e))));
    expect([...series]).toEqual([JSON.stringify({ action: 'authenticate', result: 'unauthenticated' })]);
  });

  it('keep the closed action of a decision about a session', () => {
    expect(
      authzDecisionLabels({
        requestId: 'req-1',
        authenticatedUserId: 'user-1',
        action: 'session:check',
        sessionId: 'sess-0123456789abcdef',
        authorizationResult: 'denied-not-owner',
        timestamp: new Date(0).toISOString(),
      }),
    ).toEqual({ action: 'session:check', result: 'denied-not-owner' });
  });
});
