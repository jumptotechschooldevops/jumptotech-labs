/**
 * Per-session SSH credentials.
 *
 * Every Ansible sandbox gets its own freshly generated keypair:
 *
 * ```text
 *   session start ──► generateSessionKeyPair()
 *                     ├── public  → authorized_keys on control + every node
 *                     └── private → control node (0600) + the student's shell
 *   session end   ──► containers destroyed ──► both halves cease to exist
 * ```
 *
 * Properties worth stating plainly:
 *
 *   - **No host SSH key is ever used.** The platform does not read
 *     `~/.ssh`, does not mount it, and does not pass any host credential into a
 *     sandbox. The only key that can open a sandbox is the one minted for it.
 *   - **The private key never touches the host filesystem.** It lives in memory
 *     in the orchestrator, is streamed into the control node over stdin, and is
 *     written 0600 by the terminal service for exactly as long as one PTY runs.
 *   - **Keys do not outlive sessions.** There is no key store, no rotation
 *     schedule, and nothing to revoke: destroying the containers destroys the
 *     only copies that were authorised.
 *
 * RSA rather than Ed25519 is deliberate. Node can emit an RSA private key in
 * the PEM form OpenSSH reads directly; an Ed25519 private key would have to be
 * re-encoded into the OpenSSH-proprietary container by hand. (RSA *keys* are
 * not deprecated — only the SHA-1 `ssh-rsa` signature algorithm is, and modern
 * OpenSSH negotiates `rsa-sha2-256`/`rsa-sha2-512` with the same key.)
 */
import { createPublicKey, generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';

const generateKeyPairAsync = promisify(generateKeyPair);

export interface SessionKeyPair {
  /** PEM, PKCS#1 — the form `ssh -i` accepts without conversion. */
  privateKey: string;
  /** OpenSSH one-line form, e.g. `ssh-rsa AAAAB3… jumptotech-session`. */
  publicKey: string;
  /** Fingerprint-free label written into the public key's comment field. */
  comment: string;
}

export const DEFAULT_KEY_MODULUS_BITS = 2048;

/**
 * Encode a length-prefixed SSH wire-format string.
 *
 * The OpenSSH public key blob is a sequence of these: the algorithm name, then
 * each key parameter as a big-endian multiple-precision integer.
 */
function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

/**
 * SSH mpint encoding: big-endian, minimal length, and prefixed with a zero
 * byte when the top bit is set so the value is never read as negative.
 */
function sshMpInt(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const needsPad = (trimmed[0] ?? 0) & 0x80;
  return sshString(needsPad ? Buffer.concat([Buffer.from([0]), trimmed]) : Buffer.from(trimmed));
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Convert an RSA public key to the single-line `ssh-rsa AAAA…` form. */
export function toOpenSshPublicKey(publicKeyPem: string, comment: string): string {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' }) as {
    kty?: string;
    n?: string;
    e?: string;
  };
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new Error('only RSA public keys can be encoded as ssh-rsa');
  }

  const blob = Buffer.concat([
    sshString(Buffer.from('ssh-rsa')),
    sshMpInt(fromBase64Url(jwk.e)),
    sshMpInt(fromBase64Url(jwk.n)),
  ]);

  return `ssh-rsa ${blob.toString('base64')} ${comment}`;
}

/**
 * Mint a keypair for one session.
 *
 * The comment carries the sandbox id so an operator inspecting a container's
 * `authorized_keys` can tell which session authorised it — and nothing more:
 * the sandbox id is one-way derived from the session id, so it is not itself a
 * capability.
 */
export async function generateSessionKeyPair(
  sandboxId: string,
  modulusLength = DEFAULT_KEY_MODULUS_BITS,
): Promise<SessionKeyPair> {
  const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const comment = `jumptotech-${sandboxId}`;
  return {
    privateKey: privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`,
    publicKey: toOpenSshPublicKey(publicKey, comment),
    comment,
  };
}
