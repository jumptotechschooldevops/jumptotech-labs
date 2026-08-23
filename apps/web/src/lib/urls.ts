/**
 * Public URL resolution for the browser.
 *
 * When `VITE_API_URL` / `VITE_TERMINAL_WS_URL` are unset, the UI talks to the
 * same origin that served the page. A reverse proxy (Vite in development,
 * nginx in Docker / Cloudflare Tunnel) forwards `/api/*` to the API service and
 * `/terminal` to the terminal WebSocket service.
 *
 * Explicit env vars still win, so a developer can point the UI directly at
 * localhost:4000 and ws://localhost:4001 without a proxy when they prefer.
 */

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

/** Base URL for REST calls. Empty string means same-origin relative paths. */
export function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured?.trim()) return trimTrailingSlash(configured.trim());
  return '';
}

/**
 * WebSocket base URL for the terminal service (no `/terminal` suffix).
 *
 * `LabTerminal` appends `/terminal`. When env is unset, derive from the page
 * origin so `wss://public-host/terminal` works through the web proxy.
 */
export function resolveTerminalWsBase(fallback?: string | null): string {
  const configured = import.meta.env.VITE_TERMINAL_WS_URL as string | undefined;
  if (configured?.trim()) return trimTrailingSlash(configured.trim());

  if (typeof window !== 'undefined' && window.location?.host) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }

  if (fallback?.trim()) return trimTrailingSlash(fallback.trim());
  return 'ws://localhost:4001';
}

/** Human-readable API target for error messages. */
export function describeApiTarget(base: string = resolveApiBase()): string {
  if (!base) {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin} (same origin)`;
    }
    return 'the JumpToTech Labs API (same origin)';
  }
  return base;
}
