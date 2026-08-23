import type { VerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';

export const serviceHttp: VerifierHandler<'service_http'> = {
  type: 'service_http',
  label: (r) =>
    r.path
      ? `Service ${r.service} responds over HTTP on port ${r.port}${r.path}`
      : `Service ${r.service} responds over HTTP on port ${r.port}`,
  async run(r, reader) {
    const result = await reader.checkHttp(r.service, r.port, {
      ...(r.path !== undefined ? { path: r.path } : {}),
      ...(r.expected_status !== undefined ? { expectedStatus: r.expected_status } : {}),
      ...(r.body_contains !== undefined ? { bodyContains: r.body_contains } : {}),
      ...(r.timeout_seconds !== undefined ? { timeoutSeconds: r.timeout_seconds } : {}),
    });
    return result.ok ? pass() : fail(result.detail ?? 'HTTP check failed');
  },
};

export const serviceTcp: VerifierHandler<'service_tcp'> = {
  type: 'service_tcp',
  label: (r) => `Service ${r.service} accepts TCP connections on port ${r.port}`,
  async run(r, reader) {
    const result = await reader.checkTcp(r.service, r.port, {
      ...(r.timeout_seconds !== undefined ? { timeoutSeconds: r.timeout_seconds } : {}),
    });
    return result.ok ? pass() : fail(result.detail ?? 'TCP check failed');
  },
};
