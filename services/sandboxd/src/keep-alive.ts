/**
 * How long the broker keeps an idle keep-alive connection open.
 *
 * The api reaches `/v1/runtime` with the global `fetch`, which pools
 * keep-alive sockets. Node's server advertises `Keep-Alive: timeout=5`, the
 * client idles a pooled socket for that minus 1 s (4 s), and the server really
 * closes it at keepAliveTimeout + keepAliveTimeoutBuffer (5 s + 1 s by
 * default). That 2 s margin is the only thing between a reused socket and a
 * socket the server is destroying.
 *
 * On a loaded host the api's event loop runs late and reuses sockets past its
 * own 4 s: measured on the wire, 2026-09-29, requests reached the broker on
 * connections idle 4.1–5.08 s. When the broker's keep-alive timer runs before
 * it reads such a request, Node destroys the socket with the request unread:
 * the kernel answers RST with no FIN, and the api reports `fetch failed
 * (ECONNRESET | UND_ERR_SOCKET) during 'exec'` — a Start or Reset lost with no
 * failed operation on this side. Three such resets were captured, one inside
 * the failed request's window.
 *
 * The advertised timeout stays 5 s, so clients keep idling for 4 s. Only the
 * server's own hold is lengthened, to 60 s, which turns the 2 s margin into
 * 56 s. The cost is an idle socket per recent caller held for a minute.
 */
import type { Server } from 'node:http';

/** What `Keep-Alive: timeout=` advertises; a client idles a pooled socket for this less 1 s. */
export const ADVERTISED_KEEP_ALIVE_MS = 5_000;

/** How much longer than advertised an idle socket is actually held. */
export const KEEP_ALIVE_GRACE_MS = 55_000;

/**
 * Apply the policy. Before `listen`: Node reads both values when a connection
 * is set up. `keepAliveTimeoutBuffer` is a runtime property of the server that
 * the type definitions only declare as a constructor option.
 */
export function applyKeepAlivePolicy(server: Server): void {
  server.keepAliveTimeout = ADVERTISED_KEEP_ALIVE_MS;
  (server as Server & { keepAliveTimeoutBuffer: number }).keepAliveTimeoutBuffer = KEEP_ALIVE_GRACE_MS;
}
