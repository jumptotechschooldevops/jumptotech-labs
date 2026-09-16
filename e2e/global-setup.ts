/**
 * Readiness gate, run once before any browser opens.
 *
 * e2e/stack.sh already waits for the same conditions after `up`; this repeats
 * them so that `playwright test` against an externally started stack cannot
 * silently run against a half-started or wrong one. Bounded, and it throws.
 */
import { requiredEnv } from './tests/support/env.js';

const TIMEOUT_MS = 60_000;

async function probe(): Promise<string> {
  const web = requiredEnv('E2E_BASE_URL');
  const api = requiredEnv('E2E_API_URL');
  const get = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    return response;
  };

  await get(`${web}/`);
  const auth = (await (await get(`${web}/auth/config`)).json()) as { data?: { mode?: string; signInAvailable?: boolean } };
  if (auth.data?.mode !== 'oidc' || auth.data.signInAvailable !== true) {
    throw new Error(`browser sign-in is not available (mode=${auth.data?.mode}, signInAvailable=${auth.data?.signInAvailable})`);
  }
  const health = (await (await get(`${api}/health`)).json()) as {
    data?: { labsLoaded?: number; providers?: { provider: string; available: boolean }[] };
  };
  if (!health.data?.labsLoaded) throw new Error('the api has no labs loaded');
  if (!health.data.providers?.find((p) => p.provider === 'linux')?.available) {
    throw new Error('the linux provider is not available');
  }
  return `${health.data.labsLoaded} labs, linux provider available, OIDC sign-in enabled`;
}

export default async function globalSetup(): Promise<void> {
  requiredEnv('E2E_RUNTIME_OWNER_ID');
  const deadline = Date.now() + TIMEOUT_MS;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const summary = await probe();
      console.log(`[e2e] stack ready: ${summary}`);
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(`[e2e] stack not ready after ${TIMEOUT_MS / 1000}s: ${last instanceof Error ? last.message : String(last)}`);
}
