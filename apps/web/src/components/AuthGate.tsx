/**
 * What the app renders before anybody has signed in — PLATFORM-010.
 *
 * Four states, four honest answers. The one this component exists to avoid is a
 * sign-in button on a deployment that cannot complete a sign-in, and its mirror
 * image: "please sign in" shown when the real problem is that the API is down.
 */
import type { ReactNode } from 'react';
import { useAuth } from '../lib/AuthContext';

export interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <main className="auth-gate" aria-busy="true">
        <p className="auth-gate__status">Checking your session…</p>
      </main>
    );
  }

  if (auth.status === 'unavailable') {
    return (
      <main className="auth-gate">
        <h1 className="auth-gate__title">JumpToTech Labs</h1>
        <p className="auth-gate__status auth-gate__status--error" role="alert">
          Cannot reach the labs API.
        </p>
        {/* The cause, not a guess at it — an operator reads this too. */}
        {auth.error ? <p className="auth-gate__detail">{auth.error}</p> : null}
        <button type="button" className="btn btn--ghost" onClick={() => void auth.refresh()}>
          Try again
        </button>
      </main>
    );
  }

  if (auth.status === 'anonymous') {
    return (
      <main className="auth-gate">
        <h1 className="auth-gate__title">JumpToTech Labs</h1>
        <p className="auth-gate__lede">
          Sign in to start a lab. Every sandbox belongs to one student, and your progress
          follows your account.
        </p>

        {auth.signInAvailable ? (
          <button type="button" className="btn btn--primary btn--lg" onClick={() => auth.signIn()}>
            Sign in
          </button>
        ) : (
          /*
           * No identity provider is configured here. Saying so beats a button
           * that leads to a 503, and it names what an operator has to set.
           */
          <div className="auth-gate__unconfigured" role="alert">
            <p>This deployment has no identity provider configured.</p>
            <p className="auth-gate__detail">
              Set <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>,{' '}
              <code>OIDC_CLIENT_SECRET</code> and <code>OIDC_AUDIENCE</code> on the API, or
              run with <code>AUTH_MODE=development</code> for local work.
            </p>
          </div>
        )}
      </main>
    );
  }

  return <>{children}</>;
}
