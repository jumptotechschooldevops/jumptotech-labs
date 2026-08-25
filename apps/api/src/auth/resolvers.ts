/**
 * Turning a request's credentials into a user — PLATFORM-009.
 *
 * Two resolvers, one interface. Which one a deployment gets is decided once, at
 * startup, from configuration that production refuses to misread.
 */
import { AuthError, type AuthenticatedUser, type IdentityResolver } from './identity.js';
import { bearerToken, type TokenVerifier } from './oidc.js';
import type { UserRepository } from './users.js';

/** Verifies a real token, then finds or creates the account behind it. */
export class OidcIdentityResolver implements IdentityResolver {
  readonly mode = 'oidc' as const;

  constructor(
    private readonly verifier: TokenVerifier,
    private readonly users: UserRepository,
  ) {}

  async resolve(header: string | undefined): Promise<AuthenticatedUser> {
    const claims = await this.verifier.verify(bearerToken(header));
    return this.users.upsert(claims);
  }
}

/**
 * The development resolver: `Authorization: Developer <name>`.
 *
 * It exists so the test suite and a laptop can exercise ownership without an
 * identity provider, and it is deliberately *not* a bearer token — a
 * development credential that looked like a real one would be far too easy to
 * leave switched on. It can only be constructed through `buildIdentityResolver`
 * below, which refuses to build it in production.
 */
export class DevelopmentIdentityResolver implements IdentityResolver {
  readonly mode = 'development' as const;
  static readonly ISSUER = 'urn:jumptotech:development';

  constructor(
    private readonly users: UserRepository,
    /** Used when a request carries no credential at all. */
    private readonly defaultSubject = 'dev-student',
  ) {}

  async resolve(header: string | undefined): Promise<AuthenticatedUser> {
    const subject = this.#subjectFrom(header);
    return this.users.upsert({
      issuer: DevelopmentIdentityResolver.ISSUER,
      subject,
      displayName: subject,
    });
  }

  #subjectFrom(header: string | undefined): string {
    if (!header) return this.defaultSubject;
    const match = /^Developer[ ]+(\S+)$/.exec(header.trim());
    if (!match) {
      // A real bearer token offered to the development resolver is refused
      // rather than silently ignored: it means the deployment is misconfigured.
      throw new AuthError(
        'AUTH_INVALID_TOKEN',
        'This deployment uses development authentication and does not accept bearer tokens.',
      );
    }
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(match[1]!)) {
      throw new AuthError('AUTH_INVALID_TOKEN', 'Malformed development identity.');
    }
    return match[1]!.toLowerCase();
  }
}

export interface AuthRuntimeConfig {
  mode: 'oidc' | 'development';
  /** `NODE_ENV`, so the gate below can see what kind of deployment this is. */
  nodeEnv: string | undefined;
}

/**
 * The production safety gate.
 *
 * Development authentication accepts whoever the caller says they are. Shipping
 * it by accident would not be a weak login — it would be no login, with every
 * student able to become every other. The two ways that happens are a stale
 * `AUTH_MODE` in a production environment file and a missing one falling back
 * to a permissive default, so: the default is `oidc`, and production with
 * `AUTH_MODE=development` refuses to start rather than starting insecurely.
 */
export function assertAuthModeAllowed(config: AuthRuntimeConfig): void {
  if (config.mode === 'development' && config.nodeEnv === 'production') {
    throw new AuthError(
      'AUTH_MISCONFIGURED',
      'AUTH_MODE=development cannot be used when NODE_ENV=production: ' +
        'development authentication accepts any identity the caller claims.',
      'Set AUTH_MODE=oidc and configure OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_AUDIENCE.',
    );
  }
}

export function buildIdentityResolver(options: {
  config: AuthRuntimeConfig;
  users: UserRepository;
  verifier?: TokenVerifier;
  defaultDevelopmentSubject?: string;
}): IdentityResolver {
  assertAuthModeAllowed(options.config);

  if (options.config.mode === 'development') {
    return new DevelopmentIdentityResolver(options.users, options.defaultDevelopmentSubject);
  }
  if (!options.verifier) {
    throw new AuthError(
      'AUTH_MISCONFIGURED',
      'AUTH_MODE=oidc requires OIDC_ISSUER and OIDC_AUDIENCE.',
    );
  }
  return new OidcIdentityResolver(options.verifier, options.users);
}
