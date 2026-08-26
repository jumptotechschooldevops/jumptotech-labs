/**
 * The owner claim a terminal credential request must carry — PLATFORM-010.
 *
 * `POST /internal/sessions/:id/credentials` now re-proves ownership before
 * releasing anything, so a test standing in for the terminal service has to do
 * what the terminal service does: verify the token it was given and forward the
 * `uid` claim.
 *
 * Reading it out of the token rather than out of the session record is
 * deliberate — it is the same value, arrived at the same way, so a test that
 * passes here is evidence the real path works rather than evidence the record
 * agrees with itself.
 */
import { verifySessionToken } from '@jumptotech/lab-orchestrator';

/** The `uid` the API will insist on, taken from a start response's token. */
export function ownerFromTerminalToken(token: string, secret: string): string {
  return verifySessionToken(token, secret).uid;
}

/** The body the terminal service sends with a credential request. */
export function terminalCredentialBody(token: string, secret: string): { ownerUserId: string } {
  return { ownerUserId: ownerFromTerminalToken(token, secret) };
}
