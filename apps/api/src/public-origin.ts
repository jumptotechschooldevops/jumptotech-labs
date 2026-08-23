/**
 * Resolve the browser-facing origin when the platform sits behind a reverse
 * proxy (nginx, Cloudflare Tunnel, etc.).
 *
 * Used to mint terminal WebSocket URLs that match what the student's browser
 * can reach — never an internal Docker hostname or localhost on the student's
 * machine.
 */
import type { Request } from 'express';

export interface PublicOriginOptions {
  /** Explicit override, e.g. the tunnel URL for this session. Never hardcoded. */
  publicOrigin?: string | undefined;
}

/** Strip a trailing slash so URL composition stays predictable. */
function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

/**
 * The HTTPS (or HTTP) origin students use in the browser.
 *
 * Priority:
 *   1. `PUBLIC_ORIGIN` when the operator set it
 *   2. `X-Forwarded-Proto` + `X-Forwarded-Host` / `Host` from the proxy
 *   3. null — caller falls back to configured defaults
 */
export function resolvePublicOrigin(req: Request, options: PublicOriginOptions = {}): string | null {
  if (options.publicOrigin?.trim()) {
    return normalizeOrigin(options.publicOrigin.trim());
  }

  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost =
    req.get('x-forwarded-host')?.split(',')[0]?.trim() ?? req.get('host')?.trim();

  if (forwardedProto && forwardedHost) {
    return normalizeOrigin(`${forwardedProto}://${forwardedHost}`);
  }

  return null;
}

/** Map `https://host` → `wss://host`, `http://host` → `ws://host`. */
export function httpOriginToWebSocketBase(origin: string): string {
  const normalized = normalizeOrigin(origin);
  if (normalized.startsWith('https://')) return `wss://${normalized.slice('https://'.length)}`;
  if (normalized.startsWith('http://')) return `ws://${normalized.slice('http://'.length)}`;
  return normalized;
}

/**
 * Terminal WebSocket base (no path) for a start-lab response.
 *
 * When a public origin is known, students connect through the web proxy at
 * `/terminal`. Otherwise use the configured default (local development).
 */
export function resolveTerminalWsBaseForClient(
  req: Request,
  options: PublicOriginOptions & { defaultTerminalWsUrl: string },
): string {
  const origin = resolvePublicOrigin(req, options);
  if (origin) return httpOriginToWebSocketBase(origin);
  return options.defaultTerminalWsUrl.replace(/\/$/, '');
}
